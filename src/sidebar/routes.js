// The right-Sidebar HTTP surface for Unity assets.
//
// The browser half of this plugin cannot open the broker itself: the broker is
// a Unix socket (or a Win32 named pipe) that only the Host process holds open,
// and the protocol is line-JSON over a raw byte stream. So every browser action
// becomes one fenced Host route here, and the route calls the same
// `src/sidebar/unity-asset.js` functions the `unity_*` tools share.
//
// Route map (all under `/locus/api`, all same-origin, all behind the
// browser-trust fence):
//
//   GET  status        connection + editor state for a Session's project
//   GET  asset         the property tree for one asset (no body)
//   POST asset/read    the same tree for one node of an already-open asset
//   POST asset/write   one SerializedProperty write (in-memory + dirty)
//   POST asset/save    persist that asset exactly as Locus saves an asset
//   POST asset/select  reveal the asset in Unity's Project window
//   GET  thumb         cached PNG thumbnail, ETag revalidated
//   GET  frame         cached PNG orbit frame for a prefab/model, ETag revalidated
//
// Nothing here trusts the browser's idea of the filesystem: a request names a
// project-relative `Assets/…` path, the Session names the project, and
// `paths.js` refuses everything else.

import { relative, resolve, sep } from 'node:path'

import { resolveProjectRoot } from '../args.js'
import { LocusError } from '../locus-client.js'
import { isReloading } from '../protocol.js'
import { normalizeAssetPath, assertInsideProject, isAssetApiPath, isEditableAssetPath, suffixOf } from './paths.js'
import {
  PngCache,
  assetVersion,
  editorStatus,
  etagOf,
  readNode,
  readSnapshot,
  readTree,
  subassetNodes,
  renderFrame,
  saveAsset,
  selectAsset,
  thumbnailPng,
  writeNode,
} from './unity-asset.js'

/** Route prefix; also the document-relative base the client fetches under. */
export const ROUTE_PREFIX = '/locus/api'
const MAX_BODY_BYTES = 1024 * 1024
/** Project resolution is a filesystem walk; a short cache keeps typing cheap. */
const PROJECT_CACHE_MS = 5_000

/**
 * Register the asset routes on a Host that has a web server.
 *
 * `webCtx` must carry `webServer`; the caller derives it through
 * `ctx.inject(['webServer'], …)` so a desktop Host without a web surface simply
 * never runs this.
 */
export function registerAssetRoutes(webCtx) {
  const png = new PngCache()
  const projectCache = new Map()
  const fences = {
    thumb: new Map(),
    frame: new Map(),
  }

  const fence = (req) => {
    const connection = webCtx.get('connection')
    if (!connection?.requestRejection) return false
    return connection.requestRejection(req) === undefined
  }

  /**
   * Resolve the Unity project for one Session id.
   *
   * The Session's working directory is the authority (the same value every
   * `unity_*` tool resolves from), so a Sidebar tab shows the project the
   * conversation is actually about.
   */
  /**
   * The Session's Unity project root and its workspace directory.
   *
   * `workspace` matters because a file address is relative to the Session's
   * working directory, not to the Unity project: a project checked out at
   * `<workspace>/unity-test` addresses a prefab as
   * `dsh-resource://file/session/<id>/unity-test/Assets/...`, and the panel has
   * to translate that back into an `Assets/…` path before the Host validation
   * (which speaks project-relative paths) will accept it. Resolving through the
   * session's own cwd is the only honest way to do that: a bare `Assets/x`
   * string is ambiguous the moment two projects could live under one workspace.
   */
  const projectOf = (sessionId) => {
    if (!sessionId) throw new HttpError(400, 'sessionId is required.')
    const cached = projectCache.get(sessionId)
    if (cached && Date.now() - cached.at < PROJECT_CACHE_MS) return cached
    const sessions = webCtx.get('sessions')
    const session = sessions?.get?.(sessionId)
    if (!session) throw new HttpError(404, `Unknown Session ${sessionId}.`)
    const workingDirectory = webCtx.get('workingDirectory')
    const agent = { session }
    let root
    try {
      root = resolveProjectRoot(undefined, { agent, workingDirectory })
    } catch (error) {
      throw new HttpError(409, String(error?.message ?? error))
    }
    // The session's own directory is where its file addresses are rooted.
    // `workingDirectory` is a service; a plain `cwd` on the record is the
    // fallback the Session store also carries.
    const workspace = workingDirectory?.get?.(session) ?? session?.header?.cwd ?? session?.cwd ?? root
    const record = { root, workspace }
    projectCache.set(sessionId, { ...record, at: Date.now() })
    return record
  }

  /**
   * Turn a browser-supplied address path into a project-relative `Assets/…` path.
   *
   * Two spellings are legitimate and both must work:
   *
   *   * `Assets/x.prefab` — the project is the Session's directory (the common
   *     case when the workspace *is* the Unity project);
   *   * `unity-test/Assets/x.prefab` — the project sits inside the workspace, so
   *     the file address carries the whole path from the Session's cwd.
   *
   * The second is resolved against the session workspace and then made relative
   * to the project root; anything that escapes that root is refused by
   * `normalizeAssetPath` as before.
   */
  const assetPathOf = (record, rawPath) => {
    const text = String(rawPath ?? '').replaceAll('\\', '/')
    if (text.startsWith('Assets/')) return text
    if (record.workspace && record.workspace !== record.root) {
      const absolute = resolve(record.workspace, text)
      const inside = relative(record.root, absolute)
      if (inside !== '' && !inside.startsWith('..')) return inside.split(sep).join('/')
    }
    return text
  }

  /**
   * Validate one request's `path` against its Session's project.
   *
   * A rejected path is a bad request (400), never a Unity failure: reporting it
   * as 500 would look like an editor problem and invite a retry.
   */
  const assetOf = (sessionId, rawPath) => {
    const record = projectOf(sessionId)
    const root = record.root
    rawPath = assetPathOf(record, rawPath)
    let path
    try {
      path = normalizeAssetPath(rawPath)
      assertInsideProject(root, path)
    } catch (error) {
      throw new HttpError(400, String(error?.message ?? error))
    }
    return { root, path }
  }

  const routes = [
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/status`,
      handler: async (req, res) => {
        if (!fence(req)) return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        if (req.method !== 'GET') return methodNotAllowed(res)
        try {
          const url = urlOf(req)
          const root = projectOf(url.searchParams.get('sessionId') ?? '').root
          const status = await editorStatus({ projectRoot: root })
          sendJson(res, 200, {
            ok: true,
            projectRoot: root,
            projectName: root.split(/[\\/]/).filter(Boolean).pop() ?? root,
            ...status,
          })
        } catch (error) {
          respondError(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/asset`,
      handler: async (req, res) => {
        if (!fence(req)) return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        if (req.method !== 'GET') return methodNotAllowed(res)
        try {
          const url = urlOf(req)
          const { root, path } = assetOf(url.searchParams.get('sessionId') ?? '', url.searchParams.get('path'))
          const subtree = url.searchParams.get('node')
          const version = assetVersion(root, path)
          const read = subtree
            ? await readSubtree(root, path, subtree)
            : await readTree({ projectRoot: root }, {
                path,
                // Depth is a *rows* budget, not a curiosity setting. A prefab in
                // a real project can hold a whole level: at depth 4 this asset
                // answers 4.6 MB, at depth 2 it is 1 MB and still shows every
                // object row. The panel expands a row by asking again
                // (`asset/read`), so a shallow root is the cheap, correct
                // default; `?depth=` stays available for a caller that wants more.
                maxDepth: numberParam(url, 'depth') ?? DEFAULT_UI_DEPTH,
                maxArrayItems: numberParam(url, 'items'),
              })
          // Some objects expose no visible serialized children through the
          // property tree: an `AnimatorController` keeps its layers, states and
          // transitions as *sub-assets*, and a model keeps its clips that way.
          // Locus' inspector shows them as the asset's own rows, so graft them
          // onto the root here — that is what makes such a file browsable.
          const withSubassets = attachSubassets(read.root, read.subassets)
          // When a file still has nothing to show, fall back to the flat
          // `asset_api` snapshot so the panel is not an empty box. Text-YAML
          // projects only: the flat reader refuses binary-serialized assets, and
          // that refusal is a fact about the project worth reporting, not hiding.
          let flat = null
          let flatError = null
          const noChildren = (withSubassets?.children ?? []).length === 0
          if (!subtree && noChildren && isAssetApiPath(path)) {
            try {
              flat = flattenSnapshot(await readSnapshot({ projectRoot: root }, { path }))
            } catch (error) {
              flat = null
              flatError = String(error?.message ?? error)
            }
          }
          sendJson(res, 200, {
            ok: true,
            path,
            projectRoot: root,
            version,
            editable: isEditableAssetPath(path),
            suffix: suffixOf(path),
            tree: withSubassets,
            target: read.target ?? null,
            subassets: read.subassets ?? [],
            flat,
            flatError,
          })
        } catch (error) {
          respondError(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/asset/read`,
      handler: async (req, res) => {
        if (!fence(req)) return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        if (req.method !== 'POST') return methodNotAllowed(res)
        try {
          const body = await readJsonBody(req)
          const { root, path } = assetOf(body.sessionId, body.path)
          const read = body.node
            ? await readNode({ projectRoot: root }, body.node, { maxDepth: body.depth, maxArrayItems: body.items })
            : await readTree({ projectRoot: root }, { path, maxDepth: body.depth, maxArrayItems: body.items })
          sendJson(res, 200, {
            ok: true,
            path,
            version: assetVersion(root, path),
            tree: read.root ?? read,
            target: read.target ?? null,
          })
        } catch (error) {
          respondError(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/asset/write`,
      handler: async (req, res) => {
        if (!fence(req)) return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        if (req.method !== 'POST') return methodNotAllowed(res)
        try {
          const body = await readJsonBody(req)
          const { root, path } = assetOf(body.sessionId, body.path)
          if (!body.node) throw new HttpError(400, 'node is required.')
          if (!('value' in body)) throw new HttpError(400, 'value is required.')
          const result = await writeNode({ projectRoot: root }, {
            path,
            node: body.node,
            value: body.value,
            mode: body.mode === 'preview' ? 'preview' : 'commit',
          })
          sendJson(res, 200, {
            ok: true,
            path,
            version: assetVersion(root, path),
            node: result.node,
            persisted: result.persisted,
            before: result.node?.beforeSnapshot ?? null,
          })
        } catch (error) {
          respondError(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/asset/save`,
      handler: async (req, res) => {
        if (!fence(req)) return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        if (req.method !== 'POST') return methodNotAllowed(res)
        try {
          const body = await readJsonBody(req)
          const { root, path } = assetOf(body.sessionId, body.path)
          const result = await saveAsset({ projectRoot: root }, { path })
          sendJson(res, 200, { ok: true, path, version: assetVersion(root, path), kind: result.kind ?? null })
        } catch (error) {
          respondError(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/asset/select`,
      handler: async (req, res) => {
        if (!fence(req)) return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        if (req.method !== 'POST') return methodNotAllowed(res)
        try {
          const body = await readJsonBody(req)
          const { root, path } = assetOf(body.sessionId, body.path)
          await selectAsset({ projectRoot: root }, { path })
          sendJson(res, 200, { ok: true, path })
        } catch (error) {
          respondError(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/thumb`,
      handler: async (req, res) => {
        if (!fence(req)) return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res)
        try {
          const url = urlOf(req)
          const { root, path } = assetOf(url.searchParams.get('sessionId') ?? '', url.searchParams.get('path'))
          const size = numberParam(url, 'size') ?? 256
          const version = url.searchParams.get('v') || assetVersion(root, path)
          const key = `thumb|${path}|${version}|${size}`
          let entry = png.get(key)
          if (!entry) {
            const image = await thumbnailPng({ projectRoot: root }, { path, maxSize: size })
            entry = { ...image, etag: etagOf(key, image.bytes), key }
            png.set(key, entry)
          }
          sendPng(req, res, entry)
        } catch (error) {
          respondError(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/frame`,
      handler: async (req, res) => {
        if (!fence(req)) return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res)
        try {
          const url = urlOf(req)
          const { root, path } = assetOf(url.searchParams.get('sessionId') ?? '', url.searchParams.get('path'))
          const params = {
            width: numberParam(url, 'w') ?? 480,
            height: numberParam(url, 'h') ?? 320,
            yaw: numberParam(url, 'yaw') ?? 25,
            pitch: numberParam(url, 'pitch') ?? -12,
            distance: numberParam(url, 'distance') ?? 1.15,
            panX: numberParam(url, 'panX') ?? 0,
            panY: numberParam(url, 'panY') ?? 0,
            panZ: numberParam(url, 'panZ') ?? 0,
          }
          const version = url.searchParams.get('v') || assetVersion(root, path)
          const key = `frame|${path}|${version}|${JSON.stringify(params)}`
          let entry = png.get(key)
          if (!entry) {
            const image = await renderFrame({ projectRoot: root }, { path, ...params })
            entry = { ...image, etag: etagOf(key, image.bytes), key }
            png.set(key, entry)
          }
          sendPng(req, res, entry)
        } catch (error) {
          respondError(res, error)
        }
      },
    },
  ]

  for (const route of routes) {
    webCtx.effect(() => webCtx.webServer.register(route), `dsh-locus-bridge: ${route.path}`)
  }

  // Route-scoped caches die with the registration.
  webCtx.effect(() => () => {
    png.clear()
    projectCache.clear()
    fences.thumb.clear()
    fences.frame.clear()
  })

  return routes.map((route) => route.path)
}

/**
 * Graft `property_tree_read`'s sub-assets onto the root as ordinary children.
 *
 * Returns the root unchanged when there is nothing to graft, so a caller can
 * always use the result as "the tree".
 */
export function attachSubassets(root, subassets) {
  const nodes = subassetNodes(subassets)
  if (!root || nodes.length === 0) return root
  return {
    ...root,
    children: [...(root.children ?? []), ...nodes],
    hasChildren: true,
  }
}

/**
 * Reduce a flat `asset_api` snapshot to what a summary table needs.
 *
 * A controller's snapshot is ~320 fields across 11 objects; the panel shows one
 * row per object with its class and field count, and every field as
 * `property → value` on expansion. Values stay strings: this view is a summary,
 * not an editor (the property tree is that).
 */
export function flattenSnapshot(snapshot) {
  const objects = Array.isArray(snapshot?.objects) ? snapshot.objects : []
  return {
    revision: String(snapshot?.revision ?? ''),
    capabilities: snapshot?.capabilities ?? null,
    diagnostics: Array.isArray(snapshot?.diagnostics) ? snapshot.diagnostics : [],
    objects: objects.map((object) => ({
      objectId: String(object?.object_id ?? ''),
      classId: object?.class_id == null ? null : String(object.class_id),
      rootType: String(object?.root_type ?? ''),
      fields: (Array.isArray(object?.fields) ? object.fields : []).map((field) => ({
        path: String(field?.property_path ?? ''),
        kind: String(field?.kind ?? ''),
        value: summarizeFieldValue(field?.value),
      })),
    })),
  }
}

/** One field's value as a short display string (objects/arrays included). */
function summarizeFieldValue(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.length}]`
  if (typeof value === 'object') {
    if (typeof value.value === 'string' && typeof value.kind === 'string') return `${value.value} (${value.kind})`
    try {
      const text = JSON.stringify(value)
      return text.length > 160 ? `${text.slice(0, 157)}…` : text
    } catch {
      return String(value)
    }
  }
  return String(value)
}

/**
 * Tree depth the panel opens with.
 *
 * Two levels is the asset's own objects plus their first fields — everything an
 * Inspector shows before a click. Deeper reads are one request per expanded row.
 */
const DEFAULT_UI_DEPTH = 2

/** Read one node's subtree from an `?node=` JSON blob (GET form of asset/read). */
async function readSubtree(root, path, encoded) {
  let node
  try {
    node = JSON.parse(encoded)
  } catch {
    throw new HttpError(400, 'node must be JSON.')
  }
  const read = await readNode({ projectRoot: root }, node, {})
  return { root: read, target: read?.target ?? null }
}

function urlOf(req) {
  return new URL(req.url ?? '/', 'http://dsh.internal')
}

function numberParam(url, name) {
  const raw = url.searchParams.get(name)
  if (raw === null || raw === '') return undefined
  const number = Number(raw)
  return Number.isFinite(number) ? number : undefined
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function sendPng(req, res, entry) {
  const headers = {
    'content-type': entry.mimeType || 'image/png',
    'content-length': entry.bytes.length,
    'cache-control': 'private, max-age=0, must-revalidate',
    etag: entry.etag,
    'x-content-type-options': 'nosniff',
  }
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304, headers)
    res.end()
    return
  }
  res.writeHead(200, headers)
  res.end(req.method === 'HEAD' ? undefined : entry.bytes)
}

function methodNotAllowed(res) {
  sendJson(res, 405, { ok: false, error: { code: 'method-not-allowed', message: 'method not allowed' } })
}

class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/**
 * Map a failure onto a status the panel can act on.
 *
 * A reloading editor is the common case that must not look permanent: the panel
 * keeps its data and shows "Unity is reloading", then retries.
 */
function respondError(res, error) {
  const message = String(error?.message ?? error)
  if (error instanceof HttpError) {
    sendJson(res, error.status, { ok: false, error: { code: `http_${error.status}`, message } })
    return
  }
  const code = error instanceof LocusError ? String(error.code ?? '') : ''
  if (isReloading(code) || /managed_reloading|managed_not_ready|main_thread_unresponsive/i.test(message)) {
    sendJson(res, 503, { ok: false, retryable: true, error: { code: 'unity_busy', message } })
    return
  }
  if (/locus_not_connected|ENOENT|ECONNREFUSED/i.test(message) || code === 'locus_not_connected') {
    sendJson(res, 503, { ok: false, retryable: true, error: { code: 'unity_unavailable', message } })
    return
  }
  if (/^revision_conflict|^dirty_asset|^persist_failed/i.test(message)) {
    sendJson(res, 409, { ok: false, error: { code: 'unity_conflict', message } })
    return
  }
  // A scene the editor does not have open is a state, not a failure: reading it
  // would require loading it (changing what the editor has open) and this panel
  // never does that. Report it as "not viewable right now" so the tab explains
  // itself instead of showing a red error box.
  if (/^scene is not loaded/i.test(message)) {
    sendJson(res, 409, { ok: false, error: { code: 'unity_scene_not_loaded', message } })
    return
  }
  // An asset that is not there is also a state. The panel prints the path and
  // says it disappeared, which is more useful than "internal error".
  if (/asset target not found|asset is not found|asset not found|^no asset at|not found at path/i.test(message)) {
    sendJson(res, 404, { ok: false, error: { code: 'unity_asset_missing', message } })
    return
  }
  if (/read only|unsupported_capability|inherited Prefab|not supported|cannot be edited/i.test(message)) {
    sendJson(res, 409, { ok: false, error: { code: 'unity_read_only', message } })
    return
  }
  sendJson(res, 500, { ok: false, error: { code: 'unity_error', message } })
}

/** Read a bounded JSON request body. */
export async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, 'request body is too large.')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    const value = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value
  } catch {
    throw new HttpError(400, 'request body must be a JSON object.')
  }
}
