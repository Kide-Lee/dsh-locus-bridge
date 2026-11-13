// The browser half of the Unity asset preview/editor.
//
// This is an ESM module so tests can import it; `scripts/build-client.mjs`
// strips the `export` keywords and wraps the body in the `__ModuleLoader__`
// factory a DSH client bundle must register (the same lazy-CJS shape
// `dsh-lazy-history` hand-writes). Nothing here imports anything statically:
// the only external `require` is `react`, and the three.js model viewer is a
// separate `lib/model-viewer.js` loaded with a dynamic import only on demand.
//
// What the tab does, and why each choice matches Locus:
//
//   * The tree comes from `property_tree_read`, i.e. Unity's own SerializedProperty
//     walk with display names, enum options, ranges and foldouts — the same
//     source `LocusPropertyTree` exposes. It is NOT a YAML re-implementation.
//   * Edits go one property at a time through `property_tree_write`, which is
//     what the Locus inspector does (`unityPropertyApi.write`), and they are
//     in-memory edits that dirty the object. Saving is a separate, explicit
//     action, exactly like pressing Ctrl+S in the editor.
//   * Prefab previews are the editor's own renderer (`asset_preview_render`
//     orbits a prefab through `PreviewRenderUtility`, `asset_thumbnail` asks
//     `AssetPreview`). `.fbx`/`.glb` files take Locus' other path: the raw bytes
//     are parsed by a lazily loaded browser three.js viewer, so Unity needs no
//     importer for them and orbiting is WebGL, not an editor render.

/** Tab kind and registration identity (unique across every tab type). */
export const TAB_ID = 'dsh-locus-bridge/asset'
export const TAB_KIND = 'locus-asset'

/**
 * Settings section id.
 *
 * Must equal the id given to `settings.section` and to the matching
 * `settings.section.icon` row: the shell matches icons to sections by id, and an
 * unmatched id simply never renders (it does not fall back to the gear).
 */
export const SETTINGS_SECTION_ID = 'dsh-locus-bridge'

/**
 * Suffixes this tab claims; the Host keeps the same list in `src/sidebar/paths.js`.
 *
 * Models are read-only (see `isEditableAssetPath`). `.fbx` / `.glb` are drawn by
 * the browser three.js viewer; the remaining model suffixes keep the Unity
 * fallback (`property_tree_read` walks the imported GameObject,
 * `asset_preview_render` orbits it) when the project has an importer.
 */
export const EXTENSIONS = [
  'prefab',
  'asset',
  'mat',
  'controller',
  'anim',
  'overridecontroller',
  'playable',
  'mask',
  'physicsmaterial2d',
  'fbx',
  'obj',
  'dae',
  '3ds',
  'max',
  'blend',
  'gltf',
  'glb',
]

/**
 * The patterns this tab registers.
 *
 * **Why whole addresses rather than `*.prefab`.** The Sidebar ranks the tab
 * types that claim an address by `(priority band, pattern length, order)`. Other
 * installed plugins — `dsh-better-sidebar` is the one that bit here — register a
 * generic `dsh-resource://file/**` at the same `extension` band, and 22 characters
 * beat `*.prefab`'s 9, so *their* editor opened every prefab and this panel was
 * never chosen. A scheme-qualified pattern is both more precise (it can only
 * match a file address) and longer than the generic one, so the file this tab
 * specializes in reaches this tab.
 */
export function patternsFor(extensions = EXTENSIONS) {
  return extensions.map((extension) => `${FILE_ADDRESS_PREFIX}**/*.${extension}`)
}

/** Model suffixes: orbit-rendered and read-only (mirrors `src/sidebar/paths.js`). */
export const MODEL_EXTENSIONS = ['fbx', 'obj', 'dae', '3ds', 'max', 'blend', 'gltf', 'glb']

const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'
const PREVIEW_COLLAPSE_WIDTH = 560

// ── localisation ────────────────────────────────────────────────────────────
//
// The panel's copy follows the DSH i18n system, like every shipped UI plugin:
// the client apply attaches the `locale` service and registers this plugin's
// dictionaries under {@link LOCALE_NS}. `t()` resolves the active language from
// the service's snapshot — so switching the Host locale re-renders the panel
// live — and falls back to the browser language when no service is attached (a
// bare test composition, or a Host that never mounted a locale plugin).
//
// Deliberately not `ctx.locale.bind()`: the copy is needed synchronously inside
// plain functions (`valueSummary`, `encodeWrite`) as well as components, and
// threading a bound translate function through all of them is more machinery
// than one module-level holder. A missing service degrades to the browser
// language, never to raw keys.

/** Locale namespace this plugin registers its dictionaries under. */
export const LOCALE_NS = 'locusBridge'

/** Chinese copy — the source of truth: every key here exists in `en` too. */
const zh = Object.freeze({
  loading: '加载中…',
  errorBusyTitle: 'Unity 正忙',
  errorReadTitle: '无法读取该资产',
  retry: '重试',
  chipOffline: '离线',
  chipCompiling: '编译中',
  chipError: '错误',
  editorEditing: '编辑中',
  editorPlaying: '运行中',
  editorPlayingPaused: '已暂停',
  editorDisconnected: '未连接',
  previewHide: '隐藏预览',
  previewShow: '预览',
  locate: '定位',
  reload: '重新读取',
  revert: '还原',
  save: '保存',
  saveWithCount: '保存（{n}）',
  saving: '保存中…',
  saved: '已保存',
  tooltipLocate: '在 Unity 中选中该资产',
  tooltipReload: '从 Unity 重新读取',
  tooltipRevert: '把所有改过的字段还原为打开此标签页时的值',
  tooltipNothingToRevert: '没有可还原的修改',
  tooltipSave: '把修改后的资产保存到磁盘',
  tooltipNoEdits: '没有未保存的修改',
  noThumbnail: '该资产没有缩略图。',
  noOrbit: '该资产没有轨道预览，显示缩略图。',
  orbitHint: '拖动旋转，滚轮缩放，WASD/QE 平移',
  rendering: '渲染中…',
  modelLoading: '加载模型…',
  modelError: '无法预览该模型',
  modelUnsupported: '该模型使用了当前查看器不支持的压缩格式（例如 Draco）。',
  modelPause: '暂停',
  modelPlay: '播放',
  modelClips: '动画',
  modelClipUnnamed: '动画 {n}',
  modelWireframe: '线框',
  modelClay: 'Clay',
  modelGrid: '网格',
  modelReset: '重置视角',
  modelStats: '网格 {meshes} · 三角面 {triangles} · 材质 {materials}',
  modelStatsRig: '骨骼 {bones}',
  modelNoTree: '该模型由浏览器查看器渲染，Unity 没有可读的序列化树。',
  expand: '展开',
  collapse: '折叠',
  addElement: '添加元素',
  removeElement: '移除最后一个元素',
  none: '无',
  clearReference: '清空该引用',
  flatSummaryTitle: '共 {n} 个对象（摘要）',
  notFileAddress: '此标签页不是会话文件地址。',
  readingAsset: '正在读取资产…',
  noSerializedData: '该资产没有可序列化的数据。',
  dirtyFooter: '{n} 项未保存的修改（仅在内存中，按保存写入文件）',
  savedToDisk: '已保存到磁盘',
  noUnsaved: '没有未保存的修改',
  itemCount: '{n} 项',
  notEditable: '该属性在此不可编辑。',
  expectedNumber: '需要一个有限数值。',
  severityWarning: '警告',
  severityError: '错误',
  severityInfo: '信息',
  settingsNav: 'Unity 桥接',
  settingsIntro: '这台机器上的所有会话共用同一份开关；改动会立即生效，不需要重启。',
  settingsFeatures: '功能',
  settingsUnity: 'Unity 操纵',
  settingsUnityHint: 'unity_* 工具：查询编辑器状态、执行 C# 片段、场景与资产编辑、截屏、运行测试。关闭后这些工具不再出现在模型的可调用列表里。',
  settingsCsharp: 'C# 分析',
  settingsCsharpHint: 'code_* 工具：基于 Roslyn 的符号搜索、跳转、引用查找、悬停与诊断。关闭时会同时关闭已启动的语言服务器进程。',
  settingsCsharpLocked: '已被 DSH_LOCUS_CSHARP=0 强制关闭，无法在此打开。',
  settingsPreview: '文件预览',
  settingsPreviewHint: '右侧栏的 Unity 资产标签页：prefab/材质/控制器等可浏览编辑，模型可轨道预览。关闭后资产接口一律拒绝请求。',
  settingsPreferences: '其它',
  settingsFrameCache: '把预览帧缓存到工程里',
  settingsFrameCacheHint: '把渲染出的预览帧写到工程的 Library/Locus/asset-preview-cache。关闭后每次都要重新渲染，但工程目录不会因浏览而增长。',
  settingsSaveFailed: '没有保存成功',
  settingsLoading: '读取设置…',
  settingsUnavailable: '无法读取设置：Host 没有挂载预览路由（可能不是 Web 端）。',
  settingsPath: '存储位置',
  projectsGroup: 'Unity 工程',
  projectsIntro: '列出工作区里能找到的 Unity 工程，并逐个检查 Locus 桥接状态。没有「已连接的工程」不代表出错——编辑器没开、或开了但原生桥没启动，都会显示为未连接。',
  projectsEmpty: '在这个工作区里没有找到 Unity 工程（需要同时有 Assets/ 和 ProjectSettings/）。',
  projectsRescan: '重新检测',
  projectsScanning: '检测中…',
  projectsStateConnected: '已连接',
  projectsStateNotConnected: '未连接',
  projectsStateMissing: '没有插件',
  projectHintClosed: '编辑器没有打开这个工程。',
  projectHintOpenNoBridge: '编辑器开着这个工程，但原生桥没有启动：检查 Library/Locus/NativeBridge.enabled 是否存在，然后重启编辑器。',
  projectHintMarkerMissing: '缺少 Library/Locus/NativeBridge.enabled，编辑器启动时不会拉起原生桥。',
  projectHintVersion: '插件版本 {version}',
  projectInstall: '安装插件',
  projectInstalling: '安装中…',
  projectInstalled: '已安装。请按下面的提示重开编辑器。',
  projectInstallBlocked: '编辑器正开着这个工程，占着插件的程序集文件。请先关闭编辑器再安装。',
  projectInstallDone: '插件已装入。请重新打开 Unity 编辑器，原生桥会在启动时拉起。',
  projectInstallNoPayload: '这个构建没有内置 Locus 插件包，无法自动安装。',
  settingsWorkspaceGroup: '工作区',
  settingsWorkspace: '工作区',
  settingsWorkspaceHint: '选择需要设置的 DSH 工作区',
  settingsWorkspaceNone: '使用当前会话的工作区',
  settingsWorkspaceUnavailable: '这个 Host 没有可读取的 DSH 工作区列表。',
  settingsWorkspaceLoadFailed: '读取工作区失败：{message}',
  settingsProject: 'Unity 工程',
  settingsProjectNone: '没有找到 Unity 工程',
  settingsPlugin: 'Locus 插件',
  settingsPluginInstalled: '已安装',
  settingsPluginMissing: '没有插件',
  settingsPluginOffline: '未打开 Unity',
  settingsPluginConnectionFailed: '连接失败',
  settingsPluginConnected: '已连接',
  settingsPluginInstall: '安装',
  settingsPluginInstalling: '安装中…',
  skillsGroup: '领域技能',
  skillsIntro: '把本插件内置的 Unity 领域知识作为 DSH 技能提供给模型：调试器、性能分析、图形诊断、UI Toolkit、Locus View。只保留 DSH 没有对应物的领域知识；技能随插件版本走，不写入工作区。',
})

/** English copy; must carry exactly the same keys as {@link zh}. */
const en = Object.freeze({
  loading: 'Loading…',
  errorBusyTitle: 'Unity is busy',
  errorReadTitle: 'Could not read this asset',
  retry: 'Retry',
  chipOffline: 'offline',
  chipCompiling: 'compiling',
  chipError: 'error',
  editorEditing: 'editing',
  editorPlaying: 'playing',
  editorPlayingPaused: 'paused',
  editorDisconnected: 'disconnected',
  previewHide: 'Hide preview',
  previewShow: 'Preview',
  locate: 'Locate',
  reload: 'Reload',
  revert: 'Revert',
  save: 'Save',
  saveWithCount: 'Save ({n})',
  saving: 'Saving…',
  saved: 'Saved',
  tooltipLocate: 'Select this asset in Unity',
  tooltipReload: 'Re-read from Unity',
  tooltipRevert: 'Put every edited field back to the value it had when this tab opened',
  tooltipNothingToRevert: 'Nothing to revert',
  tooltipSave: 'Save the edited asset to disk',
  tooltipNoEdits: 'No unsaved edits',
  noThumbnail: 'No thumbnail for this asset.',
  noOrbit: 'This asset has no orbit preview; showing its thumbnail.',
  orbitHint: 'Drag to orbit, scroll to zoom, WASD/QE to pan',
  rendering: 'Rendering…',
  modelLoading: 'Loading model…',
  modelError: 'Could not preview this model',
  modelUnsupported: 'This model uses a compression format the viewer does not support (for example Draco).',
  modelPause: 'Pause',
  modelPlay: 'Play',
  modelClips: 'Clip',
  modelClipUnnamed: 'Clip {n}',
  modelWireframe: 'Wireframe',
  modelClay: 'Clay',
  modelGrid: 'Grid',
  modelReset: 'Reset view',
  modelStats: 'Meshes {meshes} · Triangles {triangles} · Materials {materials}',
  modelStatsRig: 'Bones {bones}',
  modelNoTree: 'This model is rendered by the browser viewer; there is no Unity serialized tree.',
  expand: 'Expand',
  collapse: 'Collapse',
  addElement: 'Add element',
  removeElement: 'Remove last element',
  none: 'None',
  clearReference: 'Clear this reference',
  flatSummaryTitle: '{n} object(s) (summary)',
  notFileAddress: 'This tab is not a Session file address.',
  readingAsset: 'Reading the asset…',
  noSerializedData: 'No serialized data for this asset.',
  dirtyFooter: '{n} unsaved change(s) (in memory; press Save to write the file)',
  savedToDisk: 'Saved to disk',
  noUnsaved: 'No unsaved changes',
  itemCount: '{n} item(s)',
  notEditable: 'This property is not editable here.',
  expectedNumber: 'Expected a finite number.',
  severityWarning: 'warning',
  severityError: 'error',
  severityInfo: 'info',
  settingsNav: 'Unity bridge',
  settingsIntro: 'One set of switches is shared by every session on this machine; changes apply immediately, no restart needed.',
  settingsFeatures: 'Features',
  settingsUnity: 'Unity control',
  settingsUnityHint: 'The unity_* tools: editor status, C# snippets, scene and asset edits, capture, tests. Off removes them from the model’s callable list.',
  settingsCsharp: 'C# analysis',
  settingsCsharpHint: 'The code_* tools: Roslyn symbol search, go-to-definition, references, hover and diagnostics. Turning it off also closes the language-server processes it started.',
  settingsCsharpLocked: 'Forced off by DSH_LOCUS_CSHARP=0 and cannot be turned on here.',
  settingsPreview: 'File preview',
  settingsPreviewHint: 'The right-Sidebar Unity asset tab: prefabs, materials and controllers browse and edit; models orbit in the browser. Off makes every asset request refuse.',
  settingsPreferences: 'Other',
  settingsFrameCache: 'Cache preview frames inside the project',
  settingsFrameCacheHint: 'Writes rendered preview frames under the project’s Library/Locus/asset-preview-cache. Off re-renders every time, but browsing never grows the project directory.',
  settingsSaveFailed: 'Not saved',
  settingsLoading: 'Reading settings…',
  settingsUnavailable: 'Could not read settings: the Host has not mounted the preview routes (this may not be the Web client).',
  settingsPath: 'Stored at',
  projectsGroup: 'Unity projects',
  projectsIntro: 'Every Unity project found in the workspace, each checked for its Locus bridge state. "Not connected" is not a failure: a closed editor, or one that started without the native bridge, both read that way.',
  projectsEmpty: 'No Unity project found in this workspace (a project needs both Assets/ and ProjectSettings/).',
  projectsRescan: 'Rescan',
  projectsScanning: 'Scanning…',
  projectsStateConnected: 'Connected',
  projectsStateNotConnected: 'Not connected',
  projectsStateMissing: 'No plugin',
  projectHintClosed: 'The editor does not have this project open.',
  projectHintOpenNoBridge: 'The editor has this project open but the native bridge never started: check Library/Locus/NativeBridge.enabled, then restart the editor.',
  projectHintMarkerMissing: 'Library/Locus/NativeBridge.enabled is missing, so the editor will not start the native bridge on launch.',
  projectHintVersion: 'Plugin version {version}',
  projectInstall: 'Install plugin',
  projectInstalling: 'Installing…',
  projectInstalled: 'Installed. Reopen the editor as described below.',
  projectInstallBlocked: 'The editor has this project open and holds the package assemblies. Close the editor before installing.',
  projectInstallDone: 'The plugin is in place. Reopen the Unity Editor; the native bridge starts on launch.',
  projectInstallNoPayload: 'This build carries no bundled Locus package, so it cannot install.',
  settingsWorkspaceGroup: 'Workspace',
  settingsWorkspace: 'Workspace',
  settingsWorkspaceHint: 'Choose the DSH workspace this page configures',
  settingsWorkspaceNone: 'Use the current Session workspace',
  settingsWorkspaceUnavailable: 'This Host exposes no readable DSH workspace list.',
  settingsWorkspaceLoadFailed: 'Could not read the workspaces: {message}',
  settingsProject: 'Unity project',
  settingsProjectNone: 'No Unity project found',
  settingsPlugin: 'Locus plugin',
  settingsPluginInstalled: 'Installed',
  settingsPluginMissing: 'Not installed',
  settingsPluginOffline: 'Unity not open',
  settingsPluginConnectionFailed: 'Connection failed',
  settingsPluginConnected: 'Connected',
  settingsPluginInstall: 'Install',
  settingsPluginInstalling: 'Installing…',
  skillsGroup: 'Domain skills',
  skillsIntro: 'Expose the Unity domain knowledge this plugin ships as DSH skills: debugger, profiler, graphics diagnostics, UI Toolkit and Locus View. Only the domain knowledge with no DSH equivalent is kept; the skills follow the plugin version and are never written into a workspace.',
})

/** The attached DSH locale service, or null (browser-language fallback). */
let localeService = null

/** Attach (or clear, with null/undefined) the DSH locale service. */
export function attachLocale(service) {
  localeService = service ?? null
}

/** The active locale id ('zh', 'en', …) from the service, else the browser's. */
export function activeLocaleId() {
  const fromService = localeService?.getSnapshot?.()?.active
  if (typeof fromService === 'string' && fromService !== '') return fromService
  const navigatorLanguage = typeof navigator !== 'undefined' ? navigator?.language : ''
  return typeof navigatorLanguage === 'string' ? navigatorLanguage : ''
}

/** Whether the active language is Chinese. */
export function isChineseUi() {
  return activeLocaleId().toLowerCase().startsWith('zh')
}

/**
 * Translate one copy key; `{name}` placeholders interpolate from `params`.
 *
 * An unknown key falls back to English, then to the key itself, so a missing
 * entry shows something identifiable instead of `undefined`.
 */
export function t(key, params) {
  const dictionary = isChineseUi() ? zh : en
  let text = dictionary[key]
  if (typeof text !== 'string') text = en[key]
  if (typeof text !== 'string') text = String(key)
  if (params !== undefined) {
    for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

/** Subscribe to locale switches; returns an unsubscribe function (never throws). */
export function subscribeLocale(listener) {
  const service = localeService
  if (typeof service?.subscribe !== 'function') return () => {}
  try {
    const off = service.subscribe(listener)
    return typeof off === 'function' ? off : () => {}
  } catch {
    return () => {}
  }
}

/** The keys either dictionary defines (used by the tests and `severityLabel`). */
export function copyKeys() {
  return Object.keys(zh)
}

/** Editor status ('editing' | 'playing' | 'playing_paused') as localised text. */
export function editorStatusLabel(status) {
  const value = String(status ?? '').trim().toLowerCase()
  const key = `editor${value.charAt(0).toUpperCase()}${value.slice(1).replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())}`
  return key in zh ? t(key) : String(status ?? '')
}

/** A diagnostic severity as localised text (`warning` / `error` / `info`). */
export function severityLabel(severity) {
  const value = String(severity ?? 'warning').trim().toLowerCase()
  if (value === 'error') return t('severityError')
  if (value === 'info') return t('severityInfo')
  return t('severityWarning')
}


/**
 * Read `{ sessionId, path }` out of a `dsh-resource://file/session/<id>/<path>`
 * address. Mirrors the document preview's parser: the whole address is the
 * content identity, so two same-named files are two tabs.
 */
export function parseFileAddress(address) {
  const text = String(address ?? '')
  if (!text.startsWith(FILE_ADDRESS_PREFIX)) return undefined
  const end = text.search(/[?#]/)
  const body = text.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end)
  const [scope, ...rest] = body.split('/')
  if (scope !== 'session') return undefined
  const [sessionId, ...segments] = rest
  if (!sessionId || segments.length === 0) return undefined
  try {
    return { sessionId: decodeURIComponent(sessionId), path: segments.map(decodeURIComponent).join('/') }
  } catch {
    return undefined
  }
}

/** Basename of an asset path (the tab chip text). */
export function basenameOf(path) {
  return String(path ?? '').split('/').filter(Boolean).pop() ?? String(path ?? '')
}

/** Suffix without the dot, lowercased. */
export function suffixOf(path) {
  const name = basenameOf(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * Content sniffing for the browser viewer, following Locus' rule that bytes
 * beat the extension: a mislabeled FBX must not be handed to GLTFLoader.
 */
export function detectModelFormat(buffer, fallback) {
  const head = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 64))
  let ascii = ''
  for (const byte of head) ascii += String.fromCharCode(byte)
  if (ascii.startsWith('glTF')) return 'glb'
  if (ascii.startsWith('Kaydara FBX') || /^;\s*FBX\b/.test(ascii)) return 'fbx'
  return fallback
}

/**
 * The routes are served from the page's own directory, so a reverse-proxy
 * prefix or the desktop shell's custom scheme keeps working (the same reason
 * `dsh-better-sidebar` resolves its routes relatively).
 */
export function apiUrl(path, params) {
  const base = typeof document === 'undefined' ? 'http://dsh.internal/' : document.baseURI
  const url = new URL(`locus/api/${path}`.replace(/^\/+/, ''), directoryBase(base))
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }
  return url
}

function directoryBase(base) {
  const url = new URL(base)
  url.search = ''
  url.hash = ''
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname.replace(/[^/]*$/, '')}`
  return url
}

/** One JSON request; a Unity failure arrives as `{ error: { code, message } }`. */
export async function callApi(path, { method = 'GET', params, body, signal } = {}) {
  const url = apiUrl(path, params)
  const response = await fetch(url, {
    method,
    signal,
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }
  if (!response.ok || !payload?.ok) {
    const error = new Error(payload?.error?.message || `request failed (${response.status})`)
    error.code = payload?.error?.code ?? `http_${response.status}`
    error.retryable = payload?.retryable === true
    error.status = response.status
    throw error
  }
  return payload
}

/**
 * Positional key of one node: its ancestors' keys then its own.
 *
 * `nodeKey` alone is the *identity* of a target+property pair, which is what a
 * property write and the dirty mark need. Two different nodes in one tree can
 * share that identity (the aggregate root and one of its objects), so a row key
 * must also carry its position.
 */
export function rowKey(parentKey, node) {
  const own = nodeKey(node)
  return parentKey === null || parentKey === undefined ? own : `${parentKey}>${own}`
}

/** Flatten a tree into the rows an indented list renders (visible set only). */
export function flattenTree(root, expanded, childCache, depthLimit = 64) {
  const rows = []
  const walk = (node, depth, parentKey) => {
    if (!node || typeof node !== 'object') return
    const key = rowKey(parentKey, node)
    rows.push({ node, key, depth, parentKey })
    if (depth >= depthLimit) return
    const open = expanded.has(key)
    if (!open) return
    const children = nodeChildren(node, childCache, key)
    if (!Array.isArray(children)) return
    for (const child of children) walk(child, depth + 1, key)
  }
  walk(root, 0, null)
  return rows
}

/**
 * Identity of one node's *target*: what a property write addresses.
 *
 * Deliberately ignores `propertyPath`, so every field of one component shares
 * it — that is the object an array fetch or a whole-object patch names.
 */
export function targetKey(node) {
  const binding = node?.bindingTarget ?? {}
  return binding.globalObjectId || `${binding.path ?? ''}#${binding.targetFileId ?? ''}#${binding.componentType ?? ''}`
}

/** Stable identity for one node: its target plus its property path. */
export function nodeKey(node) {
  return `${targetKey(node)}|${node?.propertyPath ?? ''}`
}

/**
 * Children of a node, preferring a lazily fetched subtree.
 *
 * `key` is the node's row key when the caller already computed it (the tree
 * walker has); the cache is keyed positionally for the same reason rows are.
 */
export function nodeChildren(node, childCache, key) {
  const cached = childCache?.get(key ?? nodeKey(node))
  if (Array.isArray(cached)) return cached
  return Array.isArray(node?.children) ? node.children : []
}

/** True when a tree actually has something to show (not just a title row). */
export function hasTreeRows(tree) {
  if (!tree) return false
  if (Array.isArray(tree.children) && tree.children.length > 0) return true
  return hasChildren(tree)
}

/** Whether a row can be expanded at all. */
export function hasChildren(node) {
  return node?.hasChildren === true || (Array.isArray(node?.children) && node.children.length > 0)
}

/** True when the node is a leaf whose value the panel may edit. */
export function isLeaf(node) {
  return !hasChildren(node)
}

/** A short label for a node's current value, used in collapsed rows. */
export function valueSummary(node) {
  if (!node) return ''
  if (Array.isArray(node.value)) return t('itemCount', { n: node.value.length })
  const display = node.displayValue
  if (typeof display === 'string' && display !== '') return display
  if (node.value === null || node.value === undefined) return ''
  if (typeof node.value === 'object') return JSON.stringify(node.value)
  return String(node.value)
}

/** The editable descriptor for one leaf, or null when it is not directly editable. */
export function editorFor(node) {
  if (!node || !isLeaf(node) || node.editable === false) return null
  const type = String(node.valueType ?? node.type ?? '')
  if (type === 'Boolean') return { kind: 'boolean' }
  if (type === 'Integer' || type === 'ArraySize' || type === 'LayerMask') return { kind: 'integer', step: 1 }
  if (type === 'Float' || type === 'Double' || type === 'Long' || type === 'UnsignedLong') return { kind: 'number', step: 0.01 }
  if (type === 'String') return { kind: 'string' }
  if (type === 'Character') return { kind: 'string', single: true }
  if (type === 'Enum') {
    const options = Array.isArray(node.enumOptions) ? node.enumOptions : []
    return { kind: 'enum', options, flags: node.isFlagsEnum === true, flagValue: Number(node.enumValueFlag ?? 0) }
  }
  if (type === 'Color') return { kind: 'color' }
  if (type === 'Vector2' || type === 'Vector2Int') return { kind: 'vector', keys: ['x', 'y'] }
  if (type === 'Vector3' || type === 'Vector3Int') return { kind: 'vector', keys: ['x', 'y', 'z'] }
  if (type === 'Vector4') return { kind: 'vector', keys: ['x', 'y', 'z', 'w'] }
  if (type === 'Quaternion') return { kind: 'vector', keys: ['x', 'y', 'z', 'w'] }
  if (type === 'Rect' || type === 'RectInt') return { kind: 'vector', keys: ['x', 'y', 'width', 'height'] }
  if (type === 'ObjectReference' || type === 'ExposedReference') {
    const present = typeof node.value === 'string' ? node.value !== '' && node.value !== 'null' : node.value !== null && node.value !== undefined
    return { kind: 'reference', present }
  }
  return null
}

/**
 * Build the `valueJson` payload one property write expects.
 *
 * The vocabulary is `SetSerializedPropertyValue`'s: scalars as raw JSON, vectors
 * and colors as objects, enums by index or flag mask, references by
 * `{globalObjectId}` or null, and array structure by `{action, index}`.
 */
export function encodeWrite(node, value) {
  const editor = editorFor(node)
  if (!editor) throw new Error(t('notEditable'))
  switch (editor.kind) {
    case 'boolean':
      return Boolean(value)
    case 'integer':
    case 'number': {
      const number = Number(value)
      if (!Number.isFinite(number)) throw new Error(t('expectedNumber'))
      return editor.kind === 'integer' ? Math.round(number) : number
    }
    case 'string':
      return String(value ?? '')
    case 'enum':
      return editor.flags ? { action: 'setflags', flagValue: Number(value) || 0 } : { index: Number(value) || 0 }
    case 'color':
      return {
        r: clamp01(value?.r),
        g: clamp01(value?.g),
        b: clamp01(value?.b),
        a: clamp01(value?.a ?? 1),
      }
    case 'vector': {
      const next = {}
      for (const key of editor.keys) next[key] = Number(value?.[key] ?? 0)
      return next
    }
    case 'reference':
      return value === undefined || value === null ? null : value
    default:
      throw new Error(t('notEditable'))
  }
}

/** The array structural command the write path understands. */
export function arrayCommand(action, { index, toIndex, size } = {}) {
  const command = { action }
  if (Number.isInteger(index)) command.index = index
  if (Number.isInteger(toIndex)) command.toIndex = toIndex
  if (Number.isInteger(size)) command.size = size
  return command
}

function clamp01(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(1, Math.max(0, number))
}

/** Unity colors are linear in the serialized object; show sRGB hex for the swatch. */
export function colorToHex(color) {
  const toByte = (value) => {
    const c = clamp01(value)
    const srgb = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
    return Math.round(Math.min(1, Math.max(0, srgb)) * 255)
  }
  const hex = [color?.r, color?.g, color?.b].map((channel) => toByte(channel).toString(16).padStart(2, '0')).join('')
  return `#${hex}`
}

/** Inverse of {@link colorToHex}, for the native color input. */
export function hexToColor(hex) {
  const match = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim())
  if (!match) return null
  const value = match[1]
  const toLinear = (byte) => {
    const c = parseInt(byte, 16) / 255
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return {
    r: toLinear(value.slice(0, 2)),
    g: toLinear(value.slice(2, 4)),
    b: toLinear(value.slice(4, 6)),
  }
}

/**
 * Create the plugin definition. `require` is the module table the DSH client
 * bundle receives; only `react` is requested.
 */
export function createLocusAssetPlugin(require) {
  const React = require('react')
  const h = React.createElement
  const { useCallback, useEffect, useMemo, useRef, useState } = React

  // ── styles ────────────────────────────────────────────────────────────────
  injectStyles()

  // ── small building blocks ─────────────────────────────────────────────────
  function Spinner({ label }) {
    return h('div', { className: 'locus-asset-loading' }, h('span', { className: 'locus-asset-dot' }), h('span', null, label ?? t('loading')))
  }

  function ErrorBox({ error, onRetry }) {
    const retryable = error?.retryable === true
    return h(
      'div',
      { className: 'locus-asset-error', 'data-locus-asset-error': error?.code ?? 'error' },
      h('div', { className: 'locus-asset-error-title' }, retryable ? t('errorBusyTitle') : t('errorReadTitle')),
      h('div', { className: 'locus-asset-error-line' }, String(error?.message ?? error)),
      onRetry ? h('button', { type: 'button', className: 'locus-asset-btn', onClick: onRetry }, t('retry')) : null,
    )
  }

  function Toolbar({ status, path, dirty, saving, onSave, onRevert, onReload, onSelect, preview, onTogglePreview, error }) {
    const connected = status?.connected === true
    const editorStatus = connected ? String(status.status ?? '').split('|')[0] : 'disconnected'
    return h(
      'div',
      { className: 'locus-asset-toolbar' },
      h(
        'div',
        { className: 'locus-asset-toolbar-main' },
        h('span', { className: 'locus-asset-path', title: path }, basenameOf(path)),
        h('span', { className: `locus-asset-chip locus-asset-chip-${connected ? editorStatus : 'off'}` }, connected ? editorStatusLabel(editorStatus) : t('chipOffline')),
        status?.reload && status.reload.is_compiling ? h('span', { className: 'locus-asset-chip locus-asset-chip-busy' }, t('chipCompiling')) : null,
        error ? h('span', { className: 'locus-asset-chip locus-asset-chip-error', title: String(error.message ?? error) }, t('chipError')) : null,
      ),
      h(
        'div',
        { className: 'locus-asset-toolbar-actions' },
        h('button', { type: 'button', className: 'locus-asset-btn', onClick: onTogglePreview }, preview ? t('previewHide') : t('previewShow')),
        h('button', { type: 'button', className: 'locus-asset-btn', onClick: onSelect, title: t('tooltipLocate') }, t('locate')),
        h('button', { type: 'button', className: 'locus-asset-btn', onClick: onReload, title: t('tooltipReload') }, t('reload')),
        h(
          'button',
          {
            type: 'button',
            className: 'locus-asset-btn',
            onClick: onRevert,
            disabled: saving || dirty === 0,
            title: dirty ? t('tooltipRevert') : t('tooltipNothingToRevert'),
          },
          t('revert'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: `locus-asset-btn locus-asset-btn-primary${dirty ? '' : ' locus-asset-btn-idle'}`,
            onClick: onSave,
            disabled: saving || dirty === 0,
            title: dirty ? t('tooltipSave') : t('tooltipNoEdits'),
          },
          saving ? t('saving') : dirty ? t('saveWithCount', { n: dirty }) : t('saved'),
        ),
      ),
    )
  }

  /** Which model suffixes three.js can parse from one self-contained buffer. */
  const WEB_MODEL_EXTENSIONS = Object.freeze(['fbx', 'glb'])

  const DEFAULT_ORBIT = Object.freeze({ yaw: 25, pitch: -12, distance: 1.15, panX: 0, panY: 0, panZ: 0 })
  /** WASD/QE pan, matching the desktop preview's key map. */
  const PAN_KEYS = Object.freeze({
    w: ['panZ', 1],
    s: ['panZ', -1],
    a: ['panX', -1],
    d: ['panX', 1],
    q: ['panY', -1],
    e: ['panY', 1],
  })

  /**
   * Load the lazy viewer bundle once per page.
   *
   * The URL goes through `apiUrl` so the request follows the Host's base path
   * (the same rule every other Sidebar request uses). `lib/model-viewer.js` is
   * built separately; the main client bundle never imports three.js.
   */
  let modelViewerPromise = null
  function loadModelViewer() {
    if (!modelViewerPromise) {
      modelViewerPromise = import(apiUrl('model-viewer.js').toString()).catch((error) => {
        modelViewerPromise = null
        throw error
      })
    }
    return modelViewerPromise
  }

  /**
   * Choose the preview implementation exactly like Locus does:
   *
   *   * `.prefab` (and model formats Unity imported but three.js cannot parse)
   *     is rendered by the editor's own `PreviewRenderUtility`;
   *   * `.fbx` / `.glb` bytes are parsed and drawn in the browser by three.js.
   */
  function PreviewPane({ sessionId, path, version, suffix, onError }) {
    if (WEB_MODEL_EXTENSIONS.includes(suffix)) {
      return h(ModelPreview, { sessionId, path, version, suffix, onError })
    }
    return h(UnityPreview, { sessionId, path, version, suffix, onError })
  }

  /**
   * Unity-rendered preview: a thumbnail for every asset, plus an orbit frame
   * for prefabs and for model formats that only Unity can read.
   *
   * Frames are requested while the pointer moves (90 ms floor) and coalesced so
   * at most one editor render is in flight; a drag therefore feels continuous
   * without queueing `PreviewRenderUtility` passes behind each other.
   */
  function UnityPreview({ sessionId, path, version, suffix, onError }) {
    const [orbit, setOrbitState] = useState(() => ({ ...DEFAULT_ORBIT }))
    const orbitRef = useRef(orbit)
    orbitRef.current = orbit
    const [dragging, setDragging] = useState(false)
    const [frameSrc, setFrameSrc] = useState(null)
    const [thumbSrc, setThumbSrc] = useState(null)
    // A *key*, not a sentence: the note must re-translate when the locale
    // switches, so the state holds which message to show and `t()` resolves its
    // text during render.
    const [failedKey, setFailedKey] = useState(null)
    const dragRef = useRef(null)
    const boxRef = useRef(null)
    const scheduleRef = useRef(null)
    const interactedRef = useRef(false)
    const isOrbit = suffix === 'prefab' || (MODEL_EXTENSIONS.includes(suffix) && !WEB_MODEL_EXTENSIONS.includes(suffix))

    const setOrbit = useCallback((next) => {
      orbitRef.current = next
      setOrbitState(next)
    }, [])

    // Thumbnails come from AssetPreview: cheap, and available for any asset the
    // editor can draw (materials, sprites, ScriptableObjects with an icon).
    useEffect(() => {
      let cancelled = false
      const url = apiUrl('thumb', { sessionId, path, size: 256, v: version })
      setThumbSrc(url.toString())
      const image = new Image()
      image.onerror = () => {
        if (cancelled) return
        // A prefab or model often has no AssetPreview (nothing imported an icon
        // for it), and the orbit render is the real picture there — so silence
        // the thumbnail failure instead of reporting a broken asset.
        setThumbSrc(null)
        setFailedKey(isOrbit ? null : 'noThumbnail')
        onError?.(null)
      }
      image.onload = () => {
        if (cancelled) return
        setFailedKey(null)
      }
      image.src = url.toString()
      return () => {
        cancelled = true
        image.onerror = null
        image.onload = null
      }
    }, [sessionId, path, version, isOrbit])

    // One frame pipeline per asset. It owns the timer, the in-flight request
    // and the object URL, so a tab switch aborts everything instead of leaking
    // an editor render into a disposed component.
    useEffect(() => {
      if (!isOrbit) {
        // A suffix change can leave an object URL from the orbit pipeline in
        // state; drop it so a material/asset falls back to its thumbnail.
        setFrameSrc(null)
        return undefined
      }
      let disposed = false
      let timer = null
      let inFlight = false
      let queued = false
      let lastAt = 0
      let restoreController = null
      let frameController = null
      let objectUrl = null

      const commitOrbit = (next) => {
        if (disposed) return
        orbitRef.current = next
        setOrbitState(next)
      }

      // Decode before swapping: a drag can produce frames faster than the
      // compositor draws them, and revoking the previous URL mid-decode shows a
      // broken image for a frame. Locus waits for `decode()` for the same reason.
      const install = async (blob) => {
        const next = URL.createObjectURL(blob)
        const image = new Image()
        image.src = next
        try {
          if (typeof image.decode === 'function') await image.decode()
        } catch {
          URL.revokeObjectURL(next)
          throw new Error('preview frame could not be decoded')
        }
        if (disposed) {
          URL.revokeObjectURL(next)
          return
        }
        const previous = objectUrl
        objectUrl = next
        setFrameSrc(next)
        setFailedKey(null)
        // React commits the new `src` after this task; revoking the old URL in
        // the same tick can blank the <img> for one paint.
        if (previous) setTimeout(() => URL.revokeObjectURL(previous), 1000)
      }

      const readCamera = (response) => {
        const read = (name, fallback) => {
          const raw = response.headers.get(name)
          const value = raw === null ? Number.NaN : Number(raw)
          return Number.isFinite(value) ? value : fallback
        }
        return {
          yaw: read('x-locus-frame-yaw', DEFAULT_ORBIT.yaw),
          pitch: read('x-locus-frame-pitch', DEFAULT_ORBIT.pitch),
          distance: read('x-locus-frame-distance', DEFAULT_ORBIT.distance),
          panX: read('x-locus-frame-pan-x', DEFAULT_ORBIT.panX),
          panY: read('x-locus-frame-pan-y', DEFAULT_ORBIT.panY),
          panZ: read('x-locus-frame-pan-z', DEFAULT_ORBIT.panZ),
        }
      }

      const request = (immediate, persist = immediate) => {
        if (disposed) return
        if (inFlight) {
          queued = true
          return
        }
        if (timer) clearTimeout(timer)
        const wait = immediate ? 0 : Math.max(0, 90 - (Date.now() - lastAt))
        timer = setTimeout(async () => {
          timer = null
          if (disposed) return
          if (inFlight) {
            queued = true
            return
          }
          inFlight = true
          // A drag that starts before the restore lands owns the view now.
          restoreController?.abort()
          frameController = new AbortController()
          const camera = orbitRef.current
          const url = apiUrl('frame', {
            sessionId,
            path,
            v: version,
            w: 480,
            h: 360,
            yaw: camera.yaw.toFixed(2),
            pitch: camera.pitch.toFixed(2),
            distance: camera.distance.toFixed(3),
            panX: camera.panX.toFixed(3),
            panY: camera.panY.toFixed(3),
            panZ: camera.panZ.toFixed(3),
            // Only the settle/default frame is worth a disk write; Locus waits
            // 450 ms after the last frame for the same reason.
            cache: persist ? 1 : 0,
          })
          try {
            const response = await fetch(url, { signal: frameController.signal })
            if (!response.ok) throw new Error(`frame request failed (${response.status})`)
            const blob = await response.blob()
            if (!disposed) await install(blob)
          } catch (error) {
            if (disposed || error?.name === 'AbortError') return
            // A model without a renderable prefab still has a thumbnail; do not
            // replace a working picture with an error.
            setFailedKey('noOrbit')
          } finally {
            if (disposed) return
            inFlight = false
            lastAt = Date.now()
            if (queued) {
              queued = false
              request(true)
            }
          }
        }, wait)
      }

      const restore = async () => {
        try {
          const response = await fetch(apiUrl('frame', { sessionId, path, v: version, restore: 1 }), {
            signal: (restoreController = new AbortController()).signal,
          })
          if (disposed) return
          if (!response.ok) {
            request(true)
            return
          }
          // A user gesture that landed while the cache was in flight wins; the
          // drag's own request will render the new camera.
          if (interactedRef.current) return
          commitOrbit(readCamera(response))
          const blob = await response.blob()
          if (!disposed && !interactedRef.current) await install(blob)
        } catch (error) {
          if (disposed || error?.name === 'AbortError') return
          request(true)
        }
      }

      scheduleRef.current = request
      interactedRef.current = false
      dragRef.current = null
      setDragging(false)
      commitOrbit({ ...DEFAULT_ORBIT })
      setFrameSrc(null)
      setFailedKey(null)
      restore()

      return () => {
        disposed = true
        scheduleRef.current = null
        if (timer) clearTimeout(timer)
        restoreController?.abort()
        frameController?.abort()
        if (objectUrl) URL.revokeObjectURL(objectUrl)
      }
    }, [sessionId, path, version, isOrbit])

    const onPointerDown = useCallback(
      (event) => {
        if (!isOrbit || event.button !== 0) return
        interactedRef.current = true
        dragRef.current = { x: event.clientX, y: event.clientY, orbit: { ...orbitRef.current } }
        setDragging(true)
        event.currentTarget.setPointerCapture?.(event.pointerId)
      },
      [isOrbit],
    )

    const onPointerMove = useCallback((event) => {
      const drag = dragRef.current
      if (!drag) return
      const dx = event.clientX - drag.x
      const dy = event.clientY - drag.y
      setOrbit({
        ...drag.orbit,
        yaw: drag.orbit.yaw + dx * 0.6,
        pitch: Math.max(-80, Math.min(80, drag.orbit.pitch + dy * 0.5)),
      })
      scheduleRef.current?.(false)
    }, [setOrbit])

    const onPointerUp = useCallback(() => {
      dragRef.current = null
      setDragging(false)
      scheduleRef.current?.(true)
    }, [])

    const onWheel = useCallback(
      (event) => {
        if (!isOrbit) return
        event.preventDefault()
        interactedRef.current = true
        const current = orbitRef.current
        setOrbit({ ...current, distance: Math.max(0.7, Math.min(3.5, current.distance - event.deltaY * 0.0015)) })
        scheduleRef.current?.(false, true)
      },
      [isOrbit, setOrbit],
    )

    // Locus lets the same drag that orbits also pan with WASD/QE. The keys are
    // only live while the pointer is down, so they never steal typing from the
    // property fields above.
    useEffect(() => {
      if (!dragging || !isOrbit) return undefined
      const pressed = new Set()
      const onKeyDown = (event) => {
        const key = String(event.key ?? '').toLowerCase()
        if (!PAN_KEYS[key]) return
        pressed.add(key)
        event.preventDefault()
      }
      const onKeyUp = (event) => pressed.delete(String(event.key ?? '').toLowerCase())
      const onBlur = () => pressed.clear()
      let frame = 0
      const tick = () => {
        let changed = false
        const next = { ...orbitRef.current }
        for (const key of pressed) {
          const [axis, sign] = PAN_KEYS[key]
          next[axis] = Math.max(-8, Math.min(8, next[axis] + sign * 0.01))
          changed = true
        }
        if (changed) {
          orbitRef.current = next
          setOrbitState(next)
          scheduleRef.current?.(false)
        }
        frame = requestAnimationFrame(tick)
      }
      window.addEventListener('keydown', onKeyDown)
      window.addEventListener('keyup', onKeyUp)
      window.addEventListener('blur', onBlur)
      frame = requestAnimationFrame(tick)
      return () => {
        cancelAnimationFrame(frame)
        window.removeEventListener('keydown', onKeyDown)
        window.removeEventListener('keyup', onKeyUp)
        window.removeEventListener('blur', onBlur)
      }
    }, [dragging, isOrbit])

    const source = frameSrc ?? thumbSrc
    return h(
      'div',
      { className: 'locus-asset-preview', ref: boxRef },
      h(
        'div',
        {
          className: `locus-asset-preview-surface${isOrbit ? ' is-orbit' : ''}${dragging ? ' is-dragging' : ''}`,
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
          onWheel,
          title: isOrbit ? t('orbitHint') : undefined,
        },
        source ? h('img', { src: source, alt: '', draggable: false }) : h(Spinner, { label: t('rendering') }),
      ),
      failedKey ? h('div', { className: 'locus-asset-preview-note' }, t(failedKey)) : null,
    )
  }

  /**
   * Browser-rendered model: Locus' `ModelViewer` path.
   *
   * The bytes come from `/locus/api/model` as an ArrayBuffer; the lazily loaded
   * viewer bundle parses GLB/FBX with three.js, so Unity does not need an
   * importer for the file and the orbit runs at WebGL frame rate.
   */
  function ModelPreview({ sessionId, path, version, suffix, onError }) {
    const hostRef = useRef(null)
    const engineRef = useRef(null)
    const [status, setStatus] = useState({ loading: true, error: null, stats: null, clips: [] })
    const [clipIndex, setClipIndex] = useState(0)
    const [playing, setPlaying] = useState(true)
    const [wireframe, setWireframe] = useState(false)
    const [clay, setClay] = useState(false)
    const [grid, setGrid] = useState(true)

    // The load effect starts before the user can touch the toolbar, but keeping
    // the current toggles in a ref lets the newly mounted engine inherit them.
    const uiRef = useRef({ playing, wireframe, clay, grid })
    uiRef.current = { playing, wireframe, clay, grid }

    useEffect(() => {
      const host = hostRef.current
      if (!host) return undefined
      const fallbackFormat = suffix === 'glb' ? 'glb' : 'fbx'
      let disposed = false
      const controller = new AbortController()
      setStatus({ loading: true, error: null, stats: null, clips: [] })
      setClipIndex(0)

      const run = async () => {
        try {
          const response = await fetch(apiUrl('model', { sessionId, path, v: version }), { signal: controller.signal })
          if (!response.ok) {
            let message = `HTTP ${response.status}`
            try {
              const payload = await response.json()
              message = payload?.error?.message ?? message
            } catch {
              // The body was not JSON; the status is still useful.
            }
            throw new Error(message)
          }
          const buffer = await response.arrayBuffer()
          if (disposed) return
          const viewer = await loadModelViewer()
          if (disposed) return
          const engine = viewer.mount(host, { compact: false })
          engineRef.current = engine
          engine.setActive(!document.hidden)
          const ui = uiRef.current
          engine.setWireframe(ui.wireframe)
          engine.setMaterialMode(ui.clay ? 'clay' : 'original')
          engine.setGridVisible(ui.grid)
          engine.setPlaying(ui.playing)
          const loaded = await engine.load(buffer, detectModelFormat(buffer, fallbackFormat))
          if (disposed || !loaded) return
          setStatus({ loading: false, error: null, stats: loaded.stats ?? null, clips: loaded.clips ?? [] })
        } catch (error) {
          if (disposed || error?.name === 'AbortError') return
          setStatus({ loading: false, error, stats: null, clips: [] })
          onError?.(error)
        }
      }

      void run()
      return () => {
        disposed = true
        controller.abort()
        engineRef.current?.dispose()
        engineRef.current = null
      }
    }, [sessionId, path, version, suffix])

    useEffect(() => {
      engineRef.current?.setPlaying(playing)
    }, [playing])
    useEffect(() => {
      engineRef.current?.setWireframe(wireframe)
    }, [wireframe])
    useEffect(() => {
      engineRef.current?.setMaterialMode(clay ? 'clay' : 'original')
    }, [clay])
    useEffect(() => {
      engineRef.current?.setGridVisible(grid)
    }, [grid])
    useEffect(() => {
      const onVisibility = () => engineRef.current?.setActive(!document.hidden)
      document.addEventListener('visibilitychange', onVisibility)
      return () => document.removeEventListener('visibilitychange', onVisibility)
    }, [])

    const selectClip = (index) => {
      setClipIndex(index)
      engineRef.current?.selectClip(index)
    }

    const error = status.error
    const unsupported = error?.code === 'unsupportedCompression'
    const stats = status.stats

    return h(
      'div',
      { className: 'locus-model-preview' },
      h(
        'div',
        { className: 'locus-model-stage' },
        // A dedicated, childless host: three.js appends its canvas here, so a
        // React re-render of the loading/error overlays never removes it.
        h('div', { className: 'locus-model-canvas', ref: hostRef }),
        status.loading ? h('div', { className: 'locus-model-overlay' }, h(Spinner, { label: t('modelLoading') })) : null,
        error
          ? h(
              'div',
              { className: 'locus-model-overlay locus-model-overlay-error' },
              h('div', { className: 'locus-model-error-title' }, t('modelError')),
              h('div', { className: 'locus-model-error-line' }, unsupported ? t('modelUnsupported') : String(error.message ?? error)),
            )
          : null,
      ),
      h(
        'div',
        { className: 'locus-model-toolbar' },
        h(
          'button',
          {
            type: 'button',
            className: 'locus-asset-btn',
            onClick: () => setPlaying((value) => !value),
            title: playing ? t('modelPause') : t('modelPlay'),
            disabled: status.loading || !!error,
          },
          playing ? t('modelPause') : t('modelPlay'),
        ),
        status.clips.length > 1
          ? h(
              'select',
              {
                className: 'locus-model-clip',
                value: String(clipIndex),
                disabled: status.loading || !!error,
                onChange: (event) => selectClip(Number(event.target.value)),
                title: t('modelClips'),
              },
              status.clips.map((clip, index) =>
                h('option', { key: `${clip.name ?? 'clip'}-${index}`, value: String(index) }, clip.name || t('modelClipUnnamed', { n: index + 1 })),
              ),
            )
          : null,
        h(
          'button',
          {
            type: 'button',
            className: `locus-asset-btn${wireframe ? ' is-active' : ''}`,
            onClick: () => setWireframe((value) => !value),
            disabled: status.loading || !!error,
          },
          t('modelWireframe'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: `locus-asset-btn${clay ? ' is-active' : ''}`,
            onClick: () => setClay((value) => !value),
            disabled: status.loading || !!error,
          },
          t('modelClay'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: `locus-asset-btn${grid ? ' is-active' : ''}`,
            onClick: () => setGrid((value) => !value),
            disabled: status.loading || !!error,
          },
          t('modelGrid'),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'locus-asset-btn',
            onClick: () => engineRef.current?.resetView(),
            disabled: status.loading || !!error,
          },
          t('modelReset'),
        ),
      ),
      stats
        ? h(
            'div',
            { className: 'locus-model-stats' },
            stats.meshes
              ? t('modelStats', {
                  meshes: stats.meshes,
                  triangles: Number(stats.triangles || 0).toLocaleString(),
                  materials: stats.materials,
                })
              : t('modelStatsRig', { bones: stats.bones }),
          )
        : null,
    )
  }


  function Row({ row, expanded, onToggle, onWrite, dirtyMap, disabled }) {
    const { node, key, depth } = row
    const open = expanded.has(key)
    const children = hasChildren(node)
    const editor = editorFor(node)
    const edited = dirtyMap.has(key)
    return h(
      'div',
      { className: `locus-asset-row${edited ? ' is-edited' : ''}`, style: { paddingLeft: `${depth * 14 + 4}px` } },
      h(
        'div',
        { className: 'locus-asset-row-head' },
        h(
          'button',
          {
            type: 'button',
            className: `locus-asset-fold${children ? '' : ' is-empty'}`,
            onClick: children ? () => onToggle(node, key) : undefined,
            tabIndex: children ? 0 : -1,
            'aria-label': children ? (open ? t('collapse') : t('expand')) : undefined,
          },
          children ? (open ? '▾' : '▸') : '',
        ),
        h('span', { className: 'locus-asset-label', title: node.tooltip || node.displayName }, node.displayName || node.name || ''),
        node.type && node.type !== node.displayName ? h('span', { className: 'locus-asset-type' }, node.type) : null,
      ),
      h(
        'div',
        { className: 'locus-asset-row-value' },
        editor
          ? h(ValueEditor, { node, editor, dirty: edited, disabled, onWrite })
          : h('span', { className: `locus-asset-static${children ? ' is-summary' : ''}`, title: valueSummary(node) }, children ? valueSummary(node) : (node.displayValue || valueSummary(node) || '—')),
        children && node.isArray ? h(ArrayControls, { node, disabled, onWrite }) : null,
      ),
    )
  }

  function ArrayControls({ node, disabled, onWrite }) {
    const size = Number(node.arraySize ?? 0)
    return h(
      'span',
      { className: 'locus-asset-array' },
      h('span', { className: 'locus-asset-count' }, `${size}`),
      h('button', { type: 'button', className: 'locus-asset-mini', disabled, title: t('addElement'), onClick: () => onWrite(node, arrayCommand('insert', { index: size })) }, '+'),
      h('button', { type: 'button', className: 'locus-asset-mini', disabled: disabled || size === 0, title: t('removeElement'), onClick: () => onWrite(node, arrayCommand('delete', { index: size - 1 })) }, '−'),
    )
  }

  function ValueEditor({ node, editor, dirty, disabled, onWrite }) {
    const commit = (value) => {
      try {
        onWrite(node, encodeWrite(node, value))
      } catch (error) {
        onWrite(node, undefined, error)
      }
    }

    if (editor.kind === 'boolean') {
      return h('input', {
        type: 'checkbox',
        className: 'locus-asset-check',
        checked: node.value === true || node.value === 1,
        disabled,
        onChange: (event) => commit(event.target.checked),
      })
    }

    if (editor.kind === 'enum') {
      if (editor.flags) {
        return h(FlagsEditor, { node, editor, disabled, onCommit: commit })
      }
      const options = editor.options
      const current = Number(node.value?.index ?? 0)
      return h(
        'select',
        {
          className: 'locus-asset-select',
          value: String(current),
          disabled,
          onChange: (event) => commit(Number(event.target.value)),
        },
        options.map((option, index) =>
          h('option', { key: `${option.value ?? index}`, value: String(index) }, option.label ?? option.name ?? String(index)),
        ),
      )
    }

    if (editor.kind === 'color') {
      const color = node.value && typeof node.value === 'object' ? node.value : { r: 0, g: 0, b: 0, a: 1 }
      const keys = ['r', 'g', 'b', 'a']
      return h(
        'span',
        { className: 'locus-asset-color' },
        h('input', {
          type: 'color',
          className: 'locus-asset-swatch',
          value: colorToHex(color),
          disabled,
          onChange: (event) => {
            const converted = hexToColor(event.target.value)
            if (converted) commit({ ...converted, a: Number(color.a ?? 1) })
          },
        }),
        keys.map((key) =>
          h(NumberCell, {
            key,
            label: key.toUpperCase(),
            value: Number(color[key] ?? 0),
            step: 0.01,
            disabled,
            onCommit: (next) => commit({ ...color, [key]: next }),
          }),
        ),
      )
    }

    if (editor.kind === 'vector') {
      const value = node.value && typeof node.value === 'object' ? node.value : {}
      return h(
        'span',
        { className: 'locus-asset-vector' },
        editor.keys.map((key) =>
          h(NumberCell, {
            key,
            label: key === 'width' ? 'W' : key === 'height' ? 'H' : key.toUpperCase(),
            value: Number(value[key] ?? 0),
            step: String(node.type ?? '').endsWith('Int') ? 1 : 0.01,
            disabled,
            onCommit: (next) => commit({ ...value, [key]: next }),
          }),
        ),
      )
    }

    if (editor.kind === 'reference') {
      const text = typeof node.value === 'string' ? node.value : ''
      return h(
        'span',
        { className: 'locus-asset-reference' },
        h('span', { className: 'locus-asset-ref-text', title: text }, text || t('none')),
        editor.present
          ? h(
              'button',
              {
                type: 'button',
                className: 'locus-asset-mini',
                disabled,
                title: t('clearReference'),
                onClick: () => commit(null),
              },
              '×',
            )
          : null,
      )
    }

    if (editor.kind === 'string') {
      return h(TextCell, { value: String(node.value ?? ''), disabled, single: editor.single === true, onCommit: commit })
    }

    return h(NumberCell, {
      value: Number(node.value ?? 0),
      step: editor.step ?? 0.01,
      integer: editor.kind === 'integer',
      disabled,
      onCommit: commit,
    })
  }

  function FlagsEditor({ node, editor, disabled, onCommit }) {
    const options = editor.options
    const current = Number(editor.flagValue ?? 0)
    return h(
      'span',
      { className: 'locus-asset-flags' },
      options.map((option, index) => {
        const mask = Number(option.numericValue ?? option.index ?? 1 << index)
        const checked = (current & mask) === mask && mask !== 0
        return h(
          'label',
          { key: `${option.value ?? index}`, className: 'locus-asset-flag' },
          h('input', {
            type: 'checkbox',
            checked,
            disabled,
            onChange: () => onCommit(checked ? current & ~mask : current | mask),
          }),
          h('span', null, option.label ?? option.name ?? String(mask)),
        )
      }),
    )
  }

  /** A number cell that commits on blur/Enter, so typing never spams Unity. */
  function NumberCell({ label, value, step, integer, disabled, onCommit }) {
    const [text, setText] = useState(String(value))
    const [focused, setFocused] = useState(false)
    useEffect(() => {
      if (!focused) setText(String(value))
    }, [value, focused])
    const commit = () => {
      const parsed = Number(text)
      if (!Number.isFinite(parsed)) {
        setText(String(value))
        return
      }
      const next = integer ? Math.round(parsed) : parsed
      if (next !== value) onCommit(next)
    }
    return h(
      'span',
      { className: 'locus-asset-number' },
      label ? h('span', { className: 'locus-asset-number-label' }, label) : null,
      h('input', {
        type: 'number',
        className: 'locus-asset-input',
        value: text,
        step,
        disabled,
        onFocus: () => setFocused(true),
        onChange: (event) => setText(event.target.value),
        onBlur: () => {
          setFocused(false)
          commit()
        },
        onKeyDown: (event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur()
          } else if (event.key === 'Escape') {
            setText(String(value))
            event.currentTarget.blur()
          }
        },
      }),
    )
  }

  function TextCell({ value, disabled, single, onCommit }) {
    const [text, setText] = useState(String(value ?? ''))
    const [focused, setFocused] = useState(false)
    useEffect(() => {
      if (!focused) setText(String(value ?? ''))
    }, [value, focused])
    return h('input', {
      type: 'text',
      className: 'locus-asset-input locus-asset-text',
      value: text,
      disabled,
      maxLength: single ? 1 : undefined,
      onFocus: () => setFocused(true),
      onChange: (event) => setText(event.target.value),
      onBlur: () => {
        setFocused(false)
        if (text !== String(value ?? '')) onCommit(text)
      },
      onKeyDown: (event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        else if (event.key === 'Escape') {
          setText(String(value ?? ''))
          event.currentTarget.blur()
        }
      },
    })
  }

  /** Read-only object/field summary for an asset whose tree is empty. */
  function FlatSummary({ flat }) {
    const [openObjects, setOpenObjects] = useState(() => new Set())
    const objects = Array.isArray(flat?.objects) ? flat.objects : []
    return h(
      'div',
      { className: 'locus-asset-flat' },
      h('div', { className: 'locus-asset-flat-title' }, t('flatSummaryTitle', { n: objects.length })),
      objects.map((object) => {
        const open = openObjects.has(object.objectId)
        return h(
          'div',
          { key: object.objectId, className: 'locus-asset-flat-object' },
          h(
            'button',
            {
              type: 'button',
              className: 'locus-asset-flat-head',
              onClick: () =>
                setOpenObjects((current) => {
                  const next = new Set(current)
                  if (next.has(object.objectId)) next.delete(object.objectId)
                  else next.add(object.objectId)
                  return next
                }),
            },
            h('span', { className: 'locus-asset-fold' }, open ? '▾' : '▸'),
            h('span', { className: 'locus-asset-label' }, object.rootType || object.classId || object.objectId),
            h('span', { className: 'locus-asset-count' }, String(object.fields?.length ?? 0)),
          ),
          open
            ? h(
                'div',
                { className: 'locus-asset-flat-fields' },
                (object.fields ?? []).map((field) =>
                  h(
                    'div',
                    { key: field.path, className: 'locus-asset-flat-field' },
                    h('span', { className: 'locus-asset-flat-path', title: field.path }, field.path.split('/').filter(Boolean).pop() ?? field.path),
                    h('span', { className: 'locus-asset-static', title: field.value }, field.value),
                  ),
                ),
              )
            : null,
        )
      }),
      (flat?.diagnostics ?? []).length > 0
        ? h(
            'div',
            { className: 'locus-asset-flat-diagnostics' },
            flat.diagnostics.map((diagnostic, index) =>
              // The severity is this panel's own vocabulary, so it is localised;
              // the message is Unity's own diagnostic text (an arbitrary
              // technical string) and translating it would be inventing words.
              h('div', { key: `${diagnostic.code ?? index}`, className: 'locus-asset-preview-note' }, `${severityLabel(diagnostic.severity)}: ${diagnostic.message ?? diagnostic.code ?? ''}`),
            ),
          )
        : null,
    )
  }

  // ── the tab body ──────────────────────────────────────────────────────────
  /**
   * Re-render the panel when the UI language switches.
   *
   * `t()` reads the locale service synchronously during render, so a switch
   * only becomes visible when something re-renders. Subscribing here (rather
   * than in every component) keeps `AssetBody` itself free of i18n plumbing;
   * the counter is intentionally only read for its effect of forcing a render.
   */
  function LocalizedAssetBody(props) {
    const [, setLocaleTick] = useState(0)
    useEffect(() => subscribeLocale(() => setLocaleTick((value) => value + 1)), [])
    return h(AssetBody, props)
  }

  // ── settings page ─────────────────────────────────────────────────────────
  //
  // One row per switch, modelled on the host's own settings rows: a label, a
  // one-line explanation and a right-aligned control. The controls are written
  // here rather than imported from a primitives package (a client plugin must
  // not load another Harness Client package); `role="switch"` plus
  // `aria-checked` is what the host's own toggle exposes to assistive tech.
  //
  // State lives on the Host, not in localStorage: the switches decide which
  // tools the Host registers, so a browser-local copy could disagree with the
  // running process. Every toggle therefore round-trips through
  // `POST /locus/api/settings`, and the answer (not the click) is what the page
  // renders.

  /**
   * One labelled switch row, matching the host's own settings rows.
   *
   * The control deliberately copies `@deepseek-ai/dsh-client-ui-primitives`'
   * `Switch` instead of importing it (a plain-JS client plugin must not load a
   * Harness Client package: it changes without notice and has no type check).
   * The copied parts are the ones users actually see and operate:
   *
   *   * a 36×20 capsule track, 2px padding, 10px radius, with `corner-shape:
   *     round` so the global superellipse does not square the ends off against
   *     the round thumb inside it;
   *   * a 16×16 round thumb translating 16px, animated over 120ms;
   *   * the track colour keyed off `aria-checked` rather than a parallel class,
   *     so the visual state cannot disagree with what assistive technology
   *     reads;
   *   * `role="switch"` + `aria-label`, and no text inside the control — the
   *     host's switch is a bare capsule, which is why the visible copy lives in
   *     the row, not in the button.
   *
   * The one host token the primitive uses that this file's older stylesheet does
   * not reference yet, `--dsw-alias-label-primary-foreground`, is the thumb
   * colour: a white knob in both themes.
   */
  function SwitchRow({ id, label, hint, checked, disabled, busy, onChange }) {
    const on = checked === true
    return h(
      'div',
      { className: 'locus-settings-row', 'data-locus-switch': id },
      h(
        'div',
        { className: 'locus-settings-row-text' },
        h('div', { className: 'locus-settings-row-label' }, label),
        hint ? h('div', { className: 'locus-settings-row-hint' }, hint) : null,
      ),
      h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': on ? 'true' : 'false',
          'aria-label': label,
          className: 'locus-settings-switch',
          disabled: disabled === true || busy === true,
          onClick: () => onChange(!on),
        },
        h('span', { className: 'locus-settings-switch-thumb', 'aria-hidden': 'true' }),
      ),
    )
  }

  /**
   * A host-style select: a filled trigger plus a floating option list.
   *
   * The native `<select>` popup is drawn by the platform (a blue system
   * highlight), which is exactly the part that made this page look unlike the
   * rest of Settings. This is the host's own shape — same trigger geometry,
   * a layered menu with a check on the current option — without importing the
   * primitives package (it is not part of the shipped runtime).
   */
  function SelectMenu({ id, value, options, disabled, onChange, className }) {
    const [open, setOpen] = useState(false)
    const wrapRef = useRef(null)
    const selected = options.find((option) => option.value === value)

    useEffect(() => {
      if (!open) return undefined
      const onPointerDown = (event) => {
        const node = wrapRef.current
        if (node && event.target instanceof Node && !node.contains(event.target)) setOpen(false)
      }
      const onKeyDown = (event) => {
        if (event.key === 'Escape') setOpen(false)
      }
      document.addEventListener('mousedown', onPointerDown, true)
      document.addEventListener('keydown', onKeyDown, true)
      return () => {
        document.removeEventListener('mousedown', onPointerDown, true)
        document.removeEventListener('keydown', onKeyDown, true)
      }
    }, [open])

    return h(
      'div',
      { className: `locus-select ${className ?? ''}`.trim(), ref: wrapRef },
      h(
        'button',
        {
          type: 'button',
          id,
          className: 'locus-select-trigger',
          disabled,
          'aria-haspopup': 'listbox',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen((current) => !current),
        },
        h('span', { className: 'locus-select-value' }, selected ? selected.label : ''),
        h('span', { className: 'locus-select-chevron', 'aria-hidden': 'true' }),
      ),
      open
        ? h(
            'div',
            { className: 'locus-select-menu', role: 'menu' },
            h('div', { className: 'locus-select-material', 'aria-hidden': 'true' }),
            h(
              'div',
              { className: 'locus-select-list', role: 'presentation' },
              options.map((option) =>
                h(
                  'button',
                  {
                    type: 'button',
                    key: option.value,
                    role: 'menuitem',
                    'data-label': option.label,
                    'aria-selected': option.value === value ? 'true' : 'false',
                    className: 'locus-select-option',
                    onClick: () => {
                      setOpen(false)
                      if (option.value !== value) onChange(option.value)
                    },
                  },
                  h('span', { className: 'locus-select-option-label' }, option.label),
                  option.value === value
                    ? h(
                        'svg',
                        {
                          className: 'locus-select-check',
                          viewBox: '0 0 16 16',
                          width: 14,
                          height: 14,
                          'aria-hidden': 'true',
                        },
                        h('path', {
                          d: 'M3.5 8.5l3 3 6-7',
                          fill: 'none',
                          stroke: 'currentColor',
                          'stroke-width': 1.5,
                          'stroke-linecap': 'round',
                          'stroke-linejoin': 'round',
                        }),
                      )
                    : null,
                ),
              ),
            ),
          )
        : null,
    )
  }

  /**
   * The workspace picker: the DSH workspaces this page may scan.
   *
   * The list is loaded by the page and handed in, so the section headings can
   * name the selected workspace without a second request. The value is the
   * workspace's canonical path, which is also what the projects and skills
   * routes accept.
   */
  function WorkspaceRow({ value, busy, onChange, workspaces, error }) {
    const options = workspaces ?? []
    // A stored path that is no longer registered must not render as a selection
    // the Host would ignore; it reads as "nothing selected" instead.
    const known = value ? options.some((workspace) => workspace.path === value) : false
    return h(
      'div',
      { className: 'locus-settings-row' },
      h(
        'div',
        { className: 'locus-settings-row-text' },
        h('label', { className: 'locus-settings-row-label', htmlFor: 'locus-workspace-select' }, t('settingsWorkspace')),
        h('div', { className: 'locus-settings-row-hint' }, t('settingsWorkspaceHint')),
        error
          ? h(
              'div',
              { className: 'locus-settings-row-error' },
              t('settingsWorkspaceLoadFailed', { message: String(error.message ?? error) }),
            )
          : null,
        workspaces !== null && options.length === 0 && !error
          ? h('div', { className: 'locus-settings-row-hint' }, t('settingsWorkspaceUnavailable'))
          : null,
      ),
      h(
        'div',
        { className: 'locus-settings-row-control locus-settings-select-control' },
        h(SelectMenu, {
          id: 'locus-workspace-select',
          value: known ? value : '',
          disabled: busy || workspaces === null,
          onChange,
          options: [
            { value: '', label: t('settingsWorkspaceNone') },
            ...options.map((workspace) => ({
              value: workspace.path,
              // Only the workspace's own name: the path and the projects inside
              // it are not this picker's business.
              label:
                workspace.title || workspace.path.split(/[\\/]/).filter(Boolean).pop() || workspace.path,
            })),
          ],
        }),
      ),
    )
  }

  /**
   * The "domain skills" panel: one switch per bundled Unity knowledge document.
   *
   * Nothing is written to the workspace and nothing else is reported here. A
   * switch puts that one skill into the model's catalog and takes it out again;
   * the C# half activates itself on first use, so there is no button, no status
   * line and no per-project choice to make.
   */
  function SkillsPanel({ toggles, busy, onToggleSkill }) {
    const [packages, setPackages] = useState([])
    const [error, setError] = useState(null)

    useEffect(() => {
      let cancelled = false
      void (async () => {
        try {
          const payload = await callApi('skills/state')
          if (!cancelled) {
            setPackages(payload.packages ?? [])
            setError(null)
          }
        } catch (failure) {
          if (!cancelled) setError(failure)
        }
      })()
      return () => {
        cancelled = true
      }
    }, [])

    return h(
      'div',
      { className: 'locus-settings-block' },
      packages.map((skill) =>
        h(SwitchRow, {
          id: `skill-${skill.id}`,
          key: skill.id,
          label: skill.title,
          hint: skill.hint,
          checked: toggles[skill.id] === true,
          busy: busy === `skills.${skill.id}`,
          onChange: (value) => onToggleSkill(skill.id, value),
        }),
      ),
      error
        ? h(
            'div',
            { className: 'locus-asset-error' },
            h('div', { className: 'locus-asset-error-line' }, String(error.message ?? error)),
          )
        : null,
    )
  }
  /**
   * The "Unity projects" panel: one row per project, with its bridge state.
   *
   * Three states, and the wording matters as much as the colour:
   *
   *   connected      a broker answered on the endpoint that project derives;
   *   not_connected  the package is installed but nothing answered — split into
   *                  "editor closed" and "editor open, bridge off" because those
   *                  are fixed differently;
   *   plugin_missing the package itself is absent or incomplete.
   *
   * The install button is the only action, and it never touches a running
   * editor: the Host refuses that case and this page explains why instead of
   * hiding the refusal.
   */
  function ProjectRow({ roots, sessionId, workspace, savedProject, onSelect }) {
    const [state, setState] = useState({ loading: true, projects: [], error: null })
    const [installing, setInstalling] = useState(false)
    const [notice, setNotice] = useState(null)

    const scan = useCallback(async () => {
      setState((current) => ({ ...current, loading: true }))
      try {
        // A selected workspace is the page's own answer to "where do I look",
        // and it outranks the Session's workspace list: the Settings page
        // belongs to no Session. Without a selection the panel keeps the
        // earlier behaviour (Session roots, then the Host's registered
        // workspaces) — never an ancestor or sibling directory.
        const params = workspace
          ? { roots: workspace }
          : roots && roots.length > 0
            ? { roots: roots.join(',') }
            : { sessionId }
        const payload = await callApi('projects', { params })
        const projects = payload.projects ?? []
        setState({ loading: false, projects, error: null })
      } catch (failure) {
        setState({ loading: false, projects: [], error: failure })
      }
    }, [roots, sessionId, workspace])

    useEffect(() => {
      void scan()
    }, [scan])

    const projects = state.projects
    // The stored choice wins while it still exists; otherwise the first scanned
    // project is shown without rewriting the setting, so switching workspaces
    // back and forth does not churn the document.
    const selected = projects.find((project) => project.projectRoot === savedProject) ?? projects[0] ?? null
    const packageReady =
      selected?.package?.installed === true && (selected.package.missingAssemblies ?? []).length === 0

    const install = useCallback(async () => {
      if (!selected) return
      setInstalling(true)
      setNotice(null)
      try {
        const payload = await callApi('projects/install', { method: 'POST', body: { projectRoot: selected.projectRoot } })
        setNotice({ kind: 'ok', text: payload.next || t('projectInstallDone') })
        await scan()
      } catch (failure) {
        // `editor_running` is a state to explain, not a defect: the guard exists
        // because the editor holds the assemblies open.
        const blocked = failure?.message && /holds the package assemblies|editor/i.test(JSON.stringify(failure.message))
        setNotice({ kind: 'error', text: blocked ? t('projectInstallBlocked') : String(failure?.message ?? failure) })
      } finally {
        setInstalling(false)
      }
    }, [selected, scan])

    const status = !selected
      ? { className: 'is-missing', text: t('settingsProjectNone') }
      : selected.state === 'connected'
        ? { className: 'is-connected', text: t('settingsPluginConnected') }
        : packageReady
          ? selected.editorRunning === true
            ? { className: 'is-missing', text: t('settingsPluginConnectionFailed') }
            : { className: 'is-offline', text: t('settingsPluginOffline') }
          : { className: 'is-missing', text: t('settingsPluginMissing') }

    return h(
      'div',
      { className: 'locus-settings-block' },
      h(
        'div',
        { className: 'locus-settings-row' },
        h(
          'div',
          { className: 'locus-settings-row-text' },
          h('label', { className: 'locus-settings-row-label', htmlFor: 'locus-project-select' }, t('settingsProject')),
          selected
            ? h('div', { className: 'locus-settings-row-hint' }, selected.projectRoot)
            : state.loading
              ? null
              : h('div', { className: 'locus-settings-row-hint' }, t('settingsProjectNone')),
        ),
        h(
          'div',
          { className: 'locus-settings-row-control locus-settings-select-control' },
          h(SelectMenu, {
            id: 'locus-project-select',
            value: selected?.projectRoot ?? '',
            disabled: state.loading || projects.length === 0,
            onChange: onSelect,
            options:
              projects.length === 0
                ? [{ value: '', label: state.loading ? t('projectsScanning') : t('settingsProjectNone') }]
                : projects.map((project) => ({
                    value: project.projectRoot,
                    label: project.name || project.projectRoot,
                  })),
          }),
        ),
      ),
      h(
        'div',
        { className: 'locus-settings-row' },
        h(
          'div',
          { className: 'locus-settings-row-text' },
          h(
            'div',
            { className: 'locus-settings-row-label locus-plugin-label' },
            h('span', null, t('settingsPlugin')),
            h('span', { className: `locus-project-badge ${status.className}` }, status.text),
          ),
        ),
        h(
          'div',
          { className: 'locus-settings-row-control' },
          selected && !packageReady
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'locus-asset-btn locus-asset-btn-primary',
                  disabled: installing || selected.canInstall === false,
                  onClick: () => void install(),
                },
                installing ? t('settingsPluginInstalling') : t('settingsPluginInstall'),
              )
            : null,
        ),
      ),
      notice
        ? h(
            'div',
            {
              className: notice.kind === 'ok' ? 'locus-project-notice' : 'locus-project-notice is-error',
              role: notice.kind === 'ok' ? 'status' : 'alert',
            },
            notice.text,
          )
        : null,
      state.error
        ? h(
            'div',
            { className: 'locus-asset-error' },
            h('div', { className: 'locus-asset-error-line' }, String(state.error.message ?? state.error)),
          )
        : null,
    )
  }

  /**
   * The settings page body.
   *
   * Renders whatever the Host reports; a failed write keeps the previous values
   * on screen and shows the reason, because a switch that silently snaps back
   * reads as a broken control rather than a refused write.
   */
  function SettingsBody(props) {
    // `roots`/`sessionId` reach the projects panel; a section registered without
    // them still renders, with an empty scan, which is the honest answer.
    const roots = props?.roots
    const sessionId = props?.sessionId
    const [, setLocaleTick] = useState(0)
    useEffect(() => subscribeLocale(() => setLocaleTick((value) => value + 1)), [])

    const [state, setState] = useState(null)
    const [error, setError] = useState(null)
    const [busy, setBusy] = useState('')

    const load = useCallback(async () => {
      try {
        const payload = await callApi('settings')
        setState(payload)
        setError(null)
      } catch (failure) {
        setError(failure)
      }
    }, [])

    useEffect(() => {
      void load()
    }, [load])

    // The workspace list belongs to the page, not to one row: the skills
    // heading names the selected workspace and the picker renders the same
    // list, so loading it twice would be two routes for one fact.
    const [workspaces, setWorkspaces] = useState(null)
    const [workspacesError, setWorkspacesError] = useState(null)
    useEffect(() => {
      let cancelled = false
      void (async () => {
        try {
          const payload = await callApi('workspaces')
          if (!cancelled) setWorkspaces(payload.workspaces ?? [])
        } catch (failure) {
          if (!cancelled) setWorkspacesError(failure)
        }
      })()
      return () => {
        cancelled = true
      }
    }, [])

    const apply = useCallback(
      async (section, key, value) => {
        setBusy(`${section}.${key}`)
        try {
          const payload = await callApi('settings', {
            method: 'POST',
            body: { [section]: { [key]: value } },
          })
          setState(payload)
          setError(null)
        } catch (failure) {
          setError(failure)
        } finally {
          setBusy('')
        }
      },
      [],
    )

    if (error && !state) {
      return h(
        'div',
        { className: 'locus-settings-root' },
        h(
          'div',
          { className: 'locus-asset-error', 'data-locus-settings-error': error.code ?? 'error' },
          h('div', { className: 'locus-asset-error-title' }, t('errorReadTitle')),
          h('div', { className: 'locus-asset-error-line' }, String(error.message ?? error)),
          h('button', { type: 'button', className: 'locus-asset-btn', onClick: () => void load() }, t('retry')),
        ),
        h('div', { className: 'locus-settings-note' }, t('settingsUnavailable')),
      )
    }
    if (!state) {
      return h(
        'div',
        { className: 'locus-settings-root' },
        h('div', { className: 'locus-asset-loading' }, h('span', { className: 'locus-asset-dot' }), h('span', null, t('settingsLoading'))),
      )
    }

    // A switch the process pins off (`DSH_LOCUS_CSHARP=0`) must not render as a
    // usable control: the write would be accepted and change nothing visible.
    const locked = state.locked ?? {}
    const features = state.features ?? {}
    const preferences = state.preferences ?? {}
    const effective = state.effective ?? features
    // The selected workspace narrows both panels below; empty means "keep using
    // the Session's own workspace". `savedProject` is the remembered Unity
    // project; a project that disappeared falls back to the first scanned one
    // without rewriting the setting.
    const workspace = typeof preferences.workspacePath === 'string' ? preferences.workspacePath : ''
    const savedProject = typeof preferences.unityProject === 'string' ? preferences.unityProject : ''

    return h(
      'div',
      { className: 'locus-settings-root' },
      h(
        'section',
        { className: 'locus-settings-card' },
        h('div', { className: 'locus-settings-group' }, t('settingsWorkspaceGroup')),
        h(WorkspaceRow, {
          value: workspace,
          busy: busy === 'preferences.workspacePath',
          onChange: (value) => void apply('preferences', 'workspacePath', value),
          workspaces,
          error: workspacesError,
        }),
        h(ProjectRow, {
          roots,
          sessionId,
          workspace,
          savedProject,
          onSelect: (value) => void apply('preferences', 'unityProject', value),
        }),
      ),
      h(
        'section',
        { className: 'locus-settings-card' },
        h('div', { className: 'locus-settings-group' }, t('settingsFeatures')),
        h(SwitchRow, {
          id: 'unity',
          label: t('settingsUnity'),
          hint: t('settingsUnityHint'),
          checked: features.unity,
          busy: busy === 'features.unity',
          onChange: (value) => void apply('features', 'unity', value),
        }),
        h(SwitchRow, {
          id: 'csharp',
          label: t('settingsCsharp'),
          hint: locked.csharp ? t('settingsCsharpLocked') : t('settingsCsharpHint'),
          checked: features.csharp,
          disabled: locked.csharp === true && effective.csharp !== true,
          busy: busy === 'features.csharp',
          onChange: (value) => void apply('features', 'csharp', value),
        }),
        h(SwitchRow, {
          id: 'preview',
          label: t('settingsPreview'),
          hint: t('settingsPreviewHint'),
          checked: features.preview,
          busy: busy === 'features.preview',
          onChange: (value) => void apply('features', 'preview', value),
        }),
      ),
      h(
        'section',
        { className: 'locus-settings-card' },
        h('div', { className: 'locus-settings-group' }, t('skillsGroup')),
        h(SkillsPanel, {
          toggles: state.skills ?? {},
          busy,
          onToggleSkill: (id, value) => void apply('skills', id, value),
        }),
      ),
      error && state
        ? h(
            'div',
            { className: 'locus-asset-error', 'data-locus-settings-error': error.code ?? 'error' },
            h('div', { className: 'locus-asset-error-title' }, t('settingsSaveFailed')),
            h('div', { className: 'locus-asset-error-line' }, String(error.message ?? error)),
          )
        : null,
    )
  }

  function AssetBody(props) {
    const { useTabInfo, sessionId } = props
    const { tab } = useTabInfo()
    const parsed = useMemo(() => parseFileAddress(tab.contentId ?? tab.address), [tab.contentId, tab.address])
    const path = parsed?.path ?? ''
    const session = parsed?.sessionId ?? sessionId
    const suffix = suffixOf(path)

    const [tree, setTree] = useState(null)
    const [flat, setFlat] = useState(null)
    const [target, setTarget] = useState(null)
    const [version, setVersion] = useState('')
    const [status, setStatus] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)
    const [expanded, setExpanded] = useState(() => new Set())
    const [childCache, setChildCache] = useState(() => new Map())
    // key -> the value the node held before this tab's first edit. That is the
    // only thing a revert can honestly restore: Unity's undo stack belongs to
    // the editor's own Ctrl+Z, not to a browser session.
    const [dirtyMap, setDirtyMap] = useState(() => new Map())
    const [saving, setSaving] = useState(false)
    const [showPreview, setShowPreview] = useState(true)
    const [lastSave, setLastSave] = useState(null)
    const mountedRef = useRef(true)

    useEffect(() => {
      mountedRef.current = true
      return () => {
        mountedRef.current = false
      }
    }, [])

    const loadStatus = useCallback(async () => {
      if (!session) return
      try {
        // The path lets the Host pick the right project when the workspace holds
        // more than one; without it a multi-project workspace has no answer.
        const payload = await callApi('status', { params: { sessionId: session, path: path || undefined } })
        if (mountedRef.current) setStatus(payload)
      } catch (failure) {
        if (mountedRef.current) setStatus({ connected: false, error: failure.message })
      }
    }, [session, path])

    const load = useCallback(
      async ({ keepEdits = false } = {}) => {
        if (!session || !path) {
          setError(new Error(t('notFileAddress')))
          setLoading(false)
          return
        }
        setLoading(true)
        setError(null)
        // A load that ends in an error (for example a `.glb` Unity has not
        // imported) must not leave the previous asset's dirty rows in the
        // toolbar; only a reload that explicitly keeps edits preserves them.
        if (!keepEdits) setDirtyMap(new Map())
        try {
          // Depth 2 is the asset's own objects plus their first fields, which is
          // what an Inspector shows before any click. Every further level is one
          // request on expand (`asset/read`), so a 270 KB prefab holding a whole
          // level costs ~1 MB here instead of ~5 MB.
          const payload = await callApi('asset', { params: { sessionId: session, path, depth: 2, items: 32 } })
          if (!mountedRef.current) return
          setTree(payload.tree ?? null)
          setFlat(payload.flat ?? null)
          setTarget(payload.target ?? null)
          setVersion(payload.version ?? '')
          setExpanded((current) => {
            if (keepEdits && current.size > 0) return current
            // Auto-expand the first two levels: an asset's own objects and their
            // first fields is what an inspector shows before any click. Keys are
            // positional (`rowKey`), the same ones the row list uses.
            const next = new Set()
            // Expand the asset's own object rows (their fields were fetched with
            // the root). Anything deeper loads on demand.
            const walk = (node, depth, parentKey, level) => {
              if (!node || level > 1) return
              const key = rowKey(parentKey, node)
              if (level < 2 && Array.isArray(node.children) && node.children.length > 0) next.add(key)
              for (const child of node.children ?? []) walk(child, depth + 1, key, level + 1)
            }
            walk(payload.tree, 0, null, 0)
            return next
          })
          setChildCache(new Map())
          if (!keepEdits) setDirtyMap(new Map())
        } catch (failure) {
          if (!mountedRef.current) return
          // A `.fbx`/`.glb` can be previewed by the browser even when Unity
          // has no importer for it; in that case there is no serialized tree,
          // and the import error belongs in the preview's own message, not as
          // a red "could not read this asset" over a perfectly good model.
          if (WEB_MODEL_EXTENSIONS.includes(suffixOf(path))) {
            setTree(null)
            setFlat(null)
            setTarget(null)
            setError(null)
          } else {
            setError(failure)
          }
        } finally {
          if (mountedRef.current) setLoading(false)
        }
      },
      [session, path],
    )

    useEffect(() => {
      void load({ keepEdits: false })
      void loadStatus()
    }, [load, loadStatus])

    const toggle = useCallback(
      async (node, key) => {
        const next = new Set(expanded)
        if (next.has(key)) {
          next.delete(key)
          setExpanded(next)
          return
        }
        next.add(key)
        setExpanded(next)
        // A row that already carries its children needs no request. That covers
        // every object row from the root read, and every sub-asset row: Unity's
        // file id for a sub-asset does not resolve back to the object, so asking
        // the broker again is not merely wasteful but wrong.
        if (Array.isArray(node.children) && node.children.length > 0) return
        if (node.nodeKind === 'subasset') return
        try {
          const payload = await callApi('asset/read', { method: 'POST', body: { sessionId: session, path, node: node.bindingTarget ? { ...node, propertyPath: node.propertyPath } : node, depth: 3, items: 32 } })
          if (!mountedRef.current) return
          const fresh = payload.tree
          setChildCache((current) => {
            const map = new Map(current)
            map.set(key, Array.isArray(fresh?.children) ? fresh.children : [])
            return map
          })
        } catch (failure) {
          if (mountedRef.current) setError(failure)
        }
      },
      [expanded, session, path],
    )

    const patchNode = useCallback((node, patch) => {
      setTree((current) => replaceNode(current, nodeKey(node), patch))
      setChildCache((current) => {
        const map = new Map()
        for (const [key, children] of current) map.set(key, children)
        return map
      })
    }, [])

    const write = useCallback(
      async (node, value, failure) => {
        if (failure) {
          setError(failure)
          return
        }
        const key = nodeKey(node)
        const original = node.value
        try {
          const payload = await callApi('asset/write', {
            method: 'POST',
            body: { sessionId: session, path, node, value },
          })
          if (!mountedRef.current) return
          if (payload.node) patchNode(node, { value: payload.node.value, displayValue: payload.node.displayValue })
          setDirtyMap((current) => {
            const map = new Map(current)
            if (!map.has(key)) map.set(key, original)
            return map
          })
          setError(null)
        } catch (error_) {
          if (mountedRef.current) setError(error_)
        }
      },
      [session, path, patchNode],
    )

    const save = useCallback(async () => {
      setSaving(true)
      setError(null)
      try {
        const payload = await callApi('asset/save', { method: 'POST', body: { sessionId: session, path } })
        if (!mountedRef.current) return
        setDirtyMap(new Map())
        setVersion(payload.version ?? version)
        setLastSave(Date.now())
      } catch (failure) {
        if (mountedRef.current) setError(failure)
      } finally {
        if (mountedRef.current) setSaving(false)
      }
    }, [session, path, version])

    const rows = useMemo(() => (tree ? flattenTree(tree, expanded, childCache) : []), [tree, expanded, childCache])

    /** Replay every recorded original value back, then drop the dirty marks. */
    const revert = useCallback(async () => {
      const entries = [...dirtyMap.entries()]
      if (entries.length === 0) return
      setSaving(true)
      setError(null)
      const byKey = new Map(rows.map((row) => [row.key, row.node]))
      try {
        for (const [key, original] of entries) {
          const node = byKey.get(key)
          if (!node) continue
          const payload = await callApi('asset/write', {
            method: 'POST',
            body: { sessionId: session, path, node, value: original },
          })
          if (!mountedRef.current) return
          if (payload.node) patchNode(node, { value: payload.node.value, displayValue: payload.node.displayValue })
        }
        setDirtyMap(new Map())
      } catch (failure) {
        if (mountedRef.current) setError(failure)
      } finally {
        if (mountedRef.current) setSaving(false)
      }
    }, [dirtyMap, rows, session, path, patchNode])

    const reveal = useCallback(async () => {
      try {
        await callApi('asset/select', { method: 'POST', body: { sessionId: session, path } })
      } catch (failure) {
        if (mountedRef.current) setError(failure)
      }
    }, [session, path])

    const dirtyCount = dirtyMap.size

    return h(
      'div',
      { className: 'locus-asset-root' },
      h(Toolbar, {
        status,
        path,
        dirty: dirtyCount,
        saving,
        error,
        preview: showPreview,
        onSave: save,
        onRevert: revert,
        onReload: () => void load({ keepEdits: false }),
        onSelect: reveal,
        onTogglePreview: () => setShowPreview((value) => !value),
      }),
      showPreview
        ? h(PreviewPane, { sessionId: session, path, version, suffix })
        : null,
      h(
        'div',
        { className: 'locus-asset-scroll' },
        loading && !tree && !flat ? h(Spinner, { label: t('readingAsset') }) : null,
        error ? h(ErrorBox, { error, onRetry: () => void load({ keepEdits: false }) }) : null,
        // `flat` is the read-only summary the Host falls back to when the
        // property tree has no visible children (an AnimatorController keeps its
        // states as sub-assets). The panel says "summary" instead of pretending
        // the empty tree is the whole asset.
        flat && !hasTreeRows(tree) ? h(FlatSummary, { flat }) : null,
        tree && hasTreeRows(tree)
          ? rows.map((row) => h(Row, {
              key: `${row.key}#${row.depth}`,
              row,
              expanded,
              onToggle: toggle,
              onWrite: write,
              dirtyMap,
              disabled: saving,
            }))
          : null,
        !loading && !error && !hasTreeRows(tree) && !flat
          ? h('div', { className: 'locus-asset-empty' }, WEB_MODEL_EXTENSIONS.includes(suffix) ? t('modelNoTree') : t('noSerializedData'))
          : null,
      ),
      h(
        'div',
        { className: 'locus-asset-footer' },
        h('span', { className: 'locus-asset-footer-text' }, dirtyCount > 0 ? t('dirtyFooter', { n: dirtyCount }) : lastSave ? t('savedToDisk') : t('noUnsaved')),
        h('span', { className: 'locus-asset-footer-path', title: path }, path),
      ),
    )
  }

  // ── registration ──────────────────────────────────────────────────────────
  return {
    name: 'dsh-locus-bridge',
    // `locale` is optional on purpose: a Host that mounts no locale plugin must
    // still get the panel (with browser-language copy), so a required injection
    // would turn a cosmetic absence into a missing tab.
    inject: ['slots', 'sidebarRightTabs'],
    apply(ctx) {
      // Attach the DSH locale service and register this plugin's dictionaries.
      // Both disposers run on fiber disposal, so re-activation re-registers
      // cleanly instead of duplicating entries.
      const locale = ctx.get?.('locale')
      if (locale) {
        attachLocale(locale)
        ctx.effect(() => {
          const disposers = []
          for (const [id, dict] of [
            ['zh', zh],
            ['en', en],
          ]) {
            try {
              const off = locale.register(LOCALE_NS, id, dict)
              if (typeof off === 'function') disposers.push(off)
            } catch {
              // A locale service with a different registration face is not worth
              // failing the tab over: `t()` still resolves from the snapshot.
            }
          }
          return () => {
            for (const off of disposers) off()
            attachLocale(null)
          }
        }, 'dsh-locus-bridge: locale dictionaries')
      }
      // ── settings page ─────────────────────────────────────────────────────
      //
      // The icon slot contract addresses an icon by the section id, so this row
      // fills the shell's default glyph for exactly this page.
      //
      // The artwork is the Unity logo, supplied by the user as a 128-unit
      // three-facet mark: its three paths, order and greys are kept verbatim as
      // presentation attributes, so the light theme is exactly the supplied
      // SVG. Dark mode is a pure CSS override (see `.locus-unity-mark` in the
      // stylesheet): the supplied darkest facet is near-black and would vanish
      // on a dark panel.
      //
      // The override keys off `body[data-ds-dark-theme]` — the attribute the
      // Host's own theme stylesheet uses; there is no `data-theme`.
      ctx.slots.inject('settings.section.icon', () =>
        ctx.slots.register(
          { name: 'settings.section.icon', id: SETTINGS_SECTION_ID, order: 48, label: () => t('settingsNav') },
          ({ size }) =>
            h(
              'svg',
              {
                viewBox: '0 0 128 128',
                width: size,
                height: size,
                xmlns: 'http://www.w3.org/2000/svg',
                className: 'locus-unity-mark',
                'aria-hidden': 'true',
                focusable: 'false',
              },
              h('path', {
                d: 'm64.414 122.93 47.606-27.49-18.247-10.553-18.656 10.777a1.06 1.06 0 0 1-1.035-.008 1.054 1.054 0 0 1-.523-.898V69.164c0-.754.39-1.437 1.043-1.812L96.77 54.55a1.03 1.03 0 0 1 1.035.008c.324.18.527.52.53.89v21.543l18.259 10.547V32.56l-52.18 30.12Zm0 0',
              }),
              h('path', {
                fill: '#4d4d4d',
                d: 'm53.738 95.676-18.664-10.79-18.261 10.552 47.601 27.492V62.68L12.25 32.559v54.976l18.254-10.543V55.45c.008-.37.207-.71.527-.89a1.04 1.04 0 0 1 1.04-.008l22.179 12.8a2.095 2.095 0 0 1 1.043 1.813v25.598c-.004.37-.2.71-.52.902-.316.188-.71.191-1.035.012',
              }),
              h('path', {
                fill: 'gray',
                d: 'M68.988 5.07v21.086l18.657 10.77c.32.187.511.531.511.906 0 .371-.195.711-.511.898L65.469 51.54a2.12 2.12 0 0 1-2.09 0L41.21 38.73a1.033 1.033 0 0 1-.516-.898 1.038 1.038 0 0 1 .516-.906l18.652-10.77V5.07L12.25 32.56l52.164 30.12 52.176-30.12Zm0 0',
              }),
            ),
        ),
      )
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: SETTINGS_SECTION_ID,
            order: 48,
            label: () => t('settingsNav'),
          },
          SettingsBody,
        ),
      )

      // ── tab type, driven by the preview switch ────────────────────────────
      //
      // The registration is synchronous and unconditional, then reconciled
      // against the Host switch: a client whose settings request fails (a
      // non-Web Host, an older Host without the route) must still get the tab,
      // and waiting for the round-trip before registering would make the panel
      // appear a network interval after the page loads. Turning the switch off
      // removes it on the next reconcile.
      const registerTab = () =>
        ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          patterns: patternsFor(),
          priority: 'extension',
          title: (address) => basenameOf(parseFileAddress(address)?.path ?? address),
          // A visited body keeps its unsaved edits through tab and Session
          // switches; closing the tab is the only thing that discards them.
          keepMounted: true,
        })
      let disposeTab = registerTab()
      let previewOn = true
      const syncTab = async () => {
        let on = true
        try {
          const payload = await callApi('settings')
          on = payload?.effective?.preview !== false
        } catch {
          // Keep the tab: see above.
          on = true
        }
        if (on === previewOn) return
        previewOn = on
        if (on) {
          if (!disposeTab) disposeTab = registerTab()
        } else if (disposeTab) {
          disposeTab()
          disposeTab = null
        }
      }
      ctx.effect(
        () => () => {
          if (disposeTab) disposeTab()
          disposeTab = null
        },
        'dsh-locus-bridge: tab type',
      )
      void syncTab()
      // The settings page cannot reach this component, so the switch is
      // re-read whenever the browser regains focus — the moment a user returns
      // from Settings to the conversation.
      const onFocus = () => {
        void syncTab()
      }
      if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('focus', onFocus)
        ctx.effect(
          () => () => window.removeEventListener('focus', onFocus),
          'dsh-locus-bridge: preview switch watcher',
        )
      }
      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: TAB_ID,
                inject: (sessionId) => ({ sessionId }),
              },
              LocalizedAssetBody,
            ),
          ),
        'dsh-locus-bridge: tab body',
      )
      document.documentElement.dataset.locusAsset = 'active'
      ctx.on('dispose', () => {
        delete document.documentElement.dataset.locusAsset
      })
    },
  }
}

/**
 * Replace one node in a tree by its row key, returning a new root.
 *
 * The key is positional (see {@link rowKey}), so patching a child never touches
 * an identically-identified sibling — the aggregate root and its objects.
 */
export function replaceNode(root, key, patch) {
  if (!root) return root
  const walk = (node, parentKey) => {
    if (!node) return node
    if (rowKey(parentKey, node) === key) return { ...node, ...patch }
    if (!Array.isArray(node.children) || node.children.length === 0) return node
    const ownKey = rowKey(parentKey, node)
    let changed = false
    const children = node.children.map((child) => {
      const next = walk(child, ownKey)
      if (next !== child) changed = true
      return next
    })
    return changed ? { ...node, children } : node
  }
  return walk(root, null)
}

const STYLE_ID = 'dsh-locus-bridge'

/** Inject the tab's stylesheet once per document. */
export function injectStyles() {
  if (typeof document === 'undefined') return
  if (document.head.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)) return
  const style = document.createElement('style')
  style.setAttribute('data-plugin-css', STYLE_ID)
  style.textContent = STYLESHEET
  document.head.appendChild(style)
}

const STYLESHEET = `
.locus-asset-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--dsw-alias-label-primary,inherit)}
.locus-asset-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));flex:0 0 auto;flex-wrap:wrap}
.locus-asset-toolbar-main{display:flex;align-items:center;gap:6px;min-width:0}
.locus-asset-toolbar-actions{display:flex;align-items:center;gap:4px;margin-left:auto}
.locus-asset-path{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-secondary,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:26ch}
.locus-asset-chip{font-size:11px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));color:var(--dsw-alias-label-tertiary,inherit);white-space:nowrap}
.locus-asset-chip-editing{color:var(--dsw-alias-state-success-primary,#3a3);border-color:currentColor}
.locus-asset-chip-playing,.locus-asset-chip-playing_paused{color:var(--dsw-alias-state-warn-primary,#b80);border-color:currentColor}
.locus-asset-chip-off{color:var(--dsw-alias-state-error-primary,#c33);border-color:currentColor}
.locus-asset-chip-busy{color:var(--dsw-alias-state-warn-primary,#b80);border-color:currentColor}
.locus-asset-chip-error{color:var(--dsw-alias-state-error-primary,#c33);border-color:currentColor}
.locus-asset-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:var(--dsw-alias-interactive-bg-hover,transparent);color:inherit;border-radius:var(--dsw-radius-sm,6px);padding:3px 8px;font-size:12px;cursor:pointer;line-height:1.5}
.locus-asset-btn:hover{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.18)))}
.locus-asset-btn:disabled{opacity:.55;cursor:default}
.locus-asset-btn-primary{border-color:var(--dsw-alias-brand-primary,#3a7);color:var(--dsw-alias-brand-primary,#3a7)}
.locus-asset-btn-idle{border-color:var(--dsw-alias-border-l2,rgba(128,128,128,.35));color:var(--dsw-alias-label-tertiary,inherit)}
.locus-asset-preview{flex:0 0 auto;padding:8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));background:var(--dsw-alias-bg-layer-1,transparent)}
.locus-asset-preview-surface{position:relative;display:flex;align-items:center;justify-content:center;height:180px;border-radius:var(--dsw-radius-md,8px);overflow:hidden;background:var(--dsw-alias-bg-layer-2,rgba(128,128,128,.08))}
.locus-asset-preview-surface.is-orbit{cursor:grab;touch-action:none}
.locus-asset-preview-surface.is-dragging{cursor:grabbing}
.locus-asset-preview-surface img{max-width:100%;max-height:100%;object-fit:contain;pointer-events:none;user-select:none}
.locus-asset-preview-note{margin-top:4px;font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}
.locus-model-preview{flex:0 0 auto;display:flex;flex-direction:column;gap:6px;padding:8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));background:var(--dsw-alias-bg-layer-1,transparent)}
.locus-model-stage{position:relative;height:320px;min-height:220px;border-radius:var(--dsw-radius-md,8px);overflow:hidden;background:#15161a}
.locus-model-canvas{position:absolute;inset:0}
.locus-model-stage canvas{display:block;width:100%;height:100%}
.locus-model-overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:12px;text-align:center;font-size:12px;color:#eee;background:rgba(0,0,0,.35);pointer-events:none}
.locus-model-overlay-error{background:rgba(48,12,12,.72);pointer-events:auto}
.locus-model-error-title{font-weight:600}
.locus-model-error-line{max-width:42ch;word-break:break-word;color:#ddd}
.locus-model-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:4px}
.locus-model-toolbar .locus-asset-btn.is-active{border-color:var(--dsw-alias-brand-primary,#3a7);color:var(--dsw-alias-brand-primary,#3a7)}
.locus-model-clip{font:inherit;font-size:11px;max-width:14ch;color:inherit;background:var(--dsw-alias-bg-base,transparent);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:var(--dsw-radius-sm,6px);padding:2px 4px}
.locus-model-stats{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);font-variant-numeric:tabular-nums}
.locus-asset-scroll{flex:1 1 auto;min-height:0;overflow:auto;padding:4px 0 12px}
.locus-asset-row{display:flex;align-items:center;gap:6px;min-height:24px;padding-right:8px;border-bottom:1px solid transparent}
.locus-asset-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}
.locus-asset-row.is-edited{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#b80) 8%,transparent)}
.locus-asset-row-head{display:flex;align-items:center;gap:4px;flex:1 1 auto;min-width:0}
.locus-asset-row-value{display:flex;align-items:center;gap:4px;flex:0 1 auto;justify-content:flex-end;min-width:0}
.locus-asset-fold{appearance:none;border:0;background:none;color:var(--dsw-alias-label-tertiary,inherit);width:16px;padding:0;cursor:pointer;font-size:10px;line-height:1}
.locus-asset-fold.is-empty{cursor:default;visibility:hidden}
.locus-asset-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,inherit)}
.locus-asset-type{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);font-family:var(--ds-font-family-code,ui-monospace,monospace);flex:0 0 auto}
.locus-asset-static{color:var(--dsw-alias-label-secondary,inherit);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:24ch}
.locus-asset-static.is-summary{color:var(--dsw-alias-label-tertiary,inherit)}
.locus-asset-input{width:64px;font:inherit;font-size:12px;color:inherit;background:var(--dsw-alias-bg-base,transparent);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:var(--dsw-radius-sm,6px);padding:1px 4px;min-width:0}
.locus-asset-input:focus{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary,#3a7));outline-offset:-1px}
.locus-asset-text{width:150px}
.locus-asset-select{font:inherit;font-size:12px;color:inherit;background:var(--dsw-alias-bg-base,transparent);border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:var(--dsw-radius-sm,6px);padding:1px 4px;max-width:16ch}
.locus-asset-check{margin:0}
.locus-asset-number{display:inline-flex;align-items:center;gap:2px}
.locus-asset-number-label{font-size:10px;color:var(--dsw-alias-label-tertiary,inherit)}
.locus-asset-vector,.locus-asset-color{display:inline-flex;align-items:center;gap:3px;flex-wrap:wrap;justify-content:flex-end}
.locus-asset-swatch{width:20px;height:20px;padding:0;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));border-radius:4px;background:none}
.locus-asset-reference{display:inline-flex;align-items:center;gap:4px;min-width:0}
.locus-asset-ref-text{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-secondary,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:22ch}
.locus-asset-mini{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));background:none;color:inherit;border-radius:4px;width:18px;height:18px;line-height:1;font-size:12px;padding:0;cursor:pointer}
.locus-asset-mini:disabled{opacity:.4;cursor:default}
.locus-asset-array{display:inline-flex;align-items:center;gap:3px;margin-left:4px}
.locus-asset-count{font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);min-width:1.5ch;text-align:right}
.locus-asset-flags{display:inline-flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;max-width:24ch}
.locus-asset-flag{display:inline-flex;align-items:center;gap:2px;font-size:11px;color:var(--dsw-alias-label-secondary,inherit)}
.locus-asset-loading{display:flex;align-items:center;gap:6px;padding:12px;font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}
.locus-asset-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-brand-primary,#3a7);animation:locus-asset-pulse 1.1s ease-in-out infinite}
@keyframes locus-asset-pulse{0%,100%{opacity:.25}50%{opacity:1}}
.locus-asset-error{margin:8px;padding:8px;border:1px solid var(--dsw-alias-state-error-primary,#c33);border-radius:var(--dsw-radius-md,8px);font-size:12px}
.locus-asset-error-title{font-weight:600;margin-bottom:2px}
.locus-asset-error-line{color:var(--dsw-alias-label-secondary,inherit);word-break:break-word;margin-bottom:6px}
.locus-asset-empty{padding:12px;font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}
.locus-asset-flat{padding:4px 0}
.locus-asset-flat-title{padding:2px 8px 6px;font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);text-transform:uppercase;letter-spacing:.04em}
.locus-asset-flat-object{border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.12))}
.locus-asset-flat-head{appearance:none;border:0;background:none;color:inherit;font:inherit;display:flex;align-items:center;gap:4px;width:100%;padding:3px 8px;text-align:left;cursor:pointer}
.locus-asset-flat-head:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}
.locus-asset-flat-fields{padding:0 8px 6px 26px;display:flex;flex-direction:column;gap:1px}
.locus-asset-flat-field{display:flex;align-items:baseline;gap:8px;min-width:0}
.locus-asset-flat-path{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);flex:0 0 auto;max-width:44%}
.locus-asset-flat-diagnostics{padding:6px 8px}
.locus-asset-footer{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 8px;border-top:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25));font-size:11px;color:var(--dsw-alias-label-tertiary,inherit)}
.locus-asset-footer-path{font-family:var(--ds-font-family-code,ui-monospace,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40%}
/* ── settings page ────────────────────────────────────────────────────────
   Row geometry follows the host's own settings rows (label + hint on the
   left, control on the right, one hairline between groups) and every colour
   is a --dsw-alias-* token, so light and dark themes both come from the host.
   The only literal value is the thumb's white, which must stay lighter than
   the track in either theme. */
.locus-settings-intro{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-tertiary);max-width:66ch}
.locus-settings-card{border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));background:var(--dsw-alias-settings-card-fill,transparent);border-radius:var(--dsw-radius-xl,12px);padding:0 16px;margin-top:12px}
.locus-settings-root>.locus-settings-card:first-child{margin-top:0}
.locus-settings-group{margin:12px 0 0;font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-secondary)}
.locus-settings-card .locus-settings-row:last-child{border-bottom:none}
/* Row geometry is the host's: DeveloperToolsRow.module.css in
   @deepseek-ai/dsh-client-ui-settings-general is
   "border-bottom:.5px solid var(--dsw-alias-border-l2);justify-content:space-between;
   align-items:center;gap:24px;padding:16px 0;display:flex", with a 14px/22px
   title and a 12px/18px tertiary description 4px below it. Copying those
   numbers is what makes this page read as part of Settings instead of as a
   page that merely sits inside it. */
.locus-settings-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.locus-settings-root{display:flex;flex-direction:column;gap:0;max-width:720px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);padding:0}
.locus-settings-row-text{display:flex;flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px}
.locus-settings-row-label{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
.locus-settings-row-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px;max-width:60ch}
.locus-settings-row-stack{flex-direction:column;align-items:stretch;gap:10px}
.locus-settings-root>.locus-settings-row:last-child,
.locus-settings-block>.locus-settings-row:last-child{border-bottom:none}
.locus-settings-row-error{font-size:12px;line-height:18px;color:var(--dsw-alias-label-error)}
/* The host's Menu primitive (ui-primitives Menu.module.css + MenuSurface):
   a 4px-padded translucent card, 34px rows with a 14px trailing check, and a
   40ms fade. An external client bundle cannot import the primitives package,
   so these are its numbers, not an imitation of its look. */
.locus-select{position:relative;display:inline-flex;max-width:100%;min-width:0}
.locus-select-trigger{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:space-between;gap:4px;height:36px;width:100%;min-width:0;padding:0 8px 0 12px;border:0;border-radius:var(--dsw-radius-md,6px);background-color:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:20px;cursor:pointer;text-align:left}
@media (hover:hover){.locus-select-trigger:hover:not(:disabled){background-color:var(--dsw-alias-interactive-bg-hover)}}
.locus-select-trigger:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary)))}
.locus-select-trigger:disabled{opacity:.6;cursor:default}
.locus-select-value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.locus-select-chevron{display:inline-flex;flex:0 0 auto;width:5px;height:5px;border-right:1.5px solid var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));border-bottom:1.5px solid var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));transform:rotate(45deg) translateY(-1px);transition:transform 120ms ease}
.locus-select-trigger[aria-expanded='true'] .locus-select-chevron{transform:rotate(225deg) translateY(1px)}
.locus-select-menu{position:absolute;top:calc(100% + 4px);right:0;left:auto;z-index:100;box-sizing:border-box;isolation:isolate;min-width:min(144px,calc(100vw - 24px));max-width:min(360px,calc(100vw - 24px));max-height:calc(100dvh - 24px);padding:4px;display:flex;flex-direction:column;border-radius:var(--dsw-radius-lg,10px);box-shadow:var(--dsw-elevation-prominent);overflow:hidden;animation:locus-menu-in 40ms ease-out}
.locus-select-material{position:absolute;inset:0;z-index:-1;border-radius:inherit;background:var(--dsw-alias-bg-layer-2);pointer-events:none}
.locus-select-list{display:flex;flex-direction:column;min-height:0;max-height:calc(100dvh - 32px);overflow-y:auto}
.locus-select-option{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md,6px);background:transparent;cursor:pointer;font:inherit;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);text-align:left}
@media (hover:hover){.locus-select-option:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.locus-select-option:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}
.locus-select-option-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.locus-select-check{flex:none;color:var(--dsw-alias-label-primary)}
@keyframes locus-menu-in{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.locus-select-menu{animation-duration:0ms}}
.locus-settings-block{display:flex;flex-direction:column}
.locus-settings-row-control{display:flex;align-items:center;gap:12px;flex:0 0 auto;min-width:0}
/* Both selectors share one width: the container owns it, the select fills it.
   Declared after the generic control rule so this flex-basis cannot lose the
   cascade (a later flex:0 0 auto would shrink the workspace picker to its
   content). */
.locus-settings-select-control{flex:0 0 140px;justify-content:flex-end}
.locus-plugin-label{display:flex;align-items:center;gap:8px;min-width:0}
.locus-plugin-state{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.locus-plugin-state.is-installed{color:var(--dsw-alias-label-secondary)}
/* Every button inside the settings page uses the same geometry and fill as the
   host's selector, primary action or not: the host does not grow a filled
   variant inside settings rows, and a mixed pair reads as two component kits. */
.locus-settings-root .locus-asset-btn{box-sizing:border-box;height:36px;padding:0 14px;border:0;border-radius:var(--dsw-radius-md,6px);background-color:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px;cursor:pointer}
@media (hover:hover){.locus-settings-root .locus-asset-btn:hover{background-color:var(--dsw-alias-interactive-bg-hover)}}
.locus-settings-root .locus-asset-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.locus-settings-root .locus-asset-btn:disabled{opacity:.6;cursor:default}
/* The install action is the one primary button: same geometry as every other
   button, filled with the host's brand colour so it reads as the action. */
.locus-settings-root .locus-asset-btn-primary{background-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground)}
@media (hover:hover){.locus-settings-root .locus-asset-btn-primary:hover{background-color:var(--dsw-alias-brand-primary)}}
/* The switch is a copy of the host primitive (@deepseek-ai/dsh-client-ui-primitives
   Switch.module.css), not a look-alike: same 36×20 capsule, 2px padding, 10px
   radius, 16px thumb translating 16px over 120ms, and the track colour keyed
   off aria-checked so the picture cannot disagree with the accessible state.
   "corner-shape:round" opts the capsule out of the global superellipse, which
   would otherwise square its ends off against the round thumb inside.

   Two colour deviations from that file, both deliberate:
   * the OFF track uses "--dsw-alias-border-l2" (its "border-l3" is used by the
     primitive but is not in the theme token list, so a renamed token would
     leave this track transparent against the panel);
   * the thumb uses "--dsw-alias-label-primary-foreground" with a white
     fallback, because that token is likewise outside the registered set but is
     the only one that stays lighter than the track in both themes. */
.locus-settings-switch{box-sizing:border-box;position:relative;display:block;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:10px;corner-shape:round;background:var(--dsw-alias-border-l2,rgba(128,128,128,.45));cursor:pointer;appearance:none}
.locus-settings-switch[aria-checked='true']{background:var(--dsw-alias-brand-primary,#3a7)}
.locus-settings-switch:disabled{cursor:default;opacity:.5}
.locus-settings-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#3a7);outline-offset:2px}
.locus-settings-switch-thumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground,#fff);transition:transform 120ms ease}
.locus-settings-switch[aria-checked='true'] .locus-settings-switch-thumb{transform:translateX(16px)}
/* ── settings nav icon ────────────────────────────────────────────────────
   The Unity mark is drawn with its own three greys (#000, #4d4d4d, gray) as
   presentation attributes, so the light theme renders the supplied artwork
   unchanged. On a dark panel the near-black facet disappears, so dark mode
   remaps the facets onto the label ramp while keeping their relative tone
   (brightest facet stays brightest). These rules are the only place the
   artwork is recoloured; the component itself stays verbatim.

   Only tokens from the Host's registered set are used (label-primary and
   label-secondary are both in it; there is no label-tertiary). The selector is
   the Host's own dark marker: its theme stylesheet uses
   body[data-ds-dark-theme], and no data-theme attribute exists. */
.locus-unity-mark{display:block;flex:0 0 auto}
:root body[data-ds-dark-theme] .locus-unity-mark path:nth-of-type(1){fill:var(--dsw-alias-label-primary,#e6e6e6)}
:root body[data-ds-dark-theme] .locus-unity-mark path:nth-of-type(2){fill:var(--dsw-alias-label-secondary,#a8a8a8)}
/* The third facet is the supplied flat "gray". With only two label tokens to
   work with, its step below the second facet comes from the same token at
   reduced opacity rather than from a third, unregistered token. */
:root body[data-ds-dark-theme] .locus-unity-mark path:nth-of-type(3){fill:var(--dsw-alias-label-secondary,#8a8a8a);opacity:.72}
.locus-settings-note{margin-top:8px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary,inherit)}
.locus-settings-path{display:flex;align-items:baseline;gap:8px;margin-top:12px;font-size:11px;color:var(--dsw-alias-label-tertiary,inherit);min-width:0}
.locus-settings-path-label{flex:0 0 auto}
.locus-settings-path code{font-family:var(--ds-font-family-code,ui-monospace,monospace);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
/* ── Unity projects panel ─────────────────────────────────────────────────
   Same row rhythm as the switches above (host hairline, 16px padding), with a
   state badge whose three colours are all theme tokens: success/success-warn
   for the two live states, error for a missing plugin. */
.locus-projects{display:flex;flex-direction:column;margin-top:8px}
.locus-projects-head{display:flex;align-items:center;justify-content:space-between;gap:16px}
.locus-projects-head .locus-settings-group{margin-bottom:0}
.locus-project-row{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(128,128,128,.25))}
.locus-project-main{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1 1 auto}
.locus-project-title{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.locus-project-name{font-size:14px;line-height:20px;color:var(--dsw-alias-label-primary,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.locus-project-badge{flex:0 0 auto;font-size:11px;line-height:16px;padding:0 8px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}
.locus-project-badge.is-connected{color:var(--dsw-alias-state-success-primary,#3a7)}
.locus-project-badge.is-offline{color:var(--dsw-alias-state-warn-primary,#b80)}
.locus-project-badge.is-missing{color:var(--dsw-alias-state-error-primary,#c33)}
.locus-project-path{font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,inherit);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.locus-project-reason{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,inherit)}
.locus-project-notice{margin:8px 0 0;padding:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary)}
.locus-project-notice.is-error{color:var(--dsw-alias-state-error-primary)}
@media (max-width: ${PREVIEW_COLLAPSE_WIDTH}px){
 .locus-asset-preview-surface{height:140px}
 .locus-model-stage{height:220px}
 .locus-asset-text{width:110px}
 .locus-asset-static{max-width:16ch}
}
`
