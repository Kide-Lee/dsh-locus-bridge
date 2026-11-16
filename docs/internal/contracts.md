# 内部契约：重型能力补齐（Hot reload / Compiler / Health / Flavor / Docs）

本文件是并行开发期间的**唯一接口真相**。子代理只实现自己模块里列出的函数签名与
返回形态；跨模块接线（`src/tools.js`、`src/index.js`、`src/settings.js`、
`src/sidebar/routes.js`）一律由 Lead 完成，子代理不要碰这些文件。

基线：HEAD `9b2b494`，`locus.version` 0.9.3，上游参考实现位于 `./Locus/`（只读）。

---

## 0. 全局规则（所有线必须遵守）

1. **不改 `payload/locus_unity/`**。它是 `npm run sync:payload` 的生成物，CI 里
   `npm run check:payload` 会校验。插件**不附带任何 Unity 侧代码**：编辑器侧能力只用 payload
   已有的消息与工具，引擎里缺什么就删功能或改走磁盘/原生，而不是旁挂一个包。插件在根
   `package.json` 的 `locus.payload` 声明对应的 payload 版本。
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
| `unity_hot_reload` | A | `paths`(string[], 至少一个), `dry_run?`(boolean, 默认 false) | `{text, hot, needCompile, failed, files:[{path,state,reason?,method_count}], patches:[{id,path,methods,applied}], patchError?, supported}` | 编辑会话内不写工程文件；`dry_run` 只跑归类器不落补丁。`files` 是逐文件结论（含无方法体的热文件）。补丁由 payload 原生 `hot_patch_loaded` 落地，不需要旁挂包。 |
| `unity_asset_search` | E | `type?`, `name?`, `under?`, `guid?`(32-hex), `limit?`(1..200 默认 20), `rescan?` | `{text, total, partial, assets:[{path,type,guid}]}` | 只读，无编辑器也可用；非法 `guid` 直接报错。 |
| `unity_yaml_read` | E | `path`(必填), `object?`(fileId 或名字), `depth?`(0..4 默认 2), `max_items?`(1..1024 默认 20), `source?`('auto'\|'disk'\|'live') | `{text, path, source:'live'\|'disk', total}` | 只读。磁盘模式无编辑器也可用；`auto` 对单文件走 live 并回退磁盘。 |
| `unity_yaml_search` | E | `query`(必填, 支持 `re:`), `scope?`(文件或目录), `match_fields?`(path\|field_name\|field_value\|type\|all), `limit?`(1..1000 默认 50), `source?` | `{text, matches:[{path, pointer, field, value}], scanned}` | 只读。单文件范围可用 live；目录/全工程只读磁盘。 |
| `unity_lock` | E | `action?`(acquire\|release\|status), `owner?`, `mode?`('wait'\|'try', 默认 wait), `timeout_seconds?`(1..900 默认 300, 越界报错), `reason`(acquire 必填) | `{text, action, held, acquired, holder, path}` | 协作锁，锁文件 `Library/Locus/session-lock.json`，非编辑器锁。 |
| `unity_release` | E | `owner?` | `{text, released, holder}` | 只释放本会话 owner 的锁。 |
| `unity_offline_docs` | D | `action`('status'\|'import'\|'search'\|'read'\|'cancel'\|'delete'), `query?`, `path?`, `locale?`('en'\|'zh-cn'), `version?`, `limit?` | `{text, action, imported, state, version, results}` | 导入/检索 Unity 官方离线文档；导入可取消，索引可删除。 |
| `unity_recompile` (改) | A | 新增 `mode?`('auto'\|'compile'\|'scripts', 默认 'compile') | 原输出 + `mode` | `auto`：热更优先，结构变化回退重编译。 |
| `unity_console_log` (改) | E | 新增 `source?`('console'\|'editorLog', 默认 'console') | 原输出，前缀 `[source: Editor.log]` | — |
| `unity_status` (改) | B/C | — | 原输出 + `flavor`, `editorHealth`, `selection` | flavor 由 B 提供，health 由 C 提供，selection 由 E 提供。 |
| `unity_asset_graph` (改) | E | 新增行为：未打开的资产走工程索引 | + `source:'project'\|'open-scene'` | — |

---

## 2. 线 A：热重载

### 2.1 编辑器侧（payload 原生，不需要旁挂包）
热补丁的**应用**完全走 payload 自带的消息（`LocusBridge.cs` 的 `hot_patch_loaded` /
`hot_patch_dispose` / `hot_reload_probe` 三个 case），就是 Locus 桌面端驱动的那条路：
分类与编译在插件进程，应用在 payload 内完成，台账在驱动方。

| 消息 | 请求 | 应答 |
|---|---|---|
| `hot_patch_loaded` | `{patch_id, assembly_b64, methods:[HotPatchMethodDto], domain_generation?, message_drivers?}` | `{patch_id, method_count, detour_engine, inlined_method_keys[], inlined_sources[], pump_supported, pumped_count, pump_skipped_count, pump_skipped_messages[], pump_failed_count}` |
| `hot_patch_dispose` | 裸字符串：`all` / 空串 / `patch_id` | 文本 `disposed:<n>` |
| `hot_reload_probe` | 空 | `{detour_ok, detour_engine, code_optimization, domain_reload_on_play, error?}` |

`HotPatchMethodDto`：`{declaring_type, patch_declaring_type, name, param_type_names,
param_type_sigs, is_static, is_ctor, source_path, original_assembly}`，其中
`param_type_names` 是**必需**的（payload 靠它解析重载，缺了会报
"original method not found in the loaded assemblies"）。

语义要点：
1. **整批原子**：payload 内任一方法失败即 `RollbackHotPatch` 并回 `ok:false`
   （`hot patch apply failed (rolled back): …`），不像旧旁挂包那样逐方法 `skipped`。
   DSH 侧把整批失败记成该文件的 `skipped` 行，不视为「编辑器丢了」。
2. **domain 校验**：`domain_generation` 与 payload 的 `_compileDomainGeneration` 不一致时
   payload 拒绝；空值跳过校验。驱动方先 `get_reload_state` 取真值再发送。
3. **重打同一方法 = 替换**：payload 的键是
   `MethodKey = declaring_type|name|join(param_type_names)|s|i` 再加 `|original_assembly`，
   同一键只有一条活 detour（注释称与 Rust `unity_method_key` 逐字节一致）。
4. **台账在驱动方**：payload 的 `_hotMethodDetours` 是私有的、没有查询消息，所以
   `src/hotreload.js` 自己按同一键规则维护台账，并在 `get_reload_state` 的
   `domain_generation` 变化时清空（detour 随域消失，payload 也不清）。
5. **打补丁前先自检**：`hot_reload_probe` 用两个 `[MethodImpl(NoInlining)]` 探针方法验证
   detour 引擎（挂上得 2、dispose 后回到 1），失败就整批不打、直接报原因。
6. **内联风险**：Release 构建里被内联的方法，detour 虽活着但调用点仍走编译体；
   payload 在应答的 `inlined_method_keys` / `inlined_sources` 里点名，DSH 在报告里如实写出。

旁挂包里的 `dsh_hot_reload_apply/status/dispose` 与 `Editor/HotReload/` 目录已删除：payload 里
本来就有 `_hotMethodDetours`，同一条路径不留第二个实现。

实现路径（按优先级）：
1. **首选（即当前实现）**：JS 侧直接发 payload 的 `hot_patch_loaded`。此前认为私有
   处理器「不可达」，但 `private` 只是 C# 可见性：扩展消息走的是同一个
   `HandleMessageAsync` 的 `default:` 分支，native broker 不做消息白名单，所以
   `client.request('hot_patch_loaded', json)` 与桌面端完全同路。
2. 结构变化（字段增删、签名、类型形状）→ 归类为 `needCompile`，不尝试补丁。

### 2.2 JS 侧
`src/hotreload.js`：

```js
export const HOT_RELOAD_MODES = Object.freeze(['auto', 'compile', 'scripts'])
export function classifyHotEdit(projectRoot, paths)      // → {hot, needCompile, failed, files}（本地分类）
export async function probeDetourEngine(client)        // → {detourOk, detourEngine, codeOptimization, domainReloadOnPlay, error}
export async function applyHotPatch(client, { patchId, assemblyB64, methods, domainGeneration, sourcePath })
export async function hotReloadStatus(client = null)   // → {detours, patchedMethods, lastError, domainGeneration, entries}
export async function disposeHotPatches(client, { patchId })
export function methodKey(method) / detourKey(method)  // 与 payload 的键规则一致
export async function hotReload(target, { paths, dryRun }) // → 汇总，供工具层直接用
export function formatHotReload(result)                // → 给人看的多行文本
```

约束：`hot_patch_loaded` 走 `client.request('hot_patch_loaded', json, {timeoutMs: 60_000})`；
`hot_patch_dispose` 的 body 是裸字符串（不是 JSON）；`hot_reload_probe` 空 body。
跨域重载窗口用 `src/protocol.js` 的三个瞬态码精确匹配（与上游
`is_transient_broker_error` 同义）并至多重试一次。

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
- `state_probe/mod.rs`：`probe(pid) -> StateProbeTiers {t2, t3}`，用
  `/proc/<pid>/stat`（Linux）/ `proc_pidinfo`（macOS）测 CPU，用 `kill(pid, 0)` 测存活。
  没有托管阶段档：payload 不提供阶段，编辑器是否在编译由 broker 拒绝 managed 请求体现。
- `hang/mod.rs`：`capture_main_thread_stack(pid) -> Result<Vec<Frame>, StackError>`，
  能用 `mono_names.rs` 已解析的符号时给出托管帧（方法名 + 文件 + 行），否则
  `StackError::Unavailable`。**必须幂等、必须不阻塞主线程**。

### 4.2 编辑器侧
无。健康能力全部在原生 broker（§4.1）里应答，编辑器侧不装任何旁挂包。

### 4.3 JS（C 负责）
`src/health.js`：

```js
export const UNRESPONSIVE_AFTER_MS = 30_000
export const BUSY_CPU_PERCENT = 25.0
export async function editorHealth(target)     // → {supported, responsive, stuckAt?, cpuPercent?, diagnosis?, backgroundHook, stateProbe}
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
| A | `src/hotreload.js`, `src/hotreload-classify.js`, `test/hotreload.test.js`, `src/recompile.js` |
| B | `tools/dsh-finish/Compiler/**`, `src/csharp/sidecar.js`, `src/unity-flavor.js`, `test/compiler.test.js`, `test/flavor.test.js` |
| C | `native/locus_unix_native/src/{hook,state_probe,hang}/**`, `src/health.js`, `test/health.test.js`, `native/locus_unix_native/tests/**` |
| D | `src/docs/**`, `test/unity-docs.test.js`, `test/unity-docs-skill.test.js` |
| E | `src/asset-db.js`, `src/yaml-lite.js`, `src/editor-lock.js`, `src/console.js`, `src/asset-graph.js`, `src/skills/**`, `src/sidebar/paths.js`, `src/client/plugin.js`(仅第 15 行注释), `AGENTS.md`, `docs/marketplace/README.md`, `test/fake-broker.js`, `test/{asset-db,yaml-lite,editor-lock,console-log,skills-provider}.test.js` |

各线只改上表列出的文件；跨线的公共骨架（`src/tools.js`、`src/index.js`、`package.json`）
由 **Lead 先写好**再分发。