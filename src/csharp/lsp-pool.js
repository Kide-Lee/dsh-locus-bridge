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

import { requireAssets, assetsRoot } from './assets.js'
import { LspConnection, LspConnectionError, LspResponseError, REQUEST_CANCELLED } from './lsp-client.js'
import { ensureProjectFiles, ensureRestored, findProjectTargets, projectFilesStale, projectIsRestored } from './project-sync.js'

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

/** workspace root → { connection, project, lastUsed, starting } */
const pool = new Map()
let reaper = null

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
      pool.delete(key)
      // Closing is async and must never reject into the timer.
      Promise.resolve(entry.connection.close()).catch(() => {})
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
      idleMs: Date.now() - entry.lastUsed,
    })
  }
  return { workspaces: entries.length, maxWorkspaces: MAX_WORKSPACES, entries }
}

/** Close one workspace or every workspace. */
export async function shutdownCsharpPool({ workspace = null } = {}) {
  const targets = workspace ? [normalizeRoot(workspace)] : [...pool.keys()]
  const closed = []
  for (const key of targets) {
    const entry = pool.get(key)
    if (!entry) continue
    pool.delete(key)
    await Promise.resolve(entry.connection?.close?.()).catch(() => {})
    closed.push(key)
  }
  return closed
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
    pool.delete(oldestKey)
    await Promise.resolve(victim?.connection?.close?.()).catch(() => {})
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
 * unless the project files changed on disk after the last load.
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
    // Dead or unloaded: drop it and rebuild below.
    pool.delete(key)
    await Promise.resolve(connection?.close?.()).catch(() => {})
  }
  if (existing && force) {
    pool.delete(key)
    await Promise.resolve(existing.connection?.close?.()).catch(() => {})
  }

  await evictIfNeeded()
  startReaper()

  const entry = { connection: null, project: null, lastUsed: Date.now(), starting: null }
  entry.starting = (async () => {
    const assets = await requireAssets()
    const project = await ensureProjectFiles(key, { target, unityExecutable, force, signal })
    if (!project.solution && project.projects.length === 0) {
      throw new CsharpWorkspaceError('no .sln or .csproj is available for the workspace', {
        code: 'project_files_missing',
      })
    }
    // Restore before the server evaluates MSBuild: without `obj/project.assets.json`
    // the compiler diagnostic provider silently returns nothing forever.
    const stateDir = join(assetsRoot(), 'run')
    const restore = await ensureRestored(key, { dotnetProgram: assets.program, stateDir })
    const connection = new LspConnection({
      program: assets.program,
      serverDll: assets.serverDll,
      workspaceRoot: key,
      logDir: ensureLogDir(),
      // Roslyn's restore and MetadataAsSource need a writable runtime dir; an
      // inherited read-only one (sandbox, headless container) silently breaks
      // the first query. Keep the server's scratch state inside the asset root.
      stateDir,
    })
    await connection.start()
    try {
      connection.openProject({ solution: project.solution, projects: project.projects })
      await connection.waitForProjectLoad(PROJECT_LOAD_TIMEOUT_MS)
    } catch (error) {
      await connection.close().catch(() => {})
      throw error
    }
    entry.connection = connection
    entry.project = {
      solution: project.solution,
      projects: project.projects,
      channel: project.channel,
      report: project.report,
      restore,
      restored: restore.restored,
      loadedAt: Date.now(),
      // Consumed by `workspaceIsWarming`, cleared once any symbol query
      // succeeds; the deadline is only a ceiling for a server that never
      // indexes anything.
      warmUntil: Date.now() + SYMBOL_WARMUP_MS,
    }
    return { connection, project: entry.project, workspace: key }
  })()
    .catch((error) => {
      pool.delete(key)
      throw error
    })
    .finally(() => {
      entry.starting = null
    })

  pool.set(key, entry)
  return entry.starting
}

/**
 * Whether the workspace's project files went stale after the last load.
 *
 * A `.cs` file written after the generated `.sln` means a new type may be
 * invisible to the server until it re-evaluates the project, so the caller can
 * decide to re-sync (`force: true`).
 */
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

export function projectNeedsResync(root) {
  const key = normalizeRoot(root)
  const entry = pool.get(key)
  if (!entry?.project?.loadedAt) return findProjectTargets(key).scannedAt === null
  const targets = findProjectTargets(key)
  if (!targets.solution && targets.projects.length === 0) return true
  return projectFilesStale(key, targets.scannedAt, [])
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