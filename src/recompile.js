// `unity_recompile`: apply pending C# changes through compilation and domain
// reload, and wait until the result (or Unity's own verdict) is known.
//
// Wire flow (LocusBridge.cs `request_recompile` / `get_compile_result` /
// `get_reload_state`):
//   1. request_recompile {schema:1, syncMode, paths, reason, operationId}
//      → broker answers `recompile_started` once the requested compile STARTED.
//   2. The domain reload then drops the connection. Poll `get_compile_result`
//      on a freshly reconnected client (the broker answers it natively from
//      its register while the managed side is busy reloading):
//        starting | pending          → keep waiting
//        ok | not_needed            → converged
//        error:<diagnostics>        → compile failed
//        recompile_result_operation_mismatch → another compile owns the register
//   3. If the editor was already compiling, `request_recompile` answers
//      `recompile_in_progress; operation_id=<id>; …`: adopt that operation.

import { randomUUID } from 'node:crypto'
import { getClient } from './client-pool.js'
import { LocusError } from './locus-client.js'
import { BROKER_ERRORS } from './protocol.js'

const POLL_INTERVAL_MS = 1_000
const DEFAULT_START_TIMEOUT_MS = 120_000
const DEFAULT_CONVERGE_TIMEOUT_MS = 300_000

const CONVERGED = new Set(['ok', 'not_needed'])
const PENDING = new Set(['starting', 'pending'])
const MISMATCH = 'recompile_result_operation_mismatch'

/** Editor statuses that cannot host a recompile. */
export function assertRecompileableStatus(status) {
  if (status === 'playing' || status === 'playing_paused') {
    throw new Error(
      `Unity Editor status is "${status}". Recompilation requires Edit Mode; use unity_play_mode with mode "edit" first.`,
    )
  }
  if (status !== 'editing') throw new Error(`Unity Editor status is "${status}"; wait for a connected editor.`)
}

/** Keep only project-relative asset paths Locus accepts in a recompile request. */
export function normalizeChangedPaths(paths, projectRoot) {
  const list = Array.isArray(paths) ? paths : paths ? [paths] : []
  return list
    .map((value) => String(value ?? '').trim().replaceAll('\\', '/'))
    .filter(Boolean)
    .map((value) => {
      if (!projectRoot) return value
      const root = String(projectRoot).replaceAll('\\', '/').replace(/\/+$/, '')
      return value.toLowerCase().startsWith(root.toLowerCase() + '/') ? value.slice(root.length + 1) : value
    })
    .filter((value) => /^(Assets|Packages)\//.test(value))
}

/** The recompile request body Locus parses (`RecompileRequestPayload`). */
export function recompilePayload({ syncMode = 'none', paths = [], reason = '', operationId }) {
  if (!['none', 'targeted', 'full'].includes(syncMode)) {
    throw new Error(`Invalid syncMode '${syncMode}'. Allowed values: none, targeted, full.`)
  }
  if (syncMode === 'targeted' && paths.length === 0) {
    throw new Error('syncMode "targeted" requires at least one Assets/ or Packages/ path.')
  }
  return JSON.stringify({ schema: 1, syncMode, paths, reason: reason || 'dsh-locus-bridge recompile', operationId })
}

/** Extract `operation_id=<id>` from a `recompile_in_progress; …` rejection. */
export function adoptedOperationId(error) {
  const text = String(error ?? '')
  if (!text.startsWith('recompile_in_progress')) return null
  const match = /operation_id=([^;\s]*)/.exec(text)
  return match && match[1].trim() ? match[1].trim() : null
}

/**
 * Whether a broker rejection only means "the editor is between domains".
 *
 * Mirrors upstream `is_transient_broker_error` (`unity_bridge/mod.rs`), which is
 * an exact match on three codes. The previous regex here accepted any `native_*`
 * prefix, so a real broker refusal (for example `native_payload_too_large`) was
 * silently retried for the whole convergence budget instead of surfacing.
 */
export function isTransientBrokerError(error) {
  const value = String(error ?? '').trim()
  return (
    value === BROKER_ERRORS.MANAGED_RELOADING ||
    value === BROKER_ERRORS.MANAGED_NOT_READY ||
    value === BROKER_ERRORS.RELOAD_INTERRUPTED
  )
}

function isTransportFailure(error) {
  return error instanceof LocusError && (error.notExecuted || error.code === undefined)
}

async function sleep(ms, signal) {
  if (signal?.aborted) throw new Error('cancelled')
  await new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', done)
      resolve()
    }
    signal?.addEventListener?.('abort', done, { once: true })
  })
  if (signal?.aborted) throw new Error('cancelled')
}

/**
 * Run one recompile to convergence.
 *
 * @param opts.projectRoot  Unity project root (or `pipe`)
 * @param opts.pipe         explicit pipe
 * @param opts.operationId  caller-supplied id (defaults to a fresh one)
 * @param opts.syncMode     'none' | 'targeted' | 'full'
 * @param opts.paths        changed project-relative asset paths
 * @param opts.reason       free-form reason logged by Unity
 * @param opts.signal       abort → stop polling (the compile itself continues)
 * @param opts.onPhase      progress callback (label)
 * @param opts.startTimeoutMs / convergeTimeoutMs
 * @returns {{ operationId, status, message, startedAt, elapsedMs, adopted }}
 */
export async function recompile(target, options = {}) {
  const {
    syncMode = 'none',
    paths = [],
    reason = '',
    operationId = `dsh-${randomUUID()}`,
    signal,
    onPhase = () => {},
    startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
    convergeTimeoutMs = DEFAULT_CONVERGE_TIMEOUT_MS,
  } = options

  const changed = normalizeChangedPaths(paths, target.projectRoot ?? options.projectRoot)
  const request = recompilePayload({ syncMode, paths: changed, reason, operationId })
  const startedAt = Date.now()

  // ── phase 1: start ──────────────────────────────────────────────────────
  onPhase('Requesting recompile')
  const first = await getClient(target)
  let response
  try {
    response = await first.request('request_recompile', request, { timeoutMs: 60_000 })
  } catch (error) {
    if (!isTransportFailure(error)) throw error
    // The connection died while the (re)load started; the register still knows.
    response = { ok: false, error: `${BROKER_ERRORS.MANAGED_RELOADING}: ${error.message}` }
  }
  let activeId = operationId
  let adopted = false
  if (!response.ok) {
    const adoptedId = adoptedOperationId(response.error)
    if (adoptedId) {
      activeId = adoptedId
      adopted = true
      onPhase(`Adopting in-flight compile ${adoptedId}`)
    } else if (/recompile_in_progress|no active|没有开始编译/i.test(String(response.error))) {
      // Not an "in progress" owner: keep polling; `get_compile_result` tells
      // whether a compile is running for this operation (or a stale register).
      onPhase('Waiting for the compile to start')
    } else if (!isTransientBrokerError(response.error)) {
      throw new LocusError(response.error || 'request_recompile failed')
    }
  }

  // ── phase 2: converge on a fresh connection ─────────────────────────────
  const deadline = Date.now() + convergeTimeoutMs
  let last = 'starting'
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS, signal)
    let client
    try {
      client = await getClient(target)
    } catch {
      onPhase('Waiting for Unity to reconnect after reload')
      continue
    }
    let reply
    try {
      reply = await client.request('get_compile_result', activeId, { timeoutMs: 30_000 })
    } catch (error) {
      if (isTransportFailure(error)) {
        onPhase('Editor reloading')
        continue
      }
      throw error
    }
    if (reply.ok) {
      const value = String(reply.message ?? '').trim()
      if (PENDING.has(value)) {
        if (value !== last) onPhase(`Compiling (${value})`)
        last = value
        continue
      }
      if (CONVERGED.has(value)) {
        return { operationId: activeId, status: value, message: value, startedAt, elapsedMs: Date.now() - startedAt, adopted }
      }
      throw new LocusError(`unexpected compile result: ${value}`)
    }
    const error = String(reply.error ?? '').trim()
    if (error === MISMATCH) {
      // A different compile owns the register (for example a user Ctrl+R):
      // nothing of ours is pending any more.
      return {
        operationId: activeId,
        status: 'superseded',
        message: 'another compilation owns the result register',
        startedAt,
        elapsedMs: Date.now() - startedAt,
        adopted,
      }
    }
    if (/没有开始编译|no active|not started/i.test(error)) {
      await sleep(POLL_INTERVAL_MS, signal)
      continue
    }
    if (isTransientBrokerError(error)) {
      onPhase('Editor reloading')
      continue
    }
    return {
      operationId: activeId,
      status: 'error',
      message: error,
      startedAt,
      elapsedMs: Date.now() - startedAt,
      adopted,
    }
  }
  throw new Error(
    `recompile did not converge within ${Math.round(convergeTimeoutMs / 1000)}s ` +
      `(last state "${last}", operation ${activeId}); it may still finish in Unity.`,
  )
}

/** One `get_reload_state` sample (domain generation / convergence serial). */
export async function readReloadState(target) {
  const client = await getClient(target)
  const envelope = await client.call('get_reload_state', '', { timeoutMs: 30_000 })
  try {
    return JSON.parse(envelope.message || '{}')
  } catch (error) {
    throw new Error(`get_reload_state returned invalid JSON: ${error.message}`)
  }
}

export { POLL_INTERVAL_MS }
