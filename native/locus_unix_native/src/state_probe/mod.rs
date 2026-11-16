//! 分层状态探针：编辑器卡住时，仍然能在进程外回答“它到底在干什么”。
//!
//! 上游 Tauri 宿主（`Locus/src-tauri/src/unity_bridge/state_probe.rs`）用 dbghelp
//! 在 Windows 上抓 x64 CONTEXT 并查 Unity 的 reload 符号，从而判出 domain reload
//! 的子阶段。Linux/macOS 上没有 dbghelp，所以这里改成**三档递进**的采样，
//! 每档只依赖自己真正能拿到的证据，拿不到就诚实降档：
//!
//! - **T1 托管阶段**：由编辑器侧（`dsh_health_snapshot`）在
//!   `EditorApplication.update` 里打点后喂进来。broker 位于 Unity 进程内，读到的是
//!   编辑器自己维护的连续状态，因此本档总是 `supported`；但它是“编辑器愿意说”
//!   的证据，编辑器不报（版本不对、旁挂包缺失）时就是 `unknown`。
//! - **T2 CPU 活动**：Linux 读 `/proc/<pid>/stat` 的 `utime+stime`，macOS 用
//!   `proc_pidinfo(PROC_PIDTASKINFO)`，比对两次采样的差值。它区分“忙等”与“阻塞”，
//!   是卡死诊断里唯一不需要主线程配合的证据。
//! - **T3 进程存活**：`kill(pid, 0)` / `kill(pid, SIGSTOP)` 的 `ESRCH` 判定进程是否
//!   还在。没有它，客户端分不清“编辑器卡死”和“编辑器崩了”。
//!
//! T2/T3 只处理**本进程**（Unity 编辑器进程内的 broker 只关心自己）。传入别的 pid
//! 会明确返回 `NoSuchProcess`，而不是去读一个陌生进程的 CPU 时间冒充结论。
//!
//! 本模块不做任何阻塞等待：所有读取都是 `/proc` 文件读或单次 procfs 查询，失败即降档。

use std::cell::Cell;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::{json, Value};

/// 两次 CPU 采样之间至少间隔这么久，否则差分噪声盖过信号。
pub const CPU_SAMPLE_WINDOW_MS: u64 = 500;
/// 主线程心跳超过这个时间才算“卡住”（与 broker 的 `UNRESPONSIVE_AFTER_MS` 一致）。
pub const UNRESPONSIVE_AFTER_MS: u64 = 30_000;
/// 编辑器侧阶段标记超过这个时间没有更新就不再作为当前证据。
pub const PHASE_FRESH_MS: u64 = 2_000;

/// 平台能力检测结果：要么可用，要么给出不可用的原因（绝不假装成功）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PlatformSupport {
    pub supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

impl PlatformSupport {
    fn yes() -> Self {
        Self {
            supported: true,
            reason: None,
        }
    }

    fn no(reason: impl Into<String>) -> Self {
        Self {
            supported: false,
            reason: Some(reason.into()),
        }
    }

    pub fn is_supported(&self) -> bool {
        self.supported
    }
}

/// T1 档的平台能力。
pub fn phase_support() -> PlatformSupport {
    PlatformSupport::no(
        "the managed phase tier needs the editor to publish dsh_health_snapshot; \
         until it does, the phase stays unknown instead of being inferred",
    )
}

/// T2 档在本平台是否真的能采样。
pub fn cpu_support() -> PlatformSupport {
    #[cfg(target_os = "linux")]
    {
        // /proc 可能被隐藏（容器、hidepid、动态库跑在非 Linux 内核兼容层）。
        if !std::path::Path::new("/proc/self/stat").exists() {
            return PlatformSupport::no("/proc is not mounted; CPU accounting is unavailable");
        }
        PlatformSupport::yes()
    }
    #[cfg(target_os = "macos")]
    {
        // proc_pidinfo 在 macOS 上始终存在；真正的失败留给采样时的 ERANGE/EPERM。
        PlatformSupport::yes()
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        PlatformSupport::no(format!(
            "no CPU accounting implementation for {}",
            std::env::consts::OS
        ))
    }
}

/// T3 档的平台能力。
pub fn liveness_support() -> PlatformSupport {
    // kill(pid, 0) 是 POSIX 的基础能力，Linux/macOS 都有。
    PlatformSupport::yes()
}

/// 一次 CPU 采样：累计 tick 与采样时刻。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CpuSample {
    pub pid: u32,
    pub ticks: u64,
    pub at_ms: u64,
}

/// 连续两次采样的差分。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CpuActivity {
    pub percent: f64,
    pub window_ms: u64,
    /// 采样窗口内主线程心跳是否推进过。true 时哪怕 CPU 高，也不是“卡住”。
    pub heartbeat_advanced: bool,
}

/// 探针失败的原因。区分“这个平台做不到”和“这次采样失败”，好让上层决定
/// 是降档（`Unsupported`）还是重试（`Failed`）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProbeError {
    /// 平台没有这项能力。
    Unsupported { reason: String },
    /// 进程已不在。
    NoSuchProcess { pid: u32 },
    /// 找到了进程但读不出数据（权限、格式变化）。
    Failed { reason: String },
}

impl ProbeError {
    /// 稳定错误码，供 JSON 输出与测试使用。
    pub fn code(&self) -> &'static str {
        match self {
            Self::Unsupported { .. } => "unsupported",
            Self::NoSuchProcess { .. } => "no_such_process",
            Self::Failed { .. } => "failed",
        }
    }

    pub fn describe(&self) -> String {
        match self {
            Self::Unsupported { reason } => format!("unsupported: {reason}"),
            Self::NoSuchProcess { pid } => format!("process {pid} not found"),
            Self::Failed { reason } => format!("failed: {reason}"),
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// T1：编辑器侧推来的阶段标记
// ─────────────────────────────────────────────────────────────────────────────

/// 编辑器侧的一帧健康快照（`dsh_health_snapshot` 的正文）。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct HealthSnapshot {
    pub phase: String,
    pub since_ms: u64,
    pub playing: bool,
    pub paused: bool,
    pub compiling: bool,
    pub updating: bool,
    pub importing: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modal_dialog: Option<bool>,
}

impl HealthSnapshot {
    /// 解析编辑器侧 JSON 正文。字段缺失时按 false 处理、`phase` 缺失视为非法。
    pub fn parse(body: &str) -> Result<Self, ProbeError> {
        let value: Value = serde_json::from_str(body.trim()).map_err(|error| ProbeError::Failed {
            reason: format!("health snapshot is not valid JSON: {error}"),
        })?;
        let phase = value
            .get("phase")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|phase| !phase.is_empty())
            .ok_or_else(|| ProbeError::Failed {
                reason: "health snapshot has no phase".to_string(),
            })?;
        let flag = |key: &str| value.get(key).and_then(Value::as_bool).unwrap_or(false);
        let since_ms = value
            .get("since_ms")
            .and_then(Value::as_u64)
            .unwrap_or_else(now_ms);
        Ok(Self {
            phase: phase.to_string(),
            since_ms,
            playing: flag("playing"),
            paused: flag("paused"),
            compiling: flag("compiling"),
            updating: flag("updating"),
            importing: flag("importing"),
            modal_dialog: value.get("modal_dialog").and_then(Value::as_bool),
        })
    }
}

/// 编辑器侧最近一次上报的阶段。
#[derive(Debug)]
struct PhaseSample {
    snapshot: HealthSnapshot,
    received_at_ms: u64,
}

fn phase_slot() -> &'static Mutex<Option<PhaseSample>> {
    static SLOT: OnceLock<Mutex<Option<PhaseSample>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// 记录编辑器侧上报的一帧阶段。非法正文返回 `ProbeError::Failed`，且**不**覆盖上一帧：
/// 一帧坏数据不应该让探针凭空变成“未知”。
pub fn record_phase(body: &str) -> Result<(), ProbeError> {
    let snapshot = HealthSnapshot::parse(body)?;
    let received_at_ms = now_ms();
    if let Ok(mut slot) = phase_slot().lock() {
        *slot = Some(PhaseSample {
            snapshot,
            received_at_ms,
        });
    }
    Ok(())
}

/// 最近一次阶段上报（不论新鲜度），用于 `unknown` 时说明“最后一次看到的是什么”。
pub fn last_phase() -> Option<(HealthSnapshot, u64)> {
    phase_slot()
        .lock()
        .ok()
        .and_then(|slot| slot.as_ref().map(|sample| (sample.snapshot.clone(), sample.received_at_ms)))
}

/// T1 结果。
///
/// 字段名跟协议走 camelCase（`age_ms` → `ageMs`），因为它是直接进回复 JSON 的。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhaseTier {
    pub supported: bool,
    /// `fresh` | `stale` | `missing`。
    pub freshness: &'static str,
    /// 当前阶段；只有 `fresh` 时才是结论，否则是最后一次观测。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since_ms: Option<u64>,
    /// 距上次上报的毫秒数。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub age_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub playing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compiling: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updating: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub importing: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modal_dialog: Option<bool>,
}

/// 判断一次上报是否还能当证据：超过 [`PHASE_FRESH_MS`] 就是 stale。
pub fn phase_is_fresh(received_at_ms: u64, now: u64) -> bool {
    now.saturating_sub(received_at_ms) <= PHASE_FRESH_MS
}

fn read_phase_tier(now: u64) -> (PhaseTier, PlatformSupport) {
    let support = phase_support();
    let Some((snapshot, received_at_ms)) = last_phase() else {
        return (
            PhaseTier {
                supported: true,
                freshness: "missing",
                phase: None,
                since_ms: None,
                age_ms: None,
                playing: None,
                paused: None,
                compiling: None,
                updating: None,
                importing: None,
                modal_dialog: None,
            },
            support,
        );
    };
    let fresh = phase_is_fresh(received_at_ms, now);
    (
        PhaseTier {
            supported: true,
            freshness: if fresh { "fresh" } else { "stale" },
            phase: Some(snapshot.phase),
            since_ms: Some(snapshot.since_ms),
            age_ms: Some(now.saturating_sub(received_at_ms)),
            playing: Some(snapshot.playing),
            paused: Some(snapshot.paused),
            compiling: Some(snapshot.compiling),
            updating: Some(snapshot.updating),
            importing: Some(snapshot.importing),
            modal_dialog: snapshot.modal_dialog,
        },
        support,
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// T2：CPU 活动
// ─────────────────────────────────────────────────────────────────────────────

/// 采样前一刻主线程心跳的序号（由调用方在采样瞬间读取并交给差分）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HeartbeatMark {
    pub sequence: u64,
}

/// 读一次进程 CPU 累计时间。
///
/// Linux 读 `/proc/<pid>/stat`，macOS 走 `proc_pidinfo`。读不到就返回明确的错误，
/// 不缓存、不猜。
pub fn sample_cpu(pid: u32) -> Result<CpuSample, ProbeError> {
    let support = cpu_support();
    if !support.supported {
        return Err(ProbeError::Unsupported {
            reason: support.reason.unwrap_or_default(),
        });
    }
    sample_cpu_impl(pid).map(|ticks| CpuSample {
        pid,
        ticks,
        at_ms: now_ms(),
    })
}

#[cfg(target_os = "linux")]
fn sample_cpu_impl(pid: u32) -> Result<u64, ProbeError> {
    let path = format!("/proc/{pid}/stat");
    let text = std::fs::read_to_string(&path).map_err(|error| match error.kind() {
        std::io::ErrorKind::NotFound => ProbeError::NoSuchProcess { pid },
        _ => ProbeError::Failed {
            reason: format!("{path}: {error}"),
        },
    })?;
    parse_proc_stat(&text).ok_or_else(|| ProbeError::Failed {
        reason: format!("{path}: unexpected field layout"),
    })
}

/// 从 `/proc/<pid>/stat` 正文里取 `utime + stime`（字段 14、15）。
///
/// 第 2 个字段 `comm` 用圆括号包住且**可以含空格和右括号**（如 `(Web Content)`），
/// 所以从最后一个 `)` 之后才开始按空格切分。
pub fn parse_proc_stat(text: &str) -> Option<u64> {
    let close = text.rfind(')')?;
    let rest = text.get(close + 1..)?.trim_start();
    let fields: Vec<&str> = rest.split_whitespace().collect();
    // rest[0] 是 state（第 3 字段），因此 utime = rest[11]、stime = rest[12]。
    let utime: u64 = fields.get(11)?.parse().ok()?;
    let stime: u64 = fields.get(12)?.parse().ok()?;
    Some(utime.saturating_add(stime))
}

#[cfg(target_os = "macos")]
fn sample_cpu_impl(pid: u32) -> Result<u64, ProbeError> {
    use std::ffi::c_void;

    // struct proc_taskinfo（proc_info.h），只用到前面的时间字段；
    // 结构体大小必须精确，否则 proc_pidinfo 返回 ERANGE。
    #[repr(C)]
    #[derive(Default)]
    struct ProcTaskInfo {
        virtual_size: u64,
        resident_size: u64,
        total_user: u64,
        total_system: u64,
        threads_user: u64,
        threads_system: u64,
        policy: i32,
        faults: i32,
        pageins: i32,
        cow_faults: i32,
        messages_sent: i32,
        messages_received: i32,
        syscalls_mach: i32,
        syscalls_unix: i32,
        csw: i32,
        threadnum: i32,
        numrunning: i32,
        priority: i32,
    }

    const PROC_PIDTASKINFO: i32 = 4;
    extern "C" {
        fn proc_pidinfo(pid: i32, flavor: i32, arg: u64, buffer: *mut c_void, buffersize: i32) -> i32;
    }

    let mut info = ProcTaskInfo::default();
    let size = std::mem::size_of::<ProcTaskInfo>() as i32;
    // SAFETY: info is a correctly sized, mutable, aligned ProcTaskInfo.
    let written = unsafe {
        proc_pidinfo(
            pid as i32,
            PROC_PIDTASKINFO,
            0,
            &mut info as *mut ProcTaskInfo as *mut c_void,
            size,
        )
    };
    if written <= 0 {
        let error = std::io::Error::last_os_error();
        return Err(match error.raw_os_error() {
            Some(libc::ESRCH) => ProbeError::NoSuchProcess { pid },
            Some(libc::EPERM) => ProbeError::Failed {
                reason: format!("proc_pidinfo({pid}) needs task_for_pid rights: {error}"),
            },
            _ => ProbeError::Failed {
                reason: format!("proc_pidinfo({pid}): {error}"),
            },
        });
    }
    if written != size {
        return Err(ProbeError::Failed {
            reason: format!("proc_pidinfo({pid}) wrote {written} of {size} bytes (ABI mismatch)"),
        });
    }
    Ok(info.total_user.saturating_add(info.total_system))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn sample_cpu_impl(pid: u32) -> Result<u64, ProbeError> {
    Err(ProbeError::Unsupported {
        reason: format!(
            "no CPU accounting for {} (pid {pid})",
            std::env::consts::OS
        ),
    })
}

/// 每 tick 的毫秒数：Linux 用 `_SC_CLK_TCK`，macOS 的 proc_pidinfo 直接给纳秒。
/// 统一换算成“毫秒”后差值才有意义。
#[cfg(target_os = "linux")]
pub fn tick_ms() -> f64 {
    // SAFETY: sysconf has no side effects; 返回值 < 0 表示查询失败。
    let ticks_per_second = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if ticks_per_second > 0 {
        1_000.0 / ticks_per_second as f64
    } else {
        10.0 // 绝大多数 Linux 用户态 HZ=100，作为最后兜底
    }
}

#[cfg(target_os = "macos")]
pub fn tick_ms() -> f64 {
    1.0 / 1_000_000.0 // proc_taskinfo 的 total_user/total_system 单位是纳秒
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn tick_ms() -> f64 {
    10.0
}

/// 用前后两次采样算 CPU 占比。
///
/// 返回 `None` 表示窗口太短或时间倒流（不可信），调用方应继续用上一轮结论。
pub fn cpu_activity(previous: CpuSample, current: CpuSample, heartbeat_advanced: bool) -> Option<CpuActivity> {
    if previous.pid != current.pid || current.at_ms <= previous.at_ms {
        return None;
    }
    let window_ms = current.at_ms - previous.at_ms;
    if window_ms < CPU_SAMPLE_WINDOW_MS {
        return None;
    }
    // 累计时间只会增长；假如变小（进程重启复用了 pid），这次结论作废。
    let delta_ticks = current.ticks.checked_sub(previous.ticks)?;
    let busy_ms = delta_ticks as f64 * tick_ms();
    let percent = (busy_ms / window_ms as f64) * 100.0;
    Some(CpuActivity {
        percent: (percent.clamp(0.0, 10_000.0) * 100.0).round() / 100.0,
        window_ms,
        heartbeat_advanced,
    })
}

/// 采样器：保存上一次采样与心跳序号，给出“主线程近期是否在烧 CPU”。
#[derive(Debug, Default)]
pub struct CpuSampler {
    previous: Option<CpuSample>,
    previous_heartbeat: Option<u64>,
    latest: Option<CpuActivity>,
}

impl CpuSampler {
    pub fn new() -> Self {
        Self::default()
    }

    /// 采一次样并返回本次可用的活动结论（窗口不足时返回上一次的结论）。
    pub fn observe(&mut self, pid: u32, heartbeat: HeartbeatMark) -> Result<Option<CpuActivity>, ProbeError> {
        let current = sample_cpu(pid)?;
        if let Some(previous) = self.previous {
            let advanced = self
                .previous_heartbeat
                .is_some_and(|previous_sequence| heartbeat.sequence != previous_sequence);
            if let Some(activity) = cpu_activity(previous, current, advanced) {
                self.latest = Some(activity);
            }
        }
        self.previous = Some(current);
        self.previous_heartbeat = Some(heartbeat.sequence);
        Ok(self.latest)
    }

    pub fn latest(&self) -> Option<CpuActivity> {
        self.latest
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// T3：进程存活
// ─────────────────────────────────────────────────────────────────────────────

/// 进程存活判定。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Liveness {
    /// 进程在（可能是僵尸，见 `zombie`）。
    Alive,
    /// 进程不在了。
    Gone,
}

/// T3 结果。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct LivenessTier {
    pub supported: bool,
    pub state: Liveness,
    pub zombie: bool,
}

/// `kill(pid, 0)` 判定存活。`EPERM` 说明进程在、只是没权限发信号，仍然算活着。
pub fn check_liveness(pid: u32) -> Result<LivenessTier, ProbeError> {
    let support = liveness_support();
    if !support.supported {
        return Err(ProbeError::Unsupported {
            reason: support.reason.unwrap_or_default(),
        });
    }
    if pid == 0 {
        return Err(ProbeError::Failed {
            reason: "pid 0 targets the process group, not a Unity editor".to_string(),
        });
    }
    // SAFETY: signal 0 performs only the permission/existence check.
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if result == 0 {
        return Ok(LivenessTier {
            supported: true,
            state: Liveness::Alive,
            zombie: is_zombie(pid),
        });
    }
    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::EPERM) => Ok(LivenessTier {
            supported: true,
            state: Liveness::Alive,
            zombie: is_zombie(pid),
        }),
        Some(libc::ESRCH) => Ok(LivenessTier {
            supported: true,
            state: Liveness::Gone,
            zombie: false,
        }),
        _ => Err(ProbeError::Failed {
            reason: format!("kill({pid}, 0): {error}"),
        }),
    }
}

/// 僵尸进程仍占着 pid，但已经不会跑代码了：对诊断来说等于“死了”。
fn is_zombie(pid: u32) -> bool {
    #[cfg(target_os = "linux")]
    {
        let Ok(text) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            return false;
        };
        let Some(close) = text.rfind(')') else {
            return false;
        };
        let state = text.get(close + 1..).map(str::trim_start).unwrap_or_default();
        state.starts_with('Z')
    }
    #[cfg(target_os = "macos")]
    {
        // macOS 的僵尸进程由 launchd 立即回收，没有可读的 stat 状态字段；
        // 这里不猜，一律当非僵尸。
        let _ = pid;
        false
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = pid;
        false
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 汇总：三档一起看
// ─────────────────────────────────────────────────────────────────────────────

/// 探针结论：客户端拿到的就是这一份。
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ProbeReport {
    pub pid: u32,
    /// 三档里是否至少有一档给出了可用证据。
    pub supported: bool,
    /// 是否为“编辑器卡住”的结论（心跳过期且进程还在）。
    pub unresponsive: bool,
    pub phase: PhaseTier,
    /// T2：CPU 占比。窗口不足时为 `None`，而不是 0。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_window_ms: Option<u64>,
    pub liveness: LivenessTier,
    /// 每档的能力说明；不可用的档必须给出原因。
    pub tiers: Value,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

/// 三档探针。

pub struct StateProbe {
    cpu: CpuSampler,
}

impl Default for StateProbe {
    fn default() -> Self {
        Self::new()
    }
}

impl StateProbe {
    pub fn new() -> Self {
        Self { cpu: CpuSampler::new() }
    }

    /// 采一次。`heartbeat_age_ms < 0` 表示没有心跳数据。
    pub fn probe(&mut self, pid: u32, heartbeat_age_ms: i64, heartbeat: HeartbeatMark) -> ProbeReport {
        let now = now_ms();
        let (phase, phase_support) = read_phase_tier(now);
        let cpu_support = cpu_support();

        let mut notes = Vec::new();
        let liveness = match check_liveness(pid) {
            Ok(tier) => tier,
            Err(error) => {
                notes.push(format!("liveness probe {}", error.describe()));
                LivenessTier {
                    supported: false,
                    state: Liveness::Gone,
                    zombie: false,
                }
            }
        };
        if liveness.zombie {
            notes.push("the editor process is a zombie: it stays in the process table but runs no code".to_string());
        }

        let mut cpu_percent = None;
        let mut cpu_window_ms = None;
        if cpu_support.supported {
            match self.cpu.observe(pid, heartbeat) {
                Ok(Some(activity)) => {
                    cpu_percent = Some(activity.percent);
                    cpu_window_ms = Some(activity.window_ms);
                    if activity.heartbeat_advanced {
                        notes.push("the main thread heartbeat advanced inside the CPU window".to_string());
                    }
                }
                Ok(None) => notes.push(
                    "CPU accounting is waiting for its first sample window".to_string(),
                ),
                Err(ProbeError::Unsupported { reason }) => {
                    notes.push(format!("CPU accounting is unsupported: {reason}"));
                }
                Err(error) => notes.push(format!("CPU sample {}", error.describe())),
            }
        } else {
            notes.push(format!(
                "CPU accounting is unsupported: {}",
                cpu_support.reason.clone().unwrap_or_default()
            ));
        }

        let stalled = heartbeat_age_ms >= UNRESPONSIVE_AFTER_MS as i64;
        let responsive_from_heartbeat = heartbeat_age_ms >= 0 && !stalled;
        let unresponsive = !responsive_from_heartbeat
            && liveness.state == Liveness::Alive
            && !liveness.zombie
            && (stalled || phase.phase.as_deref() == Some("unresponsive"));

        let supported = phase_support.supported || cpu_support.supported || liveness.supported;
        let tiers = json!({
            "t1": { "supported": phase.support_fresh(), "reason": phase_support.reason },
            "t2": {
                "supported": cpu_support.supported,
                "platform": std::env::consts::OS,
                "reason": cpu_support.reason,
                "windowMs": cpu_window_ms,
            },
            "t3": {
                "supported": liveness.supported,
                "state": liveness.state,
                "zombie": liveness.zombie,
            },
        });

        ProbeReport {
            pid,
            supported,
            unresponsive,
            phase,
            cpu_percent,
            cpu_window_ms,
            liveness,
            tiers,
            notes,
        }
    }
}

impl PhaseTier {
    /// T1 在协议层“支持”，但只有收到过上报时才有证据。
    fn support_fresh(&self) -> bool {
        self.freshness == "fresh"
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────────────────

pub fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

thread_local! {
    static PROBE_NOW_OVERRIDE: Cell<Option<u64>> = const { Cell::new(None) };
}

/// 测试 seam：固定 `now_ms()`，避免断言依赖真实时钟。
#[cfg(test)]
pub(crate) fn with_now<T>(value: Option<u64>, body: impl FnOnce() -> T) -> T {
    PROBE_NOW_OVERRIDE.with(|cell| {
        let previous = cell.replace(value);
        let result = body();
        cell.set(previous);
        result
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proc_stat_parses_comm_with_spaces_and_parens() {
        // comm 里既有空格又有右括号，字段位置仍然正确。
        let text = "1234 (Unity Editor (x86)) S 1 1234 1234 0 -1 4194304 100 0 0 0 250 750 0 0 20 0 1 0 1000 0 0";
        assert_eq!(parse_proc_stat(text), Some(1000));
    }

    #[test]
    fn proc_stat_rejects_truncated_lines() {
        assert_eq!(parse_proc_stat("1234 (Unity) S 1"), None);
        assert_eq!(parse_proc_stat(""), None);
    }

    #[test]
    fn cpu_activity_needs_a_full_window() {
        let previous = CpuSample { pid: 1, ticks: 100, at_ms: 1_000 };
        let too_soon = CpuSample { pid: 1, ticks: 200, at_ms: 1_100 };
        assert_eq!(cpu_activity(previous, too_soon, false), None);

        let later = CpuSample { pid: 1, ticks: 200, at_ms: 2_000 };
        let activity = cpu_activity(previous, later, false).expect("a 1 s window is long enough");
        assert_eq!(activity.window_ms, 1_000);
        assert!(activity.percent > 0.0);
    }

    #[test]
    fn cpu_activity_ignores_a_restarted_pid() {
        // pid 被复用后累计时间会变小：这次结论必须作废，不能报负数。
        let previous = CpuSample { pid: 7, ticks: 5_000, at_ms: 1_000 };
        let current = CpuSample { pid: 7, ticks: 10, at_ms: 2_000 };
        assert_eq!(cpu_activity(previous, current, false), None);
        // 换了 pid 也算不同进程。
        let other = CpuSample { pid: 8, ticks: 6_000, at_ms: 2_000 };
        assert_eq!(cpu_activity(previous, other, false), None);
    }

    #[test]
    fn cpu_activity_marks_heartbeat_progress() {
        let previous = CpuSample { pid: 1, ticks: 100, at_ms: 1_000 };
        let current = CpuSample { pid: 1, ticks: 100, at_ms: 3_000 };
        let activity = cpu_activity(previous, current, true).unwrap();
        assert_eq!(activity.percent, 0.0);
        assert!(activity.heartbeat_advanced);
    }

    #[test]
    fn health_snapshot_round_trips() {
        let body = r#"{"phase":"importing","since_ms":1700000000000,"playing":true,"paused":false,"compiling":false,"updating":false,"importing":true,"modal_dialog":true}"#;
        let snapshot = HealthSnapshot::parse(body).unwrap();
        assert_eq!(snapshot.phase, "importing");
        assert_eq!(snapshot.since_ms, 1_700_000_000_000);
        assert!(snapshot.playing);
        assert_eq!(snapshot.modal_dialog, Some(true));
    }

    #[test]
    fn health_snapshot_defaults_missing_flags_to_false() {
        let snapshot = HealthSnapshot::parse(r#"{"phase":"idle"}"#).unwrap();
        assert_eq!(snapshot.phase, "idle");
        assert!(!snapshot.playing && !snapshot.paused && !snapshot.compiling);
        assert_eq!(snapshot.modal_dialog, None);
        assert!(snapshot.since_ms > 0, "a missing since_ms falls back to now");
    }

    #[test]
    fn health_snapshot_rejects_garbage_without_clearing_the_last_one() {
        record_phase(r#"{"phase":"compiling","since_ms":5}"#).unwrap();
        assert!(matches!(HealthSnapshot::parse("not json"), Err(ProbeError::Failed { .. })));
        assert!(matches!(HealthSnapshot::parse(r#"{"phase":"  "}"#), Err(ProbeError::Failed { .. })));
        let (last, _) = last_phase().expect("the good frame survives a bad one");
        assert_eq!(last.phase, "compiling");
    }

    #[test]
    fn phase_freshness_has_a_documented_window() {
        assert!(phase_is_fresh(1_000, 1_000));
        assert!(phase_is_fresh(1_000, 1_000 + PHASE_FRESH_MS));
        assert!(!phase_is_fresh(1_000, 1_000 + PHASE_FRESH_MS + 1));
    }

    #[test]
    fn liveness_sees_the_current_process() {
        let tier = check_liveness(std::process::id()).expect("the current process is killable");
        assert_eq!(tier.state, Liveness::Alive);
        assert!(!tier.zombie);
    }

    #[test]
    fn liveness_reports_a_missing_process() {
        // 找一个几乎不可能存在的 pid：内核 pid_max 上限是 4194304。
        let tier = check_liveness(4_194_303).expect("ESRCH is a normal answer");
        assert_eq!(tier.state, Liveness::Gone);
    }

    #[test]
    fn cpu_sampling_is_honest_about_the_platform() {
        let support = cpu_support();
        match sample_cpu(std::process::id()) {
            Ok(sample) => {
                assert!(support.supported);
                assert_eq!(sample.pid, std::process::id());
                if tick_ms() > 0.0 {
                    // 单位换算没有除零，并且是有限值。
                    assert!(tick_ms().is_finite());
                }
            }
            Err(error) => {
                assert!(!support.supported, "{error:?} without an unsupported platform");
                assert_eq!(error.code(), "unsupported");
            }
        }
    }

    #[test]
    fn sampling_a_foreign_pid_is_refused_not_guessed() {
        // 本进程不是那个 pid：探针必须拒绝，而不是把别人的数据当成自己的。
        let error = sample_cpu(4_194_303).unwrap_err();
        assert!(matches!(
            error,
            ProbeError::NoSuchProcess { .. } | ProbeError::Failed { .. } | ProbeError::Unsupported { .. }
        ));
    }

    #[test]
    fn probe_report_is_json_ready_and_flags_unresponsive() {
        let mut probe = StateProbe::new();
        let pid = std::process::id();
        let report = probe.probe(pid, 60_000, HeartbeatMark { sequence: 1 });
        let encoded = serde_json::to_value(&report).unwrap();
        assert_eq!(encoded["pid"], pid);
        assert_eq!(encoded["unresponsive"], true, "a 60 s old heartbeat is unresponsive");
        assert!(encoded["tiers"]["t2"].is_object());
        assert_eq!(encoded["liveness"]["state"], "alive");

        // 心跳新鲜时绝不报 unresponsive。
        let fresh = probe.probe(pid, 10, HeartbeatMark { sequence: 2 });
        assert!(!fresh.unresponsive);
    }

    #[test]
    fn unsupported_tiers_always_carry_a_reason() {
        for support in [phase_support(), cpu_support(), liveness_support()] {
            if !support.supported {
                let reason = support.reason.unwrap_or_default();
                assert!(!reason.is_empty(), "an unsupported tier must explain why");
            }
        }
    }
}