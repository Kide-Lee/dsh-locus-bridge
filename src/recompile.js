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
import { hotReload } from './hotreload.js'
import { LocusError } from './locus-client.js'
import { BROKER_ERRORS } from './protocol.js'

/**
 * Poll cadence, from upstream's recompile loop (`sleep(500ms)` between
 * `get_compile_result` reads). 1s made a run of tolerated register mismatches
 * take twice as long as the desktop client would.
 */
const POLL_INTERVAL_MS = 500
/**
 * Per-read timeout for the compile-result register, from upstream
 * `RECOMPILE_POLL_TIMEOUT`. A read is idempotent and the register answers it
 * while the main thread is away, so a slow answer means "busy", never "dead":
 * a long timeout only makes each iteration slow, which is what let a finished
 * compile keep this loop running for minutes.
 */
const POLL_TIMEOUT_MS = 4_000
/**
 * Consecutive operation-mismatch reads tolerated before declaring the register
 * taken over, from upstream `RECOMPILE_OPERATION_MISMATCH_LIMIT`. Unity can
 * answer mismatch for a moment while our own compile is still being registered,
 * so one read is not proof that another request replaced us.
 */
const OPERATION_MISMATCH_LIMIT = 20
/**
 * How long to wait for the start acknowledgement.
 *
 * Upstream `RECOMPILE_START_CONFIRM_TIMEOUT` is 90s, after which it switches to
 * reconciling the persisted compile state. Waiting much longer only delays the
 * fallback: the compile is already running either way, and the converge loop
 * reports the real outcome. Kept well under the converge budget so a request
 * queued behind a busy editor still produces an answer.
 */
const DEFAULT_START_TIMEOUT_MS = 90_000
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

/**
 * How `unity_recompile` reaches the disk→domain step (contracts.md §2.3).
 *
 *   compile — `request_recompile`: the classic full request, optionally syncing
 *             assets first.
 *   scripts — `request_script_reload`: Unity reimports changed scripts and
 *             compiles on the next delayCall (payload LocusBridge.cs:1974-1993,
 *             which answers `reload_requested`). No asset sync, no diagnostics
 *             register: it says "asked", not "converged".
 *   auto    — classify the edited paths with `unity_hot_reload` first, and only
 *             fall through to `compile` when a change needs a real compile (or
 *             when nothing at all is hot-patchable).
 */
const RECOMPILE_MODES = Object.freeze(['auto', 'compile', 'scripts'])

function assertRecompileMode(mode) {
  if (!RECOMPILE_MODES.includes(mode)) {
    throw new Error(`Invalid mode '${mode}'. Allowed values: ${RECOMPILE_MODES.join(', ')}.`)
  }
}

/** Request body for the payload's `request_script_reload` (§2.3). */
export function scriptReloadPayload({ paths = [], reason = '', operationId } = {}) {
  // The payload reads only the reason today (`request_script_reload` uses it
  // for the Console line) but forwarding paths/operationId costs nothing and
  // keeps the two paths' request shapes parallel.
  return JSON.stringify({ schema: 1, paths, reason: reason || 'dsh-locus-bridge recompile', operationId })
}

/**
 * Ask Unity to reimport changed scripts and compile, without waiting for a
 * convergence verdict.
 *
 * Deliberately NOT routed through {@link recompile}'s convergence loop: this
 * message is fire-and-forget by design (the payload schedules the reload on a
 * delayCall), so there is no compile register to poll and pretending otherwise
 * would report a compile that may never have started.
 *
 * @returns {{mode:'scripts', status:'reload_requested', message:string,
 *   operationId:string, startedAt:number, elapsedMs:number, adopted:false}}
 */
export async function requestScriptReload(target, options = {}) {
  const {
    paths = [],
    reason = '',
    operationId = `dsh-${randomUUID()}`,
    signal,
    onPhase = () => {},
    startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  } = options
  if (signal?.aborted) throw new Error('cancelled')
  const changed = normalizeChangedPaths(paths, target.projectRoot ?? options.projectRoot)
  onPhase('Requesting a script recompile')
  const startedAt = Date.now()
  const client = await getClient(target)
  const response = await client.request('request_script_reload', scriptReloadPayload({ paths: changed, reason, operationId }), {
    timeoutMs: startTimeoutMs,
  })
  if (!response?.ok) throw new LocusError(String(response?.error ?? 'request_script_reload failed'))
  const message = String(response.message ?? '').trim() || 'reload_requested'
  onPhase('Unity scheduled the script reload')
  return {
    mode: 'scripts',
    status: message === 'reload_requested' ? 'reload_requested' : message,
    message,
    operationId,
    startedAt,
    elapsedMs: Date.now() - startedAt,
    adopted: false,
  }
}

/**
 * `unity_recompile` with a mode (§2.3).
 *
 * `mode: 'auto'` classifies first: a change that is entirely hot-patchable is
 * reported as such and nothing is recompiled; anything else (or an empty path
 * list, where there is nothing to classify) falls through to the normal
 * compile. Classification failures never block the compile — a bridge that
 * predates `dsh_hot_reload_*` answers "unknown message type", and the classic
 * path must keep working in that case.
 *
 * @param {{projectRoot?: string, pipe?: string}} target
 * @param {object} options  everything {@link recompile} accepts, plus `mode`
 * @returns {Promise<object>} recompile's result, extended with `mode` and, for
 *   `auto`, the `classification` that decided the outcome
 */
export async function runRecompile(target, options = {}) {
  const mode = options.mode ?? 'compile'
  assertRecompileMode(mode)

  if (mode === 'scripts') return requestScriptReload(target, options)

  if (mode !== 'auto') return { ...(await recompile(target, options)), mode: 'compile' }

  let classification = null
  let classificationError = null
  const paths = normalizeChangedPaths(options.paths ?? [], target.projectRoot ?? options.projectRoot)
  if (paths.length > 0) {
    try {
      classification = await hotReload(target, { paths, dryRun: true, signal: options.signal, onPhase: options.onPhase })
    } catch (error) {
      // Abort must not be swallowed into a compile.
      if (options.signal?.aborted || error?.message === 'cancelled') throw error
      classificationError = error?.message ?? String(error)
    }
  }

  if (classification && classification.needCompile.length === 0 && classificationIsHot(classification)) {
    return {
      mode: 'hot',
      status: 'hot',
      message: 'every edited path is hot-patchable; nothing was recompiled',
      operationId: null,
      elapsedMs: 0,
      adopted: false,
      classification,
    }
  }

  const result = await recompile(target, options)
  return { ...result, mode: 'compile', classification, classificationError }
}

/** Render the classification part of a `mode: 'auto'` outcome, or '' when there was none. */
export function formatClassification(classification, classificationError = null) {
  if (classificationError) return `Hot reload classification was unavailable (${classificationError}); the compile ran anyway.`
  if (!classification) return ''
  const lines = []
  for (const entry of classification.needCompile) {
    lines.push(`  needs compile: ${entry.path}${entry.reason ? ` — ${entry.reason}` : ''}`)
  }
  for (const entry of classification.failed) {
    lines.push(`  not classifiable: ${entry.path}${entry.error ? ` — ${entry.error}` : ''}`)
  }
  const hotPaths = classification.files
    ? classification.files.filter((file) => file.state === 'hot').map((file) => file.path)
    : [...new Set(classification.hot.map((entry) => entry.path))]
  for (const path of hotPaths) lines.push(`  hot-patchable: ${path}`)
  return lines.length > 0 ? lines.join('\n') : ''
}

/**
 * Whether every classified file is hot-patchable.
 *
 * `hot` only carries detourable methods, so a file judged hot without a method
 * body (a comment-only edit) appears only in `files`; treating that as "nothing
 * is hot" would force a needless compile.
 */
function classificationIsHot(classification) {
  if (Array.isArray(classification.files) && classification.files.length > 0) {
    return classification.files.every((file) => file.state === 'hot')
  }
  return classification.hot.length > 0
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

/**
 * Broker refusals that mean "the editor is busy right now", mirroring upstream
 * `is_main_thread_unresponsive_error` plus the older-plugin unresponsive code.
 * These say nothing about the compile itself, so they are waited out.
 */
export function isBusyError(error) {
  const value = String(error ?? '').trim()
  return value === BROKER_ERRORS.MAIN_THREAD_UNRESPONSIVE || value === 'native_main_thread_unresponsive'
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
  // Explicit "we do not know whether it started" state, mirroring upstream's
  // `RecompileStartAck::Unconfirmed`. Faking this as a broker error string was
  // wrong twice over: it had to survive exact-match transient classification,
  // and it read like a real broker refusal in diagnostics.
  let unconfirmed = false
  let response
  try {
    response = await first.request('request_recompile', request, { timeoutMs: startTimeoutMs })
  } catch (error) {
    // A timeout here does NOT mean the compile will not happen: the reply is
    // queued behind the very work it asked for (a compile already running, or
    // an AssetDatabase refresh holding the main thread). Upstream
    // `request_recompile_and_wait_for_start` gives up after
    // RECOMPILE_START_CONFIRM_TIMEOUT and returns `Unconfirmed`, then reconciles
    // through the persisted `get_compile_result` register instead of failing.
    // Reporting a hard failure (what this did: `locus_request_timeout` carries a
    // code, so it was not seen as a transport failure) threw away a compile that
    // was in fact running.
    if (error?.message === 'locus_request_timeout' || error?.code === BROKER_ERRORS.REQUEST_TIMED_OUT) {
      onPhase('Start acknowledgement not observed; reconciling the persisted compile state')
      unconfirmed = true
      response = { ok: false, error: '' }
    } else if (isTransportFailure(error)) {
      // The connection died while the (re)load started; the register still knows.
      unconfirmed = true
      response = { ok: false, error: '' }
    } else {
      throw error
    }
  }
  let activeId = operationId
  let adopted = false
  if (!response.ok && !unconfirmed) {
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
  let mismatches = 0
  while (Date.now() < deadline) {
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())), signal)
    if (Date.now() >= deadline) break
    const remaining = deadline - Date.now()
    let client
    try {
      // Bound the reconnect by what is left of the budget: an unbounded
      // reconnect (~76s worst case) can consume the whole loop on its own, which
      // is how a finished compile kept this running for minutes.
      client = await getClient(target, { deadline })
    } catch {
      onPhase('Waiting for Unity to reconnect after reload')
      continue
    }
    let reply
    try {
      reply = await client.request('get_compile_result', activeId, {
        timeoutMs: Math.max(1_000, Math.min(POLL_TIMEOUT_MS, remaining)),
      })
    } catch (error) {
      if (isTransportFailure(error)) {
        onPhase('Editor reloading')
        continue
      }
      throw error
    }
    if (reply.ok) {
      mismatches = 0
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
      // The register can answer mismatch for a moment while our own compile is
      // still being registered, so tolerate a run of them like upstream does
      // rather than calling it superseded on the first read. An adopted compile
      // is different: someone else owned it and we merely watched.
      if (adopted) {
        throw new LocusError('the adopted recompile was replaced by another request')
      }
      mismatches += 1
      if (mismatches >= OPERATION_MISMATCH_LIMIT) {
        return {
          operationId: activeId,
          status: 'superseded',
          message: `Unity's compile register belongs to another request; operation ${activeId} was replaced before it reported a result.`,
          startedAt,
          elapsedMs: Date.now() - startedAt,
          adopted,
        }
      }
      await sleep(POLL_INTERVAL_MS, signal)
      continue
    }
    if (isBusyError(error)) {
      // The editor is compiling, importing or initializing: the register is
      // still authoritative, so keep waiting (upstream treats this as
      // EditorBusy, not as a failure).
      onPhase('Editor busy; still waiting for the compile result')
      await sleep(POLL_INTERVAL_MS, signal)
      continue
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
