//! Mono frame naming for main-thread stack capture (Unix form).
//!
//! On Windows the broker resolves `mono_*` exports out of the loaded
//! `mono-2.0-bdwgc.dll` with `GetModuleHandleW` + `GetProcAddress`. On Linux the
//! Unity Editor maps Mono from `MonoBleedingEdge/MonoEmbedRuntime/libmonobdwgc-2.0.so`
//! into its own process, so the same entry points are reachable with
//! `dlsym(RTLD_DEFAULT)` — assuming the editor's loader exported them into the
//! global scope. When it did not, this module reports "unavailable" honestly;
//! the broker then answers stack requests with `main_thread_stack_failed`
//! instead of guessing frames.
//!
//! 从 IP 到托管帧的换算入口在 [`crate::hang`]；本模块只负责把 Mono 入口点解析
//! 出来，并把一段 native 栈上的返回地址翻译成 `ManagedFrame`。
//!
//! The JIT lookup path is the upstream one (`mono_jit_info_table_find` →
//! `mono_jit_info_get_method` → `mono_method_full_name`), so a frame named here
//! reads exactly like the Windows broker's. Source file/line needs the optional
//! `mono_debug_*` exports; Unity's Mono build ships them on some versions only,
//! and when they are absent frames simply carry no file/line instead of a
//! guessed one.

#![allow(dead_code)]

use std::ffi::{c_char, c_void, CStr, CString};
use std::sync::OnceLock;

type DomainFunc = extern "C" fn(*mut c_void, *mut c_void);

/// Mono 的调试位置结构（`mono/metadata/debug-mono-symfile.h`）。
#[repr(C)]
pub(crate) struct MonoDebugSourceLocation {
    pub(crate) source_file: *mut c_char,
    pub(crate) row: u32,
    pub(crate) column: u32,
    pub(crate) il_offset: u32,
}

#[derive(Clone, Copy)]
pub(crate) struct MonoApi {
    pub(crate) get_root_domain: unsafe extern "C" fn() -> *mut c_void,
    pub(crate) thread_attach: unsafe extern "C" fn(*mut c_void) -> *mut c_void,
    pub(crate) thread_detach: unsafe extern "C" fn(*mut c_void),
    pub(crate) domain_foreach: unsafe extern "C" fn(DomainFunc, *mut c_void),
    pub(crate) jit_info_table_find: unsafe extern "C" fn(*mut c_void, *mut c_void) -> *mut c_void,
    pub(crate) jit_info_get_method: unsafe extern "C" fn(*mut c_void) -> *mut c_void,
    pub(crate) jit_info_get_code_start: unsafe extern "C" fn(*mut c_void) -> *mut c_void,
    pub(crate) method_full_name: unsafe extern "C" fn(*mut c_void, i32) -> *mut c_char,
    pub(crate) method_get_class: unsafe extern "C" fn(*mut c_void) -> *mut c_void,
    pub(crate) class_get_image: unsafe extern "C" fn(*mut c_void) -> *mut c_void,
    pub(crate) image_get_name: unsafe extern "C" fn(*mut c_void) -> *const c_char,
    pub(crate) mono_free: unsafe extern "C" fn(*mut c_void),
    /// 可选：有它才能给出源文件与行号。
    pub(crate) debug_lookup_source_location:
        Option<unsafe extern "C" fn(*mut c_void, u32, *mut c_void) -> *mut MonoDebugSourceLocation>,
    pub(crate) debug_free_source_location: Option<unsafe extern "C" fn(*mut MonoDebugSourceLocation)>,
}

/// 一帧翻译结果，与上游 `ManagedFrame` 同形。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ManagedFrame {
    pub(crate) method: String,
    pub(crate) assembly: String,
    pub(crate) file: Option<String>,
    pub(crate) line: Option<u32>,
    pub(crate) managed_offset: u32,
}

static API: OnceLock<Option<MonoApi>> = OnceLock::new();

/// Resolve the Mono entry points now (on the host thread, like the Windows
/// `locus_init`), so a later capture during a hang never takes the loader lock.
pub(crate) fn resolve_now() -> Option<&'static MonoApi> {
    API.get_or_init(load).as_ref()
}

pub(crate) fn api() -> Option<&'static MonoApi> {
    API.get().and_then(|api| api.as_ref())
}

fn symbol(name: &str) -> Option<*mut c_void> {
    let cname = CString::new(name).ok()?;
    // SAFETY: RTLD_DEFAULT searches the process's global symbol scope, where
    // the editor's own Mono image was loaded; the symbol is only used through
    // the exact Mono C signature below.
    let address = unsafe { libc::dlsym(libc::RTLD_DEFAULT, cname.as_ptr()) };
    (!address.is_null()).then_some(address)
}

fn load() -> Option<MonoApi> {
    if symbol("mono_get_root_domain").is_none() {
        eprintln!("[locus-native] Mono entry points are not in the global symbol scope; managed frame naming is unavailable");
        return None;
    }
    macro_rules! required {
        ($name:literal) => {
            unsafe { std::mem::transmute(symbol($name)?) }
        };
    }
    /// 可选入口：缺了只是少点信息，不致命。
    macro_rules! optional {
        ($name:literal) => {
            symbol($name).map(|pointer| unsafe { std::mem::transmute(pointer) })
        };
    }
    Some(MonoApi {
        get_root_domain: required!("mono_get_root_domain"),
        thread_attach: required!("mono_thread_attach"),
        thread_detach: required!("mono_thread_detach"),
        domain_foreach: required!("mono_domain_foreach"),
        jit_info_table_find: required!("mono_jit_info_table_find"),
        jit_info_get_method: required!("mono_jit_info_get_method"),
        jit_info_get_code_start: required!("mono_jit_info_get_code_start"),
        method_full_name: required!("mono_method_full_name"),
        method_get_class: required!("mono_method_get_class"),
        class_get_image: required!("mono_class_get_image"),
        image_get_name: required!("mono_image_get_name"),
        mono_free: required!("mono_free"),
        debug_lookup_source_location: optional!("mono_debug_lookup_source_location"),
        debug_free_source_location: optional!("mono_debug_free_source_location"),
    })
}

extern "C" fn collect_domain(domain: *mut c_void, user_data: *mut c_void) {
    // SAFETY: `user_data` is the `&mut Vec<*mut c_void>` built in `frames_for`.
    let domains = unsafe { &mut *(user_data as *mut Vec<*mut c_void>) };
    domains.push(domain);
}

/// 把一串返回地址（每个是 `(ip, lookup_ip)`）翻译成托管帧。
///
/// `lookup_ip` 是 `ip - 1`：返回地址指向 `call` 之后那条指令，减一才落在
/// `call` 里面，否则会命中下一个方法。整个查找期间不分配、不阻塞主线程。
///
/// 返回 `Err` 表示 Mono 根本不可用（调用方据此报 `main_thread_stack_failed`）。
pub(crate) fn name_with_mono(lookups: &[(u64, u64)]) -> Result<Vec<ManagedFrame>, String> {
    let api = api().ok_or_else(|| {
        "Mono entry points are not in the global symbol scope; managed frames cannot be named"
            .to_string()
    })?;

    // 先切到托管线程上下文：非托管线程直接调用 JIT 表查找会崩。
    // SAFETY: get_root_domain returns the process-global root domain; attach is
    // idempotent for an already-attached thread.
    let thread = unsafe {
        let root = (api.get_root_domain)();
        (api.thread_attach)(root)
    };

    let mut domains: Vec<*mut c_void> = Vec::new();
    // SAFETY: domain_foreach visits each domain once, passing our Vec through;
    // the callback only pushes.
    unsafe { (api.domain_foreach)(collect_domain, &mut domains as *mut _ as *mut c_void) };

    // 先试子 domain，再试根 domain：热重载后的方法通常驻留在子 domain 的
    // JIT 表里，顺序反了会漏帧。
    let root = unsafe { (api.get_root_domain)() } as usize;
    domains.sort_by_key(|domain| *domain as usize == root);

    let mut frames = Vec::new();
    for &(ip, lookup) in lookups {
        for &domain in &domains {
            // SAFETY: all pointers are Mono-owned handles; the signatures mirror
            // mono/metadata/jit-info.h and mono/metadata/reflection.h.
            let frame = unsafe {
                let jit_info = (api.jit_info_table_find)(domain, lookup as usize as *mut c_void);
                if jit_info.is_null() {
                    continue;
                }
                let method = (api.jit_info_get_method)(jit_info);
                if method.is_null() {
                    continue;
                }
                let code_start = (api.jit_info_get_code_start)(jit_info) as usize as u64;
                let managed_offset = ip.saturating_sub(code_start) as u32;
                let name = (api.method_full_name)(method, 1);
                if name.is_null() {
                    continue;
                }
                let method_name = CStr::from_ptr(name).to_string_lossy().into_owned();
                (api.mono_free)(name as *mut c_void);

                let class = (api.method_get_class)(method);
                let assembly = if class.is_null() {
                    String::new()
                } else {
                    let image = (api.class_get_image)(class);
                    if image.is_null() {
                        String::new()
                    } else {
                        let image_name = (api.image_get_name)(image);
                        if image_name.is_null() {
                            String::new()
                        } else {
                            CStr::from_ptr(image_name).to_string_lossy().into_owned()
                        }
                    }
                };

                let mut file = None;
                let mut line = None;
                if let (Some(lookup_location), Some(free_location)) = (
                    api.debug_lookup_source_location,
                    api.debug_free_source_location,
                ) {
                    let location = lookup_location(method, managed_offset, domain);
                    if !location.is_null() {
                        let file_name = CStr::from_ptr((*location).source_file);
                        file = Some(file_name.to_string_lossy().into_owned());
                        line = Some((*location).row);
                        free_location(location);
                    }
                }

                ManagedFrame {
                    method: method_name,
                    assembly,
                    file,
                    line,
                    managed_offset,
                }
            };
            frames.push(frame);
            break;
        }
    }

    // SAFETY: symmetric with the attach above; a no-op when the thread was
    // already attached before this call.
    if !thread.is_null() {
        unsafe { (api.thread_detach)(thread) };
    }
    Ok(frames)
}
