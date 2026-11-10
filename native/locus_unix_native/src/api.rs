//! Process-global broker and the operations behind the C ABI.
//!
//! Mirrors `crates/locus-native-broker/src/api.rs` for Unix hosts. A single
//! `tokio` runtime runs on its own thread; the FFI functions never block the
//! host main thread except for `locus_wait_request`, which is the documented
//! blocking wait of the block-mode hosts.

use std::sync::atomic::{AtomicPtr, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use crate::broker::Broker;

static CURRENT: AtomicPtr<Broker> = AtomicPtr::new(std::ptr::null_mut());
static RUNTIME: OnceLock<tokio::runtime::Runtime> = OnceLock::new();

pub(crate) fn current() -> Option<&'static Broker> {
    let pointer = CURRENT.load(Ordering::Acquire);
    // SAFETY: published pointers come from `Arc::into_raw` and are never freed,
    // so they stay valid for the process lifetime.
    (!pointer.is_null()).then(|| unsafe { &*pointer })
}

fn runtime() -> Option<&'static tokio::runtime::Runtime> {
    Some(RUNTIME.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("locus-native")
            .build()
            .expect("locus-native runtime")
    }))
}

pub fn init(config: crate::broker::HostConfig) -> i32 {
    if let Some(existing) = current() {
        if !existing.shutdown.load(Ordering::SeqCst) {
            // Already running (e.g. re-called after a domain reload): keep the
            // live socket and queue, the managed side re-registers.
            return 0;
        }
    }
    if config.socket_path.trim().is_empty() {
        return -1;
    }
    let Some(runtime) = runtime() else {
        return -1;
    };
    crate::mono_names::resolve_now();

    let broker = Arc::new(Broker::new(config));
    // Leaked on purpose: a thread holding a broker must never see freed memory,
    // and there is exactly one broker per process.
    let raw = Arc::into_raw(Arc::clone(&broker));
    CURRENT.store(raw as *mut Broker, Ordering::Release);

    let serving = Arc::clone(&broker);
    runtime.spawn(async move {
        crate::server::broker_main(Arc::clone(&serving)).await;
    });
    runtime.spawn(async move {
        broker.observe_main_thread().await;
    });
    0
}

pub fn shutdown() {
    if let Some(broker) = current() {
        broker.shutdown();
    }
}

pub fn set_managed_state(state: i32, generation: i64, editor_status: Option<String>) {
    if let Some(broker) = current() {
        broker.set_managed_state(state, generation, editor_status);
    }
}

pub fn managed_heartbeat(generation: i64) {
    if let Some(broker) = current() {
        broker.heartbeat(generation);
    }
}

pub fn managed_execution(active: bool) {
    if let Some(broker) = current() {
        broker.execution_activity(active);
    }
}

pub fn set_capabilities(caps: String) {
    if let Some(broker) = current() {
        broker.set_capabilities(caps);
    }
}

pub fn complete_request(id: &str, response: Vec<u8>) {
    if let Some(broker) = current() {
        broker.complete(id, response);
    }
}

pub fn emit_event(event_type: &str, payload: String) {
    if let Some(broker) = current() {
        broker.emit_event(event_type, payload);
    }
}

pub fn connected() -> bool {
    current().is_some_and(|broker| broker.connected())
}

pub fn execution_cancel_seq() -> u64 {
    current().map(|broker| broker.execution_cancel_seq()).unwrap_or(0)
}

pub fn execution_cancel_requested(execution_id: &str, since_seq: u64) -> bool {
    current().is_some_and(|broker| broker.execution_cancel_requested(execution_id, since_seq))
}

pub fn main_thread_stall_ms() -> i64 {
    current().map(|broker| broker.main_thread_stall_ms()).unwrap_or(-1)
}

pub fn execution_publish(execution_id: &str, json: &str) {
    if let Some(broker) = current() {
        broker.publish_execution(execution_id, json);
    }
}

pub fn execution_end(execution_id: &str) {
    if let Some(broker) = current() {
        broker.end_execution(execution_id);
    }
}

pub fn execution_client_poll_age_ms(execution_id: &str) -> i64 {
    current()
        .map(|broker| broker.execution_client_poll_age_ms(execution_id))
        .unwrap_or(-1)
}

/// Block until a request is queued (1), timeout/shutdown (0), or no broker (-1).
pub fn wait_request(timeout_ms: i32) -> i32 {
    let Some(broker) = current() else {
        return -1;
    };
    i32::from(broker.wait_request(Duration::from_millis(timeout_ms.max(0) as u64)))
}

/// Copy the next queued request line into `buffer`.
///
/// # Safety
/// `buffer` must be valid for `buffer_len` bytes (or null with `buffer_len == 0`);
/// `out_required` must be valid or null.
pub unsafe fn poll_request(buffer: *mut u8, buffer_len: i32, out_required: *mut i32) -> i32 {
    let Some(broker) = current() else {
        return 0;
    };
    let Some(needed) = broker.next_request_len() else {
        return 0;
    };
    if !out_required.is_null() {
        *out_required = needed.min(i32::MAX as usize) as i32;
    }
    if buffer.is_null() || (buffer_len.max(0) as usize) < needed {
        return -1;
    }
    let Some(request) = broker.take_next_request() else {
        return 0;
    };
    if (buffer_len as usize) < request.raw.len() {
        broker.requeue_front(request);
        return -1;
    }
    std::ptr::copy_nonoverlapping(request.raw.as_ptr(), buffer, request.raw.len());
    request.raw.len() as i32
}
