# dsh-locus-bridge

一个 **DSH 插件**：让 DSH 直接扮演 **Locus 客户端**，通过 Locus 原生 broker 操作 Unity 编辑器 —— 不需要启动 Locus 桌面程序，Unity 端也不需要改一行代码。传输层随平台选择：Windows 用命名管道，Linux/macOS 用 Unix 域套接字（配合 `Locus/locus_unix_native` 的 broker 移植）。

```
Windows:  Unity Editor ──(\\.\pipe\locus_unity_native_<key>)──────── worker(fs 阻塞 I/O) ── LocusClient ── DSH 工具
Linux:    Unity Editor ──(<runtime>/locus/locus_unity_native_<key>.sock)── worker(net 流)      ── LocusClient ── DSH 工具
```

两条传输共用同一套换行 JSON 协议、`reply_to` 路由与错误码，插件其余部分（重连、`edit session`、撤销守卫）完全一致。

> 研究依据与完整协议说明见 [`docs/locus-client-bridge.md`](docs/locus-client-bridge.md)（对应 `Locus/` checkout，src-tauri `0.9.3`）。

## 工具

| 工具 | 作用 | 底层指令 |
|---|---|---|
| `unity_status` | 连接检查、编辑器状态（editing/playing/playing_paused）、打开的场景、capabilities、域重载状态 | `status` / `bridge_capabilities` / `get_reload_state` |
| `unity_execute` | 在 Unity 主线程编译并执行 C# 方法体（`print`/`printJson`/`ctx.Progress`/`ctx.WaitFrame`），逃生口 | `status` → `begin_edit_session` → `execute_code` + 250ms `execute_code_progress` →（取消）`cancel_execute_code` → `end_edit_session` |
| `unity_play_mode` | 切换到 Play/Edit 模式并等待生效 | `status` → `set_editor_status` → 轮询 `status` |
| `unity_console_log` | 读取 Unity Console（按级别合并去重） | `unity_get_console_log` |
| `unity_recompile` | 编译 + 域重载 + 跨断线等待收敛；支持 `sync: none/targeted/full` 资产导入 | `request_recompile` → 断线 → 重连 → 轮询 `get_compile_result` |
| `unity_asset` | 资产序列化读取 / 带 revision 守卫的原子编辑（`set` 与数组操作）/ undo / reload | `asset_api`（read / apply_batch / disk_reload） |
| `unity_scene` | 场景对象 search / get（属性树）/ 原子 set（Undo、保存场景） | `search_scene_objects` / `property_tree_read` / 生成的 `execute_code` |

与 Locus 桌面 Agent 对齐的行为：

- `request_editor_status` 必须与实际状态一致，否则直接报错（不自动切模式；切模式用 `unity_play_mode`）。
- 写操作（`unity_execute` 非 readonly、`unity_asset apply`、`unity_scene set`）自动打开 owner 级 `begin_edit_session`，最后一个写工具结束时 `end_edit_session`（抑制 Auto Refresh，避免写入过程中触发导入/编译）。
- `unity_recompile`：域重载期间连接会断，插件自动重连并继续轮询 `get_compile_result`；遇到 `recompile_in_progress` 会**接管**正在进行的编译；`superseded` 表示用户 Ctrl+R 等其他编译占用了结果寄存器。
- `unity_asset`：编辑必须带读取得到的 `snapshot`（或 `expected_revision`），修订号不一致时 Unity 拒绝写入（`revision_conflict`）；undo 依据读取到的旧值生成反向批次，同样带修订号守卫。
- `unity_scene set`：一次 `execute_code` 完成「解析对象 → Undo → 写 SerializedProperty → 标记并保存场景 → 打印结果」，类型必须已在加载的程序集中（改完 C# 先 `unity_recompile`）。
- 进度轮询同时充当「客户端还活着」的心跳：Unity 会在 snippet **30 秒无输出**时强制停止。
- DSH 调用取消 → `cancel_execute_code` + 500ms 有界等待；断线（域重载）→ 返回错误结果，下一次调用自动重连。

## 前提条件（Unity 端，无需改动）

1. 项目已安装 Locus Unity 包（`com.farlocus.locus`）。
2. `locus_unity/Editor/Native/x86_64/locus_unity_native.dll` 存在（仓库中由 `bun run unity:bundle-native` 构建）。
3. 原生桥已启用：`<Project>/Library/Locus/NativeBridge.enabled` 存在（内容第一行可指定管道名），或编辑器进程环境变量 `LOCUS_UNITY_NATIVE_BRIDGE=1`。
4. **broker 与平台匹配**：Windows 用 `locus_unity_native.dll`（Win32 命名管道）；Linux/macOS 用 `liblocus_unity_native.so`（Unix 域套接字，即 `Locus/locus_unix_native` 的移植，随包放在 `locus_unity/Editor/Native/linux-x86_64/`）。
5. 可选：`Library/Locus/BackgroundHook.enabled` —— Unity 窗口失焦时仍持续 tick；否则主线程心跳停滞 >30s 后 broker 会拒绝请求（`native_main_thread_unresponsive`）。

管道名默认为 `\\.\pipe\locus_unity_native_<sha256(规范化项目路径)[0:32]>`，与 Locus 桌面端逐字节一致（`src/pipe-name.js`），也可显式指定。

## 安装到 DSH

插件只依赖 Node 内置模块（`node:worker_threads` / `node:fs` / `node:net`），不需要安装任何 npm 依赖。

```bash
dsh plugin --profile <profile> add /path/to/dsh-locus-bridge
```

然后在 profile 的 `cordis.patch.yml` 中启用（插件导出 `name` / `inject: ['tools']` / `apply` / `registerLocusTools`）：

```yaml
- name: dsh-locus-bridge
```

安装后模型会看到上面 7 个以 `unity_` 开头的工具。

`project_path` 的解析对齐 Locus 桌面端（`unity_bridge::is_unity_project` + `cli_driver::resolve_project_path`）：

1. 显式 `project_path`（绝对路径，或相对 Session 工作目录）——**并校验**目录同时含 `Assets/` 与 `ProjectSettings/`；
2. 否则读 Session 工作目录**及其祖先目录**里最近的 `.locus.json` / `locus.json` 的 `project` 字段；
3. 否则若 Session 工作目录本身就是 Unity 工程，就用它；
4. 否则在 Session 工作目录**向下最多三层**找 Unity 工程（例如仓库根的 `unity-test/`）。广度优先，**最浅的那一层优先**——三层深处才找到的工程不会和一层深处找到的冲突；
5. 同一最浅层有多个 → 报错列出候选；三层内一个都没有 → 报错提示传 `project_path`。

### 让 agent 免于每次询问

第 2 步是为了满足「AI 自行选择工程，而不是每次问人」。在仓库根放一个 `.locus.json`（支持 `//` 与 `/* */` 注释）：

```json
{
  // 本仓库驱动的 Unity 工程
  "project": "unity-test"
}
```

`project` 相对该配置文件解析。之后所有 `unity_*` 调用都可以省略 `project_path`，即使 agent 从子目录发起调用（会向上找到仓库根的配置）。若仓库里有多个 Unity 工程，写这一行即可避免歧义报错。

配置指向的目录不是 Unity 工程时**报错而不是忽略** —— 悄悄回退会让 agent 重新去猜，正是这个字段要消除的行为。也可以只在 `AGENTS.md` 里点名工程（DSH 会自动加载 `AGENTS.md` / `CLAUDE.md`），但 `.locus.json` 更强：它是机器可读的，任何工具都能用。

搜索会跳过 `.git`、`node_modules`、Unity 的 `Library/Temp/Obj/Logs/UserSettings` 等生成目录，且**不会深入已识别的工程内部**（工程自己的 `Packages/` 里嵌套的包不算候选）。符号链接不跟随，理由与下面 `realpath` 那条相同。

桌面端没有第 3 步（它只有「显式 `--project`」或「GUI 当前聚焦的 workspace」）。这里放宽一步，是因为 DSH 的 Session 通常起在仓库根而不是 Unity 工程内。路径只做 `resolve()` 折叠 `.`/`..`，**不做 `realpath`**：Unity 用它打开时的路径派生 broker key，跟随符号链接反而可能与编辑器不一致。

> 关于 schema：DSH 的 `defineTool()` 用**参数 DSL** 编译 `parameters`（对象节点必须显式 `additionalProperties`、自由 JSON 值用 author-only 的 `type: 'json'`、`required` 只能写在隐式参数属性上），而本插件直接以符合该子集的 JSON Schema 对象书写（隐式参数根、`required: true` 标注、`json` 自由值），`ctx.tools.register` 接受这种定义（与 MCP 桥接一致），`scripts/dump-tools.mjs` 按同一子集校验。若要让 `defineTool` 再编译一遍，用 `registerLocusTools(defineTool)`；`scripts/validate-dsh-tools.mjs` 已用真实 DSH 验证全部 7 个工具。

## 开发与验证（在 Linux/macOS 上也能跑）

```bash
node --test --test-concurrency=1 "test/*.test.js"   # 69 个测试（含假 broker 的 Stream 通道与真 Unix socket）
node scripts/dump-tools.mjs                          # 工具 schema 是否在 DSH 支持子集内
node scripts/typecheck.mjs                           # 跨模块 import/调用一致性（纯 ESM，无 TS）
DSH_TOOLS_PATH=/abs/.../dsh-tools/lib/index.js \
  node scripts/validate-dsh-tools.mjs                # 用真实 DSH 编译+校验参数
node scripts/live-smoke.mjs --project "F:/Projects/Game" [--recompile]   # 真机冒烟（Windows 管道 / Linux 套接字均可）
```

- `test/fake-broker.js` 实现了一个按 broker 语义应答的假服务端（`ping`/`status`/`capabilities`/`execute_code`/`asset_api`/`property_tree_read`/`recompile` 寄存器/事件广播），并能在「域重载」后接受新连接；`LocusClient` 的 `stream` 测试缝对着它，覆盖重连、接管编译、取消、超时、断线、资产修订守卫与 undo、场景 set、edit session 顺序、Console 渲染等。
- `scripts/live-smoke.mjs` 在真机上依次验证连接、capabilities、执行、Console、资产读取、场景搜索（可选重编译）与取消。

## 目录

```
src/
  index.js         DSH 插件入口（name/inject/apply + registerLocusTools）
  tools.js         7 个工具定义与结果渲染（无 DSH 依赖）
  locus-client.js  管道客户端：reply_to 路由、事件、pending 表、Stream 测试缝
  client-pool.js   按管道名复用连接、重连、owner 级 edit session、关停
  pipe-worker.js   worker 线程：独占阻塞句柄
  pipe-io.js       Win32 命名管道 fs I/O（open/read/write/close）
  socket-io.js     Unix 域套接字 I/O（net 连接、分帧、EOF/背压）
  line-framer.js   换行分帧（跨 chunk、BOM/CR、超长帧保护）
  protocol.js      协议常量/错误码/状态解析/哨兵行/超时夹取
  execute.js       execute_code 流程（状态闸门、轮询、取消、有界清理）
  recompile.js     request_recompile → 断线 → 重连 → get_compile_result 收敛
  asset-api.js     asset_api 请求构造（revision 守卫、值编码）
  scene.js         场景搜索 / 属性树读取与渲染
  scene-set.js     unity_scene set 的 C# 代码生成（转义、类型检查）
  play-mode.js     Play/Edit 模式切换与收敛轮询
  console.js       Console 参数校验与渲染
  format.js        status 展示
  args.js          项目根解析（Session cwd → project_path）、代码规范化
  undo.js          写操作的 undo checkpoint 记录
scripts/  dump-tools / typecheck / validate-dsh-tools / live-smoke
test/     pipe-name / protocol / client / tools / tools-workflow + fake-broker
```

## 已知限制

- Win32 管道路径仍未经 Windows 实机验证（仓库在 Linux 上开发）；Linux 套接字路径已在 Unity 2022.3 + Mono 上端到端跑通（见 `docs/locus-linux-port.md`）。Unity 失焦心跳依赖 `Library/Locus/BackgroundHook.enabled`，Linux 移植里没有等价的 Win32 钩子。
- 无 GPU 的环境里 Unity 必须用 `-batchmode -nographics` 启动；普通 GUI 启动会因 `Failed to initialize unity graphics` 退出。
- `unity_asset` 只支持标量/数组字段；Vector3/Color/四元数等复合字段请用 `unity_scene set` 或 `unity_execute`。继承自 Prefab 的字段（Locus 需要 effective-value 适配器）会返回 `unsupported_capability`。
- `unity_scene set` 只做单字段写入；数组操作是「先写末元素再增删」的 Locus 等价实现，复杂结构建议 `unity_execute`。
- `enable_non_public_access`（私有成员直访）依赖 Locus compile server（Roslyn sidecar），未接入。
- 资产 undo 是「读取旧值 → 反向批次」的实现，不是文件级快照；换行、注释等格式差异不会被还原。
- 尚未实现：Locus 的 `/view`、知识系统、hot-reload 面板、`run_states` 逐帧采样、`capture_viewport` 截图。协议细节见设计文档 §2.6。
