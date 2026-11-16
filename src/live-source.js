// The live Unity Editor as a data source for the YAML tools.
//
// The YAML reader in `yaml-lite.js` parses the file on disk, which works with no
// Editor at all. That is the right default — most questions ("what does this
// prefab contain") are answered by the file. A value changed in the Editor and
// not yet saved is the exception, and upstream Locus answers it from the
// payload's own `read_yaml` message, so this module does the same rather than
// describing the object graph itself.
//
// `read_yaml` is the payload's tool: it walks the live object and returns text
// in the shape the Locus desktop shows, with a `[source: …]` banner naming the
// Editor. Handing that text through instead of re-rendering a property tree
// keeps one renderer for live values — Unity's — and one parser here.

import { isAbsolute, relative, resolve, sep } from 'node:path'

/** The payload message that reads one live scene/prefab object. */
export const LIVE_READ_MESSAGE = 'read_yaml'

/** A live read is local work; it should never need seconds. */
const LIVE_TIMEOUT_MS = 15_000

/** Extensions the payload's YAML tool accepts (`LocusBridge.ReadYaml.cs`). */
const LIVE_EXTENSIONS = new Set(['.unity', '.prefab'])

/**
 * Why a live read fell back to disk. These strings reach the user, so they say
 * what to do rather than what broke.
 */
export const LIVE_UNSUPPORTED = 'the payload has no read_yaml message, so live values need a newer Locus package'

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

/** Whether `object` names one document, which a live read requires. */
export function hasObjectSelector(object) {
  return object !== undefined && object !== null && String(object).trim() !== ''
}

/**
 * Read one object of one asset through the payload.
 *
 * The payload refuses scene/prefab reads without `object_path`, and refuses any
 * other extension; both are checked here so the fallback reason names the input
 * rather than Unity's tool contract.
 *
 * @returns {Promise<{ok: true, path: string, object: string, text: string} | {ok: false, reason: string}>}
 */
export async function readLiveObject(client, projectRoot, path, object, { depth = 2 } = {}) {
  if (!hasObjectSelector(object)) return { ok: false, reason: 'a live read needs an object selector' }
  const assetPath = assetPathOf(projectRoot, path)
  const extension = assetPath.slice(assetPath.lastIndexOf('.')).toLowerCase()
  if (!LIVE_EXTENSIONS.has(extension)) {
    return { ok: false, reason: `live values are only available for .unity and .prefab files, not ${extension || assetPath}` }
  }
  let envelope
  try {
    envelope = await client.request(
      LIVE_READ_MESSAGE,
      JSON.stringify({ file_path: assetPath, object_path: String(object).trim(), max_depth: depth }),
      { timeoutMs: LIVE_TIMEOUT_MS },
    )
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
  const text = String(envelope.message ?? '')
  // The payload reports tool failures inside a successful envelope.
  if (text.startsWith('__ERROR__: ')) return { ok: false, reason: text.slice('__ERROR__: '.length) }
  if (text.trim() === '') return { ok: false, reason: `the Editor returned nothing for ${assetPath}` }
  return { ok: true, path: assetPath, object: String(object).trim(), text }
}

/**
 * Collect the live text for `unity_yaml_read` / `unity_yaml_search`.
 *
 * Returns the `live` bundle those tools understand, or null when the caller
 * asked for disk or the Editor could not answer. A search over the same file
 * must see the live text too, otherwise it contradicts a live read of the same
 * asset.
 *
 * @returns {Promise<{live: object|null, reason: string|null}>}
 */
export async function liveSource(client, projectRoot, path, { depth = 2, object = null } = {}) {
  if (!client) return { live: null, reason: 'no Editor connection' }
  if (!hasObjectSelector(object)) {
    return { live: null, reason: 'live values need an object selector (fileID, class name, or "!u!<classId>")' }
  }
  const result = await readLiveObject(client, projectRoot, path, object, { depth })
  if (!result.ok) return { live: null, reason: result.reason }
  const texts = {}
  texts[result.path] = result.text
  return { live: { path: result.path, object: result.object, texts }, reason: null }
}
