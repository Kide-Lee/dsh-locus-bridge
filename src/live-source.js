// The live Unity Editor as a data source for the YAML tools.
//
// The YAML reader in `yaml-lite.js` parses the file on disk, which works with no
// Editor at all. That is the right default — most questions ("what does this
// prefab contain") are answered by the file. But two classes of question are not:
// a value changed in the Editor and not yet saved, and a prefab instance whose
// overrides only Unity has already resolved. Upstream Locus solves both by
// reading through the bridge; so does this module.
//
// The Editor never sends us YAML text. It sends a snapshot of the serialized
// property tree (`dsh_live_read`), and `yaml-lite.js` renders it in the same
// shape as the disk renderer so the two are directly comparable. That keeps a
// single parser in the project instead of a second, Editor-side copy that would
// drift.
//
// Every failure here is recoverable by definition: the caller falls back to disk
// and says so. A missing Editor is not an error, it is "no live source".

import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Extension messages answered by the companion package (`packages/unity-bridge`). */
export const LIVE_READ_MESSAGE = 'dsh_live_read'
export const LIVE_OVERRIDES_MESSAGE = 'dsh_live_prefab_overrides'

/** A property tree read is local work; it should never need seconds. */
const LIVE_TIMEOUT_MS = 15_000

/**
 * Why a live read fell back to disk. These strings reach the user, so they say
 * what to do rather than what broke.
 */
export const LIVE_UNSUPPORTED = 'the companion package com.locus.dsh-bridge is not installed in this project'

function projectRelative(projectRoot, absolute) {
  return relative(resolve(projectRoot), resolve(absolute)).split(sep).join('/')
}

/** `Assets/...` or an absolute path → the project-relative form the Editor wants. */
export function assetPathOf(projectRoot, path) {
  const text = String(path ?? '').trim()
  if (text === '') throw new Error('a path is required')
  const relativePath = isAbsolute(text) ? projectRelative(projectRoot, text) : text.split(sep).join('/')
  return relativePath.replace(/^\.\//, '')
}

/**
 * Read the Editor's snapshot of one asset.
 *
 * @returns {Promise<{ok: true, path: string, objects: object[]} | {ok: false, reason: string}>}
 */
export async function readLiveAsset(client, projectRoot, path, { depth = 2 } = {}) {
  const assetPath = assetPathOf(projectRoot, path)
  let envelope
  try {
    envelope = await client.request(LIVE_READ_MESSAGE, JSON.stringify({ path: assetPath, depth }), {
      timeoutMs: LIVE_TIMEOUT_MS,
    })
  } catch (error) {
    // An unreachable or reloading Editor is the common case, not a bug; the
    // disk answer is still useful.
    return { ok: false, reason: `the Editor did not answer (${String(error?.code ?? error?.message ?? error)})` }
  }
  if (!envelope?.ok) {
    const text = String(envelope?.error ?? '')
    if (/unknown message type|unknown request/i.test(text)) return { ok: false, reason: LIVE_UNSUPPORTED }
    return { ok: false, reason: text || 'the Editor refused the live read' }
  }
  let body
  try {
    body = JSON.parse(String(envelope.message ?? ''))
  } catch (error) {
    return { ok: false, reason: `the Editor returned invalid JSON (${error.message})` }
  }
  if (body?.error) {
    const reason = String(body.error)
    if (/unknown message/i.test(reason)) return { ok: false, reason: LIVE_UNSUPPORTED }
    return { ok: false, reason }
  }
  const objects = []
  for (const object of Array.isArray(body?.objects) ? body.objects : []) {
    // Index by FileID so the disk documents (which carry the same FileID in
    // their header) can be matched one-to-one. Objects without a FileID — scene
    // objects, runtime-created assets — are kept under a synthetic key so a
    // caller that only wants "what the Editor has" still sees them.
    const fileId = object?.file_id === undefined || object?.file_id === null ? '' : String(object.file_id)
    objects.push({ ...object, fileId, liveKey: fileId === '' ? `anon:${objects.length}` : fileId })
  }
  return { ok: true, path: assetPathOf(projectRoot, body?.path ?? assetPath), objects }
}

/**
 * Collect the live snapshot for `unity_yaml_read` / `unity_yaml_search`.
 *
 * Returns the `live` bundle `readYamlText` and `searchYamlFiles` understand,
 * or null when the caller asked for disk or the Editor could not answer.
 *
 * @returns {Promise<{live: object|null, reason: string|null}>}
 */
export async function liveSource(client, projectRoot, path, { depth = 2 } = {}) {
  if (!client) return { live: null, reason: 'no Editor connection' }
  const result = await readLiveAsset(client, projectRoot, path, { depth })
  if (!result.ok) return { live: null, reason: result.reason }
  const objects = {}
  for (const object of result.objects) objects[object.fileId === '' ? object.liveKey : object.fileId] = object
  // The search path needs the live text of the same file; the reader supplies
  // the rendered values, the search supplies the file text it should scan.
  // Rendering the snapshot back into Unity YAML text (rather than handing the
  // search the raw property tree) keeps one matcher over one shape.
  const texts = {}
  const rendered = renderSnapshotAsYaml(result.objects)
  if (rendered !== null) texts[result.path] = rendered
  return { live: { path: result.path, objects, texts }, reason: null }
}

/**
 * Resolved prefab overrides for one asset.
 *
 * @returns {Promise<{ok: true, path: string, overrides: object[]} | {ok: false, reason: string}>}
 */
export async function readLiveOverrides(client, projectRoot, path) {
  const assetPath = assetPathOf(projectRoot, path)
  let envelope
  try {
    envelope = await client.request(LIVE_OVERRIDES_MESSAGE, JSON.stringify({ path: assetPath }), {
      timeoutMs: LIVE_TIMEOUT_MS,
    })
  } catch (error) {
    return { ok: false, reason: `the Editor did not answer (${String(error?.code ?? error?.message ?? error)})` }
  }
  if (!envelope?.ok) {
    const text = String(envelope?.error ?? '')
    if (/unknown message type|unknown request/i.test(text)) return { ok: false, reason: LIVE_UNSUPPORTED }
    return { ok: false, reason: text || 'the Editor refused the override read' }
  }
  let body
  try {
    body = JSON.parse(String(envelope.message ?? ''))
  } catch (error) {
    return { ok: false, reason: `the Editor returned invalid JSON (${error.message})` }
  }
  if (body?.error) return { ok: false, reason: String(body.error) }
  return { ok: true, path: assetPath, overrides: Array.isArray(body?.overrides) ? body.overrides : [] }
}

/**
 * Render an Editor snapshot as Unity YAML, so the disk parser can read it.
 *
 * Only the fields the Editor sent are written: a property tree is read to a
 * bounded depth, so this is a *partial* document, not a faithful serialisation.
 * That is enough for `unity_yaml_search` (which matches names and values) and it
 * is what makes the live and disk answers line up — both go through
 * `parseUnityYaml`, so both produce the same pointer shape.
 */
export function renderSnapshotAsYaml(objects) {
  const list = Array.isArray(objects) ? objects : []
  if (list.length === 0) return null
  const blocks = []
  for (const object of list) {
    const fields = Array.isArray(object?.fields) ? object.fields : null
    if (fields === null || fields.length === 0) continue
    const lines = []
    // The Editor names the class (`GameObject`), not its numeric id; the tag is
    // therefore only emitted when the snapshot carries one. The pointer shape
    // only needs the type name, which is written as a YAML comment-free header
    // line below.
    const header = object.file_id ? `--- !u!0 &${object.file_id}` : `--- !u!0 &0`
    lines.push(header)
    lines.push(`${String(object.type ?? 'Object')}:`)
    for (const field of fields) appendField(lines, field, 2)
    blocks.push(lines.join('\n'))
  }
  return blocks.length > 0 ? `${blocks.join('\n')}\n` : null
}

/** One snapshot field (and its children) as YAML lines at `indent`. */
function appendField(lines, field, indent) {
  const pad = ' '.repeat(indent)
  const name = String(field?.name ?? '').replace(/:$/, '')
  const children = Array.isArray(field?.children) ? field.children : null
  if (children !== null && children.length > 0) {
    lines.push(`${pad}${name}:`)
    for (const child of children) appendField(lines, child, indent + 2)
    return
  }
  const raw = field?.reference ? `{${field.reference}}` : field?.value
  lines.push(`${pad}${name}: ${renderScalar(raw)}`)
}

/** A value as a YAML scalar that `parseUnityYaml` reads back unchanged. */
function renderScalar(value) {
  if (value === undefined || value === null) return "''"
  const text = String(value)
  if (text === '') return "''"
  if (/^[A-Za-z0-9_./+\-{}\s]+$/.test(text)) return text
  return JSON.stringify(text)
}

/** Render the overrides as a compact table the model can read at a glance. */
export function formatOverrides(result) {
  const lines = [`Prefab overrides: ${result.path} (live, ${result.overrides.length} override(s))`]
  if (result.overrides.length === 0) {
    lines.push('<no overrides: this instance matches its prefab exactly>')
    return lines.join('\n')
  }
  for (const override of result.overrides) {
    const target = override.target ?? '?'
    const field = override.property_path ?? '?'
    const value = override.object_reference ? `{${override.object_reference}}` : (override.value ?? '')
    let line = `- ${target} ${field} = ${value}`
    if (override.original_value !== undefined || override.original_object_reference !== undefined) {
      const original = override.original_object_reference ?? override.original_value ?? ''
      line += `  (prefab: ${original})`
    }
    lines.push(line)
  }
  return lines.join('\n')
}
