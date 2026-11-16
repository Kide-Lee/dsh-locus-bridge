# 内部契约：重型能力补齐（Hot reload / Compiler / Health / Flavor / Docs）

本文件是并行开发期间的**唯一接口真相**。子代理只实现自己模块里列出的函数签名与
返回形态；跨模块接线（`src/tools.js`、`src/index.js`、`src/settings.js`、
`src/sidebar/routes.js`）一律由 Lead 完成，子代理不要碰这些文件。

基线：HEAD `9b2b494`，`locus.version` 0.9.3，上游参考实现位于 `./Locus/`（只读）。

---

## 0. 全局规则（所有线必须遵守）

1. **不改 `payload/locus_unity/`**。它是 `npm run sync:payload` 的生成物，CI 里
   `npm run check:payload` 会校验。需要编辑器侧新增能力时，写旁挂包
   `packages/unity-bridge/`（本仓库原创 GPL 代码），通过反射挂到
   `Locus.LocusBridge.RegisterExtensionMessageHandler`。
2. **不改 broker wire 协议**（`native/locus-native-protocol/`）。新增编辑器侧能力
   走**扩展消息**（同进程，不经 broker）；只有非改不可时才动
   `native/locus_unix_native/`，并在 `NOTICE` 里记录为本仓库修改。
3. **不引入运行时 npm 依赖**（YAML/HTML 解析等自写子集）。新增构建期依赖需
   在提交说明里写明来源与许可证。
4. **不自动下载**任何大型运行时（.NET SDK、Unity、文档 zip 除外——文档 zip 是
   用户显式触发的功能本身）。
5. **平台不可用要诚实上报**：返回 `{supported: false, reason}` 或
   `error code 'unsupported'`，绝不假报成功。这是现有
   `src/health.js`（新）/`src/setup.js` 的约定。
6. **测试**：`node --test`，每个新模块至少一个 `test/<module>.test.js`；
   需要编辑器的用 `test/fake-broker.js` 的 `onMessage` 拦截，**不要求真 Unity**。
7. 中文注释、英文标识符、句子短、理由优先（沿用仓库现有代码风格）。
8. 提交前：`npm run check`（若你的模块还没接线，至少 `npm test` +
   `node scripts/typecheck.mjs` 通过）。

---

## 1. 工具契约总表（Lead 负责在 `src/tools.js` 注册）

新增/变更的 `unity_*` 工具。**所有写操作必须带 `request_editor_status`**
（现有权限契约），所有 `{text}` 形态输出用 `textFailure()` 制造错误。

| 工具 | 归属线 | 参数（除 `project_path`） | 输出 | 说明 |
|---|---|---|---|---|
| `unity_hot_reload` | A | `request_editor_status`(必填), `paths?`(string[]), `dry_run?`(boolean, 默认 false) | `{text, hot, needCompile, failed, details:[{path, method?, state, reason?}]}` | 写操作。`dry_run` 只跑归类器不落补丁。 |
| `unity_asset_search` | E | `type?`, `name?`, `under?`, `guid?`, `limit?`(1..200 默认 20), `rescan?` | `{text, total, partial, entries:[{path,type,guid}], broken?}` | 只读，无编辑器也可用。 |
| `unity_yaml_read` | E | `path`(必填), `object?`(fileId 或名字), `depth?`(0..4 默认 2), `max_items?`(默认 20) | `{text, source:'live'\|'disk', documents:[…]}` | 只读。磁盘模式无编辑器也可用。 |
| `unity_yaml_search` | E | `query`(必填, 支持 `re:`), `match_fields?`, `limit?`(1..1000 默认 50), `scope?` | `{text, source, total, matches:[{path, pointer, field, value}]}` | 只读。GUID 搜索请用 `unity_asset_search`。 |
| `unity_lock` | E | `mode`('wait'\|'try', 默认 wait), `timeout_seconds?`(1..900 默认 300), `reason?` | `{text, holder, acquiredAt}` | 协作锁，非编辑器锁。 |
| `unity_release` | E | — | `{text, released}` | 只释放本会话 owner 的锁。 |
| `unity_offline_docs` | D | `action`('status'\|'import'\|'search'\|'read'), `query?`, `path?`, `locale?`('en'\|'zh-cn') | `{text, …}` | 导入/检索 Unity 官方离线文档。 |
| `unity_recompile` (改) | A | 新增 `mode?`('auto'\|'compile'\|'scripts', 默认 'compile') | 原输出 + `mode` | `auto`：热更优先，结构变化回退重编译。 |
| `unity_console_log` (改) | E | 新增 `source?`('console'\|'editorLog', 默认 'console') | 原输出，前缀 `[source: Editor.log]` | — |
| `unity_status` (改) | B/C | — | 原输出 + `flavor`, `editorHealth`, `selection` | flavor 由 B 提供，health 由 C 提供，selection 由 E 提供。 |
| `unity_asset_graph` (改) | E | 新增行为：未打开的资产走工程索引 | + `source:'project'\|'open-scene'` | — |

---

## 2. 线 A：热重载

### 2.1 编辑器侧（旁挂包，A 负责）
目录：`packages/unity-bridge/Editor/HotReload/`，asmdef 名 `Locus.DshBridge.Editor`。

通过反射注册扩展消息处理函数，消息名固定为：

| 消息 | 请求 JSON | 应答 JSON |
|---|---|---|
| `dsh_hot_reload_classify` | `{paths:[string], patch_id:string}` | `{hot:[{path, method_key, declaring_type, name, param_type_names, param_type_sigs, is_static, is_ctor}], needCompile:[{path, reason}], failed:[{path, error}]}` |
| `dsh_hot_reload_apply` | `{patch_id, assembly_b64, methods:[…同 hot], domain_generation?}` | `{applied:number, skipped:[{method_key, reason}]}` |
| `dsh_hot_reload_status` | `{}` | `{detours:number, patched_methods:[string], last_error?:string}` |
| `dsh_hot_reload_dispose` | `{patch_id?}` | `{disposed:number}` |

实现路径（按优先级）：
1. **首选**：把**已编译的**补丁程序集交给 payload 现成的 `hot_patch_loaded` 语义。
   我们旁挂包自己实现 detour 会与 payload 的 `_hotMethodDetours` 抢同一条路径，
   所以要么（a）只做归类 + 调 `execute_code` 让 payload 执行 detour，要么
   （b）自己完整实现并用**独立静态类**避免冲突。**推荐 (a)**：用
   `compile_skill_package` 的既有能力编译补丁（它的返回 `assembly_b64` 正是
   `hot_patch_loaded` 需要的），然后用 `execute_code` 反射调用
   `Locus.LocusBridge.hot_patch_loaded` 的私有处理器是不可行的——它是私有方法。
   **因此最终形态**：旁挂包自己持有 `Dictionary<MethodBase, IDisposable>`，
   通过 `MonoMod.RuntimeDetour.Hook`（payload 的 `Locus.Detour.dll` 已在编辑器域，
   旁挂包在 asmdef 里 `precompiledReferences` 引用它，并通过 `Locus.Editor`
   asmdef 的 `autoReferenced:false` 关系用反射拿到 DLL 路径后
   `Assembly.LoadFrom`）建立 detour。两条 detour 路径互不干扰的前提是：
   payload 只在桌面端驱动 `hot_patch_loaded`，DSH 侧永不发送该消息。
2. 结构变化（字段增删、签名、类型形状）→ 归类为 `needCompile`，不尝试补丁。

### 2.2 JS 侧（A 负责）
`src/hotreload.js`：

```js
export const HOT_RELOAD_MODES = Object.freeze(['auto', 'compile', 'scripts'])
export async function classifyHotEdit(client, { paths }) // → {hot, needCompile, failed}
export async function applyHotPatch(client, { patchId, assemblyB64, methods, domainGeneration })
export async function hotReloadStatus(client)          // → {detours, patchedMethods, lastError}
export async function disposeHotPatches(client, { patchId })
export async function hotReload(target, { paths, dryRun }) // → 汇总，供工具层直接用
export function formatHotReload(result)                // → 给人看的多行文本
```

约束：所有 broker 调用走 `client.request('<消息名>', JSON.stringify(payload), {timeoutMs})`；
超时默认 60s；跨域重载窗口用 `src/recompile.js` 既有的
`isTransientBrokerError()` 判定并可重试一次。

### 2.3 与 `unity_recompile` 的联动（A 负责，Lead 接线）
`unity_recompile(mode:'auto')`：先 `hotReload`；若 `needCompile.length > 0` 或
`hot.length === 0`，才调用既有 `recompile()`。`mode:'scripts'` 走
`request_script_reload`（payload `LocusBridge.cs:1974-1993` 已实现）。

---

## 3. 线 B：编译服务器 + 团结引擎

### 3.1 .NET sidecar（B 负责）
目录 `tools/dsh-finish/Compiler/`（项目名 `DshFinishCompileServer`，`net10.0`）。
方法集**第一批只需四个**：`initialize`、`shutdown`、`compile/snippet`、
`compile/runStates`。Content-Length stdio JSON-RPC，与
`Locus/locus_compile_server/StdioTransport.cs` 同帧格式（可直接复制该文件，
在 `NOTICE` 记录为本仓库派生）。

`compile/snippet` 请求：`{code, usings?, references?:[{path}], timeout_ms?, loop_guard?:boolean}`
应答：`{ok:boolean, diagnostics:[{severity,id,message,line,column}], assembly_b64?, error?}`

### 3.2 JS 客户端（B 负责）
`src/csharp/sidecar.js`：

```js
export const SIDECAR_IDLE_TIMEOUT_MS = 600_000
export const SIDECAR_MAX_WORKSPACES = 8
export async function sidecarStatus(projectRoot)   // → {available, dotnetVersion?, built, running, pid?}
export async function ensureSidecar(projectRoot)   // → {service} 或抛 SidecarUnavailable
export async function compileSnippet(projectRoot, { code, usings, timeoutMs })
export async function shutdownSidecar(projectRoot)
export class SidecarUnavailable extends Error { constructor(message, {code}) }
```

`SidecarUnavailable.code` ∈ `'no_dotnet' | 'build_failed' | 'start_failed' | 'unsupported_platform'`。
**找不到 .NET 10 时绝不抛未捕获异常**：`code_*` 工具捕获后回退现有编辑器内路径
并在输出里说明。

### 3.3 团结引擎识别（B 负责）
`src/unity-flavor.js`：

```js
export const FLAVORS = Object.freeze(['unity', 'tuanjie'])
export function detectFlavor(projectRoot)      // 读 ProjectVersion.txt → {flavor, version, productName?}
export function isTuanjieVersion(version)      // '2022.3.62t10' → true
export function editorExecutableCandidates(flavor) // 平台相关的候选可执行名
export function scanInstalledEditors({platform, homeDir}) // → [{flavor, version, path}]，读 Hub 配置
```

不依赖 Win32 窗口类；窗口标题匹配在 Unix 上返回 `{supported:false}`。

---

## 4. 线 C：状态探针 / 卡死诊断 / 后台加速

### 4.1 原生（C 负责，`native/locus_unix_native/src/`）
- `hook/mod.rs`：`cfg(windows)` 实现 `locus_set_background_active(active)` 的补丁
  与恢复（返回打点数量，失败 -1）；非 Windows 保持 -1 并在状态里标 `Unsupported`。
- `state_probe/mod.rs`：`probe(pid) -> StateProbeTiers {t1, t2, t3}`，T2/T3 用
  `/proc/<pid>/stat`（Linux）/ `proc_pidinfo`（macOS）；T1 由编辑器侧阶段标记喂入。
- `hang/mod.rs`：`capture_main_thread_stack(pid) -> Result<Vec<Frame>, StackError>`，
  能用 `mono_names.rs` 已解析的符号时给出托管帧（方法名 + 文件 + 行），否则
  `StackError::Unavailable`。**必须幂等、必须不阻塞主线程**。

### 4.2 编辑器侧（C 负责，旁挂包 `packages/unity-bridge/Editor/Health/`）
扩展消息 `dsh_health_snapshot` → `{phase, since_ms, playing, paused, compiling, updating, importing, modal_dialog?}`，
由 `EditorApplication.update` 打点；`dsh_health_subscribe` 控制开关。

### 4.3 JS（C 负责）
`src/health.js`：

```js
export const UNRESPONSIVE_AFTER_MS = 30_000
export const BUSY_CPU_PERCENT = 25.0
export async function editorHealth(target)     // → {supported, responsive, stuckAt?, phase?, cpuPercent?, diagnosis?, backgroundHook, stateProbe, compiler}
export function explainUnresponsive(error)     // → string | null，供 client-pool 错误包装使用
export async function enableBackgroundHook(target, enabled)
```

`editorHealth()` 输出直接挂到 `unity_status` 结果的 `editorHealth` 字段。
**注意**：`src/client-pool.js` 由 Lead 改（只调用 `explainUnresponsive`）。

---

## 5. 线 D：Unity 官方离线文档

`src/docs/unity-docs.js`：

```js
export const DOCS_ROOT_NAME = 'unity-docs'
export function docsRoot(projectRoot)              // <project>/Library/Locus/unity-docs
export async function importDocs(projectRoot, { locale = 'zh-cn', version?, signal } = {})
  // → {state:'imported'|'up_to_date'|'unsupported_version'|'network_error', version, files, bytes}
export async function docsStatus(projectRoot)       // → {imported, version, locale, files, updatedAt}
export async function searchDocs(projectRoot, { query, limit = 20 }) // → [{path, title, snippet, score}]
export async function readDoc(projectRoot, { path }) // → {path, title, markdown}
```

- 版本来自 `<project>/ProjectSettings/ProjectVersion.txt` 的 `m_EditorVersion`。
- URL 形态沿用上游：`https://docs.unity3d.com/{ver}/Documentation/Manual/OfflineDocumentation.html`
  （`zh-cn` 用 `https://docs.unity3d.com/cn/{ver}/Manual/OfflineDocumentation.html`）。
- HTML→Markdown 只做标题/段落/列表/代码块/链接，**自写**、不做通用 HTML 解析。
- 索引落 `Library/Locus/unity-docs/index.json`；检索用子串 + 词频打分。
- 网络层用 `fetch`，注入 `signal` 支持取消；测试用注入的假 `fetch`。

另外 D 负责把文档注册成 **DSH skill provider**（`src/docs/skill-provider.js`，
实现与 `src/skills/provider.js` 相同的 `{name, list, get}` 形状，但只读
`docsStatus()` 是否导入；未导入时 `list()` 返回 `[]`）。Lead 负责在
`src/index.js` 里注册。

---

## 6. 线 E：中型补齐 + bug 修复

见工具契约表中的 `unity_asset_search` / `unity_yaml_*` / `unity_lock` /
`unity_console_log(source)`，模块与签名：

```js
// src/asset-db.js
export const ASSET_DB_MAX_FILES = 200_000
export async function scanAssets(projectRoot, { rescan = false, budgetMs = 20_000 } = {})
  // → {assets:[{guid, path, ext, type}], broken:{missingMeta:[], duplicateGuids:[{guid, paths:[]}]},
  //    memberBindings:[{scriptGuid, assetPath, fileId, className}], partial, scannedFiles, elapsedMs}
export async function searchAssets(projectRoot, { type, name, under, guid, limit })
export async function findScriptAttachments(projectRoot, { scriptGuid, member? })
export function formatAssetSearch(result)

// src/yaml-lite.js
export function parseUnityYaml(text)   // → {documents:[{classId, fileId, stripped, tree}]}
export function queryDocument(doc, path)   // RFC6901-ish '/MonoBehaviour/speed'
export function searchDocuments(docs, { query, matchFields, limit })

// src/editor-lock.js
export async function acquireLock(projectRoot, { owner, mode = 'wait', timeoutSeconds = 300, reason })
  // → {acquired, holder, acquiredAt, waitedMs} 或抛 LockTimeout
export async function releaseLock(projectRoot, { owner })
export async function lockStatus(projectRoot)
export class LockTimeout extends Error {}

// src/console.js（追加导出）
export async function readEditorLogEntries(projectRoot, { levels, limit, since })
  // → {source:'Editor.log', path, entries:[{level, message, time?}], supported}
```

bug 修复项（E 负责）：
1. `src/skills/view/SKILL.md` 改写为 DSH 可执行版本（`unity_execute` +
   `property_tree_read/apply` 写 EditorWindow；删掉 `execute_typescript` /
   `locus.views.*` / `@locus/view-runtime` / 5 份不存在的子文档引用）。
2. `src/skills/catalog.js`：`graphics-debugger` 增加
   `capabilities: {frameDebugger: true, renderDoc: false}`；
   `view` 增加 `requiresUnity: true`。
3. `src/skills/provider.js`：`createDomainSkillProvider({enabled, control})` 接上
   `control.invalidate()`；`requiresUnity` 的技能在 `effectiveFeatures().unity === false`
   时 `invocation.modelInvocable = false`；`graphics-debugger` 的 description 追加
   `partial` 说明。
4. `/locus/api/skills/state`（`src/sidebar/routes.js:412-433`）：`executable`
   改为逐项 `{frameDebugger, renderDoc}`。**该文件由 E 改这一小段，其余路由不动。**
5. `src/client/plugin.js:15` 注释 `property_tree_write` → `property_tree_apply`。
6. `AGENTS.md` 工具数量、`docs/marketplace/README.md` 工具数量。
7. `test/fake-broker.js` 增加 `emit(eventType, payload)` 与
   `emitToOnly()` 开关，用于测 `unity-editor-update` 消费。

---

## 7. 文件写作用域（冲突即停手，先问 Lead）

| 线 | 独占目录/文件 |
|---|---|
| Lead | `src/tools.js`, `src/index.js`, `src/settings.js`, `src/client-pool.js`, `src/sidebar/routes.js`(除 E 的 skills/state 段), `cordis.patch.yml`, `package.json`, `CHANGELOG.md`, `README*.md`, `NOTICE` |
| A | `packages/unity-bridge/Editor/HotReload/**`, `src/hotreload.js`, `test/hotreload.test.js`, `src/recompile.js` |
| B | `tools/dsh-finish/Compiler/**`, `packages/unity-bridge/Editor/Compiler/**`, `src/csharp/sidecar.js`, `src/unity-flavor.js`, `test/compiler.test.js`, `test/flavor.test.js` |
| C | `native/locus_unix_native/src/{hook,state_probe,hang}/**`, `packages/unity-bridge/Editor/Health/**`, `src/health.js`, `test/health.test.js`, `native/locus_unix_native/tests/**` |
| D | `src/docs/**`, `test/unity-docs.test.js`, `test/unity-docs-skill.test.js` |
| E | `src/asset-db.js`, `src/yaml-lite.js`, `src/editor-lock.js`, `src/console.js`, `src/asset-graph.js`, `src/skills/**`, `src/sidebar/paths.js`, `src/client/plugin.js`(仅第 15 行注释), `AGENTS.md`, `docs/marketplace/README.md`, `test/fake-broker.js`, `test/{asset-db,yaml-lite,editor-lock,console-log,skills-provider}.test.js` |

`packages/unity-bridge/` 的共享骨架（`package.json`、asmdef、
`Editor/DshBridgeBootstrap.cs`、扩展消息反射桥）由 **Lead 先写好**再分发，A/B/C 只往
自己的子目录加文件。