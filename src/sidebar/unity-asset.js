// Unity asset preview/edit operations for the right-Sidebar bridge.
//
// Every call here is a thin, careful wrapper over the same broker commands the
// Locus desktop app drives (`src-tauri/src/unity_bridge/mod.rs`):
//
//   property_tree_read   → the inspector tree (`LocusBridge.PropertyTree.cs`)
//   property_tree_write  → one SerializedProperty write + Undo + dirty
//   asset_thumbnail      → `AssetPreview.GetAssetPreview` PNG
//   asset_preview_render → `PreviewRenderUtility` orbit frame (prefab/model)
//   asset_api read       → flat serialized snapshot + revision (assets only)
//   select_asset         → reveal in the Project window
//
// Two behaviours are copied from Locus rather than invented:
//
//   * A property write is an **in-memory** edit that marks the object dirty
//     (`persisted: false` in the answer). Locus' desktop keeps it that way and
//     lets the editor's own save decide; our UI shows an explicit "Save" that
//     runs the same save calls `LocusBridge.AssetApi.SaveAssetApiScopeAllowed`
//     makes, because a browser panel has no Ctrl+S.
//   * Preview images are cheap but not free (200-800 ms), so they are cached by
//     (path, kind, params, file version) and served with an ETag.

import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { join } from 'node:path'

import { withClient } from '../client-pool.js'
import { executeSnippet } from '../execute.js'
import { isReloading } from '../protocol.js'
import { isAssetApiPath, isEditableAssetPath, suffixOf } from './paths.js'

const READ_TIMEOUT_MS = 60_000
const WRITE_TIMEOUT_MS = 120_000
const SAVE_TIMEOUT_MS = 120_000
const IMAGE_TIMEOUT_MS = 60_000

/** Depth/array limits mirroring what Locus' inspector requests. */
export const DEFAULT_TREE_DEPTH = 6
export const MAX_TREE_DEPTH = 16
export const DEFAULT_ARRAY_ITEMS = 64
export const MAX_ARRAY_ITEMS = 1024
export const DEFAULT_THUMB_SIZE = 256
export const MAX_THUMB_SIZE = 512
export const MAX_FRAME_SIZE = 640

/** Parse a broker JSON answer, keeping the message on failure for context. */
function parseJson(message, what) {
  const text = String(message ?? '').trim()
  if (!text) throw new Error(`${what} returned an empty answer.`)
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`${what} returned invalid JSON: ${error.message}`)
  }
}

/** Reduce a `property_tree_read` answer to the root snapshot. */
export function treeRootOf(answer) {
  if (!answer || typeof answer !== 'object') return null
  if (Array.isArray(answer.properties) && answer.properties.length > 0) return answer.properties[0]
  if (Array.isArray(answer.results) && answer.results.length > 0) return answer.results[0]
  return answer
}

/**
 * The wire target for one node.
 *
 * `bindingTarget` is echoed verbatim: the broker prefers `globalObjectId` and
 * recomputes local file ids itself (`PropertyTreeTargetWithLocalFileIds`), so a
 * round trip through JSON's doubles is safe and is exactly what the Locus client
 * sends back (`exactUnityPropertyTarget` only forces strings for *unsafe*
 * numbers, which this path never needs because identity is the global id).
 *
 * `propertyPath` may legitimately be empty: a component or object node (the
 * `Transform` row, an array node) is addressed by its target alone, and the
 * broker answers with that object's whole tree. Only a *write* needs a real
 * property path, which `isLeaf` already guarantees.
 */
export function targetOf(node) {
  const binding = node?.bindingTarget
  if (!binding || typeof binding !== 'object') throw new Error('This node carries no binding target; reload the asset.')
  return { ...binding, propertyPath: String(node.propertyPath ?? '') }
}

/** Read one asset's property tree. Scenes require the scene to be loaded (as in Locus). */
export async function readTree(target, { path, propertyPath = '', maxDepth, maxArrayItems, hierarchyFields } = {}) {
  const depth = clampInt(maxDepth, DEFAULT_TREE_DEPTH, 0, MAX_TREE_DEPTH)
  const items = clampInt(maxArrayItems, DEFAULT_ARRAY_ITEMS, 1, MAX_ARRAY_ITEMS)
  const request = {
    target: { kind: 'asset', path, propertyPath },
    maxDepth: depth,
    maxArrayItems: items,
    hierarchyFields: Array.isArray(hierarchyFields) ? hierarchyFields : ['active', 'components'],
  }
  return withClient(
    target,
    async (client) => {
      const envelope = await client.call('property_tree_read', JSON.stringify(request), { timeoutMs: READ_TIMEOUT_MS })
      const answer = parseJson(envelope.message, 'property_tree_read')
      const root = treeRootOf(answer)
      if (!root) throw new Error('property_tree_read returned no tree.')
      // Sub-assets (an AnimatorController's layers/states, a model's clips) come
      // back as a separate `subassets` list. Locus' inspector treats them as the
      // asset's own children, so the panel does too — see `subassetNodes`.
      return { root, target: answer.target ?? null, subassets: answer.subassets ?? [], raw: answer }
    },
    { exclusive: false },
  )
}

/**
 * Turn `property_tree_read`'s `subassets` list into ordinary display nodes.
 *
 * An AnimatorController (or a model with several clips) has no serialized
 * children at all: its content is *sub-assets*, which Unity keeps as separate
 * objects inside the same file. Locus' inspector shows them as the asset's own
 * rows, and that is the only view that makes such a file browsable, so each
 * entry becomes a synthetic node whose children are the sub-asset's visible
 * children, walking into nested sub-assets (a state machine holds states).
 *
 * `bindingTarget` is carried through untouched: every sub-asset node keeps the
 * target the broker reported, so a read of it stays addressable by Locus'
 * protocol rather than by anything invented here.
 */
export function subassetNodes(subassets) {
  if (!Array.isArray(subassets)) return []
  return subassets.map((entry, index) => {
    // No target means "nothing addressable here": leave the key absent rather
    // than an empty object, so a caller can test it and the panel offers no
    // write action for the row.
    const target = entry?.target
    // Children arrive in the broker's own shape, which names the target
    // `target`; the panel speaks `bindingTarget`. Normalise once here so every
    // row is expandable through the same code path as a serialized node.
    const children = [
      ...(Array.isArray(entry?.children) ? entry.children : []).map((child) => normalizeChild(child)),
      ...subassetNodes(entry?.subassets),
    ]
    return {
      // A sub-asset has no serialized property path of its own.
      propertyPath: '',
      bindingTarget: target,
      displayName: entry?.displayName ?? entry?.segment ?? `Sub-asset ${index + 1}`,
      name: entry?.segment ?? entry?.displayName ?? '',
      type: entry?.type ?? entry?.typeFullName ?? 'Object',
      valueType: entry?.type ?? 'Object',
      nodeKind: 'subasset',
      editable: false,
      hasChildren: children.length > 0,
      children,
      isArray: false,
      arraySize: 0,
      value: null,
      displayValue: entry?.type ?? '',
    }
  })
}

/** Give one broker child node the panel's `bindingTarget` spelling. */
function normalizeChild(child) {
  if (!child || typeof child !== 'object') return child
  if (child.bindingTarget || !child.target) return child
  return { ...child, bindingTarget: child.target }
}

/** Read one node's own subtree (`property_tree_read` with its propertyPath). */
export async function readNode(target, node, { maxDepth, maxArrayItems } = {}) {
  const binding = targetOf(node)
  const request = {
    target: binding,
    maxDepth: clampInt(maxDepth, DEFAULT_TREE_DEPTH, 0, MAX_TREE_DEPTH),
    maxArrayItems: clampInt(maxArrayItems, DEFAULT_ARRAY_ITEMS, 1, MAX_ARRAY_ITEMS),
  }
  return withClient(
    target,
    async (client) => {
      const envelope = await client.call('property_tree_read', JSON.stringify(request), { timeoutMs: READ_TIMEOUT_MS })
      return parseJson(envelope.message, 'property_tree_read')
    },
    { exclusive: false },
  )
}

/**
 * Write one property value.
 *
 * `value` is the plain JSON the property expects: a scalar for numbers/strings/
 * booleans, `{x,y,z}` for vectors, `{r,g,b,a}` for colors, `{index}` or a name
 * for enums, `{globalObjectId}`/null for object references, and
 * `{action:'insert'|'delete'|'move'|'resize'|…}` for array structure — the
 * vocabulary `SetSerializedPropertyValue` parses.
 */
export async function writeNode(target, { path, node, value, mode = 'commit' }) {
  if (!isEditableAssetPath(path)) {
    throw new Error(`${suffixOf(path) || 'This asset'} cannot be edited from the Sidebar (read-only preview).`)
  }
  const request = { target: targetOf(node), valueJson: JSON.stringify(value ?? null), mode }
  return withClient(
    target,
    async (client) => {
      const envelope = await client.call('property_tree_apply', JSON.stringify({ writes: [request] }), {
        timeoutMs: WRITE_TIMEOUT_MS,
      })
      const answer = parseJson(envelope.message, 'property_tree_apply')
      const result = Array.isArray(answer.results) ? answer.results[0] : null
      if (!result) throw new Error('property_tree_apply returned no result.')
      if (result.ok === false) throw new Error(result.message || 'property_tree_apply failed.')
      if (!result.ok && answer.ok === false) throw new Error(answer.message || 'property_tree_apply failed.')

      // A structural array change (insert/delete/move/resize) is answered from
      // the SerializedObject buffer that was just applied, and Unity is allowed
      // to refuse it silently for a field that derives its storage elsewhere
      // (`Renderer.m_Materials`, a controller's parameter list). Re-reading the
      // node is the only truthful answer: the panel then shows what the editor
      // actually holds instead of a size that never moved.
      const structural = isStructuralArrayValue(value)
      if (structural) {
        try {
          const reread = await client.call(
            'property_tree_read',
            JSON.stringify({ target: request.target, maxDepth: 2, maxArrayItems: MAX_ARRAY_ITEMS }),
            { timeoutMs: READ_TIMEOUT_MS },
          )
          const fresh = treeRootOf(parseJson(reread.message, 'property_tree_read'))
          if (fresh) return { node: { ...result, ...fresh, beforeSnapshot: result.beforeSnapshot ?? null }, persisted: false, reread: true }
        } catch {
          // Keep the write's own answer when the re-read fails.
        }
      }
      return { node: result, persisted: result.persisted === true, reread: false }
    },
    // A write whose fate is unknown must not be replayed.
    { exclusive: true },
  )
}

/** True for the array-structure command shapes `SetSerializedPropertyValue` accepts. */
export function isStructuralArrayValue(value) {
  if (typeof value === 'number') return true // bare size
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return ['insert', 'add', 'insertreferences', 'duplicate', 'delete', 'remove', 'move', 'resize', 'clear'].includes(
    String(value.action ?? '').toLowerCase(),
  )
}

/**
 * Save one asset to disk.
 *
 * The branch order is `SaveAssetApiScopeAllowed`'s, unchanged: an open Prefab
 * Stage saves its contents root, a scene saves its scene, a prefab saves the
 * prefab asset, and anything else flushes each dirty sub-asset.
 */
export async function saveAsset(target, { path }) {
  const code = saveSnippet(path)
  const result = await withClient(
    target,
    (client) => executeSnippet(client, { code, executionId: randomUUID(), timeoutMs: SAVE_TIMEOUT_MS }),
    { exclusive: true },
  )
  const output = String(result.output ?? '').trim()
  const failure = String(result.error ?? '').trim()
  if (failure) throw new Error(`Saving ${path} failed: ${failure}`)
  const parsed = parseSaveOutput(output)
  if (!parsed.ok) throw new Error(`Saving ${path} failed${parsed.detail ? `: ${parsed.detail}` : '.'}`)
  return parsed
}

/** The save snippet body (kept out of `saveAsset` so tests can assert on it). */
export function saveSnippet(path) {
  return [
    '// Locus asset save, mirroring LocusBridge.AssetApi.SaveAssetApiScopeAllowed.',
    `var path = ${csString(path)};`,
    'var stage = UnityEditor.SceneManagement.PrefabStageUtility.GetCurrentPrefabStage();',
    'if (stage != null && string.Equals(stage.assetPath, path, System.StringComparison.OrdinalIgnoreCase))',
    '{',
    '    bool stageOk;',
    '    UnityEditor.PrefabUtility.SaveAsPrefabAsset(stage.prefabContentsRoot, path, out stageOk);',
    '    if (!stageOk) { print("save_failed:prefab_stage"); } else { print("saved:prefab_stage"); }',
    '}',
    'else if (path.EndsWith(".unity", System.StringComparison.OrdinalIgnoreCase))',
    '{',
    '    var scene = UnityEditor.SceneManagement.EditorSceneManager.GetSceneByPath(path);',
    '    if (!scene.IsValid() || !scene.isLoaded) { print("save_failed:scene_not_loaded"); }',
    '    else if (UnityEditor.SceneManagement.EditorSceneManager.SaveScene(scene)) { print("saved:scene"); }',
    '    else { print("save_failed:scene"); }',
    '}',
    'else if (path.EndsWith(".prefab", System.StringComparison.OrdinalIgnoreCase))',
    '{',
    '    var prefab = UnityEditor.AssetDatabase.LoadAssetAtPath<UnityEngine.GameObject>(path);',
    '    if (prefab == null) { print("save_failed:prefab_missing"); }',
    '    else',
    '    {',
    '        bool prefabOk;',
    '        UnityEditor.PrefabUtility.SavePrefabAsset(prefab, out prefabOk);',
    '        if (!prefabOk) { print("save_failed:prefab"); } else { print("saved:prefab"); }',
    '    }',
    '}',
    'else',
    '{',
    '    var all = UnityEditor.AssetDatabase.LoadAllAssetsAtPath(path);',
    '    if (all == null || all.Length == 0) { print("save_failed:asset_missing"); }',
    '    else',
    '    {',
    '        foreach (var asset in all) UnityEditor.AssetDatabase.SaveAssetIfDirty(asset);',
    '        var stillDirty = false;',
    '        foreach (var asset in all) if (UnityEditor.EditorUtility.IsDirty(asset)) stillDirty = true;',
    '        if (stillDirty) { print("save_failed:still_dirty"); } else { print("saved:asset"); }',
    '    }',
    '}',
  ].join('\n')
}

/** Parse the snippet's one `saved:<kind>` / `save_failed:<reason>` line. */
export function parseSaveOutput(output) {
  const line = String(output ?? '')
    .split('\n')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith('saved:') || entry.startsWith('save_failed:'))
  if (!line) return { ok: false, detail: output || 'no save result was reported' }
  if (line.startsWith('saved:')) return { ok: true, kind: line.slice('saved:'.length) }
  return { ok: false, detail: line.slice('save_failed:'.length) }
}

/** Reveal an asset in Unity's Project window (`select_asset` + ping). */
export async function selectAsset(target, { path }) {
  const payload = JSON.stringify({ assetPath: path, focusProjectWindow: true })
  return withClient(target, (client) => client.call('select_asset', payload, { timeoutMs: 30_000 }), { exclusive: false })
}

/** Flat serialized snapshot (the `asset_api` shape), used by the read-only table view. */
export async function readSnapshot(target, { path }) {
  if (!isAssetApiPath(path)) throw new Error(`${suffixOf(path) || 'This asset'} has no asset_api serialization.`)
  return withClient(
    target,
    async (client) => {
      const envelope = await client.call('asset_api', JSON.stringify({ action: 'read', path }), {
        timeoutMs: READ_TIMEOUT_MS,
      })
      return parseJson(envelope.message, 'asset_api read')
    },
    { exclusive: false },
  )
}

/** File version key for cache busting: mtime + size, or a marker when unreadable. */
export function assetVersion(projectRoot, path) {
  try {
    const info = statSync(join(projectRoot, path))
    return `${info.mtimeMs}:${info.size}`
  } catch {
    return 'missing'
  }
}

/**
 * `asset_thumbnail` → PNG bytes.
 *
 * The broker answers a base64 payload and its own dimensions, which can differ
 * from the requested `maxSize` (Unity snaps the preview to the importer's own
 * aspect), so the caller gets the real width/height back.
 */
export async function thumbnailPng(target, { path, maxSize }) {
  const size = clampInt(maxSize, DEFAULT_THUMB_SIZE, 64, MAX_THUMB_SIZE)
  return withClient(
    target,
    async (client) => {
      const envelope = await client.call('asset_thumbnail', JSON.stringify({ assetPath: path, maxSize: size }), {
        timeoutMs: IMAGE_TIMEOUT_MS,
      })
      const answer = parseJson(envelope.message, 'asset_thumbnail')
      const bytes = Buffer.from(String(answer.pngBase64 ?? ''), 'base64')
      if (bytes.length === 0) throw new Error('asset_thumbnail returned no pixels.')
      return { bytes, width: Number(answer.width) || 0, height: Number(answer.height) || 0, mimeType: 'image/png' }
    },
    { exclusive: false },
  )
}

/**
 * `asset_preview_render` → PNG bytes for one orbit frame.
 *
 * Only prefab/model assets render; the broker states that plainly and the UI
 * shows the message instead of a broken canvas.
 */
export async function renderFrame(target, { path, width, height, yaw, pitch, distance, panX, panY, panZ }) {
  const request = {
    assetPath: path,
    width: clampInt(width, 480, 96, MAX_FRAME_SIZE),
    height: clampInt(height, 320, 96, MAX_FRAME_SIZE),
    yaw: finiteOr(yaw, 25),
    pitch: finiteOr(pitch, -12),
    distance: finiteOr(distance, 1.15),
    panX: finiteOr(panX, 0),
    panY: finiteOr(panY, 0),
    panZ: finiteOr(panZ, 0),
  }
  return withClient(
    target,
    async (client) => {
      const envelope = await client.call('asset_preview_render', JSON.stringify(request), {
        timeoutMs: IMAGE_TIMEOUT_MS,
      })
      const answer = parseJson(envelope.message, 'asset_preview_render')
      const bytes = Buffer.from(String(answer.dataBase64 ?? ''), 'base64')
      if (bytes.length === 0) throw new Error('asset_preview_render returned no pixels.')
      return { bytes, width: Number(answer.width) || request.width, height: Number(answer.height) || request.height, mimeType: 'image/png' }
    },
    { exclusive: false },
  )
}

/** Editor status plus the reload generation, for the panel's connection strip. */
export async function editorStatus(target) {
  const started = Date.now()
  try {
    return await withClient(
      target,
      async (client) => {
        const status = await client.call('status', '', { timeoutMs: 10_000 })
        let reload = null
        try {
          const envelope = await client.call('get_reload_state', '', { timeoutMs: 10_000 })
          reload = parseJson(envelope.message, 'get_reload_state')
        } catch {
          reload = null
        }
        return { connected: true, status: status.message, reload, capabilities: client.capabilities ?? [], ms: Date.now() - started }
      },
      { exclusive: false },
    )
  } catch (error) {
    return {
      connected: false,
      reloading: isReloading(String(error?.code ?? '')) || /managed_reloading/.test(String(error?.message ?? '')),
      error: String(error?.message ?? error),
      ms: Date.now() - started,
    }
  }
}

/** Weak ETag for a cached PNG: the bytes plus the cache key. */
export function etagOf(key, bytes) {
  return `"${createHash('sha1').update(key).update(bytes).digest('hex').slice(0, 24)}"`
}

/**
 * Get-or-load PNG bytes from a bounded cache.
 *
 * Keyed by everything that changes the picture; `force` is the explicit reload
 * path the toolbar's refresh uses.
 */
export class PngCache {
  constructor({ limit = 48, bytesLimit = 64 * 1024 * 1024 } = {}) {
    this.limit = limit
    this.bytesLimit = bytesLimit
    this.entries = new Map()
    this.bytes = 0
  }

  get(key) {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    // Refresh recency.
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry
  }

  set(key, value) {
    const previous = this.entries.get(key)
    if (previous) {
      this.bytes -= previous.bytes.length
      this.entries.delete(key)
    }
    this.entries.set(key, value)
    this.bytes += value.bytes.length
    this.trim()
    return value
  }

  trim() {
    while (this.entries.size > this.limit || this.bytes > this.bytesLimit) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      const entry = this.entries.get(oldest.value)
      this.entries.delete(oldest.value)
      this.bytes -= entry?.bytes.length ?? 0
    }
  }

  clear() {
    this.entries.clear()
    this.bytes = 0
  }
}

function clampInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function finiteOr(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

const CS_ESCAPE = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' }

/** C# string literal for an arbitrary value (no interpolation). */
export function csString(value) {
  return `"${String(value).replace(/[\\"\n\r\t]/g, (ch) => CS_ESCAPE[ch])}"`
}
