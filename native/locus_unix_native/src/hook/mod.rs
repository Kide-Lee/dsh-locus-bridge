//! 后台调度钩子：让 Unity 在编辑器失去焦点时仍然跑主线程。
//!
//! Unity 的 `IsApplicationActive()` 在两处决定“窗口不在前台就少干活”：
//! 一处是导出符号 `Unity!IsApplicationActive`，另一处是它的 OS 实现
//! `Unity!IsApplicationActiveOSImpl`。上游在 Windows 上把这两个函数入口改写成
//! `mov eax,1; ret`，于是编辑器认为自己始终在前台，domain reload / 编译 / 导入
//! 不会因为窗口失焦而停摆。
//!
//! 本移植是**同进程内打补丁**：broker 以动态库形式跑在 Unity 进程里，所以直接
//! 改自己的代码页即可，不需要上游那套跨进程 `WriteProcessMemory`。补丁字节与符号
//! 表必须与上游 `unity_bridge/background_hook.rs` 完全一致——两条路径打的是同一
//! 批字节，谁先谁后都不该留下不一致的状态。
//!
//! 符号从哪来，按平台分两条路，解析到的地址用途完全相同：
//!
//! - **Windows**：dbghelp 从 `unity_x64.pdb` 解析私有符号（上游同款）。
//! - **Unix**：Unix 版 Unity 既不带 PDB 也不导出这两个符号，所以先试动态符号表
//!   （装过调试符号的系统包时能直接命中），再用 [`symbols`] 里的模式扫描：先找
//!   符号表文本节里名字的相邻关系，再找代码节里**唯一**一条与已知签名一致的
//!   `mov eax, 1; ret`。扫描结果只认“唯一命中”——同一串字节在代码里出现两次就
//!   无法判断哪个是目标，此时照实报 `Unsupported`，绝不对猜出来的地址写代码。
//!
//! 两条路都拿不到地址时返回 [`HookSnapshot::unsupported`]，**绝不**返回“已打过
//! 补丁”，因为那会让上层误以为后台执行已经生效。
//!
//! 失败即放行：任何一步失败都保持代码页原样并返回错误，调用方（托管侧）继续用它
//! 原来的调度路径，只是失去“失焦仍然执行”的便利。

use serde::Serialize;

/// 与上游 `background_hook.rs::PATCH_BYTES` 一致：`mov eax, 1; ret`。
pub const PATCH_BYTES: [u8; 6] = [0xB8, 0x01, 0x00, 0x00, 0x00, 0xC3];
/// 与上游 `background_hook.rs::SYMBOLS` 一致。
pub const SYMBOLS: [&str; 2] = ["Unity!IsApplicationActive", "Unity!IsApplicationActiveOSImpl"];

/// 钩子状态机，与上游 `UnityBackgroundHookState` 同名同义（序列化成 snake_case）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HookState {
    /// 用户/托管侧关掉了补丁，代码页保持原样。
    Disabled,
    /// 打开着但还没打补丁（初始化前，或上一轮恢复了）。
    Inactive,
    /// 补丁已生效。
    Patched,
    /// 尝试打补丁失败，已回滚。
    Failed,
    /// 本平台没有这项能力（非 Windows）。
    Unsupported,
}

impl HookState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Disabled => "disabled",
            Self::Inactive => "inactive",
            Self::Patched => "patched",
            Self::Failed => "failed",
            Self::Unsupported => "unsupported",
        }
    }
}

/// 钩子的对外快照（`editorHealth.backgroundHook`）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookSnapshot {
    pub enabled: bool,
    /// 本构建/本平台是否实现了这项能力。
    pub supported: bool,
    pub state: HookState,
    pub patched: bool,
    /// 实际改写成功的符号数；失败或未启用时为 0。
    pub symbol_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl HookSnapshot {
    /// 本平台不支持时的快照：状态是 `Unsupported`，并且一定带原因。
    pub fn unsupported(enabled: bool) -> Self {
        Self {
            enabled,
            supported: false,
            state: HookState::Unsupported,
            patched: false,
            symbol_count: 0,
            process_id: None,
            error: Some(unsupported_reason()),
        }
    }
}

/// 本平台为什么不支持；支持的平台返回空串。
pub fn unsupported_reason() -> String {
    if cfg!(windows) {
        String::new()
    } else {
        format!(
            "neither Unity's symbol table nor a unique instruction-pattern match located \
             IsApplicationActive in this {} build",
            std::env::consts::OS
        )
    }
}

/// 非 Windows 上的符号定位：符号表优先，模式扫描兜底。
#[cfg(not(windows))]
mod symbols;

/// 当前快照。非 Windows 平台恒为 `Unsupported`——这是诚实的降级，而不是失败。
pub fn snapshot() -> HookSnapshot {
    #[cfg(windows)]
    {
        imp::snapshot()
    }
    #[cfg(not(windows))]
    {
        symbols::snapshot()
    }
}

/// 打开/关闭补丁，返回符号数。
///
/// `Err` 表示本平台做不到或打补丁失败；两种情况下代码页都保持原样，调用方应
/// 继续使用自己的调度路径（fail open）。
pub fn set_active(active: bool) -> Result<HookSnapshot, HookSnapshot> {
    #[cfg(windows)]
    {
        imp::set_active(active)
    }
    #[cfg(not(windows))]
    {
        symbols::set_active(active)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows 实现：同进程内改 `mov eax,1; ret`
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(windows)]
mod imp {
    use std::ffi::{c_void, CString, OsStr};
    use std::mem::{size_of, zeroed};
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::ptr::null_mut;
    use std::sync::{Mutex, OnceLock};

    use super::{HookSnapshot, HookState, PATCH_BYTES, SYMBOLS};

    type Bool = i32;
    type Dword = u32;
    type Dword64 = u64;
    type Handle = *mut c_void;

    const FALSE: Bool = 0;
    const TH32CS_SNAPMODULE: Dword = 0x8;
    const TH32CS_SNAPMODULE32: Dword = 0x10;
    const PAGE_EXECUTE_READWRITE: Dword = 0x40;
    const SYMOPT_UNDNAME: Dword = 0x2;
    const SYMOPT_DEFERRED_LOADS: Dword = 0x4;
    const SYMOPT_FAIL_CRITICAL_ERRORS: Dword = 0x200;
    const SYMOPT_AUTO_PUBLICS: Dword = 0x10000;
    const MAX_SYM_NAME: usize = 2048;
    /// 私有伪句柄：`SymInitializeW` 只接受一个 handle 当会话标识，用它避免
    /// `SymCleanup` 把 Unity 自己已经打开的 dbghelp 会话一并关掉。
    const SYM_HANDLE: Handle = 0x4C4F_4355 as Handle; // 'LOCU'

    #[repr(C)]
    struct ModuleEntry32W {
        dw_size: Dword,
        th32_module_id: Dword,
        th32_process_id: Dword,
        glblcnt_usage: Dword,
        proccnt_usage: Dword,
        mod_base_addr: *mut u8,
        mod_base_size: Dword,
        h_module: Handle,
        sz_module: [u16; 256],
        sz_exe_path: [u16; 260],
    }

    #[repr(C)]
    struct SymbolInfo {
        size_of_struct: Dword,
        type_index: Dword,
        reserved: [Dword64; 2],
        index: Dword,
        size: Dword,
        mod_base: Dword64,
        flags: Dword,
        value: Dword64,
        address: Dword64,
        register: Dword,
        scope: Dword,
        tag: Dword,
        name_len: Dword,
        max_name_len: Dword,
        name: [u8; 1],
    }

    #[repr(C)]
    struct SymbolInfoBuffer {
        symbol: SymbolInfo,
        name_buffer: [u8; MAX_SYM_NAME],
    }

    extern "system" {
        fn SymInitializeW(h_process: Handle, user_search_path: *const u16, invade: Bool) -> Bool;
        fn SymSetOptions(options: Dword) -> Dword;
        fn SymLoadModuleExW(
            h_process: Handle,
            h_file: Handle,
            image_name: *const u16,
            module_name: *const u16,
            base_of_dll: Dword64,
            dll_size: Dword,
            data: *mut c_void,
            flags: Dword,
        ) -> Dword64;
        fn SymFromName(h_process: Handle, name: *const u8, symbol: *mut SymbolInfo) -> Bool;
        fn SymCleanup(h_process: Handle) -> Bool;
        fn CloseHandle(handle: Handle) -> Bool;
        fn CreateToolhelp32Snapshot(flags: Dword, process_id: Dword) -> Handle;
        fn Module32FirstW(snapshot: Handle, entry: *mut ModuleEntry32W) -> Bool;
        fn Module32NextW(snapshot: Handle, entry: *mut ModuleEntry32W) -> Bool;
        fn GetCurrentProcess() -> Handle;
        fn GetCurrentProcessId() -> Dword;
        fn VirtualProtect(address: *mut c_void, size: usize, new: Dword, old: *mut Dword) -> Bool;
        fn FlushInstructionCache(process: Handle, address: *const c_void, size: usize) -> Bool;
    }

    struct OwnedHandle(Handle);

    impl OwnedHandle {
        fn new(handle: Handle) -> Result<Self, String> {
            if handle.is_null() || handle as isize == -1 {
                return Err(format!(
                    "invalid handle: {}",
                    std::io::Error::last_os_error()
                ));
            }
            Ok(Self(handle))
        }
    }

    impl Drop for OwnedHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    /// dbghelp 会话；由 Drop 负责 `SymCleanup`。
    struct SymSession;

    impl SymSession {
        fn new(search_path: &Path) -> Result<Self, String> {
            unsafe {
                SymSetOptions(
                    SYMOPT_UNDNAME
                        | SYMOPT_DEFERRED_LOADS
                        | SYMOPT_FAIL_CRITICAL_ERRORS
                        | SYMOPT_AUTO_PUBLICS,
                );
                let path = wide_null(search_path.as_os_str());
                if SymInitializeW(SYM_HANDLE, path.as_ptr(), FALSE) == 0 {
                    return Err(last_error("SymInitializeW"));
                }
            }
            Ok(Self)
        }
    }

    impl Drop for SymSession {
        fn drop(&mut self) {
            unsafe {
                SymCleanup(SYM_HANDLE);
            }
        }
    }

    struct ModuleInfo {
        base: u64,
        size: u32,
        path: String,
    }

    struct PatchRecord {
        address: u64,
        original: [u8; PATCH_BYTES.len()],
        /// 进入时已经是补丁字节（上一轮没恢复干净），恢复时不该再写回。
        applied: bool,
    }

    #[derive(Default)]
    struct HookStateData {
        enabled: bool,
        records: Vec<PatchRecord>,
        last_error: Option<String>,
    }

    fn state() -> &'static Mutex<HookStateData> {
        static STATE: OnceLock<Mutex<HookStateData>> = OnceLock::new();
        STATE.get_or_init(|| Mutex::new(HookStateData::default()))
    }

    pub(super) fn snapshot() -> HookSnapshot {
        let data = state().lock().ok();
        let (enabled, patched, count, error) = match data.as_ref() {
            Some(data) => (
                data.enabled,
                !data.records.is_empty(),
                data.records.len() as u32,
                data.last_error.clone(),
            ),
            None => (false, false, 0, Some("background hook state poisoned".to_string())),
        };
        let state = if error.is_some() && !patched {
            HookState::Failed
        } else if patched {
            HookState::Patched
        } else if enabled {
            HookState::Inactive
        } else {
            HookState::Disabled
        };
        HookSnapshot {
            enabled,
            supported: true,
            state,
            patched,
            symbol_count: count,
            process_id: Some(unsafe { GetCurrentProcessId() }),
            error,
        }
    }

    pub(super) fn set_active(active: bool) -> Result<HookSnapshot, HookSnapshot> {
        let mut data = match state().lock() {
            Ok(data) => data,
            Err(_) => {
                let mut failed = snapshot();
                failed.error = Some("background hook state poisoned".to_string());
                failed.state = HookState::Failed;
                return Err(failed);
            }
        };
        data.enabled = active;
        if !active {
            restore_locked(&mut data);
            data.last_error = None;
            drop(data);
            return Ok(snapshot());
        }
        // 幂等：已经打过就不再解析符号、不再碰代码页。
        if !data.records.is_empty() {
            data.last_error = None;
            drop(data);
            return Ok(snapshot());
        }
        data.records.clear();
        match apply_all() {
            Ok(records) => {
                data.records = records;
                data.last_error = None;
                drop(data);
                Ok(snapshot())
            }
            Err(error) => {
                data.records.clear();
                data.last_error = Some(error);
                drop(data);
                Err(snapshot())
            }
        }
    }

    fn restore_locked(data: &mut HookStateData) {
        for record in data.records.drain(..).rev() {
            if record.applied {
                let _ = write_code(record.address, &record.original);
            }
        }
    }

    fn apply_all() -> Result<Vec<PatchRecord>, String> {
        let module = find_unity_engine_module()?;
        let image_path = Path::new(&module.path);
        let symbol_dir = image_path.parent().ok_or_else(|| {
            format!("Unity engine module has no parent directory: {}", module.path)
        })?;
        let pdb_path = symbol_dir.join("unity_x64.pdb");
        if !pdb_path.is_file() {
            return Err(format!("Unity PDB is missing: {}", pdb_path.display()));
        }

        let mut records: Vec<PatchRecord> = Vec::new();
        for symbol in SYMBOLS {
            let address = match resolve_symbol(image_path, symbol_dir, &module, symbol) {
                Ok(address) => address,
                Err(error) => {
                    rollback(&records);
                    return Err(error);
                }
            };
            if address < module.base || address >= module.base.saturating_add(module.size as u64) {
                rollback(&records);
                return Err(format!(
                    "Resolved symbol {symbol} outside Unity module: 0x{address:X}"
                ));
            }
            let original = read_code(address);
            let already_patched = original.starts_with(&PATCH_BYTES);
            if !already_patched {
                if let Err(error) = write_code(address, &PATCH_BYTES) {
                    rollback(&records);
                    return Err(error);
                }
            }
            records.push(PatchRecord {
                address,
                original,
                applied: !already_patched,
            });
        }
        Ok(records)
    }

    fn rollback(records: &[PatchRecord]) {
        for record in records.iter().rev() {
            if record.applied {
                let _ = write_code(record.address, &record.original);
            }
        }
    }

    fn find_unity_engine_module() -> Result<ModuleInfo, String> {
        let pid = unsafe { GetCurrentProcessId() };
        let snapshot =
            unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid) };
        let snapshot = OwnedHandle::new(snapshot)
            .map_err(|error| format!("Failed to snapshot own modules (PID {pid}): {error}"))?;

        let mut entry: ModuleEntry32W = unsafe { zeroed() };
        entry.dw_size = size_of::<ModuleEntry32W>() as u32;
        let mut has_entry = unsafe { Module32FirstW(snapshot.0, &mut entry) != 0 };
        let mut exe_module = None;
        while has_entry {
            let name = wide_to_string(&entry.sz_module);
            if name.eq_ignore_ascii_case("Unity.dll") {
                return Ok(module_info_from_entry(&entry));
            }
            if name.eq_ignore_ascii_case("Unity.exe") {
                exe_module = Some(module_info_from_entry(&entry));
            }
            has_entry = unsafe { Module32NextW(snapshot.0, &mut entry) != 0 };
        }
        exe_module.ok_or_else(|| "Unity engine module was not found in this process".to_string())
    }

    fn module_info_from_entry(entry: &ModuleEntry32W) -> ModuleInfo {
        ModuleInfo {
            base: entry.mod_base_addr as usize as u64,
            size: entry.mod_base_size,
            path: wide_to_string(&entry.sz_exe_path),
        }
    }

    fn resolve_symbol(
        image_path: &Path,
        symbol_path: &Path,
        module: &ModuleInfo,
        symbol_name: &str,
    ) -> Result<u64, String> {
        // 靠 Drop 关会话；解析本身用的是 SYM_HANDLE。
        let _session = SymSession::new(symbol_path)?;
        let image = wide_null(image_path.as_os_str());
        let module_name = wide_null(OsStr::new("Unity"));
        let loaded = unsafe {
            SymLoadModuleExW(
                SYM_HANDLE,
                null_mut(),
                image.as_ptr(),
                module_name.as_ptr(),
                module.base,
                module.size,
                null_mut(),
                0,
            )
        };
        if loaded == 0 {
            return Err(last_error("SymLoadModuleExW"));
        }

        let mut storage: Box<SymbolInfoBuffer> = unsafe { Box::new(zeroed()) };
        let symbol = &mut storage.symbol as *mut SymbolInfo;
        unsafe {
            (*symbol).size_of_struct = size_of::<SymbolInfo>() as u32;
            (*symbol).max_name_len = MAX_SYM_NAME as u32;
        }
        let name = CString::new(symbol_name)
            .map_err(|_| format!("Symbol name contains interior nul: {symbol_name}"))?;
        let ok = unsafe { SymFromName(SYM_HANDLE, name.as_ptr() as *const u8, symbol) != 0 };
        if !ok {
            return Err(format!(
                "Failed to resolve Unity symbol {symbol_name}: {}",
                last_error("SymFromName")
            ));
        }
        Ok(unsafe { (*symbol).address })
    }

    /// 读自己地址空间里的前 `PATCH_BYTES.len()` 个字节。
    fn read_code(address: u64) -> [u8; PATCH_BYTES.len()] {
        unsafe { std::ptr::read_unaligned(address as usize as *const [u8; PATCH_BYTES.len()]) }
    }

    /// 改自己的代码页：翻转保护 → 写入 → 刷指令缓存 → 复原保护。
    fn write_code(address: u64, bytes: &[u8]) -> Result<(), String> {
        let ptr = address as usize as *mut c_void;
        let mut old_protect = 0u32;
        let unprotected =
            unsafe { VirtualProtect(ptr, bytes.len(), PAGE_EXECUTE_READWRITE, &mut old_protect) != 0 };
        if !unprotected {
            return Err(format!(
                "Failed to unprotect Unity code at 0x{address:X}: {}",
                last_error("VirtualProtect")
            ));
        }
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), address as usize as *mut u8, bytes.len());
            let mut ignored = 0u32;
            let _ = FlushInstructionCache(GetCurrentProcess(), ptr, bytes.len());
            let _ = VirtualProtect(ptr, bytes.len(), old_protect, &mut ignored);
        }
        Ok(())
    }

    fn last_error(label: &str) -> String {
        format!("{label}: {}", std::io::Error::last_os_error())
    }

    fn wide_null(value: &OsStr) -> Vec<u16> {
        value.encode_wide().chain(std::iter::once(0)).collect()
    }

    fn wide_to_string(value: &[u16]) -> String {
        let len = value.iter().position(|ch| *ch == 0).unwrap_or(value.len());
        String::from_utf16_lossy(&value[..len])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 与上游 `unity_bridge/background_hook.rs` 对齐：同进程与跨进程两条路径必须
    /// 打同一批符号、同一串字节。
    #[test]
    fn patch_constants_match_the_cross_process_hook() {
        assert_eq!(PATCH_BYTES, [0xB8, 0x01, 0x00, 0x00, 0x00, 0xC3]);
        assert_eq!(
            SYMBOLS,
            ["Unity!IsApplicationActive", "Unity!IsApplicationActiveOSImpl"]
        );
    }

    /// 补丁字节必须是合法的 `mov eax, 1; ret`。
    #[test]
    fn patch_bytes_are_a_constant_return_true_stub() {
        assert_eq!(PATCH_BYTES[0], 0xB8, "mov eax, imm32");
        assert_eq!(&PATCH_BYTES[1..5], &[1, 0, 0, 0], "returns true");
        assert_eq!(PATCH_BYTES[5], 0xC3, "ret");
    }

    /// 非 Windows 平台必须诚实报 Unsupported，而不是装着成功。
    #[test]
    fn unsupported_platforms_never_claim_a_patch() {
        if cfg!(windows) {
            return;
        }
        let snap = snapshot();
        assert!(!snap.supported);
        assert!(!snap.patched);
        assert_eq!(snap.state, HookState::Unsupported);
        assert!(snap.error.as_deref().is_some_and(|reason| !reason.is_empty()));

        let refused = set_active(true).expect_err("a non-Windows host cannot patch Unity");
        assert_eq!(refused.state, HookState::Unsupported);
        assert!(!refused.patched);
        assert!(refused.error.is_some());
    }

    /// 状态名与上游 JSON 取值一致（`disabled|inactive|patched|failed|unsupported`）。
    #[test]
    fn state_names_match_the_upstream_status_enum() {
        assert_eq!(HookState::Disabled.as_str(), "disabled");
        assert_eq!(HookState::Inactive.as_str(), "inactive");
        assert_eq!(HookState::Patched.as_str(), "patched");
        assert_eq!(HookState::Failed.as_str(), "failed");
        assert_eq!(HookState::Unsupported.as_str(), "unsupported");
        assert_eq!(
            serde_json::to_value(HookState::Unsupported).unwrap(),
            serde_json::json!("unsupported")
        );
    }

    /// 快照是驼峰字段，和 `editorHealth.backgroundHook` 的接口约定一致。
    #[test]
    fn snapshot_serializes_to_camel_case() {
        let encoded = serde_json::to_value(HookSnapshot::unsupported(true)).unwrap();
        assert_eq!(encoded["enabled"], true);
        assert_eq!(encoded["supported"], false);
        assert_eq!(encoded["state"], "unsupported");
        assert_eq!(encoded["patched"], false);
        assert_eq!(encoded["symbolCount"], 0);
        assert!(encoded["error"].is_string());
    }
}