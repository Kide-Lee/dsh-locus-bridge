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

这六个工具**完全不走 broker**：它们在本地起一个 Roslyn 语言服务器（`dotnet` 子进程），
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

### C# 分析：为什么单开一层

- **不是 broker 能力。** 上游 `code_*` 由 `src-tauri/src/csharp_lsp/` 支撑：每个 checkout 一个
  Roslyn 语言服务器进程，加载 Unity 生成的 `.sln`/`.csproj`。它和 Unity 管道毫无关系，所以
  broker 没有对应命令，也不需要——这里直接在 Node 里实现 LSP 客户端（`src/csharp/`）。
- **必须自己保证两件事，否则会静默给出错误答案。** 这两条都是实测踩出来的：
  1. **可写的运行时目录。** 服务器在 `XDG_RUNTIME_DIR`（Linux 上 `/run/user/<uid>`）建命名互斥与
     临时缓存；沙箱/容器里该路径只读时，`dotnet restore` 与 `MetadataAsSource` 组合失败，表现为
     第一次查询返回 `-32800 task canceled` 然后进程静默 `exit 0`。客户端把它重定向到资产目录。
  2. **必须有过 `dotnet restore`。** 没有 `obj/project.assets.json` 时编译器诊断 provider
     **永远返回空数组**——不报错、不超时，只有分析器还在给风格建议。用户会看到「代码没问题」，
     而文件根本编译不过。因此工作区启动前会按需 restore，且 `code_diagnostics` 在缺少还原产物时
     明确说明结论不可信，而不是报告「无诊断」。
  3. **系统 .NET 能满足运行时需求。** `assetStatus()` 把「托管运行时副本不存在」记为缺失，但
     机器上已有 .NET 10 时 `resolveDotnet` 会直接用系统的。资产门控因此只要求服务器与分析器
     两个下载件——否则开发者机器上每次都会误报「资产未安装」。
  4. **还原产物不在 `obj/`。** Unity 生成的 csproj 把
     `<BaseIntermediateOutputPath>` 设为 `Temp/obj/$(Configuration)/$(MSBuildProjectName)`，
     所以 `project.assets.json` 落在 `Temp/obj/Debug/<Project>/`。写死 `obj/project.assets.json`
     会让每个 Unity 工程都被判定为「未还原」，进而静默关闭编译器诊断。另外 `dotnet restore`
     一次只接受一个项目或解决方案，逐个传多个 csproj 会以 MSB1008 失败。
  5. **Unity 的 csproj 是显式文件列表，不是 glob。** 最后一次工程同步之后新建的 `.cs` 不在编译集
     里，Roslyn 对它不产生任何诊断。工具现在会识别这种情况并明确说明「文件不在编译集中」，
     而不是报告「无诊断」——否则新建文件里的错误会被误判为干净。
- **`--extensionLogDirectory` 是必填参数。** 缺失时服务器直接 `exit 1`，连 `initialize` 都不答。
- **工程文件由谁生成。** 有连接的编辑器时调插件新增的 `sync_project_files`，失败则回落到一段
  `execute_code` 生成链（与上游同一段 C#）；没有编辑器时用一次性 `-batchmode` 跑同一个入口，
  跑完删除临时包并清理它留在 `.sln` 里的条目。
- **`workspace/symbol` 在预热期返回空而不是报错。** 位置查询会给 `-32800`，符号查询给空数组，
  所以它在项目刚加载后的一个短窗口内把「空」当作「索引还在填」，窗口由首次成功的查询消费；
  之后不存在的符号立即返回，不付等待成本。
- **诊断覆盖范围与桌面端对比。** file scope 的**字符串引用校验**（tag / layer / build scene /
  Resources 路径 / legacy Input 轴）已照搬——那部分只读 `ProjectSettings` 文本，不依赖
  asset database。仍缺的是 `[SerializeReference]` 失效类型检查，它确实需要桌面端 `asset_db`。
  完整逐项比对见 [docs/locus-client-bridge.md](docs/locus-client-bridge.md)。

## 与 Locus 桌面端的差异

- **会话工作目录不必是 Unity 项目。** 插件会向下最多三层、广度优先地寻找 Unity 工程，找不到
  再到每个祖先目录旁去找；显式传入 `project_path` 时始终以它为准。
- **没有 Locus 的 UI、知识库和技能系统。** 本插件只取走「跨进程调用 Unity」这一项能力，桌面端
  的面板和 agent 循环都不参与。
- **broker 支持多客户端。** 在 broker 具备 `broker_multi_client_v1` capability 时，DSH 与 Locus
  桌面端可以同时连着同一个编辑器，响应回到发起请求的那条连接。
- **重编译会跨断线继续。** 域重载会在调用中途断开连接，客户端会重连并接着轮询 operation id，
  而不是报一个传输错误。

## 开发

```bash
npm test               # 229 个测试，不需要 Unity、不需要网络
npm run typecheck      # 静态检查 import / export
npm run validate       # 用 DSH 的 JSON Schema 子集校验工具定义
npm run build:native   # Linux/macOS 的 broker（Rust）
npm run test:live      # 对着真实编辑器端到端跑，见 scripts/live-smoke.mjs
npm run test:csharp    # C# 分析：真实 Roslyn 服务器端到端，见 scripts/live-csharp.mjs
```

## 许可证

GPL-3.0-or-later。`native/` 下的代码派生自上游 Locus，具体文件与对齐的上游 commit 见
[NOTICE](NOTICE)。本项目不是 Locus 的官方发布，也与 Locus 作者没有隶属关系。
