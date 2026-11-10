//! End-to-end protocol test without Unity: this test plays the *host* (the
//! Unity managed executor) against the real broker over the real Unix socket,
//! then plays a Locus client against it.
//!
//! It exercises the same contract the C# plugin and the DSH client rely on:
//! `ping`/`status`/`bridge_capabilities` answered without the executor,
//! `locus-request-accepted` events, request queue polling, completion routing,
//! the compile-result hook, execution progress/cancel registers, reload
//! interruption and the state plane.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use locus_unity_native::api;
use locus_unity_native::broker::HostConfig;
use locus_unity_native::host_config::{errors, host_kind, ExecutionCommands, COMMON, UNITY_EXECUTION};

fn test_config(socket: &str) -> HostConfig {
    HostConfig {
        host_kind: host_kind::UNITY,
        instance_key: "test".into(),
        project: "F:/Projects/Game".into(),
        socket_path: socket.into(),
        pipe_name: "test-pipe".into(),
        state_plane_path: std::path::PathBuf::new(),
        protocol_version: 1,
        quitting_error: errors::UNITY_PROCESS_EXITING,
        default_status: "editing",
        extra_capabilities: &[],
        execution: UNITY_EXECUTION as ExecutionCommands,
        request_hook: None,
        on_shutdown: None,
    }
}

struct Client {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Client {
    fn connect(socket: &str) -> Self {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match UnixStream::connect(socket) {
                Ok(stream) => {
                    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
                    let writer = stream.try_clone().unwrap();
                    return Self { reader: BufReader::new(stream), writer };
                }
                Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
                Err(error) => panic!("connect {socket}: {error}"),
            }
        }
    }

    fn send(&mut self, value: Value) {
        let mut line = value.to_string();
        if std::env::var_os("LOCUS_TEST_DEBUG").is_some() {
            eprintln!("[test] -> {line}");
        }
        line.push('\n');
        self.writer.write_all(line.as_bytes()).unwrap();
        self.writer.flush().unwrap();
    }

    fn next_frame(&mut self) -> Value {
        loop {
            let mut line = String::new();
            match self.reader.read_line(&mut line) {
                Ok(bytes) => {
                    assert!(bytes > 0, "connection closed");
                    if let Ok(value) = serde_json::from_str(line.trim()) {
                        if std::env::var_os("LOCUS_TEST_DEBUG").is_some() {
                            eprintln!("[test] <- {}", line.trim());
                        }
                        return value;
                    }
                    eprintln!("[test] unparsable frame: {line:?}");
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    eprintln!("[test] read timed out waiting for a frame");
                    panic!("frame timeout");
                }
                Err(error) => panic!("frame: {error}"),
            }
        }
    }

    /// Read until the response for `id` (skipping events).
    fn response(&mut self, id: &str) -> Value {
        loop {
            let frame = self.next_frame();
            if frame["type"] == "response" && frame["reply_to"] == id {
                return frame;
            }
        }
    }

    fn request(&mut self, id: &str, kind: &str, message: &str) -> Value {
        self.send(json!({ "id": id, "type": kind, "message": message }));
        self.response(id)
    }
}

/// Poll the host side of the broker exactly like the managed executor.
fn poll_host(buffer: &mut Vec<u8>) -> Option<Value> {
    let mut required = 0i32;
    // SAFETY: the buffer is valid for its length and `required` is a live i32.
    let length = unsafe { api::poll_request(buffer.as_mut_ptr(), buffer.len() as i32, &mut required) };
    if length == 0 {
        return None;
    }
    assert!(length > 0, "poll needs a {required} byte buffer");
    let frame = String::from_utf8_lossy(&buffer[..length as usize]).into_owned();
    serde_json::from_str(&frame).ok()
}

fn complete(id: &str, ok: bool, message: Option<&str>, error: Option<&str>) {
    let mut envelope = json!({ "type": "response", "reply_to": id, "ok": ok });
    if let Some(message) = message {
        envelope["message"] = json!(message);
    }
    if let Some(error) = error {
        envelope["error"] = json!(error);
    }
    api::complete_request(id, envelope.to_string().into_bytes());
}

fn wait_for_request(buffer: &mut Vec<u8>) -> Value {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(frame) = poll_host(buffer) {
            return frame;
        }
        assert!(Instant::now() < deadline, "managed request never arrived");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn broker_serves_the_full_locus_contract_over_a_unix_socket() {
    let dir = std::env::temp_dir().join(format!("locus-broker-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let socket = dir.join("broker.sock");
    let socket_str = socket.to_string_lossy().into_owned();
    let _ = std::fs::remove_file(&socket);

    assert_eq!(api::init(test_config(&socket_str)), 0);
    api::set_managed_state(1, 1, Some("editing|Assets/Scenes/Main.unity".into()));
    api::set_capabilities("managed_executor_v1".into());

    let mut client = Client::connect(&socket_str);

    // Broker-answered commands (no executor involved).
    assert_eq!(client.request("1", "ping", "").get("message").unwrap(), "pong");
    let status = client.request("2", "status", "");
    assert_eq!(status["ok"], true);
    assert_eq!(status["message"], "editing|Assets/Scenes/Main.unity");
    let capabilities = client.request("3", "bridge_capabilities", "");
    let caps = capabilities["message"].as_str().unwrap();
    for expected in COMMON {
        assert!(caps.split(',').any(|cap| cap == *expected), "missing {expected} in {caps}");
    }
    assert!(caps.contains("managed_executor_v1"));

    // A managed request: accepted event, queued for the host, completed back.
    client.send(json!({ "id": "4", "type": "unity_get_console_log", "message": "{\"limit\":1}" }));
    let accepted = client.next_frame();
    assert_eq!(accepted["type"], "locus-request-accepted");
    let accepted_payload: Value = serde_json::from_str(accepted["message"].as_str().unwrap()).unwrap();
    assert_eq!(accepted_payload["requestId"], "4");

    let mut host_buffer = vec![0u8; 64 * 1024];
    let request = wait_for_request(&mut host_buffer);
    assert_eq!(request["id"], "4");
    assert_eq!(request["type"], "unity_get_console_log");
    complete("4", true, Some("{\"entries\":[]}"), None);
    let response = client.response("4");
    assert_eq!(response["ok"], true);
    assert_eq!(response["message"], "{\"entries\":[]}");

    // request_state reflects the (now empty) queue.
    let state = client.request("5", "request_state", "[\"4\"]");
    let states: Value = serde_json::from_str(state["message"].as_str().unwrap()).unwrap();
    assert_eq!(states["4"], "none");

    // Execution progress register: answered without the executor.
    api::execution_publish("exec-1", "{\"active\":true,\"idleMs\":12}");
    let progress = client.request("6", "execute_code_progress", "exec-1");
    let snapshot: Value = serde_json::from_str(progress["message"].as_str().unwrap()).unwrap();
    assert_eq!(snapshot["active"], true);
    assert_eq!(snapshot["servedBy"], "native_broker");

    // Cancel signals are recorded for the managed monitor *before* the request
    // is queued, so a snippet stuck on the main thread still sees it. The
    // managed handler also runs (and is completed here) when it can.
    let since = api::execution_cancel_seq();
    client.send(json!({ "id": "7", "type": "cancel_execute_code", "message": "exec-1" }));
    let _accepted = client.next_frame();
    assert!(api::execution_cancel_requested("exec-1", since));
    assert!(!api::execution_cancel_requested("other", since));
    let cancel_request = wait_for_request(&mut host_buffer);
    assert_eq!(cancel_request["type"], "cancel_execute_code");
    complete("7", true, Some("execution cancellation signaled through the native broker"), None);
    let cancel_response = client.response("7");
    assert_eq!(cancel_response["ok"], true);

    // Managed state transitions answer errors instead of hanging.
    api::set_managed_state(2, 2, None);
    let reloading = client.request("8", "unity_get_console_log", "{}");
    assert_eq!(reloading["ok"], false);
    assert_eq!(reloading["error"], errors::MANAGED_RELOADING);
    api::set_managed_state(1, 3, Some("editing".into()));

    // Queued work is failed with a definite error on a reload.
    api::set_managed_state(1, 3, Some("editing".into()));
    client.send(json!({ "id": "9", "type": "some_managed_command", "message": "" }));
    let _accepted = client.next_frame();
    let _queued = wait_for_request(&mut host_buffer);
    api::set_managed_state(2, 4, None);
    let interrupted = client.response("9");
    assert_eq!(interrupted["ok"], false);
    assert_eq!(interrupted["error"], errors::RELOAD_INTERRUPTED);
    api::set_managed_state(1, 5, Some("editing".into()));

    // Reattachable execution requests survive a client disconnect: the snippet
    // keeps running across the reconnect, and its completion is delivered to
    // whichever client is connected when the managed side answers.
    client.send(json!({ "id": "10", "type": "execute_code", "message": "print(1);" }));
    let _accepted = client.next_frame();
    let execution = wait_for_request(&mut host_buffer);
    assert_eq!(execution["id"], "10");
    drop(client);
    std::thread::sleep(Duration::from_millis(100));
    let mut reconnected = Client::connect(&socket_str);
    std::thread::sleep(Duration::from_millis(100));
    complete("10", true, Some("1"), None);
    let late = reconnected.next_frame();
    assert_eq!(late["reply_to"], "10", "the completion reaches the reconnected client");
    assert_eq!(late["message"], "1");

    api::shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}
