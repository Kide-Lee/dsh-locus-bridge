// The `unity_execute` flow on top of one Locus connection:
//   status gate -> optional edit session -> execute_code + progress polling
//   -> cancel on abort -> bounded drain.
//
// Mirrors `src-tauri/src/unity_bridge/mod.rs::unity_execute_code_with_options`:
// the progress poll doubles as the liveness touch a snippet needs, so a call
// without polling would be stopped by Unity after 30s of silence.

import {
  EXECUTE_DEFAULT_TIMEOUT_MS,
  EXECUTE_IDLE_LIMIT_MS,
  EDITOR_STATUS_DISCONNECTED,
  executePayload,
  isKnownEditorStatus,
  isReloading,
  parseStatusMessage,
} from './protocol.js'
import { LocusError } from './locus-client.js'

const PROGRESS_POLL_MS = 250
const CANCEL_DRAIN_MS = 500
const STATUS_TIMEOUT_MS = 5_000
// Upstream `UNITY_EXECUTE_BUDGET_GRACE` is 30s: Unity enforces the budget
// itself, the host only keeps a backstop past it. 60s made a hung snippet hold
// the caller twice as long as the desktop client would.
const BUDGET_GRACE_MS = 30_000
/** Upstream `UNITY_EXECUTE_LONG_BLOCK_NOTE_MS`. */
const LONG_BLOCK_NOTE_MS = 15_000
/**
 * How long a `execute_code` may sit with neither acceptance nor progress, from
 * upstream `UNITY_EXECUTE_START_TIMEOUT_SECS`. Without it a request that never
 * leaves the sending stage (the editor's main thread is stuck) is
 * indistinguishable from a long-running snippet, so the caller waits the whole
 * budget for an answer that cannot come.
 */
const START_STALL_TIMEOUT_MS = 15_000
/** Pause between status retries while the domain reloads. */
const RELOAD_STATUS_RETRY_MS = 250

export const UNITY_EXECUTE_CANCELLED = '__locus_execute_cancelled__'

/**
 * Read the canonical editor status; returns `disconnected` instead of throwing.
 *
 * `waitForReloadMs` covers the one case where "disconnected" is misleading: the
 * editor answered `managed_reloading`, which means the pipe is fine and the
 * managed side is mid-domain-reload — typically for a second or two right after
 * a compile. A precondition check that refuses in that window reports a
 * permanent-looking failure for a transient state, so callers that are about to
 * touch the editor anyway can ask to wait it out.
 */
export async function readEditorStatus(client, { timeoutMs = STATUS_TIMEOUT_MS, waitForReloadMs = 0 } = {}) {
  const deadline = waitForReloadMs > 0 ? Date.now() + waitForReloadMs : 0
  for (;;) {
    let reloading = false
    try {
      const envelope = await client.request('status', '', { timeoutMs })
      if (envelope.ok) return { connected: true, ...parseStatusMessage(envelope.message) }
      reloading = isReloading(envelope.error)
      if (!reloading || Date.now() >= deadline) {
        return { connected: false, status: EDITOR_STATUS_DISCONNECTED, scenes: [], error: envelope.error }
      }
    } catch (error) {
      if (Date.now() >= deadline) {
        return { connected: false, status: EDITOR_STATUS_DISCONNECTED, scenes: [], error: error.message }
      }
    }
    await delay(RELOAD_STATUS_RETRY_MS)
  }
}

/** Validate `request_editor_status` and refuse a mismatched editor like Locus does. */
export function assertRequestedStatus(requested, actual) {
  if (requested === EDITOR_STATUS_DISCONNECTED || !isKnownEditorStatus(requested) || requested === EDITOR_STATUS_DISCONNECTED) {
    throw new Error(`Invalid request_editor_status '${requested}'. Allowed values: editing, playing, playing_paused.`)
  }
  if (actual !== requested) {
    throw new Error(
      `Unity Editor status is "${actual}". ` +
        `This call requires "${requested}"; use locus_play_mode to change the editor state first.`,
    )
  }
}

/**
 * Execute a C# snippet (method body) on the Unity main thread.
 *
 * The progress poll runs every 250 ms and doubles as the liveness touch a
 * snippet needs: Unity stops an execution after 30 s with no output, and the
 * managed heartbeat for the execution only advances when a client polls it.
 *
 * @param client connected LocusClient
 * @param opts.code            snippet source (method body)
 * @param opts.executionId     unique id embedded as a sentinel for progress/cancel
 * @param opts.timeoutMs       total run budget (clamped by Unity)
 * @param opts.signal          abort → sends `cancel_execute_code`
 * @param opts.onProgress      called with each progress JSON object
 * @returns {{ output: string, progress: object|null, cancelled: boolean }}
 */
export async function executeSnippet(client, { code, executionId, timeoutMs, signal, onProgress } = {}) {
  const budget = Number.isFinite(timeoutMs) ? timeoutMs : EXECUTE_DEFAULT_TIMEOUT_MS
  const payload = executePayload(code, { executionId, timeoutMs: budget })

  let cancelled = false
  let lastProgress = null
  let pollInFlight = false
  let pollHandle = null
  let rejectCancelled = null
  let sawProgress = false

  const poll = async () => {
    if (pollInFlight) return
    pollInFlight = true
    try {
      const envelope = await client.request('execute_code_progress', executionId, { timeoutMs: 5_000 })
      if (envelope.ok && envelope.message) {
        sawProgress = true
        lastProgress = safeJson(envelope.message)
        onProgress?.(lastProgress)
      }
    } catch {
      // Progress is best effort; the execute request carries the outcome.
    } finally {
      pollInFlight = false
    }
  }

  const cancelPromise = new Promise((_resolve, reject) => {
    rejectCancelled = reject
  })
  const onAbort = () => {
    if (cancelled) return
    cancelled = true
    // Signal first so a stuck snippet learns about the cancel on its next poll.
    client.request('cancel_execute_code', executionId, { timeoutMs: 5_000 }).catch(() => {})
    rejectCancelled(new LocusError(UNITY_EXECUTE_CANCELLED, { code: 'cancelled' }))
  }
  signal?.addEventListener?.('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()

  let deadline = null
  const timedOut = new Promise((_resolve, reject) => {
    deadline = setTimeout(
      () => reject(new LocusError(`execute_code did not finish within its budget plus grace period (${budget + BUDGET_GRACE_MS} ms)`)),
      budget + BUDGET_GRACE_MS,
    )
  })

  const run = client.request('execute_code', payload, { timeoutMs: budget + BUDGET_GRACE_MS })

  // Stalled-before-start watchdog: no response and no progress for 15s means the
  // request never reached Unity's executor (upstream resets the pipe and reports
  // exactly this). The timer is stopped as soon as either arrives, so a genuinely
  // long snippet is never cut short.
  const stalled = new Promise((_resolve, reject) => {
    const tick = setInterval(() => {
      if (sawProgress) {
        clearInterval(tick)
        return
      }
      clearInterval(tick)
      reject(
        new LocusError(
          `execute_code did not leave the sending stage within ${START_STALL_TIMEOUT_MS / 1000}s: the editor never ` +
            'accepted the request or reported progress. Its main thread may be blocked; check unity_status and the ' +
            'Unity Console.',
        ),
      )
    }, START_STALL_TIMEOUT_MS)
    tick.unref?.()
    run.then(() => clearInterval(tick)).catch(() => clearInterval(tick))
  })

  try {
    void poll()
    pollHandle = setInterval(poll, PROGRESS_POLL_MS)
    const envelope = await Promise.race([run, cancelPromise, timedOut, stalled])
    if (!envelope.ok) {
      if (cancelled) throw new LocusError(UNITY_EXECUTE_CANCELLED, { code: 'cancelled' })
      throw new LocusError(envelope.error || 'execute_code failed', {
        code: envelope.error,
        responses: [envelope],
      })
    }
    return { output: envelope.message ?? '', progress: lastProgress, cancelled: false }
  } catch (error) {
    // A cancel needs the drain: wait (bounded) for Unity's own terminal answer
    // so the next call does not race the still-running snippet.
    if (cancelled) await Promise.race([run.catch(() => {}), delay(CANCEL_DRAIN_MS)]).catch(() => {})
    throw error
  } finally {
    clearInterval(pollHandle)
    clearTimeout(deadline)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Notes Locus appends when a snippet blocked the editor for a long time. */
export function longBlockNote(maxMainThreadBlockedMs) {
  const ms = Number(maxMainThreadBlockedMs)
  // 15s, matching upstream `UNITY_EXECUTE_LONG_BLOCK_NOTE_MS`. A lower threshold
  // (this used to be 5s) makes ordinary editor work look pathological and trains
  // callers to ignore the note.
  if (!Number.isFinite(ms) || ms < LONG_BLOCK_NOTE_MS) return ''
  return (
    `Note: this snippet held Unity's main thread for ${(ms / 1000).toFixed(1)}s ` +
    '(the editor was frozen meanwhile). Prefer print/ctx.Progress plus await ctx.WaitFrame() for long work.'
  )
}

/** Late `ctx.Progress`/print output that arrived after the execute response. */
export function progressTail(progress) {
  if (!progress || typeof progress !== 'object') return ''
  const parts = []
  if (progress.title) parts.push(String(progress.title))
  if (progress.info) parts.push(String(progress.info))
  return parts.join(' — ')
}

function safeJson(value) {
  try {
    return JSON.parse(value)
  } catch {
    return { raw: value }
  }
}

export { EXECUTE_IDLE_LIMIT_MS, PROGRESS_POLL_MS, CANCEL_DRAIN_MS }
