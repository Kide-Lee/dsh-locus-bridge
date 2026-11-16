// A cooperative "only one session edits this project at a time" lock.
//
// Two agent sessions can be attached to the same Unity project through different
// brokers — or one can be driving the Editor while a human does. Unity itself has
// no such notion, so this module keeps a file inside the project
// (`Library/Locus/session-lock.json`) and everyone who wants exclusive editing
// agrees to read it first.
//
// Upstream reference (`Locus/src-tauri/src/unity_editor_lock.rs`) is the same
// idea with the state kept in the app process: a holder `{session_id, reason,
// acquired_at_unix_ms}`, a FIFO queue of waiters, modes Wait/Try, and separate
// errors for busy / cancelled / timed out. We cannot keep state in process —
// two sessions are two processes — so the state is the file, created atomically.
//
// `Library/` is Unity-generated (git-ignored, never an asset), which is exactly
// where a per-project cache belongs: `src/csharp` assets, run-states output and
// the native-bridge marker already live under `Library/Locus/`.
//
// A stale lock (holder process gone) is broken automatically rather than left to
// block every future session. The pid is only meaningful on the same machine,
// which is the only case that matters: a remote host's project is not shared.

import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Where the lock lives, relative to the project root. */
const LOCK_DIR = join('Library', 'Locus')
const LOCK_FILE = 'session-lock.json'

/** How long one poll waits between re-reads of the lock file. */
const POLL_MS = 250

/**
 * The lock could not be acquired in time.
 *
 * Carries `holder` (the current lock, or null) so the tool can tell the model who
 * is holding it and why, which is the only actionable information here.
 */
export class LockTimeout extends Error {
  constructor(message, { holder = null } = {}) {
    super(message)
    this.name = 'LockTimeout'
    this.holder = holder
  }
}

/**
 * Try to take the project's editing lock.
 *
 * Resolves with `{acquired, holder, acquiredAt, waitedMs}`:
 * - `{acquired: true}` means this owner now holds the lock (and `holder` is this
 *   owner, not the previous one).
 * - In `mode: 'try'` a held lock resolves `{acquired: false, holder}`.
 * - In `mode: 'wait'` (the default) it polls until the timeout, then throws
 *   `LockTimeout` — a caller that asked to wait is not helped by a silent "no".
 *
 * @param {string} projectRoot - absolute Unity project root.
 * @param {{owner: string, mode?: 'wait'|'try', timeoutSeconds?: number, reason?: string}} options
 * @returns {Promise<{acquired: boolean, holder: string|string[]|null, acquiredAt: number|null, waitedMs: number}>}
 */
export async function acquireLock(projectRoot, { owner, mode = 'wait', timeoutSeconds = 300, reason } = {}) {
  const root = requireRoot(projectRoot)
  const name = String(owner ?? '').trim()
  if (name === '') throw new Error('owner is required: name the session taking the lock.')
  const normalizedMode = mode === 'try' ? 'try' : mode === 'wait' || mode === undefined ? 'wait' : null
  if (normalizedMode === null) throw new Error(`mode must be 'wait' or 'try'; got '${mode}'.`)
  const timeoutMs = clampTimeout(timeoutSeconds) * 1000
  const startedAt = Date.now()
  const deadline = startedAt + timeoutMs

  // A lock file that exists but cannot be parsed cannot be honoured by anyone, so
  // it is cleared once up front instead of being raced against every poll (the
  // atomic create would otherwise keep failing on that file).
  if (readLock(root) === null) clearUnusable(root)

  for (;;) {
    const state = readLock(root)
    if (state === null) {
      const taken = tryCreate(root, { owner: name, reason: describeReason(reason), pid: process.pid, acquiredAt: Date.now() })
      if (taken !== null) {
        if (taken.owner !== name) {
          // Another process won the create between our read and our write; its
          // file is the real lock, so keep looking.
          noteConflict(taken, name)
        } else {
          return { acquired: true, holder: name, acquiredAt: taken.acquiredAt, waitedMs: Date.now() - startedAt }
        }
      }
    } else if (state.owner === name) {
      // Re-entrant for the same owner: the session is asking again while it holds
      // the lock (or a crashed flow left its own record behind).
      return { acquired: true, holder: name, acquiredAt: state.acquiredAt, waitedMs: Date.now() - startedAt }
    } else if (isStale(state)) {
      breakStale(root, state)
      continue
    } else if (normalizedMode === 'try') {
      return { acquired: false, holder: state.owner, acquiredAt: state.acquiredAt, waitedMs: Date.now() - startedAt }
    }

    const current = readLock(root)
    if (normalizedMode === 'try') {
      return {
        acquired: false,
        holder: current?.owner ?? null,
        acquiredAt: current?.acquiredAt ?? null,
        waitedMs: Date.now() - startedAt,
      }
    }
    if (Date.now() >= deadline) {
      const held = readLock(root)
      const who = held === null ? 'another process' : `${held.owner}${held.reason ? ` (${held.reason})` : ''}`
      throw new LockTimeout(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the project lock; it is held by ${who}. ` +
          'Ask that session to release it, or call unity_lock with mode "try" to fail immediately.',
        { holder: held?.owner ?? null },
      )
    }
    await sleep(Math.min(POLL_MS, Math.max(1, deadline - Date.now())))
  }
}

/**
 * Release the lock, but only if this owner holds it.
 *
 * Releasing someone else's lock is refused rather than "helpful": an agent that
 * could silently unlock a peer's editing session would make the lock worthless.
 *
 * @param {string} projectRoot
 * @param {{owner: string}} options
 * @returns {Promise<{released: boolean, holder: string|null, reason?: string}>}
 */
export async function releaseLock(projectRoot, { owner } = {}) {
  const root = requireRoot(projectRoot)
  const name = String(owner ?? '').trim()
  if (name === '') throw new Error('owner is required: name the session releasing the lock.')
  const state = readLock(root)
  if (state === null) return { released: false, holder: null, reason: 'no lock is held' }
  if (state.owner !== name) {
    return {
      released: false,
      holder: state.owner,
      reason: `the lock is held by ${state.owner}, not ${name}; only the holder can release it`,
    }
  }
  try {
    unlinkSync(lockPath(root))
    return { released: true, holder: null }
  } catch {
    return { released: false, holder: state.owner, reason: 'the lock file vanished while releasing it' }
  }
}

/**
 * Report the current lock without touching it.
 *
 * @param {string} projectRoot
 * @returns {Promise<{held: boolean, holder: string|null, acquiredAt: number|null, reason: string|null, stale: boolean, path: string}>}
 */
export async function lockStatus(projectRoot) {
  const root = requireRoot(projectRoot)
  const state = readLock(root)
  if (state === null) {
    return { held: false, holder: null, acquiredAt: null, reason: null, stale: false, path: lockPath(root) }
  }
  return {
    held: true,
    holder: state.owner,
    acquiredAt: state.acquiredAt ?? null,
    reason: state.reason ?? null,
    stale: isStale(state),
    path: lockPath(root),
  }
}

// ─── implementation ────────────────────────────────────────────────────────

function requireRoot(projectRoot) {
  const text = String(projectRoot ?? '').trim()
  if (text === '') throw new Error('projectRoot is required.')
  return text
}

function lockPath(root) {
  return join(root, LOCK_DIR, LOCK_FILE)
}

/** `wx` is the atomic step: the create fails when someone else got there first. */
function tryCreate(root, record) {
  const path = lockPath(root)
  try {
    mkdirSync(join(root, LOCK_DIR), { recursive: true })
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
    return record
  } catch (error) {
    if (error?.code === 'EEXIST') return null
    throw error
  }
}

function readLock(root) {
  let text
  try {
    text = readFileSync(lockPath(root), 'utf8')
  } catch {
    return null
  }
  try {
    const value = JSON.parse(text)
    if (typeof value?.owner !== 'string' || value.owner === '') return null
    return value
  } catch {
    // A half-written or hand-edited lock file is not a lock anybody can honour;
    // treating it as absent lets the next acquire replace it.
    return null
  }
}

/**
 * A holder whose process no longer exists cannot still be editing.
 *
 * Only judged for the same machine and the same pid namespace: a pid from another
 * host would be meaningless. `kill(pid, 0)` sends no signal and only probes.
 */
function isStale(state) {
  if (typeof state?.pid !== 'number' || !Number.isSafeInteger(state.pid)) return false
  if (state.pid === process.pid) return false
  try {
    process.kill(state.pid, 0)
    return false
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === 'ESRCH'
  }
}

/** Remove a lock file that exists but carries no owner we could ever honour. */
function clearUnusable(root) {
  try {
    rmSync(lockPath(root), { force: true })
  } catch {
    // Somebody else cleared it first, or it is not removable; the create below
    // reports whatever is really wrong.
  }
}

function breakStale(root, state) {
  try {
    rmSync(lockPath(root), { force: true })
  } catch {
    // Racing with another breaker is fine: somebody else removed it first.
  }
  noteStale(state)
}

/** Diagnostic line, not a warning: breaking a stale lock is normal. */
function noteStale(state) {
  process.stderr.write(`locus: broke a stale project lock held by ${state?.owner ?? 'unknown'} (pid ${state?.pid ?? '?'} is gone)\n`)
}

function noteConflict(state, name) {
  process.stderr.write(`locus: ${state?.owner ?? 'another session'} took the project lock before ${name}\n`)
}

function describeReason(reason) {
  const text = String(reason ?? '').trim()
  return text === '' ? null : text.slice(0, 500)
}

function clampTimeout(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value)) return 300
  return Math.min(900, Math.max(1, Math.trunc(value)))
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}