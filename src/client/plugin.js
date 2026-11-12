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
      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            patterns: patternsFor(),
            priority: 'extension',
            title: (address) => basenameOf(parseFileAddress(address)?.path ?? address),
            // A visited body keeps its unsaved edits through tab and Session
            // switches; closing the tab is the only thing that discards them.
            keepMounted: true,
          }),
        'dsh-locus-bridge: tab type',
      )
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
@media (max-width: ${PREVIEW_COLLAPSE_WIDTH}px){
 .locus-asset-preview-surface{height:140px}
 .locus-model-stage{height:220px}
 .locus-asset-text{width:110px}
 .locus-asset-static{max-width:16ch}
}
`
