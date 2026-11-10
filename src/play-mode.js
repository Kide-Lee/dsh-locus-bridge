// The `unity_set_play_mode` flow: request the target state, then poll `status`
// until the editor reports it (documented 30s budget in the desktop client).
//
// Entering or leaving Play Mode reloads the scripting domain on the default
// settings, so the broker connection drops mid-flight and a fresh one appears a
// moment later. That is the expected path, not a failure: `reconnect` supplies a
// new client and polling continues against it.

import { readEditorStatus } from './execute.js'
import { LocusError } from './locus-client.js'
import { parseStatusMessage } from './protocol.js'

const POLL_INTERVAL_MS = 250
/** Upstream `set_editor_status` waits at most 30s, polling every 250ms. */
const PLAY_MODE_TIMEOUT_MS = 30_000

/** Map the public tool mode (`play` / `edit`) to an editor status request. */
export function statusForMode(mode) {
  if (mode === 'play') return { message: 'playing', desired: ['playing', 'playing_paused'] }
  if (mode === 'edit') return { message: 'editing', desired: ['editing'] }
  throw new Error(`Invalid mode '${mode}'. Allowed values: play, edit.`)
}

/**
 * Change Play Mode and wait for convergence.
 * @returns {{ mode: string, changed: boolean, status: string, scenes: string[] }}
 */
export async function setPlayMode(client, mode, { signal, reconnect } = {}) {
  const { message, desired } = statusForMode(mode)
  const before = await readEditorStatus(client)
  if (!before.connected) {
    // Carry the broker's code so the shared retry layer can tell a reload apart
    // from a real outage. A bare Error was invisible to it, which is why
    // unity_play_mode failed outright right after a compile while every tool
    // going through withClient recovered.
    throw new LocusError(
      `Unity Editor is unavailable${before.error ? `: ${before.error}` : ''}.`,
      { code: before.error ?? null },
    )
  }
  if (desired.includes(before.status)) {
    return { mode, changed: false, status: before.status, scenes: before.scenes }
  }

  const envelope = await client.request('set_editor_status', message, { timeoutMs: 35_000 })
  if (!envelope.ok) {
    throw new Error(envelope.error || `set_editor_status(${message}) failed`)
  }

  const deadline = Date.now() + PLAY_MODE_TIMEOUT_MS
  let active = client
  let reconnects = 0
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('cancelled')
    await delay(POLL_INTERVAL_MS, signal)
    const current = await readEditorStatus(active)
    if (current.status === 'disconnected') {
      // A domain reload is dropping the transport; reconnect and keep waiting
      // instead of reporting a failure the caller cannot act on.
      if (!reconnect) {
        throw new Error(`Unity Editor disconnected while entering "${mode}" mode.`)
      }
      // No attempt cap: upstream `set_editor_status` just polls until its 30s
      // budget runs out. A fixed limit (this used to be 8) made a large project
      // fail with "kept disconnecting" even though Play Mode had been entered —
      // the budget below is the only real bound.
      reconnects += 1
      try {
        active = await reconnect()
      } catch (error) {
        // The editor may still be reloading: retry until the deadline.
        continue
      }
      continue
    }
    if (desired.includes(current.status)) {
      return { mode, changed: true, status: current.status, scenes: current.scenes, reconnects }
    }
  }
  throw new Error(`Timed out after ${PLAY_MODE_TIMEOUT_MS / 1000}s waiting for Unity Editor mode "${mode}".`)
}

/** Human-readable result wording aligned with Locus. */
export function playModeMessage({ mode, changed, status }) {
  if (mode === 'play') {
    return changed ? 'Unity Editor entered Play Mode (playing).' : 'Unity Editor is already in Play Mode (playing).'
  }
  return changed ? 'Unity Editor returned to Edit Mode (editing).' : 'Unity Editor is already in Edit Mode (editing).'
}

/** Parse a status message for callers that already have one. */
export { parseStatusMessage }

function delay(ms, signal) {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', done)
      resolve()
    }
    signal?.addEventListener?.('abort', done, { once: true })
  })
}
