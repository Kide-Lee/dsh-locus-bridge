# dsh-locus-bridge

[![许可证 GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.12-339933?style=flat-square&logo=node.js&logoColor=white)](package.json)
[![Unity](https://img.shields.io/badge/unity-2022.3-000000?style=flat-square&logo=unity&logoColor=white)](https://github.com/Kide-Lee/dsh-locus-bridge)
[![平台](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-4b5563?style=flat-square)](https://github.com/Kide-Lee/dsh-locus-bridge)
[![上游 Locus](https://img.shields.io/badge/upstream-r1n7aro%2FLocus-2d6cdf?style=flat-square&logo=github)](https://github.com/r1n7aro/Locus)

简体中文 | [English](README.en.md)

dsh-locus-bridge 是一个 **DeepSeek harness 插件**。它能让 DSH 直接扮演 Locus 客户端，通过 Locus 原生 broker 操作 Unity 编辑器。

关于 Locus 的更多信息，参见：

- 上游项目： https://github.com/r1n7aro/Locus
- 文档： https://unity.farlocus.com

## 安装

可以在 DSH 中输入如下提示词，让 AI 安装本插件：

```
请你帮我安装插件：https://github.com/Kide-Lee/dsh-locus-bridge。如果我的Unity项目没有Locus插件，也请你帮我安装好。
```

也可以手动安装：

```bash
dsh plugin --profile <profile> add github:Kide-Lee/dsh-locus-bridge
```

重启 DSH 后，模型会看到 11 个以 `unity_` 开头的工具，外加 6 个 `code_*` C# 分析工具（可用
`DSH_LOCUS_CSHARP=0` 关闭后者）。

## 工具

| 工具 | 作用 | 底层指令 |
|---|---|---|
| `unity_status` | 连接检查、编辑器状态（editing/playing/playing_paused）、打开的场景、capabilities、域重载状态；连不上时自动诊断，缺插件时给出安装命令 | `status` / `bridge_capabilities` / `get_reload_state` |
| `unity_execute` | 在 Unity 主线程编译并执行 C# 方法体（`print`/`printJson`/`ctx.Progress`/`ctx.WaitFrame`），逃生口 | `status` → `begin_edit_session` → `execute_code` + 250ms `execute_code_progress` →（取消）`cancel_execute_code` → `end_edit_session` |
| `unity_run_states` | 用 C# 状态机跨帧驱动 Unity（`start`/`update`/`end`），长观察没有 30 秒空闲看门狗；输出 ≤100k token 内联，100k–1M 落盘 `Library/Locus/RunStates`，更大报错 | `status` → `run_states` |
| `unity_play_mode` | 切换到 Play/Edit 模式并等待生效 | `status` → `set_editor_status` → 轮询 `status` |
| `unity_console_log` | 读取 Unity Console（按级别合并去重） | `unity_get_console_log` |
| `unity_recompile` | 编译 + 域重载 + 跨断线等待收敛；`editor_status` 必填且须与实况一致；`sync: none/targeted/full` 控制资产导入 | `request_recompile` → 断线 → 重连 → 轮询 `get_compile_result` |
| `unity_test` | 发现并运行 Unity Test Framework 测试，等待结构化结果（`list` / `run`） | `unity_test_list` / `unity_test_start` → 250ms `unity_test_status` →（取消）`unity_test_cancel` |
| `unity_asset` | 资产序列化读取；带 revision 守卫的原子编辑（`set` 与数组操作）；undo；reload | `asset_api`（read / apply_batch / disk_reload） |
| `unity_asset_graph` | 资产引用图与脚本用法：`references` / `dependencies` / `usages` | 生成的 `execute_code`（按 `.meta` 的 GUID 比对序列化字段） |
| `unity_capture` | 截取 Game / Scene / 编辑器窗口，图像直接随结果返回（`ImageBlock`），一次调用即可看见 | `capture_viewport` + `attachments.saveImage` |
| `unity_scene` | 场景对象检索（`search` 按名称、`find` 按组件类型）、属性树读取、原子 `set`、单事务 `batch` 与 `undo` | `search_scene_objects` / `property_tree_read` / 生成的 `execute_code` |

`unity_execute` 与 `unity_test action:"run"` 还接受宿主注入的 `async` 参数，语义与 Locus 一致：`sync`（默认）等待结果；`async` 立即返回 job id，不发送完成通知，用 `job_output` 读取；`notify` 立即返回，并在完成时自动投递结果。job 由 DSH 的 jobs 管理，`job_kill` 可以取消，生命周期限于当前 Session；后台只让 agent 继续，不绕开 Unity 主线程，也不解除 `unity_execute` 的 30 秒无输出限制和工具自身的 `timeout`。`unity_run_states` 按官方行为保持同步。

### C# 语义分析（可选，独立于 Unity 连接）

这六个工具不走 broker：它们在本地起一个 Roslyn 语言服务器（`dotnet` 子进程），
通过 LSP/stdio 对话，因此 Unity 关着也能用（只要 `.sln`/`.csproj` 已存在）。

| 工具 | 作用 |
|---|---|
| `code_symbol_search` | 按名字/驼峰模糊查 C# 符号（类比 Roslyn 的 workspace symbol） |
| `code_goto_definition` | 跳转到定义，跨文件、跨 asmdef、跨包 |
| `code_find_references` | 语义级引用查找（重载、泛型、partial、using 别名都解析；排除注释与字符串） |
| `code_hover` | 签名、类型与 XML 文档 |
| `code_diagnostics` | Roslyn 编译错误 + Roslyn/Unity 分析器诊断，不触发 Unity 编译 |
| `code_analysis` | 查看/安装/预热/重启/重置分析后端（`status` / `install` / `warm` / `restart` / `reset`） |

首次使用需 `code_analysis action:"install"`，下载约 90 MB（Roslyn 服务器约 60 MB；本机已有
.NET 10 运行时则跳过约 30 MB 的运行时）。可在设置里关掉，或用 `DSH_LOCUS_CSHARP=0` 整组强制关闭
（后者是部署级开关，设置页无法覆盖）。

这三个工具都照搬上游的做法，但都受「插件只做 broker 客户端」这一条约束，能力边界值得写清楚。

- **`unity_test`**：服务端是随 payload 附带的 `Editor/Testing/LocusUnityTestService.cs`——它已经注册了
  `unity_test_list` / `unity_test_start` / `unity_test_status` / `unity_test_cancel` 四个扩展命令，
  所以 Unity 侧一行都没改，插件只负责驱动它们。轮询节奏（250 ms）与「取消后必须观察到终态」的收尾
  都对齐上游 `unity_bridge/mod.rs::unity_test_run_controlled`。超时也会走取消，避免丢失调用方的 run
  一直占着编辑器。asmdef 带 `LOCUS_HAS_UNITY_TEST_FRAMEWORK` 条件编译，项目没装
  `com.unity.test-framework >= 1.4.0` 时这些命令不存在，调用会得到 Unity 侧的报错。
- **`unity_asset_graph`**：上游用 Rust 侧自建的 `asset_db` 索引回答，插件没有这层。broker 的 `search_yaml`
  **不能**替代它：那条命令只匹配 GameObject 的名字和层级路径，**从不搜索字段值**，把 GUID 当 `query`
  传过去永远是 `Total matches: 0`（场景里确有 400 个 `Localizer` 实例时同样返回 0）。因此这三个动作改为
  生成 `execute_code` 片段遍历场景：读目标资产 `.meta` 里的 GUID，与 Unity 实际序列化的 `m_Script` /
  引用槽位比对。代价是**没有全项目扫描**——片段只走当前打开的场景，所以 `references` 和 `usages`
  必须由调用方给出 `file_path`；`.prefab` 要先在编辑器里打开才能被扫描到。搜索结果覆盖的是 Unity
  序列化数据，二进制资产、自定义序列化、Preset 以及运行时拼接的字符串引用都不在其中。
- **`unity_capture`**：走 `read_image` 同一条路——抓图后把 PNG 交给 Host 的 `attachments.saveImage`，
  再在工具结果里挂一个 `ImageBlock`，因此**一次调用就同时拿到文字摘要和图像本身**，不需要再读一次。
  提交附件之前先做图片能力检查（`llm.resolveModelInfo` 的 `inputModalities`）——纯文本模型会直接拒绝，
  而不是先存一张它永远看不到的图。若部署没挂附件服务，就退回只返回路径的文字结果。

## 右侧栏资产预览与编辑

在 Web GUI（`dsh web`）里，右栏可以像 Unity Inspector 一样打开并编辑 Unity 资产。把
`.prefab` / `.asset` / `.mat` / `.anim` / `.controller` 之类的文件从文件树点开（或让模型把它的
`dsh-resource://file/...` 地址交给右栏），就会进入本插件的 `locus-asset` 标签页。

实现上它**就是 Locus 自己的那套调用**，没有在浏览器里重写 Unity 的序列化：

| 面板动作 | 底层指令 | 对应 Locus 侧 |
|---|---|---|
| 读取属性树 | `property_tree_read` | `UnitySerializedPropertyTree` / `LocusPropertyTree` |
| 改一个字段 | `property_tree_apply`（一条 write） | `unityPropertyApi.write`（同样是内存改动 + 标脏） |
| 保存到磁盘 | `execute_code` 里按 `SaveAssetApiScopeAllowed` 的分支保存 | 桌面端让编辑器自己保存，这里给浏览器一个显式按钮 |
| 缩略图 | `asset_thumbnail` | `AssetPreview.GetAssetPreview` |
| prefab 可拖动预览 | `asset_preview_render` | `PreviewRenderUtility` 轨道渲染 |
| `.fbx` / `.glb` 模型 | `GET /locus/api/model` + 浏览器 three.js | `ModelViewer`（WebGL 直接解析模型字节） |
| 在编辑器里定位 | `select_asset` | 项目窗口 Ping |

支持的格式：`.prefab`（层级 + 组件 + 属性，含可旋转预览）、`.asset` / `.mat`
（ScriptableObject / 材质字段）、`.anim`（剪辑字段）、`.controller`（子资产摘要表）。模型分两条路：
`.fbx` / `.glb` 由浏览器里的 three.js 查看器直接解析原始字节，支持动画、线框、Clay、网格和统计；
其余模型格式（`.obj` / `.dae` / `.gltf` 等）仍交给 Unity 的 `PreviewRenderUtility`，前提是 Unity 装了
对应的 importer。`.unity` 场景**只读**：读它要求场景已在编辑器里加载，而"点开就改写"不是文件查看器
该做的决定；写入会直接拒绝并给出原因。

prefab 的轨道帧会在拖动时按 90 ms 下限连续请求，并在同一时刻只保留一个 Unity 渲染；松手后立即补一帧。
最后一张帧连同相机参数写到 `Library/Locus/asset-preview-cache/`（沿用 Locus 的目录布局；文件名哈希用
SHA-256，Locus 用 BLAKE3，因此两边的条目各自独立），重新打开时先恢复上次的角度，缓存按源文件 mtime 失效。模型查看器的 three.js bundle 是懒加载的独立文件
（`lib/model-viewer.js`），不进入主客户端包；改查看器源码后运行 `npm run build:viewer`。

几条与 Unity 语义一致、也值得提前知道的行为：

- 编辑是**内存改动**：字段立刻生效、对象变脏，磁盘上的文件不变；按 **Save** 才落盘，按
  **Revert** 把本次打开后改过的字段逐个写回原值。Unity 自己的 Ctrl+Z 不参与（撤销栈在编辑器进程里，
  不在浏览器会话里）。
- 继承自 Prefab 的字段不可写（Unity 侧 `unsupported_capability`，面板会显示原因）；派生存储的
  数组（如 `Renderer.m_Materials`）增删元素可能被 Unity 静默忽略——写入后面板会**重新读一次**
  该节点，显示编辑器真正持有的值，而不是浏览器以为的值。
- 结构与对象的改动都走同一条 revision/undo 语义；域重载期间面板显示 "Unity is busy" 并允许重试。
- 浏览器只能命名工程内的 `Assets/…` 相对路径；Host 负责解析工程根并拒绝任何越界路径。

这些路由挂在 `/locus/api/*`，只在存在 `webServer` 的 Host 上注册（CLI/TUI 不受影响），并经过
DSH 的浏览器信任闸（`ctx.connection.requestRejection`）。

右栏的地址解析值得单独说明：文件地址是**相对会话工作目录**的
（`dsh-resource://file/session/<id>/<相对路径>`），而 Unity 工程可能在其下层
（例如工作区里的 `Project/`）。Host 会先按会话工作目录还原绝对路径，再折算成
工程内的 `Assets/…`，所以两种写法都成立；越界路径仍然被拒。

另一个坑是**标签页抢占**：侧栏按 `(优先级, 模式长度, 注册顺序)` 选类型，而
`dsh-better-sidebar` 之类的文件编辑器注册了通用的 `dsh-resource://file/**`（22 字符）。
本插件因此使用 `dsh-resource://file/**/*.prefab` 这样的完整地址模式（≥28 字符），
否则 `.prefab` 永远会被对方的文本编辑器抢走。

### 界面语言

面板文案跟随 DSH 的 i18n 体系，和官方 UI 插件同一套做法：客户端 `apply` 把
`ctx.locale` 接进来，并在 `locusBridge` 命名空间下注册中英两份词典（`zh` / `en`）。
`t()` 从 locale 服务的 `getSnapshot().active` 取当前语言，所以**在设置里切换语言会立刻
重刷面板**，不用重开标签页。

`locale` 服务是**可选**的（没有写进 `inject`）：没挂 locale 插件（或裸测试组合）时
退回 `navigator.language`，再退回英文，绝不会渲染成原始 key。Unity 侧发来的诊断正文
是任意技术文本，只本地化它的 severity（警告/错误/信息），消息本身保持原文——翻译它会
变成替 Unity 编造措辞。

## 设置

DSH 设置里有一个 **Unity 桥接** 页（`settings.section`，id `dsh-locus-bridge`），分三组：

- **工作区**：选择工作区、选择 Unity 工程、查看/安装 Locus 插件；
- **功能**：三个功能面开关，改动**立即生效、无需重启**——页面向 `POST /locus/api/settings` 提交后，
  Host 重新注册工具集，`preview` 则由客户端在窗口重新获得焦点时重新读取并相应注册/注销标签页类型。
- **领域技能**：五行技能，每行一个开关（见 [领域技能](#领域技能)）。

| 开关 | 关掉之后 |
|---|---|
| **Unity 操纵** | 十一个 `unity_*` 工具从模型的工具列表里消失（Host 侧注销，并非只在 UI 隐藏） |
| **C# 分析** | 六个 `code_*` 工具消失，并关闭已启动的 Roslyn 语言服务器进程 |
| **文件预览** | 右栏 Unity 资产标签页不再注册；`/locus/api` 下访问 Unity 的路由一律返回 `feature_disabled` |

`preferences.frameCache`（预览帧写入工程）仍保留在 `settings.json` 里，但页面不再提供开关：把渲染帧
写进工程是浏览资产时才用的存储选择，不适合和功能面并列。

几个设计选择：

- **存在插件自己的文件里，不写进 `cordis.patch.yml`。** 路径是
  `<用户数据目录>/locus/locus-bridge/settings.json`（Windows：`%APPDATA%\locus\locus-bridge\settings.json`），
  可用 `DSH_LOCUS_BRIDGE_HOME` 改到别处。patch 层是给人手改的配置，让设置页去改写它会和每一次手工编辑、
  每一次 `plugin_manager` 写入打架。
- **`DSH_LOCUS_CSHARP=0` 仍然优先。** 那是部署级声明（这个 profile 就不该带这组能力），设置页会把它显示成
  锁定状态而不是可点的开关；用户偏好被夹在这个上限之内。
- **坏文件退回默认值。** 手改坏的 JSON 只会丢掉偏好，不会因为一个文件解析失败就让整组工具消失。
- **JSON 里的非布尔值不被强转。** `"off"` 或 `0` 会退回该键的默认值——把拼写错误默认当 `true` 或当 `false`
  都是在替用户猜。

### 工作区

设置页顶部的「工作区」下拉框列出 DSH 已经建立的工作区（Host 的 `workspaceRegistry`），选择会写进
`preferences.workspacePath`。它决定两件事：下面的「Unity 工程」面板从哪里开始找工程，以及
「领域技能」的 C# 能力激活到哪个工程。不选择时退回会话自己的工作区，与旧版本一致。

查找方向只有一个：**工作区本身，以及它下面的子目录**。插件不会再去祖先目录或工作区旁边的兄弟目录
里找工程——仓库里有多个 checkout 时，那种搜索会把会话接到错误的工程上。

「Unity 工程」下拉列出扫描到的工程，选择会写进 `preferences.unityProject`，下次打开设置页继续沿用；
选中的工程被删除时回退到扫描结果里的第一个。下面一行是选中工程的 **Locus 插件** 状态，用胶囊显示四态：

| 胶囊 | 含义 |
|---|---|
| **已连接** | 包已安装，broker 端点有人应答 |
| **未打开 Unity** | 包已安装，但编辑器没有打开这个工程 |
| **连接失败** | 编辑器开着，但原生桥没有启动（检查 `Library/Locus/NativeBridge.enabled`） |
| **没有插件** | 工程里没有 Locus 包，或包不完整；右侧给 **安装** 按钮 |

工作区、功能、领域技能三组各有独立的卡片边框，行几何与宿主设置页一致。

安装按钮有几个刻意的限制：

- **只装、不启动 Unity。** 装完写 marker（编辑器的原生桥靠它在启动时拉起），提示你重开编辑器。
- **编辑器开着就拒绝**（409 `editor_running`）——它正占着包的程序集文件。页面把这个拒绝解释成一句
  人话，而不是一个状态码。
- **只处理扫描结果里的工程。** 按钮不会变成一个任意的目录复制器。

工程状态由 `Temp/UnityLockfile`（编辑器是否开着）与端点探测（是否连上）共同决定；「没有插件」是
文件系统事实，不是连接问题。

### 领域技能

五行技能，每行一个开关。打开哪一行，那一条就进入模型提示词（DSH 的技能目录），模型可以用
`skill` 工具按需加载全文；关掉即完全消失。没有总开关，也不往工作区写任何文件：技能随插件版本
走，升级不会在工作区里留下一份过期的副本。

只有含 Unity 工程的工作区才会看到它们：技能的 provider 用会话工作目录做门控，非 Unity 会话的
技能目录里不会多出这几条，因此也不占提示词。只保留 DSH 没有对应物的五份文档：

| 技能 | 覆盖 | 可执行 C# |
|---|---|---|
| `debugger` | PlayerLoop/Tick 定位、跨帧条件、暂停检查、原生线程栈 | — |
| `profiler` | CPU/GPU/内存/GC 采样、基线对比、Marker 调用路径 | — |
| `graphics-debugger` | Frame Debugger 事件与 RT、RenderDoc 抓帧/回放 | `FrameDebuggerApi`、`RenderDocCaptureApi` |
| `ui-toolkit` | Unity 6.3+ UI Toolkit 布局、样式与交互调试 | `UIToolkitApi` |
| `view` | Locus View 面板（Vue UI / Inspector / 表格 / 图编辑器） | — |

带 C# 的两个技能是**隐式激活**的：打开开关后，该工程里第一次执行 `unity_execute` 时，随插件分发
的 C# 源码会自动交给编辑器自带的 `compile_skill_package` 编译成程序集并驻留，之后 `unity_execute`
里可以直接 `using Locus.Skills;`。没有按钮，也没有单独的激活动作；目标就是上方「Unity 工程」下拉
里的那个工程，工作区里有多个工程也不需要再选一次。编译失败后最多每分钟重试一次。

技能注入与工程数量无关：开关只管那一条进不进提示词，C# 编译只是附加能力。

激活之后，域重载与源码升级都不需要手点：

- 编辑器重启或域重载后，下一条 `unity_execute` 会先读编辑器的 `domain_generation`，发现换了域就
  静默重新编译一次（命中缓存时几乎无感），然后才执行代码；
- 插件升级改了技能源码，哈希不匹配会触发同样的重编译；
- 编译失败时错误会写进激活记录，最多每 60 秒重试一次，不会让每条 snippet 都卡在编译上。

`RenderDocCaptureApi` 只完成编译激活：真正的 RenderDoc 抓帧还需要 Locus 桌面端才有的 Python 脚本与
`renderdoc` 模块，本插件不携带，所以图形技能里只有 Frame Debugger 那半是完整的。重复激活是幂等的
——已经是最新的程序集直接复用编辑器缓存。

## 与 Locus 桌面端的差异

- **会话工作目录不必是 Unity 项目。** 插件会向下最多三层、广度优先地寻找 Unity 工程，**不会**再向上
  或到工作区旁边的兄弟目录里找；显式传入 `project_path` 时始终以它为准。
- **没有 Locus 的桌面 UI、知识库和技能系统。** 本插件取走「跨进程调用 Unity」这一项能力，
  外加一个右栏资产面板和五份可开关的 Unity 领域技能；桌面端的主界面、knowledge 索引、skills 运行时
  和 agent 循环都不参与。
- **broker 支持多客户端。** 在 broker 具备 `broker_multi_client_v1` capability 时，DSH 与 Locus
  桌面端可以同时连着同一个编辑器，响应回到发起请求的那条连接。
- **重编译会跨断线继续。** 域重载会在调用中途断开连接，客户端会重连并接着轮询 operation id，
  而不是报一个传输错误。

## 开发

```bash
npm install                # 开发依赖（three / esbuild，构建模型查看器需要）
npm test                   # 不需要 Unity、不需要网络
npm run typecheck          # 静态检查 import / export
npm run validate           # 工具定义 + 静态检查 + 两个 bundle 是否最新
npm run pack:release       # 发布 ZIP；先检查 Locus 是否最新、最新 DSH 是否兼容
npm run build:client       # 由 src/client/plugin.js 生成 lib/client.js（右栏面板）
npm run build:viewer       # 由 src/model-viewer/viewer.js 生成 lib/model-viewer.js（three.js 查看器）
npm run build:native       # Linux/macOS 的 broker（Rust）
npm run test:live          # 工具面：对着真实编辑器端到端，见 scripts/live-smoke.mjs
npm run test:live:sidebar  # 右栏路由：真 HTTP + 真 Unity，见 scripts/live-sidebar.mjs
npm run test:live:render   # 右栏面板：在渲染壳里跑遍所有格式，见 scripts/live-render.mjs
npm run test:csharp        # C# 分析：真实 Roslyn 服务器端到端，见 scripts/live-csharp.mjs
```

`npm run pack:release` 只有一种产物：包含 Unity payload 与安装器的可安装 ZIP。打包前会查询
GitHub 上 Locus 的最新 release；与 `package.json` → `locus.version` 不一致时**停止打包**。它还会
查询 npm 上最新 DSH 版本并对照 `engines.dsh`；不兼容或查询失败时只警告，继续打包。

右栏客户端在 `src/client/plugin.js`（普通 ESM，便于测试），`npm run build:client` 把它包成
DSH 客户端 bundle 的 `__ModuleLoader__` 工厂写进 `lib/client.js`。改面板请改源文件再重新生成；
`npm run check:client` 会校验产物是否过期。three.js 模型查看器单独放在 `src/model-viewer/`，
`npm run build:viewer` 用 esbuild 打成 `lib/model-viewer.js`；它由侧栏按需懒加载，**不要**把它
并进主客户端 bundle。`npm run check:viewer` 校验该产物。

## 许可证

GPL-3.0-or-later。`native/` 下的代码派生自上游 Locus，具体文件与对齐的上游 commit 见
[NOTICE](NOTICE)。本项目不是 Locus 的官方发布，也与 Locus 作者没有隶属关系。
