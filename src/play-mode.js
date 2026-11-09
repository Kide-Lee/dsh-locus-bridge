// The `unity_set_play_mode` flow: request the target state, then poll `status`
// until the editor reports it (documented 30s budget in the desktop client).

import { readEditorStatus } from './execute.js'
import { parseStatusMessage } from './protocol.js'

const POLL_INTERVAL_MS = 250
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
export async function setPlayMode(client, mode, { signal } = {}) {
  const { message, desired } = statusForMode(mode)
  const before = await readEditorStatus(client)
  if (!before.connected) {
    throw new Error(`Unity Editor is unavailable${before.error ? `: ${before.error}` : ''}.`)
  }
  if (desired.includes(before.status)) {
    return { mode, changed: false, status: before.status, scenes: before.scenes }
  }

  const envelope = await client.request('set_editor_status', message, { timeoutMs: 35_000 })
  if (!envelope.ok) {
    throw new Error(envelope.error || `set_editor_status(${message}) failed`)
  }

  const deadline = Date.now() + PLAY_MODE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('cancelled')
    await delay(POLL_INTERVAL_MS, signal)
    const current = await readEditorStatus(client)
    if (current.status === 'disconnected') {
      throw new Error(`Unity Editor disconnected while entering "${mode}" mode.`)
    }
    if (desired.includes(current.status)) {
      return { mode, changed: true, status: current.status, scenes: current.scenes }
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
