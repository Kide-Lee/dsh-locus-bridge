// Per-workspace pool of Roslyn language-server processes.
//
// Mirrors `Locus/src-tauri/src/csharp_lsp/mod.rs`: each active checkout owns one
// server process, spawned lazily, retained while used, and closed after an idle
// timeout. Two differences, both because this client is a single process
// serving one DSH session rather than a multi-checkout desktop app:
//
//   * capacity is one server per workspace with a global cap, instead of a
//     lease/reaper task per checkout;
//   * `-32601`-class protocol drift is retried by restarting the connection
//     once, because the only failure mode a user can recover from without
//     reading logs is a fresh process.
//
// Queries retry the specific "analysis not ready" error (-32800) instead of
// surfacing it: the server answers a position or symbol query issued before its
// semantic analysis settles with that code, and it resolves on its own within a
// few seconds.

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { installAssets, requireAssets, assetsRoot } from './assets.js'
import { removeAnalyzerProps, unityAnalyzerPath, writeAnalyzerProps } from './analyzer-injection.js'
import { watchWorkspace } from './file-watch.js'
import {
  LspConnection,
  LspConnectionError,
  LspResponseError,
  FILE_DELETED,
  REQUEST_CANCELLED,
} from './lsp-client.js'
import {
  connectedEditor,
  ensureProjectFiles,
  ensureRestored,
  fileInProject,
  findProjectTargets,
  newestSourceFile,
  projectFilesStale,
  projectIsRestored,
  readProjectIncludes,
  refreshProjectFiles,
  sourcesMissingFromProjects,
} from './project-sync.js'
import { forgetTrackedSource, forgetTrackedSources, trackedSources } from './source-tracker.js'

/** How long a load may take before the workspace is declared unusable.
 * Matches upstream `PROJECT_LOAD_TIMEOUT` (600 s). */
const PROJECT_LOAD_TIMEOUT_MS = 600_000
/** How long one query may sit in "not ready" before giving up.
 * Matches upstream `QUERY_READY_TIMEOUT` (75 s). */
const QUERY_READY_TIMEOUT_MS = 75_000
const READY_POLL_MS = 750
/**
 * Grace period covering the very first `workspace/symbol` on a fresh server.
 *
 * The index fills in just after `projectInitializationComplete`, so an empty
 * answer inside this window may mean "not indexed yet" rather than "no such
 * symbol". It is consumed by the first lookup rather than by elapsed time: once
 * one query has returned symbols the workspace is proven warm, and a genuinely
 * absent symbol afterwards must not wait.
 */
const SYMBOL_WARMUP_MS = 8_000
/**
 * Project files opened with the injected analyzers.
 *
 * Opening a project document makes the server re-evaluate it, so this is the
 * point where a large solution starts paying for its analyzers. The cap keeps a
 * 100-project checkout from spending its first query on bookkeeping; the
 * projects past it still analyze, they just carry only the analyzers Unity
 * generated for them.
 */
const MAX_LSP_PROJECT_DOCUMENTS = 48
/** Idle time after which a server process is closed.
 * Matches upstream's default `lsp_idle_timeout_secs` (600 s). */
const IDLE_TIMEOUT_MS = 600_000
/**
 * Workspace servers are not capacity-capped upstream either
 * ("Other checkouts do not impose a capacity limit; unused servers expire
 * through the idle policy"), but a DSH session is process-local and a cap keeps
 * a runaway caller from holding several .NET heaps open. The cap is generous
 * enough that normal multi-project use never evicts a live server.
 */
const MAX_WORKSPACES = 8
const REAPER_INTERVAL_MS = 60_000

/** A workspace could not be prepared for analysis. */
export class CsharpWorkspaceError extends Error {
  constructor(message, { code = null } = {}) {
    super(message)
    this.name = 'CsharpWorkspaceError'
    this.code = code
  }
}

/**
 * How soon a file change may trigger the next workspace reload.
 *
 * A prefab resave or an IDE formatting pass rewrites dozens of files in one
 * burst; reloading a large solution costs seconds (minutes when restore runs),
 * so reloads are coalesced instead of queued one per event.
 */
const RESTART_MIN_INTERVAL_MS = 5_000
/** Changes that invalidate the loaded solution, not just one document. */
// `Directory.Build.props` is in here on purpose: the analyzer list it carries is
// read by MSBuild, so rewriting it (or removing it) invalidates the loaded
// projects exactly like a csproj edit does.
// `Directory.Build.props` is in here on purpose: the analyzer list it carries is
// read by MSBuild, so writing or removing it invalidates the loaded projects
// exactly like a csproj edit does. `refreshProjectFiles` then sees no stale
// project files and keeps the running server, which is what we want — the
// write happens before the next load, not after this one.
const PROJECT_BEARING_EXTENSIONS = ['.cs', '.csproj', '.sln', '.asmdef', '.asmref', '.props', '.rsp']

/** workspace root → { connection, project, lastUsed, starting, watch, restart } */
const pool = new Map()
let reaper = null

/**
 * Download progress for the install currently in flight, or `null`.
 *
 * The first query in a profile can spend minutes fetching ~90 MB. Upstream
 * shows this as `downloading server 37%` in its status bar; a tool call has no
 * such channel, so the status is recorded here and `runQuery` appends it to
 * whatever the tool returns.
 */
let downloadStatus = null
const downloadListeners = new Set()

function forwardDownload({ received, total }) {
  const bytes = Number(received) || 0
  const size = Number(total) || null
  downloadStatus = {
    percent: size !== null && size > 0 ? Math.min(100, Math.floor((bytes * 100) / size)) : null,
    received: bytes,
    total: size,
  }
  for (const listener of downloadListeners) {
    try {
      listener(downloadStatus)
    } catch {
      // A listener that throws must not break the transfer.
    }
  }
}

/**
 * Observe download progress. Returns an unsubscribe function and the latest
 * status seen, which may already be `null` when nothing is downloading.
 */
export function watchDownload(listener) {
  downloadListeners.add(listener)
  return () => downloadListeners.delete(listener)
}

/** Human-readable transfer progress, or an empty string when nothing ran. */
export function formatDownloadStatus(status) {
  if (!status) return ''
  if (status.percent === null) return `downloaded ${megabytes(status.received)}`
  return `downloaded ${status.percent}% (${megabytes(status.received)} of ${megabytes(status.total)})`
}

function megabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function normalizeRoot(root) {
  return String(root ?? '').replaceAll('\\', '/').replace(/\/+$/, '')
}

function touch(entry) {
  entry.lastUsed = Date.now()
}

function startReaper() {
  if (reaper) return
  reaper = setInterval(() => {
    const cutoff = Date.now() - IDLE_TIMEOUT_MS
    for (const [key, entry] of pool) {
      if (entry.starting || !entry.connection) continue
      if (entry.lastUsed > cutoff) continue
      // Async and must never reject into the timer.
      Promise.resolve(disposeEntry(key, entry)).catch(() => {})
    }
  }, REAPER_INTERVAL_MS)
  // A DSH session ending must not keep the process alive waiting for the timer.
  reaper.unref?.()
}

/** Count of live workspace servers plus their open documents. */
export function poolStatus() {
  const entries = []
  for (const [workspace, entry] of pool) {
    entries.push({
      workspace,
      connected: Boolean(entry.connection?.connected),
      loaded: Boolean(entry.connection?.loaded),
      openDocuments: entry.connection?.openDocumentCount ?? 0,
      project: entry.project ?? null,
      watchedDirectories: entry.watch?.directories ?? 0,
      lastRestart: entry.lastRestart ?? null,
      analyzerProps: entry.analyzerProps ?? null,
      idleMs: Date.now() - entry.lastUsed,
    })
  }
  return { workspaces: entries.length, maxWorkspaces: MAX_WORKSPACES, entries }
}

/**
 * Release everything a pool entry owns and forget it.
 *
 * Closing a connection alone is not enough: the file watcher would keep the
 * directory handles open and a pending restart would resurrect the workspace
 * the caller just asked to drop.
 */
async function disposeEntry(key, entry) {
  pool.delete(key)
  entry.restart?.cancel?.()
  entry.watch?.close?.()
  forgetTrackedSources(key)
  await Promise.resolve(entry.connection?.close?.()).catch(() => {})
  // Leave the user's project tree as we found it (upstream `shutdown`).
  removeAnalyzerProps(key)
}

/** Close one workspace or every workspace. */
export async function shutdownCsharpPool({ workspace = null } = {}) {
  const targets = workspace ? [normalizeRoot(workspace)] : [...pool.keys()]
  const closed = []
  for (const key of targets) {
    const entry = pool.get(key)
    if (!entry) continue
    await disposeEntry(key, entry)
    closed.push(key)
  }
  return closed
}

/**
 * Regenerate the project files and reload the workspace on its next use.
 *
 * Exposed for the query layer: a file the generated project set does not list
 * is invisible to the server, and the only fix is a regeneration followed by a
 * reload. Callers stay oblivious to the mechanism and just retry later.
 */
export function scheduleProjectRefresh(root, reason = null) {
  const key = normalizeRoot(root)
  if (!pool.has(key)) return
  scheduleRestart(key, reason ? `a source file is missing from the project files (${reason})` : 'project files are stale')
}

/**
 * File changes the language server has to be told about.
 *
 * This is upstream's `start_file_watcher` equivalent: the server follows
 * `workspace/didChangeWatchedFiles` for files it did not open, and the client
 * keeps its own bookkeeping in step for the ones it did.
 *   * an open document changed → re-open it, so the server holds the new text
 *     instead of a stale snapshot (this plugin reads every file from disk, so
 *     the snapshot is the only copy either side could disagree about);
 *   * a `.cs` file in watched folders changed or appeared, or the project
 *     files / assembly definitions changed → the loaded solution no longer
 *     describes the code on disk, so it is rebuilt after a debounce;
 *   * a file that vanished is closed, so its last snapshot cannot shadow the
 *     deletion.
 */
/** Absolute paths compare equal only after the separators and trailing slash agree. */
function normalizePath(path) {
  return String(path).replaceAll('\\', '/').replace(/\/+$/, '')
}

function applyFileChanges(key, entry, changes) {
  const connection = entry.connection
  // The analyzer props file is written by this plugin on every load. Writing it
  // is not a change to the user's project, and reacting to it would reload the
  // server it was written for.
  const ownProps = entry.analyzerProps?.ok ? normalizePath(entry.analyzerProps.path) : null
  const projectBearing = []
  for (const [rawPath, kind] of changes) {
    if (ownProps && normalizePath(rawPath) === ownProps) continue
    const lower = String(rawPath).toLowerCase()
    if (kind === FILE_DELETED) {
      connection?.closeDocument?.(rawPath)
    } else if (connection?.isOpen?.(rawPath)) {
      try {
        connection.syncDocument(rawPath)
      } catch {
        // Deleted between the event and the read; the delete path handles it.
      }
    }
    if (PROJECT_BEARING_EXTENSIONS.some((extension) => lower.endsWith(extension))) projectBearing.push(rawPath)
  }
  try {
    connection?.notifyWatchedFiles?.(changes)
  } catch {
    // A dead connection reports itself when the next query reopens it.
  }
  if (projectBearing.length > 0) scheduleRestart(key, restartReason(projectBearing))
}

/** A short phrase naming what triggered a reload, like upstream's sync reason. */
function restartReason(paths) {
  const first = paths[0] ?? ''
  return `watched file change (${paths.length} file${paths.length === 1 ? '' : 's'}: ${first})`
}

/**
 * Whether the generated project files no longer describe the sources on disk.
 *
 * Sources an earlier answer named but no project compiles are the case an mtime
 * comparison misses (Unity skips a script it has not imported, so the
 * `.csproj` can be newer than every source and still omit one).
 */
function projectStale(root) {
  const existing = findProjectTargets(root)
  if (!existing.solution && existing.projects.length === 0) return false
  if (sourcesMissingFromProjects(root, trackedSources(root))) return true
  return projectFilesStale(existing.scannedAt, newestSourceFile(root))
}

/**
 * The broker target a reload should regenerate through.
 *
 * A workspace opened by a plain `code_*` query has no target (the tool takes
 * only a project path), so the first load cannot reach an editor even when one
 * is connected — and without a target the only regeneration path is a headless
 * Unity run. The plugin's own pool usually holds a connection to the editor by
 * the time a reload runs (the editor tools use it), so it is adopted here; a
 * caller-supplied `unityExecutable` produces a target directly, because the
 * headless generator needs nothing else.
 */
function editorTargetFor(root, known, unityExecutable) {
  if (known) return known
  try {
    const connected = connectedEditor(root)
    if (connected) return connected
  } catch {
    // A broken pipe description must not stop the reload.
  }
  return unityExecutable ? { projectRoot: root, unityExecutable } : null
}

/**
 * Reload a workspace whose project files no longer match the sources.
 *
 * Coalesced (`RESTART_MIN_INTERVAL_MS`) and routed through `entry.starting`, so
 * a reload that takes minutes is awaited by the next query instead of racing
 * it — the same shape as the initial load.
 */
function scheduleRestart(key, reason) {
  const entry = pool.get(key)
  if (!entry) return
  entry.restart ??= createRestartScheduler(key)
  entry.restart.schedule(reason)
}

function createRestartScheduler(key) {
  let timer = null
  let lastRun = 0
  let pendingReason = null
  /** Set while a reload is waiting for the current load to finish. */
  let queued = false

  const beginLoad = (entry) => {
    entry.starting = startWorkspace(key, entry, {
      target: entry.target ?? null,
      unityExecutable: entry.unityExecutable ?? null,
    })
      .then((result) => {
        entry.connection = result.connection
        entry.project = result.project
        return result
      })
      .catch((error) => {
        // A reload that failed leaves nothing usable behind; the next query
        // opens a fresh workspace instead of reusing a half-built entry.
        if (pool.get(key) === entry) pool.delete(key)
        throw error
      })
      .finally(() => {
        entry.starting = null
        entry.restarting = false
      })
  }

  const run = async () => {
    timer = null
    const entry = pool.get(key)
    if (!entry) return
    if (entry.starting) {
      // A load is in flight for this very entry (a first query, or an earlier
      // reload). Rebuilding underneath it would leave two servers on one
      // checkout; wait for it and re-check the files afterwards.
      queued = true
      setTimeout(() => {
        queued = false
        schedule(null)
      }, RESTART_MIN_INTERVAL_MS).unref?.()
      return
    }
    lastRun = Date.now()
    const reason = pendingReason
    pendingReason = null
    entry.restarting = true
    try {
      // Project files are what MSBuild evaluates; regenerate them first so the
      // reload sees a new script, then drop the process whose view is stale.
      const stale = await projectStale(key)
      let refreshed = { refreshed: false, channel: null, report: null }
      if (stale) {
        entry.target ??= editorTargetFor(key, null, entry.unityExecutable)
        refreshed = await refreshProjectFiles(key, {
          // A reload started by a missing source must regenerate even though
          // the project files look current: what is wrong is their *contents*,
          // which an mtime comparison cannot see (Unity skips a script it has
          // not imported, so the `.csproj` can be newer than every source and
          // still omit one).
          force: reason !== null,
          target: entry.target ?? null,
          sources: trackedSources(key),
        })
      }
      if (process.env.LOCUS_DEBUG_POOL) console.error('[debug] refresh', JSON.stringify(refreshed), 'reason', reason)
      const connection = entry.connection
      const previousProject = entry.project
      entry.connection = null
      entry.project = null
      await Promise.resolve(connection?.close?.()).catch(() => {})
      entry.lastRestart = {
        at: lastRun,
        refreshedProjectFiles: refreshed.refreshed,
        report: refreshed.report,
        reason,
      }
      if (!stale) {
        // Nothing on disk changed the project set, so the running server still
        // describes the code; reloading would cost minutes for nothing.
        entry.restarting = false
        return
      }
      if (refreshed.stale && !refreshed.refreshed) {
        // The project files are wrong and could not be rewritten (no editor, no
        // Unity binary, a generator that refused). Reloading onto the same
        // files would report the same missing script again after a full
        // project load, so the stale server is kept and the reason is recorded
        // for the next answer instead.
        entry.connection = connection
        entry.project = previousProject
        entry.restarting = false
        return
      }
      if (pool.get(key) !== entry) {
        entry.restarting = false
        return
      }
      beginLoad(entry)
    } catch (error) {
      entry.restarting = false
      entry.lastRestart = { at: lastRun, refreshedProjectFiles: false, report: error?.message ?? String(error), reason }
    }
  }

  const schedule = (reason = null) => {
    if (reason) pendingReason = reason
    if (timer || queued) return
    const wait = Math.max(0, lastRun + RESTART_MIN_INTERVAL_MS - Date.now())
    timer = setTimeout(run, wait)
    timer.unref?.()
  }

  return {
    schedule,
    cancel() {
      if (timer) clearTimeout(timer)
      timer = null
      queued = false
    },
  }
}

/** Evict the least recently used workspace when at capacity. */
async function evictIfNeeded() {
  while (pool.size >= MAX_WORKSPACES) {
    let oldestKey = null
    let oldest = Infinity
    for (const [key, entry] of pool) {
      if (entry.starting) continue
      if (entry.lastUsed < oldest) {
        oldest = entry.lastUsed
        oldestKey = key
      }
    }
    if (oldestKey === null) break
    const victim = pool.get(oldestKey)
    await disposeEntry(oldestKey, victim)
  }
}

/**
 * Retry a query while the server reports that its analysis is not ready.
 *
 * The server answers -32800 ("request was canceled") when a document is still
 * being analyzed; the same request succeeds a few seconds later. Any other
 * error propagates so a real failure is not hidden behind a long poll.
 */
export async function queryWithReadyRetry(
  connection,
  run,
  { timeoutMs = QUERY_READY_TIMEOUT_MS, signal = null, isReady = null } = {},
) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal?.aborted) throw new CsharpWorkspaceError('C# analysis cancelled', { code: 'cancelled' })
    try {
      const result = await run()
      // `isReady` lets a query decide what "settled" means for its own answer.
      // `workspace/symbol` needs it: during warm-up it does not fail, it returns
      // an empty array, which is indistinguishable from "no such symbol".
      if (!isReady || isReady(result) || Date.now() >= deadline) return result
    } catch (error) {
      const cancelled = error instanceof LspResponseError && error.code === REQUEST_CANCELLED
      const notReady = cancelled || (error instanceof LspConnectionError && error.code === 'timeout')
      if (!notReady) throw error
      if (Date.now() >= deadline) {
        throw new CsharpWorkspaceError(
          `the C# language server is still analyzing the project after ${Math.round(timeoutMs / 1000)}s; ` +
            'retry once it settles (a large project loads once per session)',
          { code: 'analysis_not_ready' },
        )
      }
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS))
  }
}

/**
 * Open (or reuse) the server for one workspace.
 *
 * The first call is expensive: it may generate project files and always waits
 * for `workspace/projectInitializationComplete`. Later calls reuse the process
 * unless the project files changed on disk after the last load — those changes
 * are picked up by the file watcher, which reloads the workspace in the
 * background (`createRestartScheduler`).
 */
export async function openWorkspace(root, { target = null, unityExecutable = null, signal = null, force = false } = {}) {
  const key = normalizeRoot(root)
  if (!key) throw new CsharpWorkspaceError('a workspace path is required')

  const existing = pool.get(key)
  if (existing && !force) {
    if (existing.starting) {
      touch(existing)
      return existing.starting
    }
    const connection = existing.connection
    if (connection?.connected && connection.loaded) {
      touch(existing)
      return { connection, project: existing.project, workspace: key }
    }
    // Dead or unloaded: drop it and rebuild below. The watcher survives: it
    // belongs to the checkout, not to one server process.
    pool.delete(key)
    await Promise.resolve(connection?.close?.()).catch(() => {})
  }
  if (existing && force) {
    await disposeEntry(key, existing)
  }

  await evictIfNeeded()
  startReaper()

  // The entry exists before any work starts, so the watcher and a concurrent
  // `/reload` see `starting` and wait for this load instead of stampeding.
  // Without a caller-supplied target, the entry adopts whatever the load
  // resolves, so a later reload can regenerate through the same editor instead
  // of failing as "no project files and no editor".
  const entry = { connection: null, project: null, lastUsed: Date.now(), starting: null, target, unityExecutable }
  pool.set(key, entry)
  entry.watch = watchWorkspace(key, (changes) => applyFileChanges(key, entry, changes))
  entry.starting = startWorkspace(key, entry, { target, unityExecutable, signal })
    .then((result) => {
      entry.connection = result.connection
      entry.project = result.project
      // Reloads regenerate through the same target this load used; without
      // this, the second load has no editor and cannot regenerate at all.
      entry.target ??= result.target ?? target
      return result
    })
    .catch((error) => {
      pool.delete(key)
      throw error
    })
    .finally(() => {
      entry.starting = null
    })
  return entry.starting
}

/**
 * Prepare and start one server process for a workspace.
 *
 * Split out of `openWorkspace` because the file watcher's reload path runs the
 * same sequence (`createRestartScheduler`); keeping it in one place is what
 * makes a reloaded workspace indistinguishable from a freshly opened one.
 */
async function startWorkspace(key, entry, { target = null, unityExecutable = null, signal = null } = {}) {
  // Fetch what a cold machine is missing, as upstream's server start path does
  // (`assets::ensure_assets` before `solution/open`). Only server and analyzers
  // are asked for: the managed runtime is optional whenever a system .NET 10
  // is present, so `assetStatus().missing` alone would over-fetch it. After the
  // first workspace every call is a couple of `existsSync` checks.
  const downloaded = await installAssets(process.env, { onProgress: forwardDownload })
  if (!downloaded.ready) {
    // Fail through `requireAssets` so the error carries `assets_missing`.
    await requireAssets()
  }
  const assets = await requireAssets()
  // Regenerate before loading, like upstream's cold path: a checkout edited
  // while no server was running (or from outside the editor) still has a
  // `.sln` that predates the new scripts.
  //
  // Upstream checks this per query from the editor's source file list; without
  // that channel, a `.cs` named by an earlier answer (`trackSource`) that no
  // project compiles is the signal that the project set is behind.
  const project = await ensureProjectFiles(key, { target, unityExecutable, force: false, signal })
  const editorTarget = target ?? project.target ?? null
  const refresh = await refreshProjectFiles(key, {
    target: editorTarget,
    unityExecutable,
    signal,
    sources: trackedSources(key),
  })
  if (!project.solution && project.projects.length === 0) {
    throw new CsharpWorkspaceError('no .sln or .csproj is available for the workspace', {
      code: 'project_files_missing',
    })
  }
  // Restore before the server evaluates MSBuild: without `obj/project.assets.json`
  // the compiler diagnostic provider silently returns nothing forever.
  const stateDir = join(assetsRoot(), 'run')
  const restore = await ensureRestored(key, {
    dotnetProgram: assets.program,
    stateDir,
    // A regenerated project set has no restore artifacts yet, and the ones the
    // old files produced describe the old file list.
    force: refresh.refreshed,
  })
  // Unity's generated csproj lists only the analyzers some IDE wrote into it,
  // so the package the bridge downloads never loads. Upstream parks a
  // marker-tagged `Directory.Build.props` next to the solution before the load,
  // which is the one place MSBuild will pick it up; failures are soft (the
  // server is still useful without `UNT*` rules).
  const analyzerDll = unityAnalyzerPath()
  entry.analyzerProps = analyzerDll ? writeAnalyzerProps(key, analyzerDll) : null
  const connection = new LspConnection({
    program: assets.program,
    serverDll: assets.serverDll,
    workspaceRoot: key,
    logDir: ensureLogDir(),
    // Roslyn's restore and MetadataAsSource need a writable runtime dir; an
    // inherited read-only one (sandbox, headless container) silently breaks
    // the first query. Keep the server's scratch state inside the asset root.
    stateDir,
    // A server that dies has to be replaced, not reused: every later request
    // on the dead connection rejects with `server_exited`.
    onServerExit: () => {
      const current = pool.get(key)
      if (current?.connection === connection) current.connection = null
    },
  })
  await connection.start()
  try {
    connection.openProject({ solution: project.solution, projects: project.projects })
    await connection.waitForProjectLoad(PROJECT_LOAD_TIMEOUT_MS)
  } catch (error) {
    await connection.close().catch(() => {})
    throw error
  }
  // The server only sees the analyzers of a project it knows from a document;
  // opening each project file with the injected item is what makes them load.
  for (const csproj of project.projects.slice(0, MAX_LSP_PROJECT_DOCUMENTS)) {
    try {
      connection.syncProjectDocument(csproj)
    } catch {
      // An unreadable project file still analyzes; it just lacks analyzers.
    }
  }
  // Files the generated set did not list a moment ago are in it now; keeping
  // them tracked would re-schedule a reload after every regeneration.
  try {
    // One parse covers the whole project set, so this stays a single pass over
    // the csproj files however many files were tracked.
    const includes = readProjectIncludes(key)
    for (const trackedPath of trackedSources(key)) {
      if (fileInProject(key, trackedPath, includes) === 'member') forgetTrackedSource(key, trackedPath)
    }
  } catch {
    // An unreadable project set keeps its entries tracked and reloads again.
  }
  return {
    connection,
    target: editorTarget,
    project: {
      solution: project.solution,
      projects: project.projects,
      channel: project.channel,
      report: project.report,
      refreshedProjectFiles: refresh.refreshed,
      restore,
      restored: restore.restored,
      loadedAt: Date.now(),
      // Consumed by `workspaceIsWarming`, cleared once any symbol query
      // succeeds; the deadline is only a ceiling for a server that never
      // indexes anything.
      warmUntil: Date.now() + SYMBOL_WARMUP_MS,
    },
  }
}

/**
 * Whether the workspace has restore artifacts.
 *
 * `code_diagnostics` consults this: without them the compiler provider reports
 * nothing, so an empty error list must not be presented as "the code compiles".
 */
export function workspaceIsRestored(root) {
  const entry = pool.get(normalizeRoot(root))
  if (entry?.project) return entry.project.restored === true
  return projectIsRestored(normalizeRoot(root))
}

/**
 * Start the server for `root` so a later query does not pay the load latency.
 *
 * Mirrors upstream `warm_up_in_background`/`warm_up_workspace`: it ends once the
 * project has loaded (or failed to), which is what makes the first real query
 * fast. A failure is returned rather than thrown at a caller that only wanted a
 * head start.
 */
export async function warmUpWorkspace(root, { target = null, unityExecutable = null } = {}) {
  try {
    await openWorkspace(root, { target, unityExecutable })
    return { warmed: true, workspace: normalizeRoot(root) }
  } catch (failure) {
    return { warmed: false, workspace: normalizeRoot(root), error: failure?.message ?? String(failure) }
  }
}

/**
 * Restart the server for one workspace.
 *
 * The desktop client does this when Unity restarts (the language server's view
 * of the project's generated files is stale). `force: true` on
 * `openWorkspace` is the same operation; this names it for the tool surface.
 */
export async function restartWorkspace(root, options = {}) {
  await shutdownCsharpPool({ workspace: root })
  return openWorkspace(root, { ...options, force: true })
}

/**
 * Run `fn(connection)` against the workspace server, guaranteeing the process
 * exists first.
 */
export async function withWorkspace(root, fn, options = {}) {
  const { connection, project } = await openWorkspace(root, options)
  touch(pool.get(normalizeRoot(root)) ?? {})
  const entry = pool.get(normalizeRoot(root))
  if (entry) touch(entry)
  return fn(connection, project)
}

/**
 * Whether a workspace is still inside its post-load warm-up window.
 *
 * `workspace/symbol` answers from a partial index while the server finishes
 * analyzing; only during this window can an empty answer mean "not yet".
 */
export function workspaceIsWarming(root) {
  const entry = pool.get(normalizeRoot(root))
  if (!entry?.project) return true
  if (entry.project.warm) return false
  if (Date.now() >= (entry.project.warmUntil ?? 0)) {
    entry.project.warm = true
    return false
  }
  return true
}

/**
 * Record that the workspace produced a real symbol answer, so later empty
 * results are trusted immediately instead of being retried as "not indexed".
 */
export function markWorkspaceWarm(root) {
  const entry = pool.get(normalizeRoot(root))
  if (entry?.project) entry.project.warm = true
}

/** Prepare the assets log directory eagerly (the server writes there). */
export function ensureLogDir() {
  const dir = join(assetsRoot(), 'logs')
  mkdirSync(dir, { recursive: true })
  return dir
}