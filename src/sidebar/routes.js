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
//   GET  settings      this plugin's feature switches and their effective state
//   POST settings      merge a switch patch and apply it to the live Host
//   GET  asset         the property tree for one asset (no body)
//   POST asset/read    the same tree for one node of an already-open asset
//   POST asset/write   one SerializedProperty write (in-memory + dirty)
//   POST asset/save    persist that asset exactly as Locus saves an asset
//   POST asset/select  reveal the asset in Unity's Project window
//   GET  thumb         cached PNG thumbnail, ETag revalidated
//   GET  frame         cached PNG orbit frame for a prefab/model, ETag revalidated
//   GET  model         raw `.fbx`/`.glb` bytes for the browser three.js viewer
//   GET  model-viewer.js  the lazily loaded three.js viewer bundle
//
// Nothing here trusts the browser's idea of the filesystem: a request names a
// project-relative `Assets/…` path, the Session names the project, and
// `paths.js` refuses everything else.

import { readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveProjectRoot } from '../args.js'
import { LocusError } from '../locus-client.js'
import { BROKER_ERRORS, isReloading } from '../protocol.js'
import { describeProject, listProjectCandidates } from '../projects.js'
import { installPackage, writeMarker, editorIsRunning } from '../setup.js'
import { FEATURE_KEYS, PREFERENCE_KEYS, readSettings, resolveFeatures, saveSettings, settingsPath } from '../settings.js'
import { readFrameCache, sourceMtimeMs, writeFrameCache } from './frame-cache.js'
import {
  normalizeAssetPath,
  assertInsideProject,
  isAssetApiPath,
  isEditableAssetPath,
  isWebModelPath,
  projectRootForAssetPath,
  suffixOf,
  webModelMimeType,
} from './paths.js'
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
/** Same ceiling as Locus' browser model viewer (25 MB). */
export const MODEL_VIEW_MAX_BYTES = 25 * 1024 * 1024
/** Built by `npm run build:viewer`; absent in a checkout that never ran it. */
export const MODEL_VIEWER_BUNDLE_PATH = fileURLToPath(new URL('../../lib/model-viewer.js', import.meta.url))
/** Project resolution is a filesystem walk; a short cache keeps typing cheap. */
const PROJECT_CACHE_MS = 5_000

/**
 * Register the asset routes on a Host that has a web server.
 *
 * `webCtx` must carry `webServer`; the caller derives it through
 * `ctx.inject(['webServer'], …)` so a desktop Host without a web surface simply
 * never runs this.
 */
export function registerAssetRoutes(webCtx, { env = process.env, onFeaturesChanged = null } = {}) {
  const png = new PngCache()
  const projectCache = new Map()
  const fences = {
    thumb: new Map(),
    frame: new Map(),
  }

  /**
   * Refuse an asset request while the preview plane is switched off.
   *
   * The tab is not registered at all in that state, so this only fires for a
   * tab that was already open when the switch flipped, or for a stale page
   * after a reload. Answering 409 with the switch named is what lets the panel
   * say "this feature is off" instead of painting a Unity failure.
   */
  const previewOff = (res) => {
    if (resolveFeatures(readSettings(env), env).preview) return false
    sendJson(res, 409, {
      ok: false,
      error: {
        code: 'feature_disabled',
        message: 'The Unity asset preview is switched off in Settings → dsh-locus-bridge.',
      },
    })
    return true
  }

  /**
   * Directories the project list scans.
   *
   * `?roots=` wins so the page can browse anywhere the user pointed it; a
   * `sessionId` falls back to that Session's workspace, which is the set the
   * conversation is actually about. Neither form accepts a path from the page
   * without it naming a real directory: `listProjectCandidates` skips the rest.
   */
  const projectRootsFor = (url) => {
    const explicit = (url.searchParams.get('roots') ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
    if (explicit.length > 0) return explicit
    const sessionId = url.searchParams.get('sessionId') ?? ''
    if (sessionId) {
      const record = projectOf(sessionId)
      // A Session whose workspace *is* the project still gets that one row.
      return [...new Set([record.workspace, record.root].filter(Boolean))]
    }
    // No Session and no explicit roots: fall back to the workspaces the Host
    // itself has registered. This is the case a Settings page hit, which has no
    // Session of its own — and reading the registry is far better than asking
    // the page to guess a path it cannot know.
    const registry = webCtx.get('workspaceRegistry')
    try {
      const workspaces = registry?.list?.() ?? []
      return workspaces.map((workspace) => workspace?.path).filter(Boolean)
    } catch {
      return []
    }
  }

  /**
   * Whether a rendered frame may be written into the user's Unity project.
   *
   * Off means the panel still caches in memory for the life of the route, but
   * never creates `Library/Locus/asset-preview-cache`; that is the difference
   * browsing is allowed to make to a project the user did not hand over.
   */
  const frameCacheEnabled = (targetEnv) => readSettings(targetEnv).preferences.frameCache === true

  /**
   * Where the settings document lives, for the page to display.
   *
   * Reported, never trusted: the browser names no path for it, exactly like the
   * asset routes above.
   */
  const settingsPathFor = (targetEnv) => settingsPath(targetEnv)

  const fence = (req) => {
    const connection = webCtx.get('connection')
    if (!connection?.requestRejection) return false
    return connection.requestRejection(req) === undefined
  }

  /**
   * The Session's Unity project root (when it has exactly one) and its
   * workspace directory.
   *
   * The Session's working directory is the authority (the same value every
   * `unity_*` tool resolves from), so a Sidebar tab shows the project the
   * conversation is actually about.
   *
   * `workspace` matters because a file address is relative to the Session's
   * working directory, not to the Unity project: a project checked out at
   * `<workspace>/unity-test` addresses a prefab as
   * `dsh-resource://file/session/<id>/unity-test/Assets/...`, and the panel has
   * to translate that back into an `Assets/…` path before the Host validation
   * (which speaks project-relative paths) will accept it. Resolving through the
   * session's own cwd is the only honest way to do that: a bare `Assets/x`
   * string is ambiguous the moment two projects could live under one workspace.
   *
   * `root` is **null** when the workspace holds more than one Unity project:
   * that is a normal layout (a game and a simulation side by side), not an
   * error worth failing every request over. `rootError` keeps the explanation
   * so a request that has no path to disambiguate can still report it.
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
    let root = null
    let rootError = null
    try {
      root = resolveProjectRoot(undefined, { agent, workingDirectory })
    } catch (error) {
      rootError = String(error?.message ?? error)
    }
    // The session's own directory is where its file addresses are rooted.
    // `workingDirectory` is a service; a plain `cwd` on the record is the
    // fallback the Session store also carries.
    const workspace = workingDirectory?.get?.(session) ?? session?.header?.cwd ?? session?.cwd ?? root
    const record = { root, workspace, rootError }
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
   * The project a browser-supplied path belongs to, with the path made relative
   * to it.
   *
   * `projectOf` answers "which project is this Session about?", which has no
   * single answer when the workspace holds more than one Unity project: it
   * throws and names the candidates (`src/args.js`), and a workspace with a game
   * and a simulation side by side is a real layout, not a mistake. A click in
   * the Sidebar *does* have an answer — the file address names the file, and the
   * file lives in exactly one project — so that project wins whenever it can be
   * found. The Session-based resolution stays the fallback for every path that
   * does not sit inside a project (a stale address, a deleted checkout), which
   * is also where its diagnostics are worth showing.
   */
  const projectForPath = (sessionId, rawPath) => {
    const record = projectOf(sessionId)
    const fromPath = projectRootForAssetPath(record.workspace, rawPath)
    if (!fromPath) {
      // No project named by the path: fall back to the Session's own project,
      // and when even that is ambiguous the explanation is the answer.
      if (!record.root) throw new HttpError(409, record.rootError ?? 'This Session does not resolve to one Unity project.')
      return { ...record, path: assetPathOf(record, rawPath) }
    }
    const absolute = resolve(record.workspace, String(rawPath ?? '').replaceAll('\\', '/'))
    const inside = relative(fromPath, absolute)
    // The path must really be below the project it named; anything else falls
    // back rather than silently widening what the browser may touch.
    const path = inside === '' || inside.startsWith('..') ? assetPathOf(record, rawPath) : inside.split(sep).join('/')
    return { ...record, root: fromPath, path }
  }

  /**
   * Validate one request's `path` against its Session's project.
   *
   * A rejected path is a bad request (400), never a Unity failure: reporting it
   * as 500 would look like an editor problem and invite a retry.
   */
  const assetOf = (sessionId, rawPath) => {
    const record = projectForPath(sessionId, rawPath)
    const root = record.root
    let path
    try {
      path = normalizeAssetPath(record.path)
      assertInsideProject(root, path)
    } catch (error) {
      throw new HttpError(400, String(error?.message ?? error))
    }
    return { root, path }
  }

  const routes = [
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/settings`,
      handler: async (req, res) => {
        if (!fence(req)) return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        const stored = readSettings(env)
        if (req.method === 'GET') {
          sendJson(res, 200, {
            ok: true,
            features: { ...stored.features },
            effective: { ...resolveFeatures(stored, env) },
            preferences: { ...stored.preferences },
            // The UI has to be able to explain a switch that refuses to move.
            // `csharp` is the one plane another owner can pin off.
            locked: {
              csharp: stored.features.csharp && !resolveFeatures(stored, env).csharp,
            },
            path: settingsPathFor(env),
          })
          return
        }
        if (req.method !== 'POST') return methodNotAllowed(res)
        try {
          const body = await readJsonBody(req)
          if (!isSwitchPatch(body)) {
            throw new HttpError(400, `features and preferences may only carry the keys ${FEATURE_KEYS.join(', ')} and booleans.`)
          }
          const saved = saveSettings({ features: body.features, preferences: body.preferences }, env)
          // The Host tool set follows the same notification the tools register
          // on, so a failed re-registration must be reported here instead of
          // leaving the page claiming a state the process does not have.
          try {
            onFeaturesChanged?.(resolveFeatures(saved, env))
          } catch (error) {
            throw new HttpError(500, `saved, but applying it failed: ${error?.message ?? error}`)
          }
          sendJson(res, 200, {
            ok: true,
            features: { ...saved.features },
            effective: { ...resolveFeatures(saved, env) },
            preferences: { ...saved.preferences },
            locked: { csharp: saved.features.csharp && !resolveFeatures(saved, env).csharp },
            path: settingsPathFor(env),
          })
        } catch (error) {
          respondError(res, error)
        }
      },
    },
    {
      // Which Unity projects exist near a Session, and whether the bridge can
      // reach each one.
      //
      // The roots come from the caller because this plugin has no global
      // "where are all the projects" knowledge: `GET ?sessionId=` resolves the
      // Session's own project set, `?roots=a,b` names directories explicitly.
      // Either way every row is a real directory probe, never a guess.
      kind: 'exact',
      path: `${ROUTE_PREFIX}/projects`,
      handler: async (req, res) => {
        if (!fence(req)) return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        if (req.method !== 'GET') return methodNotAllowed(res)
        try {
          const url = urlOf(req)
          const roots = projectRootsFor(url)
          const candidates = listProjectCandidates(roots)
          // Sequential on purpose: each row opens a socket. Firing twenty at once
          // would be a burst of connection attempts against one editor, which is
          // exactly the shape of a port scan to anything watching.
          const projects = []
          for (const root of candidates) {
            try {
              projects.push(await describeProject(root, { env }))
            } catch (error) {
              // One unreadable project must not blank the whole list.
              projects.push({ projectRoot: root, name: root.split(/[\\/]/).pop(), state: 'unknown', error: String(error?.message ?? error) })
            }
          }
          sendJson(res, 200, { ok: true, roots, projects })
        } catch (error) {
          respondError(res, error)
        }
      },
    },
    {
      // Install the bundled Locus package into one project.
      //
      // Refuses while the editor holds the project open — that is `installPackage`'s
      // own guard, surfaced here as a 409 the page can explain, not a 500. The
      // page must follow this up by telling the user to reopen the editor: this
      // plugin never launches Unity.
      kind: 'exact',
      path: `${ROUTE_PREFIX}/projects/install`,
      handler: async (req, res) => {
        if (!fence(req)) return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        if (req.method !== 'POST') return methodNotAllowed(res)
        try {
          const body = await readJsonBody(req)
          const root = String(body.projectRoot ?? '').trim()
          if (!root) throw new HttpError(400, 'projectRoot is required.')
          // Only a path that is already a project this list would show is
          // installable: the button must not become an arbitrary-tree copier.
          const known = listProjectCandidates([root])
          if (!known.includes(resolve(root))) {
            throw new HttpError(400, `${root} is not a Unity project (expected Assets/ and ProjectSettings/).`)
          }
          if (editorIsRunning(root)) {
            sendJson(res, 409, {
              ok: false,
              error: {
                code: 'editor_running',
                message:
                  'The Unity Editor has this project open and holds the package assemblies. ' +
                  'Close the editor, install, then reopen it.',
              },
            })
            return
          }
          const installed = installPackage(root)
          // The marker is what makes the editor start the native bridge. An
          // install without it is the exact state `not_connected` reports, so
          // writing it here means a reopened editor actually connects.
          const marker = writeMarker(root)
          sendJson(res, 200, {
            ok: true,
            projectRoot: resolve(root),
            installed,
            marker,
            next: 'Reopen the Unity Editor: the bridge starts on launch once the marker is present.',
          })
        } catch (error) {
          respondError(res, error)
        }
      },
    },
    {
      kind: 'exact',
      path: `${ROUTE_PREFIX}/status`,
      handler: async (req, res) => {
        if (!fence(req)) return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        if (previewOff(res)) return
        if (req.method !== 'GET') return methodNotAllowed(res)
        try {
          const url = urlOf(req)
          const sessionId = url.searchParams.get('sessionId') ?? ''
          const hint = url.searchParams.get('path')
          // The panel asks for status for the tab it is showing, so the asset
          // path disambiguates a workspace holding more than one project. Without
          // one, a Session that resolves to no single project reports "no
          // project" instead of failing the whole tab.
          const record = projectOf(sessionId)
          const root = hint ? assetOf(sessionId, hint).root : record.root
          if (!root) {
            sendJson(res, 200, {
              ok: true,
              projectRoot: null,
              projectName: null,
              connected: false,
              status: 'disconnected',
              reason: record.rootError ?? 'This Session does not resolve to one Unity project.',
            })
            return
          }
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
        if (previewOff(res)) return
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
        if (previewOff(res)) return
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
        if (previewOff(res)) return
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
        if (previewOff(res)) return
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
        if (previewOff(res)) return
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
      // The browser half loads this only when a `.fbx`/`.glb` is opened, so
      // three.js stays out of the main DSH client bundle.
      kind: 'exact',
      path: `${ROUTE_PREFIX}/model-viewer.js`,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res)
        let bytes
        try {
          bytes = readFileSync(MODEL_VIEWER_BUNDLE_PATH)
        } catch {
          sendJson(res, 503, {
            ok: false,
            error: {
              code: 'model_viewer_missing',
              message: 'The model viewer bundle is not built. Run `npm run build:viewer`.',
            },
          })
          return
        }
        const etag = etagOf('model-viewer', bytes)
        const headers = {
          'content-type': 'text/javascript; charset=utf-8',
          'content-length': bytes.length,
          'cache-control': 'no-cache',
          etag,
          'x-content-type-options': 'nosniff',
        }
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304, headers)
          res.end()
          return
        }
        res.writeHead(200, headers)
        res.end(req.method === 'HEAD' ? undefined : bytes)
      },
    },
    {
      // Raw bytes for one `.fbx`/`.glb`. The client fetches this into an
      // ArrayBuffer and hands it to the lazily loaded three.js viewer; no file
      // path ever comes from the browser and no bytes leave the project.
      kind: 'exact',
      path: `${ROUTE_PREFIX}/model`,
      handler: async (req, res) => {
        if (!fence(req)) return sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
        if (previewOff(res)) return
        if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res)
        try {
          const url = urlOf(req)
          const { root, path } = assetOf(url.searchParams.get('sessionId') ?? '', url.searchParams.get('path'))
          if (!isWebModelPath(path)) {
            throw new HttpError(400, 'The browser model viewer only accepts .fbx and .glb paths.')
          }
          const absolute = join(root, path)
          let info
          try {
            info = statSync(absolute)
          } catch {
            throw new HttpError(404, `Model was not found: ${path}`)
          }
          if (!info.isFile()) throw new HttpError(404, `Model was not found: ${path}`)
          if (info.size > MODEL_VIEW_MAX_BYTES) {
            throw new HttpError(413, `Model is larger than ${Math.trunc(MODEL_VIEW_MAX_BYTES / (1024 * 1024))} MB.`)
          }
          const etag = `"m-${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`
          if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { etag })
            res.end()
            return
          }
          const bytes = readFileSync(absolute)
          res.writeHead(200, {
            'content-type': webModelMimeType(path),
            'content-length': bytes.length,
            'cache-control': 'private, max-age=0, must-revalidate',
            etag,
            'x-content-type-options': 'nosniff',
          })
          res.end(req.method === 'HEAD' ? undefined : bytes)
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
        if (previewOff(res)) return
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
        if (previewOff(res)) return
        if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res)
        try {
          const url = urlOf(req)
          const { root, path } = assetOf(url.searchParams.get('sessionId') ?? '', url.searchParams.get('path'))
          const mtime = sourceMtimeMs(root, path)

          // `restore=1` is what the panel asks on mount: give it the last frame
          // written by a previous session, including the camera that produced
          // it. A miss is a normal state, not an error the panel should paint.
          //
          // With the disk cache switched off there is nothing to restore from:
          // reporting a miss (rather than reading a file the user asked us not
          // to keep) is what makes the switch mean what it says.
          if (url.searchParams.get('restore') === '1') {
            const cached =
              mtime === null || !frameCacheEnabled(env)
                ? null
                : readFrameCache(root, path, { expectedMtimeMs: mtime })
            if (!cached) {
              sendJson(res, 404, {
                ok: false,
                error: { code: 'frame_cache_miss', message: 'No cached preview frame for this asset.' },
              })
              return
            }
            const key = `frame|restore|${path}|${mtime}`
            const entry = { bytes: cached.bytes, mimeType: cached.mimeType, etag: etagOf(key, cached.bytes), key }
            sendPng(req, res, entry, frameHeaders(cached, 'cache'))
            return
          }

          const params = {
            width: numberParam(url, 'w') ?? 480,
            height: numberParam(url, 'h') ?? 360,
            yaw: numberParam(url, 'yaw') ?? 25,
            pitch: numberParam(url, 'pitch') ?? -12,
            distance: numberParam(url, 'distance') ?? 1.15,
            panX: numberParam(url, 'panX') ?? 0,
            panY: numberParam(url, 'panY') ?? 0,
            panZ: numberParam(url, 'panZ') ?? 0,
          }
          const version = url.searchParams.get('v') || assetVersion(root, path)
          const persist = url.searchParams.get('cache') !== '0'
          const key = `frame|${path}|${version}|${JSON.stringify(params)}`
          let entry = png.get(key)
          let source = 'cache'
          if (!entry) {
            const cached =
              mtime === null || !frameCacheEnabled(env)
                ? null
                : readFrameCache(root, path, { expectedMtimeMs: mtime, params })
            if (cached) {
              entry = { bytes: cached.bytes, mimeType: cached.mimeType, etag: etagOf(key, cached.bytes), key }
              source = 'cache'
            } else {
              const image = await renderFrame({ projectRoot: root }, { path, ...params })
              entry = { ...image, etag: etagOf(key, image.bytes), key }
              source = 'render'
            }
            png.set(key, entry)
          }
          // A drag frame may already sit in the in-memory cache under the same
          // key as the settle frame. Persist on the settle request even when no
          // editor render was needed, or the disk would keep an older angle.
          //
          // The disk cache is a *project* write (it lives under Library/), so it
          // is the one thing the `frameCache` preference governs: with it off the
          // in-memory cache still answers, but browsing never adds files.
          if (persist && mtime !== null && frameCacheEnabled(env)) {
            try {
              writeFrameCache(root, path, { ...entry, ...params })
            } catch {
              // Best effort, exactly like Locus' cache.
            }
          }
          sendPng(req, res, entry, frameHeaders({ ...params, ...entry }, source))
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

/** Path of one field's value in a settings patch; only booleans are writable. */
function isSwitchPatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false
  for (const key of Object.keys(body)) {
    if (key !== 'features' && key !== 'preferences') return false
  }
  const sections = [body.features, body.preferences]
  for (const section of sections) {
    if (section === undefined) continue
    if (!section || typeof section !== 'object' || Array.isArray(section)) return false
    for (const value of Object.values(section)) {
      if (typeof value !== 'boolean') return false
    }
  }
  // A patch that only names keys outside the known set would silently do
  // nothing, which reads as "the switch is broken" in the UI — so an unknown
  // key in either section is a bad request, not a no-op.
  for (const key of Object.keys(body.features ?? {})) {
    if (!FEATURE_KEYS.includes(key)) return false
  }
  for (const key of Object.keys(body.preferences ?? {})) {
    if (!PREFERENCE_KEYS.includes(key)) return false
  }
  return true
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

/**
 * Camera headers that accompany one preview frame.
 *
 * The panel uses these when restoring a cached frame: the PNG alone cannot say
 * which yaw/pitch/distance produced it, and guessing would make the first drag
 * jump. They are also useful in a HAR when diagnosing a stale preview.
 */
function frameHeaders(frame, source) {
  const number = (key, fallback) => {
    const value = Number(frame?.[key])
    return Number.isFinite(value) ? value : fallback
  }
  return {
    'x-locus-frame-yaw': String(number('yaw', 25)),
    'x-locus-frame-pitch': String(number('pitch', -12)),
    'x-locus-frame-distance': String(number('distance', 1.15)),
    'x-locus-frame-pan-x': String(number('panX', 0)),
    'x-locus-frame-pan-y': String(number('panY', 0)),
    'x-locus-frame-pan-z': String(number('panZ', 0)),
    'x-locus-frame-source': source,
  }
}

function sendPng(req, res, entry, extraHeaders) {
  const headers = {
    'content-type': entry.mimeType || 'image/png',
    'content-length': entry.bytes.length,
    'cache-control': 'private, max-age=0, must-revalidate',
    etag: entry.etag,
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
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
  // "The editor is not there" is a state, not a failure of this request: the
  // panel must offer a retry and keep whatever it already shows. The client
  // connection failure carries `managed_not_ready` (a disabled editor is not a
  // reload, so `isReloading` says no) and its message speaks of pipes and
  // sockets, which is why matching the text alone missed it and every read
  // became a red 500.
  if (code === BROKER_ERRORS.MANAGED_NOT_READY || /locus_not_connected|ENOENT|ECONNREFUSED|EPERM|EACCES/i.test(message)) {
    sendJson(res, 503, { ok: false, retryable: true, error: { code: 'unity_unavailable', message } })
    return
  }
  if (isReloading(code) || /managed_reloading|managed_not_ready|main_thread_unresponsive/i.test(message)) {
    sendJson(res, 503, { ok: false, retryable: true, error: { code: 'unity_busy', message } })
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
