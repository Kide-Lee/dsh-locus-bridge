# dsh-locus-bridge

[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.12-339933?style=flat-square&logo=node.js&logoColor=white)](package.json)
[![Unity](https://img.shields.io/badge/unity-2022.3-000000?style=flat-square&logo=unity&logoColor=white)](#前提条件unity-端无需改动)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-4b5563?style=flat-square)](#前提条件unity-端无需改动)
[![Upstream: Locus](https://img.shields.io/badge/upstream-r1n7aro%2FLocus-2d6cdf?style=flat-square&logo=github)](https://github.com/r1n7aro/Locus)

dsh-locus-bridge是一个**DeepSeek harness 插件**。它能让 DSH 直接扮演 Locus 客户端，通过 Locus 原生 broker 操作 Unity 编辑器。

在本项目的`native/`目录中包含了 Locus 官方的 Unity 插件，以及本项目自行构建的兼容Linux/macOS的 Locus Unity 插件。关于 Locus 的更多信息，参见：

- 上游项目： https://github.com/r1n7aro/Locus
- 文档： https://unity.farlocus.com

## 安装
可以在DSH中输入如下提示词，来让 AI 安装本插件：
```
请你帮我安装插件：https://github.com/Kide-Lee/dsh-locus-bridge。如果我的Unity项目没有Locus插件，也请你帮我安装好。
```

亦或者也可以在克隆本项目后手动安装：
```bash
dsh plugin --profile <profile> add /path/to/dsh-locus-bridge
```

安装后模型会看到 7 个以`unity_`开头的工具。
| 工具 | 作用 | 底层指令 |
|---|---|---|
| `unity_status` | 连接检查、编辑器状态（editing/playing/playing_paused）、打开的场景、capabilities、域重载状态 | `status` / `bridge_capabilities` / `get_reload_state` |
| `unity_execute` | 在 Unity 主线程编译并执行 C# 方法体（`print`/`printJson`/`ctx.Progress`/`ctx.WaitFrame`），逃生口 | `status` → `begin_edit_session` → `execute_code` + 250ms `execute_code_progress` →（取消）`cancel_execute_code` → `end_edit_session` |
| `unity_play_mode` | 切换到 Play/Edit 模式并等待生效 | `status` → `set_editor_status` → 轮询 `status` |
| `unity_console_log` | 读取 Unity Console（按级别合并去重） | `unity_get_console_log` |
| `unity_recompile` | 编译 + 域重载 + 跨断线等待收敛；支持 `sync: none/targeted/full` 资产导入 | `request_recompile` → 断线 → 重连 → 轮询 `get_compile_result` |
| `unity_asset` | 资产序列化读取 / 带 revision 守卫的原子编辑（`set` 与数组操作）/ undo / reload | `asset_api`（read / apply_batch / disk_reload） |
| `unity_scene` | 场景对象 search / get（属性树）/ 原子 set（Undo、保存场景） | `search_scene_objects` / `property_tree_read` / 生成的 `execute_code` |

## 与 Locus 客户端的不同之处
- DSH会话的工作目录无需在Unity项目中，插件会**向下最多三层**寻找 Unity 工程，广度优先。如果没找到，插件会到**祖先目录**里寻找 Unity 工程。
