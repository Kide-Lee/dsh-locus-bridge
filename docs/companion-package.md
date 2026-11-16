# 协作包 `com.locus.dsh-bridge`

本文说明这个仓库里那个额外的 Unity 包：谁依赖它、依赖什么、每项能力在 Locus 里原本怎么实现，以及为什么 Locus 自己不需要这样一个包。

## 1. 它是什么

`packages/unity-bridge/` 是一个原始的 Unity 包，安装时由 `src/setup.js` 复制到工程的
`Packages/com.locus.dsh-bridge/`，与上游的 `com.farlocus.locus`（payload）并排存在。

它通过 asmdef 显式引用 `Locus.Editor`，向 payload 的
`LocusBridge.RegisterExtensionMessageHandler` 注册一组扩展消息。payload 不修改：
`payload/locus_unity/` 是 `npm run sync:payload` 的生成副本，`check:payload` 会校验它没有漂移。

当前它只注册七条消息：

| 消息 | 用途 |
|---|---|
| `dsh_hot_reload_apply` | 加载补丁程序集并对列出的方法挂 MonoMod detour |
| `dsh_hot_reload_status` | 报告本包自己的 detour 台账 |
| `dsh_hot_reload_dispose` | 按补丁（或全部）摘除 detour |
| `dsh_health_snapshot` | 报告编辑器阶段（compiling / importing / reloading / playing / paused / editing） |
| `dsh_health_subscribe` | 订阅阶段快照推送（订阅期间由编辑器主动推事件） |
| `dsh_live_read` | 读取实时属性树快照（与磁盘 YAML 同形），供 yaml 的 live 模式 |
| `dsh_live_prefab_overrides` | 读取 Unity 已解析的 prefab 覆盖表 |

热重载的**分类**不在这里：它在插件进程的 `src/hotreload-classify.js`，只读磁盘源码。

## 2. 谁依赖它

依赖方全部在插件进程（Node.js），不是别的 Unity 脚本：

| 插件侧模块 | 用到的消息 | 面向用户的工具 | 缺包时的行为 |
|---|---|---|---|
| `src/hotreload.js` | apply / status / dispose | `unity_hot_reload`（非 dry-run） | 无法应用补丁；工具报告 `patchError`，建议退回 `unity_recompile` |
| `src/health.js` | snapshot / subscribe | `unity_status` 的阶段字段、`explainUnresponsive` | `dsh_health` 仍由原生 broker 应答；缺的只是「编辑器正在编译/导入」这类 managed 阶段 |
| `src/live-source.js` + `src/yaml-lite.js` | `dsh_live_read` | `unity_yaml_read` / `unity_yaml_search` 的 `source: "live"` | 回退磁盘并写明原因（`the companion package com.locus.dsh-bridge is not installed`） |
| `src/live-source.js` | `dsh_live_prefab_overrides` | `unity_prefab_overrides` | 工具直接报错，说明需要协作包 |
| `src/setup.js` / `src/companion-package.js` | —— | 安装与完整性诊断（`companion_missing`） | 只影响安装诊断，不影响其余工具 |

**不依赖协作包**的部分同样要说清楚，避免误以为它是全插件的枢纽：

- 热重载分类（`src/hotreload-classify.js`）；
- 资产索引与 `.meta` 扫描（`src/asset-db.js`，SQLite）；
- 离线文档（`src/docs/`，纯 Node）；
- 协作锁（`src/editor-lock.js`，只写 `Library/Locus/session-lock.json`）；
- 设置、Web 侧、`code_*`（Roslyn LSP 子进程）。

## 3. 四项能力：作用、为什么需要、Locus 怎么实现

### 3.1 热补丁应用（apply / status / dispose）

**作用**：把 .NET 编译服务产出的补丁程序集加载进当前编辑器域，对每个方法挂 MonoMod
detour，维护自己的台账，并能按补丁摘除。

**为什么需要**：补丁必须进入 Unity 的进程与程序集上下文；而 payload 的
`hot_patch_loaded` / `hot_patch_dispose` 处理器是 **private** 的，DSH 侧不能直接调用。payload 内部
已经有一套 detour 台账（`LocusBridge.HotReload.cs` 的 `_hotMethodDetours`），本包另建一套
（`DshHotReloadRegistry`）并明确「DSH 侧永不发送 `hot_patch_loaded`」，避免两边互相污染。

**Locus 的实现**：同一件事被拆在两层：
- 分类与补丁编译在桌面侧的编译服务 `locus_compile_server`（`analyze/hotDiff`、
  `compile/hotPatch`）；
- 应用在 payload 里：`hot_patch_loaded` 加载补丁程序集并用 MonoMod 改写原方法；
- 协调与台账在桌面 Rust（`src-tauri/src/unity_hotreload/`）。

**本仓库的差异**：分类改在插件进程（只读磁盘源码），补丁编译复用自带的 .NET 10
编译服务（`src/csharp/sidecar.js`），应用交给协作包。

### 3.2 编辑器阶段快照（snapshot / subscribe）

**作用**：报告「编辑器现在在干什么」——`compiling` / `importing` / `reloading` /
`playing` / `paused` / `editing`，以及对应的布尔位。`unity_status` 的
`responsive` / `phase` / `diagnosis` 因此能区分「真的卡死」与「正在编译」。

**为什么需要**：原生 broker 从进程外面只能看到 CPU、心跳、主线程栈；「正在编译 / 正在导入」
只有编辑器自己知道，而 payload 没有暴露这类状态的消息。

**Locus 的实现**：没有 managed 阶段上报。Locus 的健康判断来自原生状态探针
（CPU / 心跳 / 互斥量、主线程栈），本仓库的 `native/locus_unix_native/` 就是那条路径的移植；
真正的 `dsh_health` 消息也由原生 broker 自己应答，不进 managed 队列。协作包补的是
「编辑器阶段」这一层 managed 信息，属于本仓库新增，不是照搬上游。

**缺包时**：`dsh_health` 仍然工作（broker 应答），只是没有 phase 细节；`explainUnresponsive`
会少一段「在编译/在导入」的解释。

### 3.3 实时值（`dsh_live_read`）

**作用**：从编辑器内存里读一份属性的快照（包括未保存的修改），由 `yaml-lite.js` 渲染成
**与磁盘 YAML 同形**的文本，供 `unity_yaml_read` / `unity_yaml_search` 的 `live` 模式使用。

**为什么需要**：payload 已有 `property_tree_read`，但它返回的是**展示树**
（`nodeKind` / `valueType` / `display` / 分页字段），不是 Unity 序列化 YAML 的字段树。
本仓库的 live 语义是「live 与 disk 逐字段对齐、可互换比较」，因此需要在编辑器内用
`SerializedObject` 遍历出与磁盘同形的树。协作包做的是这一步，渲染仍在 Node 侧。

**Locus 的实现**：桌面侧直接调 payload 的 `property_tree_read`（`agent/instance/mod.rs`），
在 Rust 里聚合并渲染成 `unity_yaml_read` 的输出。它不需要「与磁盘 YAML 同形」的中间层，
因为它的 live 输出本来就是自己的展示格式。

**缺包时**：`source: "live"` 回退磁盘并明确说明原因；`auto` 也回退磁盘。

### 3.4 prefab 覆盖（`dsh_live_prefab_overrides`）

**作用**：给出 Unity **解析后**的覆盖表：每条覆盖的目标、属性路径、实例值、以及预制体里的
原值。这是 `unity_prefab_overrides` 工具的全部内容。

**为什么需要**：`PrefabUtility.GetPropertyModifications` / `GetObjectOverrides` 是 internal
API，只有编辑器内能反射调用；payload 没有公开「解析后的覆盖表」这类消息。

**Locus 的实现**：上游**没有**独立的 `unity_prefab_overrides` 工具。它把这件事做成
`unity_yaml_read` 的一个 detail 模式（测试夹具里可见 `detail: prefab_overrides`），
从 `property_tree` 读 prefab 实例的 `m_Modifications` 原始记录，在 Rust 侧聚合。得到的是
「文件里写了什么覆盖」，不是「Unity 认为哪些覆盖仍生效」。

**缺包时**：工具直接报错，说明需要协作包；不会返回一张空表冒充「没有覆盖」。

## 4. 为什么 Locus 不需要协作包

一句话：**Locus 是 payload 的作者，而我们是 payload 的客户端，且不允许分叉它。**

具体拆开是四条：

1. **归属与发布边界**：Locus 的桌面 app 与 Unity 包同属一个产品、同一条发布流水线。编辑器内
   需要新能力时，直接改自家 Unity 包（`LocusBridge.HotReload.cs`、`PropertyTree.cs`、
   `LocusEditorScheduling.cs`……）随版本发布。它没有「第三方客户端需要、但 payload 没暴露」的问题。
2. **进程边界**：Locus 的编排在桌面 Rust 进程，编辑器内执行在 payload。要在编辑器里多做事，
   它改 payload；本仓库的编排在 DSH 插件（Node）进程，编辑器内执行只能来自 payload 或另一个
   Unity 包。
3. **payload 不可改**：本仓库的 `payload/locus_unity/` 是上游生成副本，`check:payload` 校验，
   手工修改会在下次同步时丢失并让 CI 失败。因此新增的编辑器侧代码只能放在旁挂包里。
4. **payload 预留了扩展点**：`LocusBridge.RegisterExtensionMessageHandler` 的注释写明
   「optional package integration without adding its assembly dependencies to the core bridge」。
   协作包就是照这个口子挂的——它是上游预期的第三方集成形态，只是 Locus 自己用不上。

换句话说，Locus 的「协作包」就是 payload 本身：它把编辑器侧扩展直接长在包里。我们只是把
「Locus 放在桌面进程或 payload 里的那部分能力」搬进一个独立的旁挂包，因为前两个位置我们
都动不了。

## 5. 维护约束

- **payload 版本声明**：根 `package.json` 的 `locus.payload`（包版本）与 `locus.version`
  （上游 release）共同声明本插件对应的 payload；`unity_status` 的诊断与 `check:payload`
  都会校验，不一致会告警或失败。
- **asmdef 引用**：协作包显式 `references: ["Locus.Editor"]`，`overrideReferences: true`；
  payload 的 `autoReferenced: false` 不妨碍显式引用。
- **Detour 仍走反射**：`Locus.Detour.dll` 虽然列在 `precompiledReferences` 里，但实测把协作包
  整体重装后 Unity 会丢失包内 precompiled 解析，直接构造 MonoMod 类型会编译失败；因此
  detour 引擎保留反射加载，只有扩展注册与事件发送是硬引用。
- **安装顺序**：payload 先就位，协作包才能编译（它引用 `Locus.Editor`）。`install-unity-package.mjs`
  会一并复制；运行中的编辑器会拒绝重装（它持有程序集）。
- **缺包是降级，不是崩溃**：四类能力各自有明确的降级路径，工具不会假装成功。