# DSH 插件扮演 Locus 客户端 —— 研究结论与实现设计

> 依据源码：`Locus/`（commit `4ee37ed0`，src-tauri `0.9.3`）。
> 结论一句话：**可行的路径只有一条——实现 Locus 原生 broker 的 Windows 命名管道客户端**；不要走 Tauri 内部的 `UnityPipeConnection`，也不需要 Unity 端改一行代码（只要它加载了 `locus_unity_native.dll`）。

> 研究时打过一次 `mcp__godot-ai__editor_state` 作探测（本机只装了一个叫 "Godot AI MCP" 的 MCP server，没有 Unity MCP，直接返回未连接）。Locus/Unity 走的是自己的命名管道，不是 MCP。


---

## 1. 先纠正一个前提

Locus 不是「Unity 做服务端、桌面做客户端」的普通前后端：

- **Unity 端服务 = 宿主内 broker（Rust dll）+ C# 执行器**。`LocusBridge.cs` 通过 P/Invoke 加载 `locus_unity_native.dll`，DLL 在 **Unity 进程内**起一个 Windows 命名管道服务端，并且靠「DLL 常驻」跨域重载存活（`locus_unity_native/src/lib.rs`、`crates/locus-native-broker/src/server.rs`）。
- **Locus 桌面端（Tauri 前端）= 客户端 + Agent 大脑**。工具 `unity_execute` 等最终都是「连管道 → 发一行 JSON → 等 `reply_to` 响应」（`src-tauri/src/unity_bridge/transport.rs`）。
- 所以「DSH 插件扮演 Locus 客户端」= **让 DSH 去当 `transport.rs` 那个角色**：DSH 插件里的代码连上管道，用 Locus 的 JSON 协议调用 Unity。Locus 桌面 `/view`、`/skill`、知识系统、hot-reload 面板、Tauri UI 这些**都不会出现**，DSH 只是拿走了「跨进程调用 Unity 的能力」。

结论：Unity 端完全不用改（前提：Unity 里装了 Locus 插件 + 原生 DLL 已就位 + 原生桥已启用，见 §3）。

---

## 2. 传输与协议（照抄就能互通）

### 2.1 管道名

```
\\.\pipe\locus_unity_native_<sha256(normalize(projectRoot)).hex[0:32]>
```

`normalize`：去掉 `\\?\` 前缀 → `/`→`\` → 去尾部 `\`（长度 ≤3 时保留，如 `c:\`）→ 全小写（`crates/locus-native-protocol/src/names.rs`，与 `LocusBridge.Native.cs::GenerateNativePipeName` 逐字节一致）。

- Unity 侧若存在 `<Project>/Library/Locus/NativeBridge.enabled`，会读取其**第一行**作为管道名（允许带 `\\.\pipe\` 前缀）。所以最稳的做法是：调用方显式传 `projectRoot` 或 `pipe`，优先读 marker 文件。
- 设 `LOCUS_UNITY_TEST_PIPE_NAMESPACE` 等价于管道名后缀 `_<ns>`，用于和正式 Locus 桌面实例隔离（`mod.rs::get_native_pipe_name`）。
- **多客户端**：broker 支持 `broker_multi_client_v1`，Locus 桌面和 DSH 可**同时**连接，互不干扰（响应回到发起连接，事件广播给所有人）。

### 2.2 帧格式

- UTF-8、**按字节管道（`PipeMode::Byte`）**、**每行一个 JSON**（`\n` 结尾），BOM/首尾空白会被容忍。
- 请求：`{"id":"req-<pid>-<seq>","type":"<command>","message":"<string>"}`
- 响应：`{"reply_to":"<id>","type":"response","ok":true|false,"message":"...","error":"...","processId":N,"processPath":"..."}`
- 事件（无 `reply_to`，广播）：`{"type":"locus-request-accepted","ok":true,"message":"{\"requestId\":\"..\",\"requestType\":\"..\"}"}` 等。
- **`message` 永远是字符串**：参数要么是纯文本，要么是把 JSON `to_string()` 后塞进字符串（Unity 端用 `JsonUtility.FromJson` 解析），不是嵌套对象。
- 前置 hello：Unity 宿主的 `auth_token` 为空 → **不需要** hello。Blender 宿主才有 token，Unity 没有。
- 限制：单请求 ≤ 16 MiB；待处理请求 ≤ 128 条 / 32 MiB；在途 ≤ 64；普通请求 deadline 10 分钟，执行类 2 小时；客户端未读响应超过 256 MiB 会被断开（响应**从不丢弃**：客户端不在就广播给其他连接，所以重连后仍能拿到）。
- 错误码（`crates/locus-native-protocol/src/errors.rs`）：`managed_reloading` / `managed_not_ready` / `unity_process_exiting` / `native_queue_full` / `native_inflight_full` / `native_main_thread_unresponsive` / `domain_reload_interrupted` / `native_payload_too_large` / `native_request_timed_out`。其中前 7 种**表示请求未执行、可安全重试**（`errors::is_not_executed`）。

### 2.3 broker 直接应答的命令（不经 C#，域重载期间也可用）

| type | message | 返回 |
|---|---|---|
| `ping` | `""` | `pong` |
| `status` | `""` | `"editing"` / `"playing"` / `"playing_paused"`，可带 `"|Assets/Scenes/Main.unity|..."`（活动场景 + 附加场景，`|` 分隔）。重载中返回错误而非卡住 |
| `bridge_capabilities` | `""` | 逗号拼接的 capability 串（`broker_v1,broker_request_state_v1,...,broker_compile_result_v1,managed_executor_v1,...`） |
| `request_state` | `["id1","id2"]` | `{"id1":"queued","id2":"none"}`，用于响应丢失检测 |
| `main_thread_stack` | `{...}` | 卡死主线程时的原生/托管栈采集 |
| `get_compile_result` | `operation_id` | Unity 专用：`starting`/`pending`/`ok`/`not_needed`，或 `error:<诊断>`；operationId 不匹配 → `recompile_result_operation_mismatch` |
| `cancel_execute_code` | `execution_id` | 先置取消信号再入队 |

其余命令全部进队列交给 C# 主线程执行器（`LocusBridge.cs::HandleMessageAsync`）。

### 2.4 最重要的执行命令：`execute_code`

- `message` = **C# 方法体源码**（不是 JSON）。可带两个「哨兵注释行」：
  - `//__LOCUS_EXECUTION_ID__:<uuid>` —— **必须带**，否则取消/重挂靠/进度都对不上；
  - `//__LOCUS_TIMEOUT_MS__:<ms>` —— 总预算，Unity 侧自己执行（默认 600000，夹取 1000..3600000）。
- **30 秒静默即杀**：snippet 连续 30s 没有 `print` / `printJson` / `ctx.Progress` 输出就会被停止（`ExecuteTimeoutMs = 30000`）。横跨多帧的长任务必须分块输出或每块 `await ctx.WaitFrame()`。
- 进度/取消（可选的「脚手架」，但只有它们能让 `ctx.Progress`、`print` 流式回传并发起取消）：
  1. `execute_code` 发出后，每 250ms 发 `execute_code_progress`，`message` = `execution_id`；
  2. 需要取消时发 `cancel_execute_code`，`message` = `execution_id`；
  3. 连接断了，用 `execute_code_wait`（`message` = `execution_id`）**重挂靠**到仍在跑的执行，拿最终响应。执行请求是 `reattachable`，重连后结果会广播到新连接。
  4. 进度轮询本身也刷新「客户端还活着」的心跳——托管侧有机制防止客户端失联后 snippet 无限跑。
- 另有 `execute_loaded`：`{"assembly_b64"|"assembly_path","entry_type","execution_id","source_code","timeout_ms"}`，即把 **Locus compile server（locus_compile_server，Roslyn sidecar）** 编译出的程序集交给 Unity 加载执行。这是 Locus 的「非 public 成员直接访问 / 编译期诊断」通道。DSH 若没有这个 sidecar，就默认走 in-Unity 编译路径（`execute_code`）。
- 结果在 `response.message`：print 出来的文本；错误在 `response.error`（含编译错误、超时、取消等）。

### 2.5 域重载（domain reload）是一等公民

- C# 改完 → `request_recompile`（`message` 可为空，或 `{"schema":1,"syncMode":"none|targeted|full","paths":[...],"reason":"..","operationId":".."}`）→ **可能断线**。重载期间 broker 回答 `managed_reloading`，不卡死。
- 编译结果用 `get_compile_result` 轮询（broker 直答，主线程被占也能答）；`get_reload_state` 返回 `session_id / domain_generation / converged_serial / is_compiling / is_updating`（需主线程）。
- **客户端必须自己重连**：`LocusBridge.Native.cs` 在重载前把状态置 `Reloading`，重载后 generation+1 重新注册 `Ready`。DSH 逐出连接后按退避重连即可（参考 Tauri 的 `NATIVE_CONNECT_RETRIES=3` + 100ms 递增）。

### 2.6 其他好用的 C# 命令（按需接入）

`get_console_text` / `unity_get_console_log`（`{level|levels, limit}` → 合并后的 Console 条目）、`exit_play_mode`、`set_editor_status`、`import_assets`（`\n` 分隔路径）、`begin_edit_session` / `end_edit_session`（owner 字符串，抑制 Auto Refresh，避免磁盘改动在编辑中途触发导入/编译）、`search_scene_objects`、`property_tree_read`（`{target, maxDepth, maxArrayItems}`）及其 write/apply/discover、`asset_api`（含 array_insert/remove/move/resize 等）、`read_yaml` / `search_yaml`、`capture_viewport` / `capture_spatial_snapshot`、`asset_thumbnail`、`hot_reload_*`（Locus 热更，涉及 Detour，不建议首版）、`run_states`（逐帧反射采样）。

---

## 3. Unity 端前提（不改代码，但要保证）

1. `locus_unity/` 作为 Unity 包引入（`com.farlocus.locus`），`Locus.Editor.asmdef` 会 `[InitializeOnLoad]`。
2. **原生 broker DLL 就位**：`locus_unity/Editor/Native/x86_64/locus_unity_native.dll`（不在仓库里，需 `bun run unity:bundle-native` 构建；仓库内是源码 `locus_unity_native/`）。
3. **原生桥已启用**：`<Project>/Library/Locus/NativeBridge.enabled` 存在，或 Unity 编辑器进程环境变量 `LOCUS_UNITY_NATIVE_BRIDGE=1`。
4. 平台：broker 与下单管道是 **Windows-only**（`locus-native-broker` 只实现了 Win32 管道 / tokio `windows::named_pipe`）。
5. 可选：`Library/Locus/BackgroundHook.enabled` —— 让 Unity 窗口不在前台时仍持续 tick（否则主线程心跳停滞，broker 会以 `native_main_thread_unresponsive` 拒绝请求）。注意它是对 `Unity!IsApplicationActive` 的代码补丁，只用 DSH 时可不开，但 Unity 失焦后请求会被拒。

---

## 4. DSH 插件设计

### 4.1 总体形状

```
Unity Editor ──(\\.\pipe\locus_unity_native_<key>)── DSH plugin (Node)
                                                          │
                                     LocusClient (frame I/O, 重连, 进度轮询, 取消)
                                                          │
                          defineTool: locus_status / locus_execute / locus_play_mode ...
```

关键点：DSH 插件是 **Node.js**。**不要**用 `net.connect` 连 Windows 命名管道——Node 的 `net` 只支持 Unix socket / TCP，不支持 Win32 pipe 路径。两个可行方案：

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| **A（推荐，纯 Node）** | 用 **`node:fs` 打开 `\\.\pipe\...`** 当文件读写（Win32 下 CreateFile 对命名管道有效）：`fs.openSync(pipe,'r+')` → `fs.writeSync(fd, encoded)` → 读用 `fs.readSync` 循环拼行（阻塞，放 `setImmediate`/worker_threads 里） | 零原生依赖、无构建步骤、Windows 即可用 | 阻塞 I/O 要用 worker 或子进程跑；`fs` 对管道没有事件驱动（不能 epoll），需要小 tick 轮询；写在同 fd 上需串行化 |
| B（稳妥，子进程） | 插件 spawn 一个极小的 helper（Rust/Go/C# 任选其一），helper 走真正的 Win32 管道 I/O，DSH 与 helper 之间用 `stdin/stdout` 行协议 | 非阻塞、可 `PeekNamedPipe`/overlapped I/O | 多一个二进制，需按平台打包；Windows-only 二进制 |

> 更省事的第三条路：参考 `scripts/native-dll-exports.mjs` 思路，直接复用 Locus 仓库的 `crates/locus-native-protocol` **只做类型/管道名计算**；但 Rust 侧没有现成的「客户端连接器」导出（broker 只有服务端），所以 Rust 方案等于方案 B 自写。

### 4.2 连接器要点（无论 A/B）

```
connect(projectPath | pipeName)
  ├─ 解析管道名：显式 pipe > <project>/Library/Locus/NativeBridge.enabled 第一行 > 计算名
  ├─ open，失败（ERROR_PIPE_BUSY 231）→ 100·n ms 退避重试，与 Tauri 一致
  ├─ 发送 {"id",type:"ping"}，10s 内无响应视为不可用
  ├─ 后台读循环：按 \n 切帧 → 解析 JSON
  │    ├─ reply_to 存在 → 结束对应 pending（同时结束它的 acceptance 等待）
  │    ├─ type == "locus-request-accepted" → 标记 accepted
  │    └─ 其他 → 广播事件（缓存上限 64 条类型化，与 broker outbox 对齐）
  ├─ 请求：id = `dsh-<pid>-<seq>`；pending Map<id, {resolve, accept, timer}>
  └─ 断线：所有 pending 失败为 transport_error；指数退避重连（1s,2s,5s,10s,30s）
```

**幂等/可重试**：收到 `errors::is_not_executed` 里的错误码时，请求肯定没进执行器，可以安全重发；`domain_reload_interrupted` 表示执行被重载打断（是否重发由调用方决定）。`request_state` 可以在超时前探一下「是否还 queued/inflight」，避免把「响应丢了」误判成「没执行」。

### 4.3 工具集（DSH `defineTool`，参数用 raw JSON Schema）

DSH 的 `defineTool` 支持原样传入 `properties: Record<string, JsonSchemaNode>` 与 `required?: string[]`（`dsh-tools/lib/types/json-schema.d.ts`），所以可以直接复用 Locus 的 `tools/*.json`（`unity_execute.json`、`unity_set_play_mode.json`、`unity_get_console_log.json` …），title/description 无需改写。

建议首版 4 个工具：

| DSH 工具 | 对应 Locus 语义 | 底层命令序列 |
|---|---|---|
| `locus_status` | 连接 + 编辑器状态 | `status`（失败则 `bridge_capabilities` 判断 reloading） |
| `locus_execute` | `unity_execute` | `status` 校验 `request_editor_status` 与 `readonly` → 自动 `begin/end_edit_session`（非 readonly）→ `execute_code`（拼哨兵行）+ 250ms `execute_code_progress` + 支持 `exec_signal` 取消 → 取消时 `cancel_execute_code` |
| `locus_play_mode` | `unity_set_play_mode` | `status` → `set_editor_status`/`exit_play_mode` → 轮询 `status` 直到目标态（参考 `format_play_mode_tool_result` 文案） |
| `locus_console` | `unity_get_console_log` | `unity_get_console_log`（JSON 参数） |

第二阶段：`locus_recompile`（`request_recompile` + `get_compile_result`/`get_reload_state` 轮询 + **重连**）、`locus_import_assets`、`locus_asset_api`、`locus_property_tree_*`、`locus_capture_viewport`。

### 4.4 与 Locus 桌面 Agent 行为对齐的关键点（照抄才能「无感」）

1. `request_editor_status` 不匹配时**不要自动切模式**，直接报错（`unity_execute` 行为：`Unity Editor status is "playing". unity_execute requires "editing".`）；切模式用 `locus_play_mode`。
2. `readonly=true` 表示「只观察」，DSH 侧应据此拒绝写类命令、跳过 edit session；`readonly=false` 时包 `begin_edit_session(owner)` … `end_edit_session(owner)`，owner 用 DSH session id（多客户端隔离由 Unity 的 owner 集合保证）。
3. **C# 文件改动**不要走 `execute_code`（`execute_code` 说明里明确：`.cs` 改动/导入会触发域重载，把 snippet 干掉）→ 用 `write` 工具改文件 + `locus_recompile`。
4. 30 秒静默限制写进工具 description，并提示 `ctx.Progress` / `WaitFrame` 分块法（DSH 可以用子 agent 但这里只是提示）。
5. `enable_non_public_access`：DSH 没有 Locus compile server 时该参数只能置灰/忽略，并在 description 注明「in-Unity 编译不支持 private 成员直访」。若要完整支持，需要把 `locus_compile_server`（.NET sidecar，stdio 协议见 `StdioTransport.cs`）也接进来——工作量约等于半个客户端，不建议首版。

### 4.5 生命周期

- `ctx.plugin(...)` 注册工具；工具 execute 时按 `projectRoot`（从 `args.project_path` 或 DSH 当前工作目录）懒建连接，**进程内复用单条连接**（与 Tauri 的 `CONNECTIONS` Map 一致）。
- 插件 `dispose()`：发 `end_edit_session`（如持有）、关闭 fd、清理定时器。
- **单实例并发**：同一 broker 上 DSH 和 Locus 桌面可共存；但两个客户端同时 `execute_code` 会串行（Unity 侧串行执行），进度/取消按 `execution_id` 隔离。
- 进程重启：DSH 断线 → `managed_not_ready`/连接失败 → 重连到新 generation 的 broker。**不要在收到 `domain_reload_interrupted` 后无限重试**——先 `status` 确认 `managedState==ready`。

---

## 5. 骨架代码（Node，方案 A 写法示意）

```ts
// locus-bridge/client.ts
import { openSync, readSync, writeSync, closeSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isWindows } from './platform'

export function pipeNameFor(projectRoot: string): string {
  const norm = projectRoot.replace(/^\\\\\?\\/, '').trim().replace(/\//g, '\\')
  const trimmed = norm.replace(/\\+$/, m => norm.length - m.length <= 3 ? m : '')
  const key = createHash('sha256').update(trimmed.toLowerCase()).digest('hex').slice(0, 32)
  return `\\\\.\\pipe\\locus_unity_native_${key}`
}

export class LocusClient {
  private pending = new Map<string, { resolve: (v: Envelope) => void; reject: (e: Error) => void }>()
  private seq = 0

  constructor(private readonly pipe: string) {}

  async connect(timeoutMs = 10_000) { /* openSync(pipe, 'r+'); startLinePump(); ping */ }

  request(type: string, message = '', timeoutMs = 60_000): Promise<Envelope> {
    const id = `dsh-${process.pid}-${++this.seq}`
    // 串行写入（writeSync 在本 fd 上需互斥）
    writeSync(this.fd, Buffer.from(JSON.stringify({ id, type, message }) + '\n'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('locus_timeout')) }, timeoutMs)
      this.pending.set(id, { resolve: v => (clearTimeout(timer), resolve(v)), reject })
    })
  }
}
```

读循环：在 Windows 上 `fs` 对管道不可读会直接抛 `EAGAIN/EOF`，所以用 **worker_threads + 阻塞 `readSync` 缓冲 8KB**，主线程只收 `postMessage` 切好的行；或者改用方案 B 的小 helper。**不要**在工具 execute 里同步读管道（会卡住 DSH 事件循环）。

DSH 工具注册（参考 `dsh-tools` README）：

```ts
import { readFileSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'

const spec = JSON.parse(readFileSync('./tools/unity_execute.json', 'utf8'))

ctx.tools.register(defineTool({
  name: 'locus_execute',
  description: spec.description,
  parameters: spec.parameters.properties,   // JsonSchemaNode 原样透传
  required: spec.parameters.required,
  async execute(args, exec) {
    const client = await ctl.clientFor(args.project_path ?? cwd())
    return runExecute(client, args, exec.signal)  // 返回 string
  },
}))
```

> 需要确认当前 DSH `defineTool` 版本是否接受 `parameters` 直接传 JSON Schema 对象（而不是 DSL spec）。若接受，就不要手抄 schema；若只接受 DSL，用 `json` 类型 + `description` 也能表达，但 `enum`/`minimum` 等约束会丢失，建议升级到支持 `JsonSchemaNode` 的版本。

---

## 6. 风险与边界（必须先知道的）

| 风险 | 说明 | 对策 |
|---|---|---|
| **平台** | broker 是 Windows-only；macOS/Linux 版 Unity 上压根没有 `locus_unity_native.dll` | 插件在非 Windows 时报「Locus native bridge unavailable」；需求上不能承诺跨平台 |
| **Locus 桌面在场时** | 桌面的 Undo/VCS 快照、hot reload 状态、`/view` 都依赖它自己的客户端；DSH 的操作对桌面是「外部修改」 | 可接受：桌面会在 `get_reload_state` 收敛；但要提醒用户别开两个 Agent 同时改 |
| **没有 Locus compile server** | `enable_non_public_access=true` 走不通；编译错误要等 Unity 自己编（`request_recompile`），不走 sidecar 的毫秒级诊断 | 首版置灰；后续再接 `locus_compile_server` 的 stdio |
| **`ManagedCapabilities` 依赖** | `get_compile_result` 的 broker 直答只在 managed 侧 publish 过之后生效；旧插件会回落到 C# 路径 | 用 `bridge_capabilities` 探测 `broker_compile_result_v1` |
| **主线程卡死** | 心跳停滞 >30s（失焦、长 import、阻塞 C#）→ 请求被拒 `native_main_thread_unresponsive` | 读 `main_thread_stack` 诊断；提示开 `BackgroundHook.enabled` |
| **重载边界** | `begin_edit_session` 期间文件改动不导入；域重载会断开 | 与 Tauri 一样：写文件 → `request_recompile` → 逐出连接 → 重连 → `get_compile_result` |
| **协议是内部实现细节** | 不是公开 API，随 Locus 版本演进（已有 capability 版本协商） | 锁定参考 commit；启动时用 `ping` + `bridge_capabilities` 版本闸门 |

---

## 7. 备选路线（为什么不推荐）

- **让 Unity 装 MCP server**：Unity 侧没有现成 MCP；要么写一个 MCP 适配器再包一层 broker 协议（多一层、多一个进程、还要 DSH 的 MCP 客户端），要么改插件——都不如直接当客户端。
- **驱动 Locus 桌面 CLI/headless**：`src-tauri/src/cli_driver.rs` 有 CLI，但依赖桌面二进制与项目配置；DSH 变成「控制 Locus 桌面的插件」，语义上不是「Locus 客户端」。
- **直接改了 Locus 桌面做成 MCP**：README 第 47 行明确说设计成 MCP server 很多特性做不了；我们只是复用它已有的客户端协议，不碰它的设计。

---

## 8. 最小验证清单（拿到 Windows + Unity 后按顺序）

1. `python -c` 算管道名，对比 Unity Console 里 `[Locus] Native broker bridge active` 的管道名。
2. Node（或 Go）打一帧 `ping`，看 `pong`；再 `bridge_capabilities`。
3. `execute_code` + `//__LOCUS_EXECUTION_ID__:<uuid>` 执行 `print(Application.dataPath);`，核对 250ms `execute_code_progress` 的返回。
4. 取消路径：`Thread.Sleep(5000)` 的 snippet + `cancel_execute_code`，确认 5s 内结束并返回取消错误。
5. 重载路径：改一个 `.cs` → `request_recompile` → 观察断线 → 重连 → `get_compile_result` 直到 `ok`。
6. 与 Locus 桌面同时连接，确认两者都能收发（`broker_multi_client_v1`）。

（当前工作机是 Linux，仓库与协议已读透，但 1–6 的实机步骤需要在 Windows 上完成。）

---

## 9. 实现状态

插件位于仓库根目录（`src/`、`test/`、`scripts/`，见 [`README.md`](../README.md)），共 7 个工具：

| 工具 | 状态 | 实现要点 |
|---|---|---|
| `unity_status` | 完成 | `status` + `bridge_capabilities` + `get_reload_state` |
| `unity_execute` | 完成 | 状态闸门、edit session、`execute_code` + 250ms 进度轮询、`cancel_execute_code`、有界清理 |
| `unity_play_mode` | 完成 | `set_editor_status` + 30s 收敛轮询 |
| `unity_console_log` | 完成 | `unity_get_console_log` |
| `unity_recompile` | 完成 | `request_recompile` → 断线 → 重连 → 轮询 `get_compile_result`；接管 `recompile_in_progress`、识别 `superseded`/`error` |
| `unity_asset` | 完成 | `asset_api` read / apply_batch（revision 守卫、值编码含对象引用）/ undo（反向批次）/ disk_reload |
| `unity_scene` | 完成 | `search_scene_objects`、`property_tree_read`、原子 set（生成 `execute_code`：解析 → Undo → 写属性 → 保存场景 → 打印 JSON） |

验证：
- 45 个测试（`node --test --test-concurrency=1 "test/*.test.js"`），假 broker 覆盖重连、接管编译、取消、超时、断线、资产修订守卫/undo、场景 set、edit session 顺序、Console 渲染。
- 工具 schema 同时通过本仓库子集校验（`dump-tools.mjs`）与真实 DSH 的 `defineTool`/`validateArgs` 校验（`validate-dsh-tools.mjs`）。
- `scripts/typecheck.mjs` 做跨模块 import/调用一致性检查（无 TypeScript）。

仍待实机确认（Windows + Unity）：Win32 管道读写、worker 阻塞读循环、失焦心跳、真实 `request_recompile` 跨重载时序，用 `node scripts/live-smoke.mjs --project <项目>`（可加 `--recompile`）。

未实现：Locus compile server 路径（`enable_non_public_access`、`execute_loaded` 的 sidecar 编译）、hot-reload 系命令、`run_states` 逐帧采样、`capture_viewport`、`/view` 与知识系统。
