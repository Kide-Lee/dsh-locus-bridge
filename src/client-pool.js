// Per-project client pool with reconnection, plus the edit-session owners this
// process holds on a Unity Editor.
//
// Mirrors the desktop client: one connection per endpoint, reused across tool
// calls; dropped on transport failure; reconnected with a short backoff. The
// endpoint is a Win32 named pipe on Windows and an absolute Unix socket path on
// Linux/macOS (the `Locus/locus_unix_native` broker port); both speak the same
// protocol. Every write path (snippet, asset edit, scene edit) opens an
// owner-scoped edit session so Auto Refresh stays suppressed until the last tool
// that touched the editor releases it — the same contract the Locus agent uses.


import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LocusClient, LocusError } from './locus-client.js'
import { BROKER_ERRORS, isReloading } from './protocol.js'
import { resolvePipeName } from './pipe-name.js'

const RECONNECT_ATTEMPTS = 5
const RECONNECT_BACKOFF_MS = [100, 200, 400, 800, 1_000]
const NOT_LISTENING = new Set(['ENOENT', 'ENOTFOUND', null, undefined])
/** Belt-and-braces bound for one connect attempt (the client has its own 10 s). */
const CONNECT_ATTEMPT_TIMEOUT_MS = 15_000
const SESSION_RELEASE_TIMEOUT_MS = 5_000

/** Open clients keyed by pipe name, and live edit-session owners keyed by `pipe\0owner`. */
const pool = new Map()
const editSessions = new Map()

function readMarkerLines(projectRoot) {
  try {
    return readFileSync(join(projectRoot, 'Library', 'Locus', 'NativeBridge.enabled'), 'utf8').split(/\r?\n/)
  } catch {
    return []
  }
}

/** Resolve the pipe for one target WITHOUT opening it. */
export function describeTarget({ projectRoot, pipe } = {}) {
  const markerLines = projectRoot ? readMarkerLines(projectRoot) : []
  return { projectRoot: projectRoot ?? null, pipe: resolvePipeName({ projectRoot, pipe, markerLines }) }
}

/** The native library the broker ships as, for the "not connected" hint. */
function nativeLibraryName() {
  return process.platform === 'win32' ? 'locus_unity_native.dll' : 'liblocus_unity_native.so'
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Get a connected client for the target, reconnecting after a transport loss
 * (for example a domain reload).
 */
export async function getClient(target, { deadline } = {}) {
  const { pipe } = describeTarget(target)
  if (!pipe) throw new LocusError('a Unity project path or an explicit pipe name is required')
  // A seeded (or already open) connection is trusted as-is; this keeps the
  // Stream test seam working on non-Windows hosts.
  const seeded = pool.get(pipe)
  if (seeded && (seeded.connected || seeded.state === 'connecting')) return seeded.connect().then(() => seeded)

  let client = pool.get(pipe)
  if (client && client.state !== 'connecting') {
    await client.close('reconnecting').catch(() => {})
    client = null
  }
  if (!client) {
    client = new LocusClient({ pipe })
    pool.set(pipe, client)
  }

  let lastError = null
  for (let attempt = 0; attempt < RECONNECT_ATTEMPTS; attempt += 1) {
    // A caller with its own deadline (`deadline`) must not be held past it: the
    // full retry budget below is ~76s (5 attempts x 15s), which inside a polling
    // loop means one iteration can blow a 300s budget on its own. Hopping
    // between a reloading editor used to do exactly that, so a loop whose
    // compile had already finished kept reconnecting for minutes.
    if (deadline !== undefined && Date.now() >= deadline) break
    if (attempt > 0) await sleep(RECONNECT_BACKOFF_MS[Math.min(attempt - 1, RECONNECT_BACKOFF_MS.length - 1)])
    const attemptBudget =
      deadline === undefined
        ? CONNECT_ATTEMPT_TIMEOUT_MS
        : Math.max(0, Math.min(CONNECT_ATTEMPT_TIMEOUT_MS, deadline - Date.now()))
    if (deadline !== undefined && attemptBudget === 0) break
    try {
      const outcome = await Promise.race([
        client.connect().then(() => 'connected'),
        new Promise((resolve) => setTimeout(() => resolve('stalled'), attemptBudget)),
      ])
      if (outcome === 'connected') return client
      throw new LocusError(`locus connect attempt timed out after ${attemptBudget} ms`)
    } catch (error) {
      lastError = error
      // Only "not listening yet" is worth retrying; other OS errors (denied,
      // a wrong endpoint shape) and a hung connect fail fast.
      if (!NOT_LISTENING.has(error?.code)) break
    }
  }
  if (pool.get(pipe) === client) pool.delete(pipe)
  await client.close('connect failed').catch(() => {})

  throw new LocusError(
    `Unity Editor not connected (${pipe}): ${lastError?.message ?? 'unknown error'}. ` +
      'Check that the project has the Locus package, the native broker library ' +
      `(${nativeLibraryName()}), and a Library/Locus/NativeBridge.enabled marker ` +
      '(or LOCUS_UNITY_NATIVE_BRIDGE=1).',
    { code: BROKER_ERRORS.MANAGED_NOT_READY },
  )
}

/**
 * Run `fn(client)`; on a transport failure or a broker "not executed" rejection
 * reconnect once and retry. `exclusive: true` skips the retry (a mutating call
 * whose fate is unclear must not run twice).
 */
/**
 * Poll `status` until the broker answers without a reload error, mirroring
 * upstream `wait_for_unity_bridge_ready`. Resolves false when the budget runs
 * out (the caller then surfaces the original error).
 */
async function waitForBridgeReady(target, deadline) {
  for (;;) {
    if (Date.now() >= deadline) return false
    try {
      const client = await getClient(target, { deadline })
      const ready = await client
        .request('status', '', { timeoutMs: Math.max(500, Math.min(5_000, deadline - Date.now())) })
        .catch(() => null)
      if (ready?.ok) return true
    } catch {
      // Not ready yet (or not reachable): keep waiting until the budget ends.
    }
    await sleep(Math.min(READY_POLL_MS, Math.max(0, deadline - Date.now())))
  }
}

/** Upstream `SHORT_MESSAGE_TRANSIENT_RETRY_ATTEMPTS`. */
const TRANSIENT_RETRY_ATTEMPTS = 3
/** Upstream `SHORT_MESSAGE_TRANSIENT_READY_WAIT`. */
const TRANSIENT_READY_WAIT_MS = 30_000
const READY_POLL_MS = 500

/**
 * Run `fn(client)`; on a transport failure or a broker "not executed" rejection,
 * wait for the bridge and retry. `exclusive: true` skips the retry (a mutating
 * call whose fate is unclear must not run twice).
 *
 * The wait matters as much as the retry: a domain reload answers
 * `managed_reloading` for a moment, and an immediate retry lands in the same
 * window. Upstream wraps every message in `send_message_with_transient_retry`,
 * which retries three times and waits up to 30s for bridge readiness
 * (`wait_for_unity_bridge_ready`). Without that wait, one recompile made every
 * other tool fail for the following second or two — the failure a caller sees
 * looks permanent even though the editor is merely reloading.
 */
export async function withClient(target, fn, { exclusive = false } = {}) {
  const deadline = Date.now() + TRANSIENT_READY_WAIT_MS
  let client = await getClient(target)
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn(client)
    } catch (error) {
      if (!(error instanceof LocusError)) throw error
      const transportLoss = error.code === undefined && !client.connected
      // Two different questions, deliberately separate (upstream keeps them
      // apart too): `notExecuted` = "safe to replay", `isReloading` = "the
      // editor is between domains, so try again shortly". A reload boundary is
      // NOT in NOT_EXECUTED (`domain_reload_interrupted` may have reached the
      // executor), which is why keying the retry on notExecuted alone left
      // every tool except recompile failing right after a compile.
      const reloadBoundary = isReloading(error.code)
      const retryable = !exclusive && (error.notExecuted || transportLoss || reloadBoundary)
      if (!retryable || attempt >= TRANSIENT_RETRY_ATTEMPTS) throw error
      if (Date.now() >= deadline) throw error
      // Wait for the bridge to actually become ready, not a fixed nap: a domain
      // reload lasts as long as it lasts, and retrying into the same window just
      // burns the attempt budget (3 quick retries finished in ~1s and reported
      // failure while the editor was still coming back).
      if (!(await waitForBridgeReady(target, deadline))) throw error
      try {
        client = await getClient(target, { deadline })
      } catch {
        if (Date.now() >= deadline) throw error
        continue
      }
    }
  }
}

/** An open connection for this target, or null (never connects). */
export function connectedClient(target) {
  const { pipe } = describeTarget(target)
  const client = pool.get(pipe)
  return client?.connected ? client : null
}

// ── Edit sessions ──────────────────────────────────────────────────────────

function sessionKey(pipe, owner) {
  return `${pipe}\u0000${owner}`
}

/**
 * Open (idempotently) an owner-scoped edit session for `target`.
 * Returns `{ owner, pipe, release }`; `release` may be called more than once.
 */
export async function openEditSession(target, owner) {
  const { pipe } = describeTarget(target)
  const key = sessionKey(pipe, owner)
  const client = await getClient(target)
  if (!editSessions.has(key)) {
    try {
      await client.call('begin_edit_session', owner, { timeoutMs: 20_000 })
    } catch (error) {
      // A session that could not start is not tracked; the caller surfaces it.
      throw error
    }
    editSessions.set(key, { pipe, owner, projectRoot: target.projectRoot ?? null })
  }
  let released = false
  return {
    owner,
    pipe,
    async release() {
      if (released) return
      released = true
      editSessions.delete(key)
      const live = pool.get(pipe)
      if (!live?.connected) return
      await live.call('end_edit_session', owner, { timeoutMs: SESSION_RELEASE_TIMEOUT_MS }).catch(() => {})
    },
  }
}

/** Owner of this process that currently holds an edit session on the pipe, or null. */
export function activeEditOwner(pipe) {
  for (const entry of editSessions.values()) if (entry.pipe === pipe) return entry.owner
  return null
}

/** Release edit sessions, then every connection (plugin dispose). */
export async function shutdownPool() {
  const entries = [...editSessions.values()]
  editSessions.clear()
  for (const entry of entries) {
    const client = pool.get(entry.pipe)
    if (!client?.connected) continue
    await client.call('end_edit_session', entry.owner, { timeoutMs: SESSION_RELEASE_TIMEOUT_MS }).catch(() => {})
  }
  const clients = [...pool.values()]
  pool.clear()
  await Promise.all(clients.map((client) => client.close('plugin disposed').catch(() => {})))
}

/** Test hook: remember an open client without going through the pipe. */
export function __setClientForTest(pipe, client) {
  pool.set(pipe, client)
}

/** Test hook: clear pool and sessions without touching the (fake) connections. */
export function __resetPoolForTest() {
  pool.clear()
  editSessions.clear()
}

export function __poolSize() {
  return pool.size
}

export function __editSessionCount() {
  return editSessions.size
}
