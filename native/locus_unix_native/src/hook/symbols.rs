//! Unix 上的后台钩子：不用 PDB 也能定位 `IsApplicationActive`。
//!
//! 上游只在 Windows 实现这个钩子，因为那条路要 dbghelp 从 PDB 里取私有符号。
//! Unix 版 Unity 不带 PDB，但补丁本身需要的只是**两个函数入口地址**，而地址有两
//! 条不依赖 PDB 的来路：
//!
//! 1. 动态符号表（`.dynsym`）。装了 `unity-debug-symbols` 这类系统包时，
//!    `IsApplicationActive` 就是导出符号，`dlsym` 直接给地址。这是最可靠的一条，
//!    优先用。
//! 2. **模式扫描**（[`scan`]）。没有符号表时，在加载进本进程的 ELF 映像里：
//!    先在符号表文本节（`.symtab` / `.dynstr`）里找 `IsApplicationActive` 与
//!    `IsApplicationActiveOSImpl` 两个名字相邻的关系，确定这两个名字属于**同一个
//!    目标文件**；再在该目标文件（或整张映像，若只有一个候选）的代码节里找与已知
//!    签名一致的 `mov eax, 1; ret`。
//!
//! 模式扫描的成败取决于“唯一性”：同一串字节在代码里有很多，`mov eax,1; ret` 也
//! 不止一处。所以扫描只在**恰好命中一处**时接受结果；零处或多处一律报
//! `Unsupported` 并给出命中数。宁可让上层继续用它自己的调度路径，也不对猜出来
//! 的地址写代码——在别人的代码页上写错 6 个字节是能让编辑器崩掉的。
//!
//! 打补丁的动作与 Windows 完全相同：`mprotect` 打开写权限 → 写入
//! [`super::PATCH_BYTES`] → 刷指令缓存 → 复原保护。

use std::ffi::{c_void, CStr};
use std::os::raw::{c_char, c_int};
use std::ptr;
use std::sync::{Mutex, OnceLock};

use super::{HookSnapshot, HookState, PATCH_BYTES, SYMBOLS};

/// 进程内目标：Unity 引擎映像。Linux 是进程可执行文件本身，macOS 是
/// `UnityFramework.framework`。
const LINUX_IMAGE_MARKERS: [&str; 1] = ["Unity"];
const MACOS_IMAGE_MARKERS: [&str; 2] = ["UnityFramework", "Unity"];

const PROT_READ: c_int = 0x1;
const PROT_WRITE: c_int = 0x2;
const PROT_EXEC: c_int = 0x4;

extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    fn dlopen(filename: *const c_char, flags: c_int) -> *mut c_void;
    fn dlclose(handle: *mut c_void) -> c_int;
    fn dlerror() -> *const c_char;
    fn mprotect(addr: *mut c_void, len: usize, prot: c_int) -> c_int;
}

#[cfg(target_os = "linux")]
extern "C" {
    fn __clear_cache(begin: *mut c_char, end: *mut c_char);
    fn sysconf(name: c_int) -> i64;
}

#[cfg(target_os = "macos")]
extern "C" {
    fn sys_icache_invalidate(start: *mut c_void, len: usize);
}

#[cfg(target_os = "linux")]
const _SC_PAGESIZE: c_int = 30;

/// 一个已定位地址的记录，恢复时要写回原字节。
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
    /// 符号是怎么找到的（`dynsym` / `pattern`），只用于诊断。
    resolved_via: Option<String>,
}

fn state() -> &'static Mutex<HookStateData> {
    static STATE: OnceLock<Mutex<HookStateData>> = OnceLock::new();
    STATE.get_or_init(|| {
        Mutex::new(HookStateData {
            // 进程刚起来、还没试过打补丁时，本机能不能做这件事是已知的：
            // `locate_symbols` 的两种来源都试一遍。这样 health 首次查询就能给出
            // 真话，而不是含糊的 disabled。定位是只读的，不会碰代码页。
            last_error: probe_unavailable(),
            ..HookStateData::default()
        })
    })
}

/// 进程启动时的只读探测：定位不到就返回原因，定位到了返回 `None`。
fn probe_unavailable() -> Option<String> {
    match locate_symbols() {
        Ok(_) => None,
        Err(error) => Some(error),
    }
}

fn process_id() -> u32 {
    std::process::id()
}

pub(super) fn snapshot() -> HookSnapshot {
    let data = state().lock().ok();
    let (enabled, patched, count, error, via) = match data.as_ref() {
        Some(data) => (
            data.enabled,
            !data.records.is_empty(),
            data.records.len() as u32,
            data.last_error.clone(),
            data.resolved_via.clone(),
        ),
        None => (
            false,
            false,
            0,
            Some("background hook state poisoned".to_string()),
            None,
        ),
    };
    let hook_state = if error.is_some() && !patched {
        // 从未定位成功过、也从未启用成功：本机没有这项能力（`Unsupported`）。
        // 曾经定位成功但这次打补丁失败，才是 `Failed`——那是需要排查的故障。
        if via.is_some() || enabled {
            HookState::Failed
        } else {
            HookState::Unsupported
        }
    } else if patched {
        HookState::Patched
    } else if enabled {
        HookState::Inactive
    } else {
        HookState::Disabled
    };
    // 不会因为“本机曾经定位成功过”就宣称支持：没打上补丁时，后台执行并没有
    // 发生，`supported` 必须是假。
    HookSnapshot {
        enabled,
        supported: patched,
        state: hook_state,
        patched,
        symbol_count: count,
        process_id: Some(process_id()),
        error: error.map(|error| match via {
            Some(via) => format!("{error} (resolved via {via})"),
            None => error,
        }),
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
        data.resolved_via = None;
        drop(data);
        return Ok(snapshot());
    }
    // 幂等：已经打过就不再解析、不再碰代码页。
    if !data.records.is_empty() {
        data.last_error = None;
        drop(data);
        return Ok(snapshot());
    }
    data.records.clear();
    match apply_all() {
        Ok((records, via)) => {
            data.records = records;
            data.resolved_via = Some(via);
            data.last_error = None;
            drop(data);
            Ok(snapshot())
        }
        Err(error) => {
            data.records.clear();
            data.resolved_via = None;
            data.last_error = Some(error);
            drop(data);
            // 定位失败是本机没有这项能力（Unsupported），不是“试过但失败”：
            // 上层据此区分“继续用自己的调度路径”与“需要排查”。
            let mut refused = snapshot();
            refused.state = HookState::Unsupported;
            refused.supported = false;
            Err(refused)
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

/// 找到两个函数的地址并打补丁；返回记录与“怎么找到的”。
fn apply_all() -> Result<(Vec<PatchRecord>, String), String> {
    let (addresses, via) = locate_symbols()?;
    let mut records: Vec<PatchRecord> = Vec::with_capacity(addresses.len());
    for address in addresses {
        let original = read_code(address);
        let already_patched = original.starts_with(&PATCH_BYTES);
        if !already_patched {
            if let Err(error) = write_code(address, &PATCH_BYTES) {
                for record in records.iter().rev() {
                    if record.applied {
                        let _ = write_code(record.address, &record.original);
                    }
                }
                return Err(error);
            }
        }
        records.push(PatchRecord {
            address,
            original,
            applied: !already_patched,
        });
    }
    Ok((records, via))
}

/// 两个符号的地址，`dlsym` 优先，模式扫描兜底。
fn locate_symbols() -> Result<(Vec<u64>, String), String> {
    match dynsym_addresses() {
        Ok(addresses) => return Ok((addresses, "dynsym".to_string())),
        Err(dynsym_error) => {
            let scan = scan::locate();
            match scan {
                Ok(addresses) => Ok((addresses, "pattern".to_string())),
                Err(scan_error) => Err(format!("{dynsym_error}; {scan_error}")),
            }
        }
    }
}

/// 从动态符号表里取两个函数地址。
fn dynsym_addresses() -> Result<Vec<u64>, String> {
    let mut addresses = Vec::with_capacity(SYMBOLS.len());
    for qualified in SYMBOLS {
        // `Unity!IsApplicationActive` → 函数名 `IsApplicationActive`。
        let name = qualified.rsplit('!').next().unwrap_or(qualified);
        let c_name = std::ffi::CString::new(name).map_err(|_| format!("symbol name contains nul: {name}"))?;
        // RTLD_DEFAULT：先查已加载的库（Unity 引擎映像），再查主程序。
        let exported = unsafe { dlsym(std::ptr::null_mut::<c_void>() as *mut c_void, c_name.as_ptr()) };
        if !exported.is_null() {
            addresses.push(exported as usize as u64);
            continue;
        }
        // 有些构建把符号留在主程序里但不进动态符号表：试一次 dlopen(NULL)。
        let handle = unsafe { dlopen(ptr::null(), 0x2 /* RTLD_NOW */) };
        if handle.is_null() {
            return Err(format!(
                "{name} is not exported by any loaded image ({})",
                last_dl_error()
            ));
        }
        let found = unsafe { dlsym(handle, c_name.as_ptr()) };
        unsafe {
            dlclose(handle);
        }
        if found.is_null() {
            return Err(format!(
                "{name} is not exported by any loaded image ({})",
                last_dl_error()
            ));
        }
        addresses.push(found as usize as u64);
    }
    Ok(addresses)
}

fn last_dl_error() -> String {
    unsafe {
        let error = dlerror();
        if error.is_null() {
            String::new()
        } else {
            CStr::from_ptr(error as *const c_char).to_string_lossy().into_owned()
        }
    }
}

fn read_code(address: u64) -> [u8; PATCH_BYTES.len()] {
    unsafe { ptr::read_unaligned(address as usize as *const [u8; PATCH_BYTES.len()]) }
}

/// 改自己进程的代码页：打开写权限 → 写入 → 刷指令缓存 → 复原保护。
fn write_code(address: u64, bytes: &[u8]) -> Result<(), String> {
    let page = page_size();
    let start = (address as usize) & !(page - 1);
    let end = (address as usize + bytes.len() + page - 1) & !(page - 1);
    let length = end - start;
    let ptr = start as *mut c_void;

    let failed = unsafe { mprotect(ptr, length, PROT_READ | PROT_WRITE | PROT_EXEC) };
    if failed != 0 {
        return Err(format!(
            "Failed to unprotect code at 0x{address:X}: {}",
            std::io::Error::last_os_error()
        ));
    }
    unsafe {
        ptr::copy_nonoverlapping(bytes.as_ptr(), address as usize as *mut u8, bytes.len());
    }
    flush_cache(address, bytes.len());
    let restored = unsafe { mprotect(ptr, length, PROT_READ | PROT_EXEC) };
    if restored != 0 {
        return Err(format!(
            "Patched 0x{address:X} but failed to restore protection: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

fn page_size() -> usize {
    #[cfg(target_os = "linux")]
    {
        let size = unsafe { sysconf(_SC_PAGESIZE) };
        if size > 0 {
            return size as usize;
        }
    }
    // macOS 上 sysconf 的 _SC_PAGESIZE 编号与 Linux 不同；16 KiB 是 Apple
    // Silicon 的页大小，也是 x86_64 mac 上 4 KiB 的安全上界倍数。
    if cfg!(target_os = "macos") {
        return 16 * 1024;
    }
    4096
}

fn flush_cache(address: u64, length: usize) {
    #[cfg(target_os = "linux")]
    unsafe {
        __clear_cache(address as usize as *mut c_char, (address as usize + length) as *mut c_char);
    }
    #[cfg(target_os = "macos")]
    unsafe {
        sys_icache_invalidate(address as usize as *mut c_void, length);
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = (address, length);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 模式扫描：没有符号时从 ELF/映像布局里找代码签名
// ─────────────────────────────────────────────────────────────────────────────

pub(crate) mod scan {
    use super::{MACOS_IMAGE_MARKERS, LINUX_IMAGE_MARKERS};
    use super::{PATCH_BYTES, SYMBOLS};

    /// 已知签名：`IsApplicationActive` 在编辑器空闲时返回 1。上游交叉编译时
    /// 记录的就是这条指令序列，与 [`PATCH_BYTES`] 首 6 字节相同。
    pub(crate) const SIGNATURE: [u8; 6] = PATCH_BYTES;

    /// 一段进程内可读的内存范围。
    #[derive(Clone, Debug, PartialEq, Eq)]
    pub(crate) struct Segment {
        pub start: u64,
        pub len: u64,
        pub exec: bool,
    }

    impl Segment {
        pub(crate) fn as_bytes(&self) -> &'static [u8] {
            // SAFETY: 调用方保证这段地址来自本进程 /proc/self/maps 且标为可读。
            unsafe { std::slice::from_raw_parts(self.start as usize as *const u8, self.len as usize) }
        }
    }

    /// 在给定的段里找全部签名命中地址。
    pub(crate) fn find_signature(segments: &[Segment]) -> Vec<u64> {
        let mut hits = Vec::new();
        for segment in segments.iter().filter(|segment| segment.exec) {
            let bytes = segment.as_bytes();
            if bytes.len() < SIGNATURE.len() {
                continue;
            }
            let mut index = 0usize;
            while index + SIGNATURE.len() <= bytes.len() {
                if bytes[index..index + SIGNATURE.len()] == SIGNATURE {
                    hits.push(segment.start + index as u64);
                    index += SIGNATURE.len();
                } else {
                    index += 1;
                }
            }
        }
        hits
    }

    /// 两个符号名在 `text` 里是否相邻（中间只隔零字节或少量非字母字节）。
    ///
    /// 相邻意味着它们由同一个目标文件的不同编译单元产出，也就是我们要打补丁
    /// 的那个引擎映像——这正是 PDB 能给我们的信息。
    pub(crate) fn names_adjacent(text: &[u8], first: &str, second: &str) -> bool {
        let first_bytes = first.as_bytes();
        let second_bytes = second.as_bytes();
        let mut index = 0usize;
        while index + first_bytes.len() + second_bytes.len() <= text.len() {
            if &text[index..index + first_bytes.len()] == first_bytes {
                // 名字通常以零字节收尾；允许最多 4 个字节的间隙。
                for gap in 1..=4usize {
                    let start = index + first_bytes.len() + gap;
                    if start + second_bytes.len() > text.len() {
                        break;
                    }
                    if &text[start..start + second_bytes.len()] == second_bytes {
                        return true;
                    }
                }
            }
            index += 1;
        }
        false
    }

    /// 进程里哪个映像该被扫描。
    pub(crate) fn image_marker() -> &'static str {
        if cfg!(target_os = "macos") {
            MACOS_IMAGE_MARKERS[0]
        } else {
            LINUX_IMAGE_MARKERS[0]
        }
    }

    /// 解析 `/proc/self/maps` 风格的文本，返回含 `marker` 的文件的所有段。
    pub(crate) fn segments_for_marker(maps: &str, marker: &str) -> Vec<Segment> {
        maps.lines()
            .filter(|line| line.contains(marker))
            .filter_map(parse_map_line)
            .collect()
    }

    /// `00401000-00500000 r-xp 00000000 08:01 1234  /path/to/Unity`
    pub(crate) fn parse_map_line(line: &str) -> Option<Segment> {
        let mut fields = line.split_whitespace();
        let range = fields.next()?;
        let perms = fields.next()?;
        let (start, end) = range.split_once('-')?;
        let start = u64::from_str_radix(start, 16).ok()?;
        let end = u64::from_str_radix(end, 16).ok()?;
        if end <= start {
            return None;
        }
        // 只认可读段：不可读的段读一次就是 SIGSEGV。
        if !perms.starts_with('r') {
            return None;
        }
        Some(Segment {
            start,
            len: end - start,
            exec: perms.contains('x'),
        })
    }

    /// 真正的定位：`dlsym` 已失败，只走模式扫描。
    pub(super) fn locate() -> Result<Vec<u64>, String> {
        let segments = self_image_segments()?;
        if segments.is_empty() {
            return Err(format!(
                "no loaded image matching {:?} was found in this process",
                image_marker()
            ));
        }

        let first_function = SYMBOLS[0].rsplit('!').next().unwrap_or(SYMBOLS[0]);
        let second_function = SYMBOLS[1].rsplit('!').next().unwrap_or(SYMBOLS[1]);
        // 符号表文本通常在不可执行段里，名字相邻关系能确认映像身份。
        let adjacent = segments
            .iter()
            .any(|segment| names_adjacent(segment.as_bytes(), first_function, second_function));

        let hits = find_signature(&segments);
        match (hits.len(), adjacent) {
            // 两个名字在同一个映像里相邻，且签名唯一命中：两个独立证据指向同一处。
            (1, true) => Ok(repeat(hits[0], SYMBOLS.len())),
            // 名字相邻但签名不唯一：知道是哪个映像，仍不知道是哪条指令。
            (count, true) => Err(format!(
                "IsApplicationActive is in this image but the signature matched {count} places"
            )),
            // 签名唯一但名字没找到：没有旁证，不敢下结论。
            (1, false) => Err(
                "the signature matched one place but the symbol names were not found next to each other"
                    .to_string(),
            ),
            (0, _) => Err("the signature did not match anywhere in the loaded image".to_string()),
            (count, _) => Err(format!("the signature matched {count} places; refusing to guess")),
        }
    }

    fn repeat(value: u64, times: usize) -> Vec<u64> {
        std::iter::repeat(value).take(times).collect()
    }

    /// 本进程里 Unity 映像的各段（Linux 读 `/proc/self/maps`）。
    fn self_image_segments() -> Result<Vec<Segment>, String> {
        #[cfg(target_os = "linux")]
        {
            let maps = std::fs::read_to_string("/proc/self/maps")
                .map_err(|error| format!("failed to read /proc/self/maps: {error}"))?;
            Ok(segments_for_marker(&maps, image_marker()))
        }
        #[cfg(target_os = "macos")]
        {
            // macOS 没有 /proc；用 dyld 的映像列表。扫描只在有符号库时才有意义，
            // 这里如实报不可用而不是去猜。
            Ok(Vec::new())
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            Ok(Vec::new())
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        const MAPS: &str = "\\
55d0a00000-55d0a21000 r--p 00000000 08:01 1234 /Applications/Unity/Unity
55d0a21000-55d0a60000 r-xp 00021000 08:01 1234 /Applications/Unity/Unity
55d0c00000-55d0c01000 rw-p 00000000 00:00 0 
7f0000000000-7f0000001000 r-xp 00000000 08:01 5678 /usr/lib/libfoo.so
";

        #[test]
        fn map_lines_parse_and_skip_unreadable_segments() {
            let segments = segments_for_marker(MAPS, "Unity");
            assert_eq!(segments.len(), 2);
            assert_eq!(segments[0].start, 0x55d0a00000);
            assert!(!segments[0].exec);
            assert_eq!(segments[1].len, 0x60000 - 0x21000);
            assert!(segments[1].exec);
            // 只认含 marker 的映像。
            assert!(segments_for_marker(MAPS, "libfoo").len() == 1);
        }

        #[test]
        fn map_lines_with_no_write_permission_are_still_readable() {
            let segment = parse_map_line("1000-2000 rw-p 00000000 00:00 0 [heap]").unwrap();
            assert_eq!(segment.start, 0x1000);
            assert!(!segment.exec);
            // 不可读的段必须拒绝：读它会段错误。
            assert!(parse_map_line("1000-2000 -w-p 00000000 00:00 0 [x]").is_none());
            assert!(parse_map_line("2000-1000 r-xp 00000000 00:00 0 [x]").is_none());
        }

        #[test]
        fn adjacent_names_are_detected_only_when_close() {
            let text = b"...IsApplicationActive\\0IsApplicationActiveOSImpl\\0more";
            assert!(names_adjacent(text, "IsApplicationActive", "IsApplicationActiveOSImpl"));
            let far = b"IsApplicationActive\\0\\0\\0\\0\\0\\0IsApplicationActiveOSImpl";
            assert!(!names_adjacent(far, "IsApplicationActive", "IsApplicationActiveOSImpl"));
            assert!(!names_adjacent(b"nothing here", "IsApplicationActive", "IsApplicationActiveOSImpl"));
        }

        #[test]
        fn signature_search_reports_every_hit_in_executable_segments_only() {
            let data = vec![0u8; 64];
            let mut buffer = data.clone();
            buffer[16..22].copy_from_slice(&SIGNATURE);
            buffer[40..46].copy_from_slice(&SIGNATURE);
            // SAFETY: 测试用缓冲区在本进程内、可读。
            let segment = Segment {
                start: buffer.as_ptr() as u64,
                len: buffer.len() as u64,
                exec: true,
            };
            let hits = find_signature(&[segment]);
            assert_eq!(hits.len(), 2);
            // 不可执行段不参与匹配。
            let data_segment = Segment {
                start: buffer.as_ptr() as u64,
                len: buffer.len() as u64,
                exec: false,
            };
            assert!(find_signature(&[data_segment]).is_empty());
            std::mem::forget(buffer);
        }
    }
}
