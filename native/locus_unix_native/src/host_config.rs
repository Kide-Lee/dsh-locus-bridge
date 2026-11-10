//! Managed lifecycle states + capability list, mirrored from the Windows crates
//! so the two brokers answer byte-identical status documents.

pub mod managed_state {
    pub const INITIALIZING: i32 = 0;
    pub const READY: i32 = 1;
    pub const RELOADING: i32 = 2;
    pub const QUITTING: i32 = 3;

    pub fn name(state: i32) -> &'static str {
        match state {
            READY => "ready",
            RELOADING => "reloading",
            QUITTING => "quitting",
            _ => "initializing",
        }
    }
}

pub mod errors {
    pub const MANAGED_RELOADING: &str = "managed_reloading";
    pub const MANAGED_NOT_READY: &str = "managed_not_ready";
    pub const QUEUE_FULL: &str = "native_queue_full";
    pub const INFLIGHT_FULL: &str = "native_inflight_full";
    pub const PAYLOAD_TOO_LARGE: &str = "native_payload_too_large";
    pub const REQUEST_TIMED_OUT: &str = "native_request_timed_out";
    pub const MAIN_THREAD_UNRESPONSIVE: &str = "native_main_thread_unresponsive";
    pub const RELOAD_INTERRUPTED: &str = "domain_reload_interrupted";
    pub const STACK_FAILED: &str = "main_thread_stack_failed";
    pub const INVALID_REQUEST: &str = "native_invalid_request";
    pub const UNITY_PROCESS_EXITING: &str = "unity_process_exiting";
}

pub mod host_kind {
    pub const UNITY: &str = "unity";
}

/// Command types that carry managed code execution (Unity configuration).
#[derive(Clone, Copy, Debug)]
pub struct ExecutionCommands {
    pub execute: &'static [&'static str],
    pub wait: &'static str,
    pub cancel: &'static str,
    pub progress: &'static str,
}

pub const UNITY_EXECUTION: ExecutionCommands = ExecutionCommands {
    execute: &["execute_code", "execute_loaded"],
    wait: "execute_code_wait",
    cancel: "cancel_execute_code",
    progress: "execute_code_progress",
};

/// Capabilities every Unix host broker reports. The Windows-only capabilities
/// (`broker_state_mmf_v1`, stack capture, pipe security) are intentionally
/// absent: the Unix broker keeps the same request/response contract but no
/// Windows shared-memory window, no Win32 pipe DACL and no stack capture yet,
/// and clients gate on capability names rather than versions.
pub const COMMON: &[&str] = &[
    "broker_v1",
    "broker_queue_limits_v1",
    "broker_request_accepted_v1",
    "broker_main_thread_liveness_v1",
    "broker_execution_cancel_v1",
    "broker_execution_progress_v1",
    "broker_multi_client_v1",
    "broker_host_kind_v1",
    "broker_request_state_v1",
    "broker_compile_result_v1",
];
