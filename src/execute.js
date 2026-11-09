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
  parseStatusMessage,
} from './protocol.js'
import { LocusError } from './locus-client.js'

const PROGRESS_POLL_MS = 250
const CANCEL_DRAIN_MS = 500
const STATUS_TIMEOUT_MS = 5_000
const BUDGET_GRACE_MS = 60_000

export const UNITY_EXECUTE_CANCELLED = '__locus_execute_cancelled__'

/** Read the canonical editor status; returns `disconnected` instead of throwing. */
export async function readEditorStatus(client, { timeoutMs = STATUS_TIMEOUT_MS } = {}) {
  try {
    const envelope = await client.request('status', '', { timeoutMs })
    if (!envelope.ok) {
      return { connected: false, status: EDITOR_STATUS_DISCONNECTED, scenes: [], error: envelope.error }
    }
    return { connected: true, ...parseStatusMessage(envelope.message) }
  } catch (error) {
    return { connected: false, status: EDITOR_STATUS_DISCONNECTED, scenes: [], error: error.message }
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

  const poll = async () => {
    if (pollInFlight) return
    pollInFlight = true
    try {
      const envelope = await client.request('execute_code_progress', executionId, { timeoutMs: 5_000 })
      if (envelope.ok && envelope.message) {
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

  try {
    void poll()
    pollHandle = setInterval(poll, PROGRESS_POLL_MS)
    const envelope = await Promise.race([run, cancelPromise, timedOut])
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
  if (!Number.isFinite(ms) || ms < 5_000) return ''
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
