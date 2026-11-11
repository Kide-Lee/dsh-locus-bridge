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

重启 DSH 后，模型会看到 10 个以 `unity_` 开头的工具，外加 6 个 `code_*` C# 分析工具（可用
`DSH_LOCUS_CSHARP=0` 关闭后者）。

## 工具

| 工具 | 作用 | 底层指令 |
|---|---|---|
| `unity_status` | 连接检查、编辑器状态（editing/playing/playing_paused）、打开的场景、capabilities、域重载状态；连不上时自动诊断，缺插件时给出安装命令 | `status` / `bridge_capabilities` / `get_reload_state` |
| `unity_execute` | 在 Unity 主线程编译并执行 C# 方法体（`print`/`printJson`/`ctx.Progress`/`ctx.WaitFrame`），逃生口 | `status` → `begin_edit_session` → `execute_code` + 250ms `execute_code_progress` →（取消）`cancel_execute_code` → `end_edit_session` |
| `unity_play_mode` | 切换到 Play/Edit 模式并等待生效 | `status` → `set_editor_status` → 轮询 `status` |
| `unity_console_log` | 读取 Unity Console（按级别合并去重） | `unity_get_console_log` |
| `unity_recompile` | 编译 + 域重载 + 跨断线等待收敛；`editor_status` 必填且须与实况一致；`sync: none/targeted/full` 控制资产导入 | `request_recompile` → 断线 → 重连 → 轮询 `get_compile_result` |
| `unity_test` | 发现并运行 Unity Test Framework 测试，等待结构化结果（`list` / `run`） | `unity_test_list` / `unity_test_start` → 250ms `unity_test_status` →（取消）`unity_test_cancel` |
| `unity_asset` | 资产序列化读取；带 revision 守卫的原子编辑（`set` 与数组操作）；undo；reload | `asset_api`（read / apply_batch / disk_reload） |
| `unity_asset_graph` | 资产引用图与脚本用法：`references` / `dependencies` / `usages` | 生成的 `execute_code`（按 `.meta` 的 GUID 比对序列化字段） |
| `unity_capture` | 截取 Game / Scene / 编辑器窗口，图像直接随结果返回（`ImageBlock`），一次调用即可看见 | `capture_viewport` + `attachments.saveImage` |
| `unity_scene` | 场景对象检索（`search` 按名称、`find` 按组件类型）、属性树读取、原子 `set`、单事务 `batch` 与 `undo` | `search_scene_objects` / `property_tree_read` / 生成的 `execute_code` |

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
.NET 10 运行时则跳过约 30 MB 的运行时）。用 `DSH_LOCUS_CSHARP=0` 可整组关闭。

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
| 可拖动 3D 预览 | `asset_preview_render` | `PreviewRenderUtility` 轨道渲染 |
| 在编辑器里定位 | `select_asset` | 项目窗口 Ping |

支持的格式：`.prefab`（层级 + 组件 + 属性，含可旋转预览）、`.asset` / `.mat`
（ScriptableObject / 材质字段）、`.anim`（剪辑字段）、`.controller`（子资产摘要表）、
贴图与模型（`AssetPreview` 缩略图）。`.unity` 场景**只读**：读它要求场景已在编辑器里加载，
而"点开就改写"不是文件查看器该做的决定；写入会直接拒绝并给出原因。

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

## 与 Locus 桌面端的差异

- **会话工作目录不必是 Unity 项目。** 插件会向下最多三层、广度优先地寻找 Unity 工程，找不到
  再到每个祖先目录旁去找；显式传入 `project_path` 时始终以它为准。
- **没有 Locus 的桌面 UI、知识库和技能系统。** 本插件取走「跨进程调用 Unity」这一项能力，
  外加一个右栏资产面板；桌面端的主界面、knowledge、skills 和 agent 循环都不参与。
- **broker 支持多客户端。** 在 broker 具备 `broker_multi_client_v1` capability 时，DSH 与 Locus
  桌面端可以同时连着同一个编辑器，响应回到发起请求的那条连接。
- **重编译会跨断线继续。** 域重载会在调用中途断开连接，客户端会重连并接着轮询 operation id，
  而不是报一个传输错误。

## 开发

```bash
npm test                   # 不需要 Unity、不需要网络
npm run typecheck          # 静态检查 import / export
npm run validate           # 工具定义 + 静态检查 + 客户端 bundle 是否最新
npm run build:client       # 由 src/client/plugin.js 生成 lib/client.js（右栏面板）
npm run build:native       # Linux/macOS 的 broker（Rust）
npm run test:live          # 工具面：对着真实编辑器端到端，见 scripts/live-smoke.mjs
npm run test:live:sidebar  # 右栏路由：真 HTTP + 真 Unity，见 scripts/live-sidebar.mjs
npm run test:live:render   # 右栏面板：在渲染壳里跑遍所有格式，见 scripts/live-render.mjs
npm run test:csharp        # C# 分析：真实 Roslyn 服务器端到端，见 scripts/live-csharp.mjs
```

右栏客户端在 `src/client/plugin.js`（普通 ESM，便于测试），`npm run build:client` 把它包成
DSH 客户端 bundle 的 `__ModuleLoader__` 工厂写进 `lib/client.js`。改面板请改源文件再重新生成；
`npm run check:client` 会校验产物是否过期。

## 许可证

GPL-3.0-or-later。`native/` 下的代码派生自上游 Locus，具体文件与对齐的上游 commit 见
[NOTICE](NOTICE)。本项目不是 Locus 的官方发布，也与 Locus 作者没有隶属关系。
