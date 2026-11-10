//! `locus_unity_native` — POSIX port of the in-process Unity Editor broker.
//!
//! The Windows DLL serves a named pipe from inside the Unity Editor; this crate
//! serves the same protocol on a **Unix domain socket** (`<runtime dir>/locus/
//! locus_unity_native_<project key>.sock`) and keeps the exact C ABI in
//! `locus_unity_native/exports.txt`, so the C# plugin binds the same names on
//! every platform.
//!
//! What carries over unchanged: the newline-JSON envelope, `reply_to` routing,
//! request queue and limits, managed lifecycle, main-thread heartbeat,
//! execution progress/cancel registers, the compile-result register and the
//! status document (state plane layout included).
//!
//! What differs: the transport is a socket file instead of a pipe, the state
//! plane is a `shm` file instead of a named mapping, the in-process background
//! hook and WebView2/GPU output have no Linux counterpart (the overlay client
//! is a socket client in `overlay.rs`, but the desktop app only speaks Win32
//! pipes for it), and `main_thread_stack` has no unwinder yet.
//!
//! Non-Windows-only exports (WebView2, GPU render transport, the background
//! hook) return the platform's documented "unavailable" values so a
//! `DllImport` never fails with `EntryPointNotFoundException`.

use std::ffi::c_void;
use std::os::raw::c_int;

pub mod api;
pub mod broker;
mod heartbeat;
pub mod host_config;
mod mono_names;
mod names_unix;
mod outbox;
mod server;
mod state_plane;

use broker::HostConfig;
use host_config::{errors, host_kind, ExecutionCommands, UNITY_EXECUTION};

/// Unity request types that run snippets through the managed executor.
const UNITY_EXECUTION_COMMANDS: ExecutionCommands = UNITY_EXECUTION;

const UNITY_EXTRA_CAPABILITIES: &[&str] = &["broker_compile_result_v1"];

// ─────────────────────────────────────────────────────────────────────────────
// Raw pointer helpers (same contract as the Windows `ffi` module).
// ─────────────────────────────────────────────────────────────────────────────

/// # Safety
/// `pointer` must be valid for `length` bytes or null.
unsafe fn slice_from_raw<'a>(pointer: *const u8, length: i32) -> &'a [u8] {
    if pointer.is_null() || length <= 0 {
        &[]
    } else {
        std::slice::from_raw_parts(pointer, length as usize)
    }
}

/// # Safety
/// See [`slice_from_raw`]. Decodes loss-tolerantly; the broker never trusts the
/// bytes to be valid UTF-8.
unsafe fn string_from_raw(pointer: *const u8, length: i32) -> String {
    String::from_utf8_lossy(slice_from_raw(pointer, length)).into_owned()
}

fn unity_host_config(project: String, endpoint: String, protocol_version: i32) -> Option<HostConfig> {
    let endpoint = endpoint.trim().to_string();
    if endpoint.is_empty() {
        return None;
    }
    // The endpoint is either an absolute socket path (written by the C# plugin)
    // or the Windows-shaped pipe name some callers still pass; both resolve to
    // the same per-project socket under the runtime directory.
    let socket_path = if endpoint.starts_with('/') {
        endpoint.clone()
    } else {
        names_unix::unity_socket_path(&project).to_string_lossy().into_owned()
    };
    Some(HostConfig {
        host_kind: host_kind::UNITY,
        instance_key: locus_native_protocol::names::project_key(&project),
        project: project.clone(),
        socket_path,
        pipe_name: endpoint,
        state_plane_path: names_unix::resolve_state_plane_path(&locus_native_protocol::names::unity_state_plane_name(&project)),
        protocol_version,
        quitting_error: errors::UNITY_PROCESS_EXITING,
        default_status: "editing",
        extra_capabilities: UNITY_EXTRA_CAPABILITIES,
        execution: UNITY_EXECUTION_COMMANDS,
        request_hook: Some(compile_result::answer),
        on_shutdown: None,
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// Compile-result register
// ─────────────────────────────────────────────────────────────────────────────

mod compile_result {
    use std::sync::Mutex;

    use crate::broker::HostRequest;

    pub(crate) const NO_ACTIVE_RECOMPILE_ERROR: &str = "Unity 没有开始编译。未找到活动重编译请求。";

    static REGISTER: Mutex<Option<(String, String)>> = Mutex::new(None);

    pub(crate) fn set(operation_id: String, result: String) {
        if let Ok(mut guard) = REGISTER.lock() {
            *guard = Some((operation_id.trim().to_string(), result));
        }
    }

    /// Answer `get_compile_result` exactly like the managed handler, without the
    /// editor main thread. Terminal results stay readable (last-value register).
    pub(crate) fn answer(request: &HostRequest<'_>) -> Option<Result<Option<String>, String>> {
        if request.kind != "get_compile_result" {
            return None;
        }
        let (active_operation_id, result) = REGISTER.lock().ok()?.clone()?;
        let requested = request.message.trim();
        if !requested.is_empty() && requested != active_operation_id {
            return Some(Err("recompile_result_operation_mismatch".to_string()));
        }
        Some(match result.as_str() {
            "" => Err(NO_ACTIVE_RECOMPILE_ERROR.to_string()),
            "awaiting_reload" => Ok(Some("pending".to_string())),
            error if error.starts_with("error:") => Err(error["error:".len()..].to_string()),
            _ => Ok(Some(result.clone())),
        })
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Common C ABI (the sixteen original entry points).
// ─────────────────────────────────────────────────────────────────────────────

/// Initialize the broker and start the socket server. Idempotent: a second call
/// (e.g. after a reload) keeps the live socket. Returns 0 on success.
///
/// # Safety
/// `project`/`endpoint` must each be valid for their stated lengths or null.
#[no_mangle]
pub unsafe extern "C" fn locus_init(
    project: *const u8,
    project_len: i32,
    endpoint: *const u8,
    endpoint_len: i32,
    protocol_version: c_int,
) -> c_int {
    let project = string_from_raw(project, project_len);
    let endpoint = string_from_raw(endpoint, endpoint_len);
    if endpoint.trim().is_empty() {
        return -1;
    }
    match unity_host_config(project, endpoint, protocol_version) {
        Some(config) => api::init(config),
        None => -1,
    }
}

/// Stop the socket server. Not called on a managed reload (the broker must
/// persist) — only when the host quits or unloads the library.
#[no_mangle]
pub extern "C" fn locus_shutdown() {
    api::shutdown();
}

/// Register the managed lifecycle state, generation and cached status string.
///
/// # Safety
/// `editor_status` must be valid for `editor_status_len` bytes or null.
#[no_mangle]
pub unsafe extern "C" fn locus_set_managed_state(
    state: c_int,
    generation: i64,
    editor_status: *const u8,
    editor_status_len: i32,
) {
    let status = if editor_status.is_null() {
        None
    } else {
        Some(string_from_raw(editor_status, editor_status_len))
    };
    api::set_managed_state(state, generation, status);
}

/// Pulse the main-thread heartbeat (one atomic increment).
#[no_mangle]
pub extern "C" fn locus_managed_heartbeat(generation: i64) {
    api::managed_heartbeat(generation);
}

/// Execution lifetime is independent of the request's response/timeout.
#[no_mangle]
pub extern "C" fn locus_managed_execution(active: c_int) {
    api::managed_execution(active != 0);
}

/// Register the managed executor's capability string.
///
/// # Safety
/// `caps` must be valid for `caps_len` bytes or null.
#[no_mangle]
pub unsafe extern "C" fn locus_set_capabilities(caps: *const u8, caps_len: i32) {
    api::set_capabilities(string_from_raw(caps, caps_len));
}

/// Dequeue the next request line: byte length, `0` when empty, `-1` when the
/// buffer is too small.
///
/// # Safety
/// `buffer` must be valid for `buffer_len` bytes (or null when `buffer_len` is
/// 0); `out_required_len` must be valid or null.
#[no_mangle]
pub unsafe extern "C" fn locus_poll_request(
    buffer: *mut u8,
    buffer_len: i32,
    out_required_len: *mut i32,
) -> c_int {
    api::poll_request(buffer, buffer_len, out_required_len)
}

/// Hand a completed managed response (a full envelope JSON line) back to the
/// broker, which routes it to the requesting client.
///
/// # Safety
/// `id`/`response` must each be valid for their stated lengths or null.
#[no_mangle]
pub unsafe extern "C" fn locus_complete_request(
    id: *const u8,
    id_len: i32,
    response: *const u8,
    response_len: i32,
) {
    let id = string_from_raw(id, id_len);
    let response = slice_from_raw(response, response_len).to_vec();
    api::complete_request(&id, response);
}

/// Emit an unsolicited event (no `reply_to`) to every connected client.
///
/// # Safety
/// `event_type`/`payload` must each be valid for their stated lengths or null.
#[no_mangle]
pub unsafe extern "C" fn locus_emit_event(
    event_type: *const u8,
    type_len: i32,
    payload: *const u8,
    payload_len: i32,
) {
    let event_type = string_from_raw(event_type, type_len);
    if event_type.is_empty() {
        return;
    }
    api::emit_event(&event_type, string_from_raw(payload, payload_len));
}

/// 1 when at least one Locus client is connected.
#[no_mangle]
pub extern "C" fn locus_has_connected_client() -> c_int {
    c_int::from(api::connected())
}

/// Monotonic count of cancel signals.
#[no_mangle]
pub extern "C" fn locus_execution_cancel_seq() -> u64 {
    api::execution_cancel_seq()
}

/// 1 when a cancel newer than `since_seq` targets `execution_id` (or every one).
///
/// # Safety
/// `execution_id` must be valid for `execution_id_len` bytes or null.
#[no_mangle]
pub unsafe extern "C" fn locus_execution_cancel_requested(
    execution_id: *const u8,
    execution_id_len: i32,
    since_seq: u64,
) -> c_int {
    let execution_id = string_from_raw(execution_id, execution_id_len);
    c_int::from(api::execution_cancel_requested(&execution_id, since_seq))
}

/// Milliseconds since the host loop last pulsed, or -1 when unknown.
#[no_mangle]
pub extern "C" fn locus_main_thread_stall_ms() -> i64 {
    api::main_thread_stall_ms()
}

/// Publish the latest progress snapshot (JSON object) of a running execution.
///
/// # Safety
/// `execution_id`/`json` must each be valid for their stated lengths or null.
#[no_mangle]
pub unsafe extern "C" fn locus_execution_publish(
    execution_id: *const u8,
    execution_id_len: i32,
    json: *const u8,
    json_len: i32,
) {
    api::execution_publish(
        &string_from_raw(execution_id, execution_id_len),
        &string_from_raw(json, json_len),
    );
}

/// Forget an execution's progress snapshot.
///
/// # Safety
/// `execution_id` must be valid for `execution_id_len` bytes or null.
#[no_mangle]
pub unsafe extern "C" fn locus_execution_end(execution_id: *const u8, execution_id_len: i32) {
    api::execution_end(&string_from_raw(execution_id, execution_id_len));
}

/// Milliseconds since a client last polled this execution's progress, or -1.
///
/// # Safety
/// `execution_id` must be valid for `execution_id_len` bytes or null.
#[no_mangle]
pub unsafe extern "C" fn locus_execution_client_poll_age_ms(
    execution_id: *const u8,
    execution_id_len: i32,
) -> i64 {
    api::execution_client_poll_age_ms(&string_from_raw(execution_id, execution_id_len))
}

// ─────────────────────────────────────────────────────────────────────────────
// Unity-only C ABI.
// ─────────────────────────────────────────────────────────────────────────────

/// Publish the managed recompile register (operation id + result string).
///
/// # Safety
/// `operation_id`/`result` must each be valid for their stated lengths or null.
#[no_mangle]
pub unsafe extern "C" fn locus_set_compile_result(
    operation_id: *const u8,
    operation_id_len: i32,
    result: *const u8,
    result_len: i32,
) {
    compile_result::set(
        string_from_raw(operation_id, operation_id_len),
        string_from_raw(result, result_len),
    );
}

/// Apply/restore the in-process background hook. No Unix counterpart: the
/// editor's `IsApplicationActive` is not patched on Linux, so this always
/// reports "unavailable" and the managed side keeps its other scheduling path.
#[no_mangle]
pub extern "C" fn locus_set_background_active(active: c_int) -> c_int {
    let _ = active;
    -1
}

/// Open the persistent overlay client. The desktop overlay control channel is a
/// Win32 pipe; on Unix it reports unavailable and the managed side keeps its own
/// path.
///
/// # Safety
/// `pipe` must be valid for `pipe_len` bytes or null.
#[no_mangle]
pub unsafe extern "C" fn locus_overlay_connect(pipe: *const u8, pipe_len: i32) -> c_int {
    let _ = (pipe, pipe_len);
    -1
}

/// Forward one overlay control line. No-op without an overlay client.
///
/// # Safety
/// `line` must be valid for `line_len` bytes or null.
#[no_mangle]
pub unsafe extern "C" fn locus_overlay_push(line: *const u8, line_len: i32) {
    let _ = (line, line_len);
}

// ─────────────────────────────────────────────────────────────────────────────
// WebView2 (Windows-only). The C# host calls these only when it embeds a
// WebView2 control; the Linux editor uses its own IMGUI panel instead. Every
// entry point answers the documented "unavailable" value so binding succeeds.
// ─────────────────────────────────────────────────────────────────────────────

#[no_mangle]
pub unsafe extern "C" fn locus_webview_start(
    _window: *mut c_void,
    _x: c_int,
    _y: c_int,
    _width: c_int,
    _height: c_int,
    _url: *const u8,
    _url_len: i32,
) -> c_int {
    -1
}

#[no_mangle]
pub unsafe extern "C" fn locus_webview_bind(_id: c_int, _parent: *mut c_void) -> c_int {
    -1
}

#[no_mangle]
pub unsafe extern "C" fn locus_webview_message(_pointer: *const u8, _length: i32) -> c_int {
    -1
}

#[no_mangle]
pub unsafe extern "C" fn locus_webview_rect(
    _id: c_int,
    _x: c_int,
    _y: c_int,
    _width: c_int,
    _height: c_int,
) -> c_int {
    -1
}

#[no_mangle]
pub unsafe extern "C" fn locus_webview_parent(_id: c_int, _parent: isize) -> c_int {
    -1
}

#[no_mangle]
pub unsafe extern "C" fn locus_webview_focus(_id: c_int, _reason: c_int) -> c_int {
    -1
}

#[no_mangle]
pub extern "C" fn locus_webview_suspend(_id: c_int) {}

#[no_mangle]
pub extern "C" fn locus_webview_park(_id: c_int) {}

#[no_mangle]
pub extern "C" fn locus_webview_close(_id: c_int) {}

#[no_mangle]
pub extern "C" fn locus_webview_shutdown() {}

#[no_mangle]
pub unsafe extern "C" fn locus_webview_poll(_pointer: *mut u8, _capacity: i32) -> c_int {
    0
}

#[no_mangle]
pub unsafe extern "C" fn locus_webview_status(_pointer: *mut u8, _capacity: i32) -> c_int {
    0
}

// ─────────────────────────────────────────────────────────────────────────────
// GPU render transport (Windows shared textures). Exports exist so the plugin
// binds; every call reports the transport as unavailable.
// ─────────────────────────────────────────────────────────────────────────────

#[no_mangle]
pub extern "C" fn locus_render_version() -> c_int {
    0
}

#[no_mangle]
pub unsafe extern "C" fn locus_render_create(_id: *const u8, _length: i32) -> u64 {
    0
}

#[no_mangle]
pub unsafe extern "C" fn locus_render_bind(_handle: u64, _texture: *mut c_void) -> c_int {
    -1
}

#[no_mangle]
pub extern "C" fn locus_render_enqueue(_handle: u64) -> i64 {
    -1
}

#[no_mangle]
pub extern "C" fn locus_render_cancel(_token: usize) {}

#[no_mangle]
pub extern "C" fn locus_render_callback() -> *mut c_void {
    std::ptr::null_mut()
}

#[no_mangle]
pub extern "C" fn locus_render_close(_handle: u64) {}

#[no_mangle]
pub unsafe extern "C" fn locus_render_input(_handle: u64, _event: *mut c_void) -> c_int {
    -1
}

#[no_mangle]
pub unsafe extern "C" fn locus_render_state(_handle: u64, _state: *mut c_void) -> c_int {
    -1
}

#[no_mangle]
pub extern "C" fn locus_render_wait(_handle: u64, _milliseconds: u32) -> c_int {
    -1
}

#[no_mangle]
pub extern "C" fn locus_render_ack_input(_handle: u64, _sequence: u64, _timestamp: u64) -> c_int {
    -1
}

#[no_mangle]
pub unsafe extern "C" fn locus_render_error(buffer: *mut u8, capacity: i32) -> c_int {
    const MESSAGE: &[u8] = b"GPU output is unavailable in the Locus Linux broker";
    if buffer.is_null() || capacity <= 0 {
        return 0;
    }
    let length = MESSAGE.len().min(capacity as usize);
    std::ptr::copy_nonoverlapping(MESSAGE.as_ptr(), buffer, length);
    length as c_int
}
