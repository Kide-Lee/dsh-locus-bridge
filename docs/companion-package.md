# 为什么插件不需要额外的 Unity 包

本插件在工程里只装一个 Unity 包：上游的 `com.farlocus.locus`（payload）。插件本身**不含任何
Unity 侧 C# 代码**，也不往 `Packages/` 里放第二个包——编辑器侧要做的事，只用 payload 已有的
消息与工具。

本文记录四项能力各走哪条路，以及为什么没有第三选项。

## 1. 四项能力与实现

| 能力 | 实现 | 对应官方 Locus 的做法 |
|---|---|---|
| 热补丁应用 | payload 原生 `hot_patch_loaded` 应用、`hot_patch_dispose` 摘除、`hot_reload_probe` 打补丁前自检；台账在 `src/hotreload.js` | 桌面端发同一条 `hot_patch_loaded`，应用在 payload 内 |
| 实时值 | payload 原生 `read_yaml`，文本原样透传 | 官方 `unity_yaml_read` 的 live 路径就是 `read_yaml` |
| prefab 覆盖 | `unity_yaml_read` 读实例的 `m_Modifications` | 官方把它做成 `unity_yaml_read` 的 `detail: "prefab_overrides"`，解析磁盘 YAML |
| 编辑器健康 | 原生 broker 自己应答 `dsh_health`：CPU、心跳、存活、主线程栈 | 官方 `hang_diagnosis` 同样只看原生栈、CPU 与符号 |

## 2. 为什么没有编辑器侧代码

插件是 payload 的客户端，`payload/locus_unity/` 是逐字的上游副本（`npm run check:payload`
校验漂移）。因此在编辑器里加代码只可能有两种做法，两种都不成立：

1. **改 payload**：不允许，它就是上游副本。
2. **旁挂一个 Unity 包**：能编译通过，但每一项都要在编辑器里重新实现一遍，且只能通过
   `RegisterExtensionMessageHandler` 这条扩展消息与插件通信；payload 升级时这些实现会悄悄失效，
   又多出一份要跟 payload 内部字段（私有 detour 账本、`SerializedObject` 解析、`CompilationPipeline`
   事件）绑定的代码。

四项逐条看，payload 已有的一律走 payload：

**热补丁**：`hot_patch_loaded` 一直在，能建 detour、能整批回滚、能在打补丁前用
`hot_reload_probe` 自检。它的处理器是 `private`，但 `private` 只是 C# 可见性——broker 只转发
`type`，扩展消息走的也是同一个 `HandleMessageAsync` 的 `default:` 分支。DSH 自己的分类器需要
逐方法「跳过」语义，改用「整批失败记为该文件未能打补丁」即可，与 payload 的原子语义一致。

**实时值**：过去需要「与磁盘 YAML 同形、可逐字段 diff」的树，那必须在编辑器内再解析一遍对象图。
官方不做这件事，它把 `read_yaml` 的层级文本直接当答案；要求同形就得多一份编辑器内实现，放弃同形
后一行消息即可。

**prefab 覆盖**：官方回答的是「文件里写了什么覆盖」（`m_Modifications` + `PrefabInstance` 递归），
不是「Unity 认为哪些覆盖还生效」。两者答案不同，插件与官方对齐，因此按文件说。

**编辑器健康**：payload 不提供托管阶段（编译中/导入中/弹窗），官方也不用阶段——挂起诊断只看原生
主线程栈、CPU 与符号。「编辑器是不是在编译」有官方答案：broker 在编译期间拒绝 managed 请求
（`managed_not_ready` / `managed_reloading`），`src/recompile.js` 与 `explainUnresponsive` 已经这样用。

## 3. 能力边界

- `unity_status` 有 `responsive` / `diagnosis`，没有阶段字段；原生 `dsh_health` 的 `tiers` 只有
  `t2`（CPU）与 `t3`（存活）。
- `source: "live"` 需要 object 选择器（payload 的 `read_yaml` 要求 `object_path`），且只支持
  `.unity` / `.prefab`；其余情况回退磁盘并在输出里说明原因。
- prefab 覆盖没有独立工具，用 `unity_yaml_read` 读 `m_Modifications`。
- 只有 Windows 上真正的后台调度钩子属于本仓库实现（需要 Unity 的 PDB 私有符号），
  其它平台如实报 `unsupported`。

## 4. 约束

- 不再新增任何 Unity 侧包。编辑器侧能力一律以 payload 是否提供为准；缺就删功能或改走磁盘/原生。
- `payload/locus_unity/` 仍是 `npm run sync:payload` 的生成副本，`check:payload` 校验漂移。
