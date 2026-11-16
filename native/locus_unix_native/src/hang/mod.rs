//! 卡死诊断：主线程不响应时，抓一次它的调用栈并给出可读结论。
//!
//! 上游 `hang_diagnosis.rs` 在 Windows 上用 dbghelp 在进程外挂起线程、读 CONTEXT、
//! 用 PDB 还原符号。Unix 上等价物有两件事要分别解决：
//!
//! 1. **拿寄存器**：用 `ptrace(PTRACE_ATTACH/PTRACE_GETREGS/PTRACE_DETACH)` 在进程外
//!    挂住目标线程，读它的 PC/SP/FP，然后自己走栈（`rbp` 链 / `fp` 链）。跟 dbghelp
//!    不同，这条路**会**短暂冻结被挂起的线程，所以只允许在诊断已经发生（心跳过期
//!    ≥30 秒）时使用，而且每个进程每秒最多一次。
//! 2. **还原符号**：托管帧用 `mono_jit_info_table_find`（见 [`crate::mono_names`]），
//!    原生帧用 ELF 的 `.dynsym`/`.symtab` 加 `dladdr`。没有 PDB 那样的“输入
//!    地址 → 行号”能力，所以原生帧只有模块名和模块内偏移。
//!
//! 支持边界（都是**诚实降级**，`StackError::Unavailable` 会写清楚原因）：
//!
//! - Linux：完整可用；但 `ptrace` 需要附加权限（`ptrace_scope=1` 时要求同一进程
//!   或 `CAP_SYS_PTRACE`；容器里常被 `seccomp` 拦掉）。
//! - macOS：`task_for_pid` 需要签名与 taskgated 授权，普通进程拿不到，因此本模块
//!   在 macOS 上返回 `Unavailable` 而不是“抓了个空栈当成功”。
//! - 其它 Unix：同上。
//!
//! 这个模块**不是**用于日常轮询的：它的唯一用途是在已经判定卡死之后回答“卡在
//! 哪里”，所以允许一次短暂的 `SIGSTOP`。

use std::time::{Duration, Instant};

use serde::Serialize;

/// 一次诊断最多保留的帧数（与上游 `MAX_REPORTED_FRAMES` 一致）。
pub const MAX_REPORTED_FRAMES: usize = 40;
/// 单帧最大回溯深度，防止 `rbp` 链成环。
pub const MAX_STACK_DEPTH: usize = 256;
/// 两次采样之间至少间隔这么久，避免把编辑器反复停住。
pub const SAMPLE_INTERVAL: Duration = Duration::from_secs(1);
/// 主线程 CPU 占比达到这个值就判“忙等”而不是“阻塞”（上游同值）。
pub const BUSY_CPU_PERCENT: f64 = 25.0;

/// 栈抓取失败的原因。`Unavailable` 表示**本平台/本进程**做不到，调用方必须把它
/// 当成“没有证据”，而不是“栈是空的”。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StackError {
    /// 平台没有实现，或当前进程缺少需要的权限/设施。
    Unavailable { reason: String, platform: String },
    /// 目标线程已经不在（进程退出、线程结束）。
    ThreadGone,
    /// 附加成功但读取失败。
    Failed { reason: String },
}

impl StackError {
    /// broker 协议里的稳定错误码。
    pub fn code(&self) -> &'static str {
        match self {
            // 与 host_config::errors::STACK_FAILED 同值：托管侧与客户端已经认这个码。
            Self::Unavailable { .. } | Self::ThreadGone | Self::Failed { .. } => "main_thread_stack_failed",
        }
    }

    pub fn describe(&self) -> String {
        match self {
            Self::Unavailable { reason, platform } => {
                format!("main-thread stack capture is unavailable on {platform}: {reason}")
            }
            Self::ThreadGone => "the main thread is gone; the editor is exiting or crashed".to_string(),
            Self::Failed { reason } => format!("main-thread stack capture failed: {reason}"),
        }
    }
}

/// 一帧。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frame {
    pub index: usize,
    /// `managed` | `native` | `unknown`。
    pub kind: &'static str,
    /// 指令地址（十六进制，带 `0x`）。
    pub ip: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assembly: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module_offset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u32>,
    /// 生成给人看的一行：`Assembly!Method (File:12)` 或 `module+0x1a3c`。
    pub display: String,
}

impl Frame {
    fn unknown(index: usize, ip: u64) -> Self {
        Self {
            index,
            kind: "unknown",
            ip: format!("0x{ip:x}"),
            method: None,
            assembly: None,
            module: None,
            module_offset: None,
            file: None,
            line: None,
            display: format!("0x{ip:x}"),
        }
    }
}

/// 平台能力：`supported` 为 false 时 `reason` 说明为什么。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StackSupport {
    pub platform: String,
    pub supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// 本平台能不能抓；不能的话原因是什么。
pub fn stack_support() -> StackSupport {
    #[cfg(target_os = "linux")]
    {
        // ptrace 的实现存在；能不能用取决于运行权限，这里先报“机制可用”，
        // 真正被 seccomp/ptrace_scope 拦住时由 capture 返回 Unavailable。
        StackSupport {
            platform: "linux".to_string(),
            supported: true,
            reason: None,
        }
    }
    #[cfg(target_os = "macos")]
    {
        StackSupport {
            platform: "macos".to_string(),
            supported: false,
            reason: Some(
                "reading another thread's registers needs task_for_pid, which requires a \
                 privileged or hardened-runtime-limited process; the editor's own dylib cannot \
                 obtain it"
                    .to_string(),
            ),
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        StackSupport {
            platform: std::env::consts::OS.to_string(),
            supported: false,
            reason: Some("no out-of-process register reader is implemented for this platform".to_string()),
        }
    }
}

/// 判定结果。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// 主线程在烧 CPU：多半是死循环或过重的同步计算。
    Busy,
    /// 主线程在等：锁、IO、同步等待。
    Waiting,
    /// 证据不足。
    Unknown,
}

impl Verdict {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Busy => "busy",
            Self::Waiting => "waiting",
            Self::Unknown => "unknown",
        }
    }
}

/// 一次诊断的完整结果。
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnosis {
    /// `complete` | `unavailable`。
    pub status: &'static str,
    pub process_id: u32,
    /// 主线程 tid（Linux 上 tid 就是该线程的 pid）。
    pub main_thread_id: Option<u32>,
    pub captured_at_ms: u64,
    /// 抓栈时刻的心跳年龄，供上层判断“抓到的是不是卡住那一刻”。
    pub heartbeat_age_ms: i64,
    pub verdict: Verdict,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpu_percent: Option<f64>,
    /// 最像“用户代码”的那一帧，`Stuck at` 复用它。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location_reason: Option<&'static str>,
    pub summary: String,
    pub frames: Vec<Frame>,
    pub notes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<StackError>,
}

impl Diagnosis {
    /// 平台做不到时的结果：`Unavailable` + 原因，没有任何帧。
    pub fn unavailable(process_id: u32, error: StackError, heartbeat_age_ms: i64) -> Self {
        let summary = error.describe();
        Self {
            status: "unavailable",
            process_id,
            main_thread_id: None,
            captured_at_ms: now_ms(),
            heartbeat_age_ms,
            verdict: Verdict::Unknown,
            cpu_percent: None,
            location: None,
            location_reason: None,
            summary,
            frames: Vec::new(),
            notes: vec!["no stack was captured, so no frame is reported".to_string()],
            error: Some(error),
        }
    }
}

/// 抓一次主线程栈并判定卡死类型。
///
/// `main_thread_id` 是 [`crate::broker::Broker::main_thread_id`]（Unity 主线程的
/// tid）。`heartbeat_age_ms < 0` 表示没有心跳数据。
pub fn capture_main_thread_stack(
    process_id: u32,
    main_thread_id: Option<u32>,
    heartbeat_age_ms: i64,
    cpu_percent: Option<f64>,
) -> Diagnosis {
    let support = stack_support();
    if !support.supported {
        return Diagnosis::unavailable(
            process_id,
            StackError::Unavailable {
                reason: support.reason.unwrap_or_else(|| "unsupported platform".to_string()),
                platform: support.platform,
            },
            heartbeat_age_ms,
        );
    }
    let Some(thread_id) = main_thread_id else {
        return Diagnosis::unavailable(
            process_id,
            StackError::Unavailable {
                reason: "the broker does not know the editor's main thread id".to_string(),
                platform: support.platform,
            },
            heartbeat_age_ms,
        );
    };

    let ips = match collect_instruction_pointers(thread_id) {
        Ok(ips) => ips,
        Err(error) => return Diagnosis::unavailable(process_id, error, heartbeat_age_ms),
    };
    if ips.is_empty() {
        return Diagnosis::unavailable(
            process_id,
            StackError::Failed {
                reason: "the captured stack had no usable return addresses".to_string(),
            },
            heartbeat_age_ms,
        );
    }

    let mut notes = Vec::new();
    let frames = name_frames(&ips, &mut notes);
    let (location, location_reason) = locate(&frames);
    let verdict = verdict_for(cpu_percent);
    let summary = summarize(frames.len(), location.as_deref(), location_reason, verdict, cpu_percent);

    Diagnosis {
        status: "complete",
        process_id,
        main_thread_id: Some(thread_id),
        captured_at_ms: now_ms(),
        heartbeat_age_ms,
        verdict,
        cpu_percent,
        location,
        location_reason,
        summary,
        frames,
        notes,
        error: None,
    }
}

/// 一句结论。措辞与上游保持一致（`stuck ... in <location>`），这样两端的日志能对读。
fn summarize(
    frame_count: usize,
    location: Option<&str>,
    location_reason: Option<&'static str>,
    verdict: Verdict,
    cpu_percent: Option<f64>,
) -> String {
    let cpu_text = cpu_percent
        .map(|percent| format!(" (main-thread CPU {percent:.0}%)"))
        .unwrap_or_default();
    let location_text = match (location, location_reason) {
        (Some(location), Some("user_code")) => location.to_string(),
        (Some(location), Some("native")) => format!("native code {location}"),
        (Some(location), _) => location.to_string(),
        (None, _) => "an unnamed frame".to_string(),
    };
    match verdict {
        Verdict::Busy => format!(
            "Stuck at {location_text}: the main thread is busy executing code{cpu_text} ({frame_count} frames captured)."
        ),
        Verdict::Waiting => format!(
            "Stuck at {location_text}: the main thread is blocked waiting{cpu_text} ({frame_count} frames captured)."
        ),
        Verdict::Unknown => format!(
            "Stuck at {location_text}: the main thread is not advancing, but CPU activity could not be measured ({frame_count} frames captured)."
        ),
    }
}

fn verdict_for(cpu_percent: Option<f64>) -> Verdict {
    match cpu_percent {
        Some(percent) if percent >= BUSY_CPU_PERCENT => Verdict::Busy,
        Some(_) => Verdict::Waiting,
        None => Verdict::Unknown,
    }
}

/// 挑出“最该怪谁”的那一帧：优先用户脚本，其次插件脚本，最后才是引擎/native。
fn locate(frames: &[Frame]) -> (Option<String>, Option<&'static str>) {
    let mut agent = None;
    for frame in frames {
        let assembly = frame.assembly.as_deref().unwrap_or_default();
        if is_user_assembly(assembly) {
            return (Some(frame.display.clone()), Some("user_code"));
        }
        if agent.is_none() && is_agent_assembly(assembly) {
            agent = Some(frame.display.clone());
        }
    }
    if let Some(display) = agent {
        return (Some(display), Some("agent_code"));
    }
    if let Some(frame) = frames.iter().find(|frame| frame.kind == "managed") {
        return (Some(frame.display.clone()), Some("managed"));
    }
    if let Some(frame) = frames.iter().find(|frame| frame.module.is_some()) {
        return (Some(frame.display.clone()), Some("native"));
    }
    frames
        .first()
        .map(|frame| (Some(frame.display.clone()), Some("top")))
        .unwrap_or((None, None))
}

/// `Assembly-CSharp*` 是用户的游戏脚本；`Unity.*`、`UnityEngine.*` 是引擎；
/// `Locus.*` 是插件自身。
fn is_user_assembly(assembly: &str) -> bool {
    if assembly.is_empty() {
        return false;
    }
    // 引擎与插件自己的程序集名都以 Unity/UnityEngine/Locus 开头。
    !assembly.starts_with("Unity")
        && !assembly.starts_with("Locus")
        && !assembly.starts_with("System")
        && !assembly.starts_with("Microsoft")
        && !assembly.starts_with("mscorlib")
}

fn is_agent_assembly(assembly: &str) -> bool {
    assembly.starts_with("Locus")
}

/// 把地址列表翻译成帧。托管优先，native 兜底；两边都失败就留 `unknown`。
fn name_frames(ips: &[u64], notes: &mut Vec<String>) -> Vec<Frame> {
    let lookups: Vec<(u64, u64)> = ips.iter().map(|&ip| (ip, ip.saturating_sub(1))).collect();
    let managed = match crate::mono_names::name_with_mono(&lookups) {
        Ok(frames) => frames,
        Err(reason) => {
            notes.push(format!("managed frame naming unavailable: {reason}"));
            Vec::new()
        }
    };

    let mut frames = Vec::new();
    for (index, &ip) in ips.iter().enumerate().take(MAX_REPORTED_FRAMES) {
        let managed_frame = managed.get(index);
        let native = native_symbol(ip);
        let frame = match (managed_frame, native) {
            (Some(managed), _) => {
                let display = match (&managed.file, managed.line) {
                    (Some(file), Some(line)) => {
                        format!("{}!{} ({}:{line})", managed.assembly, managed.method, file)
                    }
                    _ => format!("{}!{}", managed.assembly, managed.method),
                };
                Frame {
                    index,
                    kind: "managed",
                    ip: format!("0x{ip:x}"),
                    method: Some(managed.method.clone()),
                    assembly: Some(managed.assembly.clone()),
                    module: None,
                    module_offset: None,
                    file: managed.file.clone(),
                    line: managed.line,
                    display,
                }
            }
            (None, Some(symbol)) => {
                let display = format!("{}{}", symbol.module, symbol.offset);
                Frame {
                    index,
                    kind: "native",
                    ip: format!("0x{ip:x}"),
                    method: None,
                    assembly: None,
                    module: Some(symbol.module),
                    module_offset: Some(symbol.offset),
                    file: None,
                    line: None,
                    display,
                }
            }
            (None, None) => Frame::unknown(index, ip),
        };
        frames.push(frame);
    }
    frames
}

struct NativeSymbol {
    module: String,
    /// 形如 `+0x1a3c`。
    offset: String,
}

/// 原生帧的模块名与模块内偏移。Linux 用 `dladdr`；没有它就只剩地址本身。
fn native_symbol(ip: u64) -> Option<NativeSymbol> {
    #[cfg(all(unix, target_pointer_width = "64"))]
    {
        let mut info: libc::Dl_info = unsafe { std::mem::zeroed() };
        // SAFETY: dladdr only reads; info is a correctly sized Dl_info.
        let found = unsafe { libc::dladdr(ip as usize as *const libc::c_void, &mut info) };
        if found == 0 || info.dli_fname.is_null() {
            return None;
        }
        let module = unsafe { std::ffi::CStr::from_ptr(info.dli_fname) }
            .to_string_lossy()
            .into_owned();
        let base = info.dli_fbase as usize as u64;
        let offset = ip.saturating_sub(base);
        return Some(NativeSymbol {
            module,
            offset: format!("+0x{offset:x}"),
        });
    }
    #[cfg(not(all(unix, target_pointer_width = "64")))]
    {
        let _ = ip;
        None
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 寄存器采集（Linux ptrace）
// ─────────────────────────────────────────────────────────────────────────────

#[cfg(target_os = "linux")]
fn collect_instruction_pointers(thread_id: u32) -> Result<Vec<u64>, StackError> {
    use std::sync::Mutex;

    // 采样节流：同一线程每秒最多停一次。
    static LAST: Mutex<Option<(u32, Instant)>> = Mutex::new(None);
    {
        let mut last = LAST.lock().map_err(|_| StackError::Failed {
            reason: "stack sampler state poisoned".to_string(),
        })?;
        if let Some((last_thread, at)) = *last {
            if last_thread == thread_id && at.elapsed() < SAMPLE_INTERVAL {
                return Err(StackError::Failed {
                    reason: format!(
                        "sampled already within {} ms; refusing to freeze the editor again",
                        SAMPLE_INTERVAL.as_millis()
                    ),
                });
            }
        }
        *last = Some((thread_id, Instant::now()));
    }

    let tid = thread_id as libc::pid_t;
    // SAFETY: ptrace with PTRACE_ATTACH/GETREGS/DETACH on our own process's thread.
    unsafe {
        if libc::ptrace(libc::PTRACE_ATTACH, tid, std::ptr::null_mut::<libc::c_void>(), std::ptr::null_mut::<libc::c_void>()) != 0 {
            return Err(ptrace_error("PTRACE_ATTACH"));
        }
        // 等目标真的停下来；附加成功后内核会给它发 SIGSTOP。
        let mut status = 0 as libc::c_int;
        if libc::waitpid(tid, &mut status, 0) < 0 {
            detach(tid);
            return Err(ptrace_error("waitpid"));
        }

        let result = read_registers_and_walk(tid);
        detach(tid);
        result
    }
}

#[cfg(target_os = "linux")]
fn detach(tid: libc::pid_t) {
    // SAFETY: mirror of the attach above.
    unsafe {
        libc::ptrace(
            libc::PTRACE_DETACH,
            tid,
            std::ptr::null_mut::<libc::c_void>(),
            std::ptr::null_mut::<libc::c_void>(),
        );
    }
}

#[cfg(target_os = "linux")]
fn ptrace_error(operation: &str) -> StackError {
    let error = std::io::Error::last_os_error();
    let reason = match error.raw_os_error() {
        Some(libc::EPERM) => format!(
            "{operation}: ptrace is not permitted for this process \
             (/proc/sys/kernel/yama/ptrace_scope, container seccomp); \
             registers cannot be read without CAP_SYS_PTRACE"
        ),
        Some(libc::ESRCH) => return StackError::ThreadGone,
        _ => format!("{operation}: {error}"),
    };
    StackError::Unavailable {
        reason,
        platform: "linux".to_string(),
    }
}

/// 读 PC/SP/FP，然后沿帧指针链往上走，收集返回地址。
#[cfg(target_os = "linux")]
unsafe fn read_registers_and_walk(tid: libc::pid_t) -> Result<Vec<u64>, StackError> {
    #[cfg(target_arch = "x86_64")]
    {
        let mut regs: libc::user_regs_struct = std::mem::zeroed();
        if libc::ptrace(
            libc::PTRACE_GETREGS,
            tid,
            std::ptr::null_mut::<libc::c_void>(),
            &mut regs as *mut libc::user_regs_struct as *mut libc::c_void,
        ) != 0
        {
            return Err(ptrace_error("PTRACE_GETREGS"));
        }
        let mut ips = Vec::new();
        ips.push(regs.rip);
        // rbp 链：fp 指向 [上一帧 fp, 返回地址]。
        let mut frame = regs.rbp;
        let stack_top = regs.rsp.saturating_add(8 * 1024 * 1024);
        for _ in 0..MAX_STACK_DEPTH {
            if frame == 0 || frame < regs.rsp || frame >= stack_top {
                break;
            }
            let mut pair = [0u64; 2];
            if !read_memory(tid, frame, &mut pair) {
                break;
            }
            let return_address = pair[1];
            if return_address == 0 {
                break;
            }
            ips.push(return_address);
            let next = pair[0];
            if next <= frame {
                break; // 链断了或成环
            }
            frame = next;
        }
        Ok(ips)
    }
    #[cfg(target_arch = "aarch64")]
    {
        // aarch64 用 arm_ptrace_regs；PC 在 user_pt_regs.pc，帧指针是 x29。
        let mut regs: libc::user_pt_regs = std::mem::zeroed();
        if libc::ptrace(
            libc::PTRACE_GETREGSET,
            tid,
            std::ptr::null_mut::<libc::c_void>(),
            &mut libc::iovec {
                iov_base: &mut regs as *mut _ as *mut libc::c_void,
                iov_len: std::mem::size_of::<libc::user_pt_regs>(),
            } as *mut libc::iovec as *mut libc::c_void,
        ) != 0
        {
            return Err(ptrace_error("PTRACE_GETREGSET"));
        }
        let mut ips = Vec::new();
        ips.push(regs.pc);
        let mut frame = regs.regs[29];
        let stack_top = regs.sp.saturating_add(8 * 1024 * 1024);
        for _ in 0..MAX_STACK_DEPTH {
            if frame == 0 || frame < regs.sp || frame >= stack_top {
                break;
            }
            let mut pair = [0u64; 2];
            if !read_memory(tid, frame, &mut pair) {
                break;
            }
            if pair[1] == 0 {
                break;
            }
            ips.push(pair[1]);
            if pair[0] <= frame {
                break;
            }
            frame = pair[0];
        }
        Ok(ips)
    }
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    {
        let _ = tid;
        Err(StackError::Unavailable {
            reason: format!(
                "no register layout is defined for {}",
                std::env::consts::ARCH
            ),
            platform: "linux".to_string(),
        })
    }
}

/// `process_vm_readv` 读目标线程的栈。比自己解析 `/proc/<tid>/mem` 少一次 open。
#[cfg(target_os = "linux")]
unsafe fn read_memory(tid: libc::pid_t, address: u64, out: &mut [u64; 2]) -> bool {
    let local = libc::iovec {
        iov_base: out.as_mut_ptr() as *mut libc::c_void,
        iov_len: std::mem::size_of::<[u64; 2]>(),
    };
    let remote = libc::iovec {
        iov_base: address as *mut libc::c_void,
        iov_len: std::mem::size_of::<[u64; 2]>(),
    };
    let read = libc::process_vm_readv(tid, &local, 1, &remote, 1, 0);
    read as usize == std::mem::size_of::<[u64; 2]>()
}

#[cfg(not(target_os = "linux"))]
fn collect_instruction_pointers(_thread_id: u32) -> Result<Vec<u64>, StackError> {
    let support = stack_support();
    Err(StackError::Unavailable {
        reason: support.reason.unwrap_or_else(|| "unsupported platform".to_string()),
        platform: support.platform,
    })
}

pub fn now_ms() -> u64 {
    crate::state_probe::now_ms()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn platform_support_is_honest() {
        let support = stack_support();
        if !support.supported {
            let reason = support.reason.clone().unwrap_or_default();
            assert!(!reason.is_empty(), "an unsupported platform must explain why");
        }
        if cfg!(not(target_os = "linux")) {
            assert!(!support.supported, "only Linux has a register reader here");
        }
    }

    #[test]
    fn unavailable_capture_returns_a_documented_error() {
        if cfg!(target_os = "linux") {
            return;
        }
        let diagnosis = capture_main_thread_stack(std::process::id(), Some(1), 60_000, None);
        assert_eq!(diagnosis.status, "unavailable");
        assert!(diagnosis.frames.is_empty(), "no frames means no frames");
        let error = diagnosis.error.expect("the diagnosis must say why");
        assert_eq!(error.code(), "main_thread_stack_failed");
        assert!(error.describe().contains("unavailable"));
        assert_eq!(diagnosis.verdict, Verdict::Unknown);
    }

    #[test]
    fn a_missing_main_thread_id_is_unavailable_not_empty() {
        if !stack_support().supported {
            return;
        }
        let diagnosis = capture_main_thread_stack(std::process::id(), None, 60_000, None);
        assert_eq!(diagnosis.status, "unavailable");
        assert!(diagnosis.summary.contains("main thread id"));
    }

    /// 采自己的主线程：这一档在 Linux 上应当真的抓到帧；被权限挡住时必须诚实报
    /// Unavailable（CI 容器里 `ptrace_scope=1` 是常态）。
    #[test]
    fn sampling_the_current_thread_is_complete_or_unavailable() {
        if !stack_support().supported {
            return;
        }
        // SAFETY: gettid identifies the calling thread.
        let tid = unsafe { libc::syscall(libc::SYS_gettid) as u32 };
        let diagnosis = capture_main_thread_stack(std::process::id(), Some(tid), 60_000, Some(90.0));
        match diagnosis.status {
            "complete" => {
                assert!(!diagnosis.frames.is_empty());
                assert_eq!(diagnosis.verdict, Verdict::Busy);
                assert!(diagnosis.summary.starts_with("Stuck at"));
                assert!(diagnosis.frames[0].display.contains("+0x") || diagnosis.frames[0].method.is_some());
            }
            "unavailable" => {
                let error = diagnosis.error.expect("an unavailable capture carries its reason");
                assert!(!error.describe().is_empty());
                assert!(diagnosis.frames.is_empty());
            }
            other => panic!("unexpected status {other}"),
        }
    }

    #[test]
    fn verdict_thresholds_match_the_documented_cutoff() {
        assert_eq!(verdict_for(Some(BUSY_CPU_PERCENT)), Verdict::Busy);
        assert_eq!(verdict_for(Some(BUSY_CPU_PERCENT - 1.0)), Verdict::Waiting);
        assert_eq!(verdict_for(Some(0.0)), Verdict::Waiting);
        assert_eq!(verdict_for(None), Verdict::Unknown);
    }

    #[test]
    fn user_code_is_blamed_before_engine_frames() {
        let frames = vec![
            Frame {
                index: 0,
                kind: "managed",
                ip: "0x1".into(),
                method: Some("Update".into()),
                assembly: Some("UnityEngine.CoreModule".into()),
                module: None,
                module_offset: None,
                file: None,
                line: None,
                display: "UnityEngine.CoreModule!Update".into(),
            },
            Frame {
                index: 1,
                kind: "managed",
                ip: "0x2".into(),
                method: Some("Tick".into()),
                assembly: Some("Assembly-CSharp".into()),
                module: None,
                module_offset: None,
                file: Some("/proj/Assets/Game.cs".into()),
                line: Some(42),
                display: "Assembly-CSharp!Tick (/proj/Assets/Game.cs:42)".into(),
            },
        ];
        let (location, reason) = locate(&frames);
        assert_eq!(reason, Some("user_code"));
        assert_eq!(location.as_deref(), Some("Assembly-CSharp!Tick (/proj/Assets/Game.cs:42)"));
    }

    #[test]
    fn native_frames_are_reported_with_module_and_offset() {
        let frames = vec![Frame {
            index: 0,
            kind: "native",
            ip: "0x7f00".into(),
            method: None,
            assembly: None,
            module: Some("/opt/Unity/Editor/Unity".into()),
            module_offset: Some("+0x1a3c".into()),
            file: None,
            line: None,
            display: "/opt/Unity/Editor/Unity+0x1a3c".into(),
        }];
        let (location, reason) = locate(&frames);
        assert_eq!(reason, Some("native"));
        assert!(location.unwrap().ends_with("+0x1a3c"));
    }

    #[test]
    fn summary_says_stuck_at_the_location() {
        let summary = summarize(
            7,
            Some("Assembly-CSharp!Awake"),
            Some("user_code"),
            Verdict::Busy,
            Some(97.4),
        );
        assert!(summary.contains("Stuck at Assembly-CSharp!Awake"));
        assert!(summary.contains("busy"));
        assert!(summary.contains("97%"));
        assert!(summary.contains("7 frames"));

        let unknown = summarize(1, None, None, Verdict::Unknown, None);
        assert!(unknown.contains("Stuck at an unnamed frame"));
        assert!(unknown.contains("could not be measured"));
    }

    #[test]
    fn diagnosis_serializes_for_the_client() {
        let diagnosis = Diagnosis::unavailable(
            std::process::id(),
            StackError::Unavailable {
                reason: "no ptrace".to_string(),
                platform: "linux".to_string(),
            },
            45_000,
        );
        let encoded = serde_json::to_value(&diagnosis).unwrap();
        assert_eq!(encoded["status"], "unavailable");
        assert_eq!(encoded["verdict"], "unknown");
        assert_eq!(encoded["heartbeatAgeMs"], 45_000);
        assert_eq!(encoded["error"]["kind"], "unavailable");
        assert!(encoded["frames"].as_array().unwrap().is_empty());
    }
}