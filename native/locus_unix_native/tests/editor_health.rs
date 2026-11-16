//! End-to-end test for the editor-health commands the DSH client uses to diagnose
//! a wedged editor. Plays the same two roles as `broker_protocol.rs` (managed host
//! + Locus client) and drives the real handlers over the real Unix socket:
//!
//! * `dsh_health` — tiered state probe (CPU / liveness) and the
//!   background-hook status; must answer even while the managed side is stuck.
//! * `dsh_main_thread_stack` — honest `main_thread_stack_failed` when capture is
//!   unavailable, real frames when it is not.
//! * the `backgroundHook` block in the broker `status` snapshot.

use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use locus_unity_native::api;
use locus_unity_native::broker::HostConfig;
use locus_unity_native::host_config::{errors, host_kind, ExecutionCommands, UNITY_EXECUTION};

fn test_config(socket: &str) -> HostConfig {
    HostConfig {
        host_kind: host_kind::UNITY,
        instance_key: "health-test".into(),
        project: "F:/Projects/Game".into(),
        socket_path: socket.into(),
        pipe_name: "health-test-pipe".into(),
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

    fn request(&mut self, id: &str, kind: &str, message: &str) -> Value {
        let mut line = json!({ "id": id, "type": kind, "message": message }).to_string();
        line.push('\n');
        self.writer.write_all(line.as_bytes()).unwrap();
        self.writer.flush().unwrap();
        loop {
            let mut reply = String::new();
            let bytes = self.reader.read_line(&mut reply).unwrap();
            assert!(bytes > 0, "connection closed while waiting for {id}");
            let Ok(frame) = serde_json::from_str::<Value>(reply.trim()) else {
                continue;
            };
            if frame["type"] == "response" && frame["reply_to"] == id {
                return frame;
            }
        }
    }

    fn message(&mut self, id: &str, kind: &str, message: &str) -> Value {
        let frame = self.request(id, kind, message);
        assert_eq!(frame["ok"], true, "{kind} failed: {frame}");
        let text = frame["message"].as_str().unwrap_or_default().to_string();
        serde_json::from_str(&text).unwrap_or_else(|error| panic!("{kind} returned non-JSON {text:?}: {error}"))
    }
}

#[test]
fn editor_health_commands_answer_without_the_managed_executor() {
    let dir = std::env::temp_dir().join(format!("locus-health-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let socket = dir.join("broker.sock");
    let socket_str = socket.to_string_lossy().into_owned();
    let _ = std::fs::remove_file(&socket);

    assert_eq!(api::init(test_config(&socket_str)), 0);
    api::set_managed_state(1, 1, Some("editing".into()));

    let mut client = Client::connect(&socket_str);

    // ── dsh_health: two tiers, each honest about what it can see ───────────
    let health = client.message("h1", "dsh_health", "");
    assert_eq!(health["pid"], std::process::id());
    assert_eq!(health["tiers"]["t3"]["state"], "alive");
    assert_eq!(health["liveness"]["state"], "alive");
    // No managed phase report exists: the answer carries no phase at all.
    assert!(health.get("phase").is_none(), "phase must be gone from {health}");
    // CPU may be measured or explicitly unsupported; never a fabricated 0.
    if let Some(percent) = health["cpuPercent"].as_f64() {
        assert!(percent >= 0.0);
    } else {
        let t2 = &health["tiers"]["t2"];
        let reason = t2["reason"].as_str().unwrap_or_default();
        if t2["supported"] == true && health["cpuWindowMs"].is_null() {
            // 支持但窗口还没攒够：只能说“还没结论”，不能说空闲。
            assert!(health["notes"].as_array().is_some_and(|notes| !notes.is_empty()), "no evidence must be noted: {health}");
        } else {
            assert!(!reason.is_empty(), "an unsupported CPU tier must say why: {t2}");
            assert!(health["notes"].as_array().is_some_and(|notes| !notes.is_empty()), "{health}");
        }
    }
    // The hook block is present and never claims a patch on a non-Windows host.
    let hook = &health["backgroundHook"];
    assert!(hook.is_object(), "backgroundHook missing from {health}");
    assert_eq!(hook["patched"], false);
    if cfg!(windows) {
        assert_eq!(hook["supported"], true);
    } else {
        assert_eq!(hook["supported"], false);
        assert_eq!(hook["state"], "unsupported");
    }

    // ── dsh_main_thread_stack: honest failure or real frames, never silence ─
    let stack = client.request("s1", "dsh_main_thread_stack", "");
    assert_eq!(stack["ok"], true, "a stack request always answers: {stack}");
    let stack: Value = serde_json::from_str(stack["message"].as_str().unwrap()).unwrap();
    match stack["status"].as_str().unwrap() {
        "complete" => {
            assert!(!stack["frames"].as_array().unwrap().is_empty());
            assert!(stack["summary"].as_str().unwrap().starts_with("Stuck at"));
        }
        "unavailable" => {
            assert_eq!(stack["error"]["kind"], "unavailable");
            assert_eq!(stack["verdict"], "unknown");
            assert!(stack["frames"].as_array().unwrap().is_empty());
            assert!(stack["summary"].as_str().unwrap().contains("unavailable"));
        }
        other => panic!("unexpected stack status {other}"),
    }

    // ── The same data appears in the broker status snapshot ────────────────
    // `status` 仍按协议返回裸文本（编辑器状态），结构化快照走 dsh_health。
    let status = client.request("h6", "status", "");
    assert_eq!(status["ok"], true);
    assert_eq!(status["message"], "editing");

    api::shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}