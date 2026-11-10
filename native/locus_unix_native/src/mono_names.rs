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
//! Stack capture itself is not implemented on Unix yet, so this module only
//! resolves the runtime and stays inert until a capture exists.

#![allow(dead_code)]

use std::ffi::{c_char, c_void, CString};
use std::sync::OnceLock;

type DomainFunc = extern "C" fn(*mut c_void, *mut c_void);

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
    })
}
