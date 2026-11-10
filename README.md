# dsh-locus-bridge

[![许可证 GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.12-339933?style=flat-square&logo=node.js&logoColor=white)](package.json)
[![Unity](https://img.shields.io/badge/unity-2022.3-000000?style=flat-square&logo=unity&logoColor=white)](https://github.com/Kide-Lee/dsh-locus-bridge)
[![平台](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-4b5563?style=flat-square)](https://github.com/Kide-Lee/dsh-locus-bridge)
[![上游 Locus](https://img.shields.io/badge/upstream-r1n7aro%2FLocus-2d6cdf?style=flat-square&logo=github)](https://github.com/r1n7aro/Locus)

简体中文 | [English](README.en.md)

dsh-locus-bridge 是一个 **DeepSeek harness 插件**。它能让 DSH 直接扮演 Locus 客户端，通过 Locus 原生 broker 操作 Unity 编辑器。

本项目的`native/`目录包含两个 Rust crate：`locus_unix_native`（本项目构建的 Linux/macOS 版原生 broker）与 `locus-native-protocol`（上游的协议 crate）。它们能编译出 `liblocus_unity_native.so`，供 Unity 里的 C# 插件调用。

关于 Locus 的更多信息，参见：

- 上游项目： https://github.com/r1n7aro/Locus
- 文档： https://unity.farlocus.com

## 工作原理

Locus 不是普通的「客户端 / 服务端」结构。**Unity 这一侧才是服务端**：`locus_unity_native` 这个
Rust dll 被编辑器以进程内方式加载，对外提供一个命名管道（Windows）或 Unix domain socket
（Linux/macOS），并且因为 dll 自身常驻，它能跨域重载存活。Locus 桌面端是这条 socket 的客户端，
本插件也是——它实现同一套「一行一个 JSON」的协议，所以 Unity 端不需要改代码。

请求形如 `{"id": "...", "type": "<command>", "message": "<string>"}`，响应带 `reply_to`，因此一条
连接可以并发多路调用。像 `managed_reloading` 或 `native_request_timed_out` 这类错误码表示请求
**没有被执行**、可以安全重试；客户端正是靠这个区分去跨域重载重连，而不是把调用判死。

## 安装

可以在 DSH 中输入如下提示词，让 AI 安装本插件：

```
请你帮我安装插件：https://github.com/Kide-Lee/dsh-locus-bridge。如果我的Unity项目没有Locus插件，也请你帮我安装好。
```

亦或者也可以在克隆本项目后手动安装：

```bash
dsh plugin --profile <profile> add /path/to/dsh-locus-bridge
```

也可以直接从 GitHub 安装：

```bash
dsh plugin --profile <profile> add github:Kide-Lee/dsh-locus-bridge
```

重启 DSH 后，模型会看到 7 个以 `unity_` 开头的工具。

### 编辑器前提

1. 项目里装了 `locus_unity` 这个 Unity 包（`com.farlocus.locus`）。
2. 对应平台的原生 broker 库就位——Windows 是 `locus_unity_native.dll`，Linux/macOS 是
   `liblocus_unity_native.so`。随包附带的 payload 已包含这两个平台，装在 Windows 或 Linux
   上都不需要自行构建。
3. `<项目>/Library/Locus/NativeBridge.enabled` 存在，或者编辑器以 `LOCUS_UNITY_NATIVE_BRIDGE=1`
   启动。Linux 上会读取该 marker 的第一行作为绝对 socket 路径，因为在沙箱里 socket 不能放在 `/tmp`。

`unity_status` 在连不上时会**自动**报告项目缺什么，不需要额外调用。只有当它判定
**缺 Unity 插件**时，才会在输出里给出安装命令：

```bash
node scripts/install-unity-package.mjs <工程路径> --install
```

它会把随包附带的 Locus 包复制进 `Packages/com.farlocus.locus`、写好
`Library/Locus/NativeBridge.enabled`，并复核结果。要求编辑器已关闭。

**编辑器开着时会被拒绝。** 判据是 `<工程>/Temp/UnityLockfile`：Unity 启动工程时创建它
并持有独占锁，异常退出留下的陈旧文件不算（能拿到锁就说明没人持有）。命中时安装不会开始，
退出码 2，并提示先关闭编辑器：

```
The Unity Editor has <工程> open. Close the editor and run this again: ...
```

之所以不接受「复制到一半再报错」：Windows 上删除旧包会以 `EPERM` 失败，而即便删除成功，
编辑器仍持着已加载的程序集，之后重载会出现难以归因的行为。

项目本身没问题、只是编辑器没开时，诊断**不输出任何内容**——「插件已就位」不是结论，
没有结论就不占上下文。工具定义因此与官方客户端**完全一致**：安装这件事不常发生，
不该长期占用上下文。

### 安装来源

`payload/locus_unity` 是已编译好的 Unity 包（233 个文件，约 15 MB，其中
`Editor/Roslyn/Locus.Roslyn.dll` 占 9 MB）。它不是从上游 git 拉取的：上游
`.gitignore` 忽略了 `Locus.Json.dll`、`Locus.Detour.dll`、`Locus.HotReload.Runtime.dll`、
`Locus.Roslyn.dll` 和原生 broker，所以
`"com.farlocus.locus": "https://github.com/...?path=locus_unity"` 装出来是**编译不过的残缺包**。
自带一份完整包是唯一在所有平台上都成立的来源。

包内随带**两个平台**的原生 broker，因此同一份 payload 在 Windows 与 Linux/macOS 上都能直接连上：

| 平台 | 路径 | 来源 |
|---|---|---|
| Windows x86_64 | `Editor/Native/x86_64/locus_unity_native.dll` | 上游 `locus_unity_native` crate（`cargo build --release`） |
| Linux x86_64 | `Editor/Native/linux-x86_64/liblocus_unity_native.so` | 本仓库 `native/locus_unix_native/`（`npm run build:native`） |

Windows 用的就是上游 crate 本身，未作修改，导出符号与上游 `locus_unity_native/exports.txt`
的 44 个名字逐一对齐（Unity 各版本靠这些名字绑定）。

用 `npm run sync:payload` 从本地 Locus 检出重新生成（`--check` 只校验不写入）。这份 15 MB 的
产物不进 npm tarball，通过 release asset 分发；用 `DSH_LOCUS_PAYLOAD_DIR` 指向解包后的目录即可，
不必放在插件目录里。

## 工具

| 工具 | 作用 | 底层指令 |
|---|---|---|
| `unity_status` | 连接检查、编辑器状态（editing/playing/playing_paused）、打开的场景、capabilities、域重载状态；连不上时自动诊断，缺插件时给出安装命令 | `status` / `bridge_capabilities` / `get_reload_state` |
| `unity_execute` | 在 Unity 主线程编译并执行 C# 方法体（`print`/`printJson`/`ctx.Progress`/`ctx.WaitFrame`），逃生口 | `status` → `begin_edit_session` → `execute_code` + 250ms `execute_code_progress` →（取消）`cancel_execute_code` → `end_edit_session` |
| `unity_play_mode` | 切换到 Play/Edit 模式并等待生效 | `status` → `set_editor_status` → 轮询 `status` |
| `unity_console_log` | 读取 Unity Console（按级别合并去重） | `unity_get_console_log` |
| `unity_recompile` | 编译 + 域重载 + 跨断线等待收敛；`sync: none/targeted/full` 控制资产导入 | `request_recompile` → 断线 → 重连 → 轮询 `get_compile_result` |
| `unity_test` | 发现并运行 Unity Test Framework 测试，等待结构化结果（`list` / `run`） | `unity_test_list` / `unity_test_start` → 250ms `unity_test_status` →（取消）`unity_test_cancel` |
| `unity_asset` | 资产序列化读取；带 revision 守卫的原子编辑（`set` 与数组操作）；undo；reload | `asset_api`（read / apply_batch / disk_reload） |
| `unity_asset_graph` | 资产引用图与脚本用法：`references` / `dependencies` / `usages` | `search_yaml`（配 `.meta` 里的 GUID） |
| `unity_capture` | 截取 Game / Scene / 编辑器窗口，图像直接随结果返回（`ImageBlock`），一次调用即可看见 | `capture_viewport` + `attachments.saveImage` |
| `unity_scene` | 场景对象检索（`search` 按名称、`find` 按组件类型）、属性树读取、原子 `set`、单事务 `batch` 与 `undo` | `search_scene_objects` / `property_tree_read` / 生成的 `execute_code` |

## 三个新能力的边界

这三个工具都照搬上游的做法，但都受「插件只做 broker 客户端」这一条约束，能力边界值得写清楚。

**`unity_test`** 的服务端是随 payload 附带的 `Editor/Testing/LocusUnityTestService.cs`——它已经注册了
`unity_test_list` / `unity_test_start` / `unity_test_status` / `unity_test_cancel` 四个扩展命令，
所以 Unity 侧一行都没改，插件只负责驱动它们。轮询节奏（250 ms）与「取消后必须观察到终态」的收尾
都对齐上游 `unity_bridge/mod.rs::unity_test_run_controlled`。超时也会走取消，避免丢失调用方的 run
一直占着编辑器。asmdef 带 `LOCUS_HAS_UNITY_TEST_FRAMEWORK` 条件编译，项目没装
`com.unity.test-framework >= 1.4.0` 时这些命令不存在，调用会得到 Unity 侧的报错。

**`unity_asset_graph`** 上游用 Rust 侧自建的 `asset_db` 索引回答，插件没有这层，因此改用 broker 自带的
`search_yaml`：把目标资产的 `.meta` 里的 GUID 当作要匹配的值/组件，在指定的 `.unity` / `.prefab` 里搜。
代价是**没有全项目扫描**——broker 一次只读一个场景或预制体，所以 `references` 和 `usages` 必须由
调用方给出 `file_path`。搜索结果覆盖的是 Unity 序列化数据，二进制资产、自定义序列化、Preset 以及
运行时拼接的字符串引用都不在其中。

**`unity_capture`** 走的是 `read_image` 同一条路：抓图后把 PNG 交给 Host 的 `attachments.saveImage`，
再在工具结果里挂一个 `ImageBlock`，因此**一次调用就同时拿到文字摘要和图像本身**，不需要再读一次。
提交附件之前先做图片能力检查（`llm.resolveModelInfo` 的 `inputModalities`）——纯文本模型会直接拒绝，
而不是先存一张它永远看不到的图。若部署没挂附件服务，就退回只返回路径的文字结果。

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
npm test               # 115 个测试，不需要 Unity
npm run typecheck      # 静态检查 import / export
npm run validate       # 用 DSH 的 JSON Schema 子集校验工具定义
npm run build:native   # Linux/macOS 的 broker（Rust）
npm run test:live      # 对着真实编辑器端到端跑，见 scripts/live-smoke.mjs
```

`unity-test/` 是本地一次性验证工程，已被 git 忽略。

## 许可证

GPL-3.0-or-later。`native/` 下的代码派生自上游 Locus，具体文件与对齐的上游 commit 见
[NOTICE](NOTICE)。本项目不是 Locus 的官方发布，也与 Locus 作者没有隶属关系。
