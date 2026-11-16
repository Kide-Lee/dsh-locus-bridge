// Editor health: "is the editor stuck, and if so where?" (contracts.md §4.3)
//
// The single most frustrating Locus failure is a Unity main thread that stops
// pumping: every `unity_*` call times out, and the client cannot tell a slow
// import from a dead editor. This module gathers the evidence the native broker
// already has and turns it into one answer plus one sentence a human can read.
//
// Everything here is *evidence*, never a guess. Each tier says whether it could
// be measured; a tier that could not is reported with its reason instead of a
// default value. That rule is why `responsive` is `false` only when there is
// positive evidence of a stall, and `null` when nothing could be observed:
// claiming a hang we cannot see is just as dishonest as hiding one.
//
// The three trailing pieces of contracts.md §4.3 arrive the same way: the
// background hook is the broker's in-process `IsApplicationActive` patch, the
// state probe is the tiered T1/T2/T3 report, and the compiler entry is the
// editor's own phase snapshot (`dsh_health_snapshot`), which is the only source
// that knows *what* the editor is doing.

import { LocusError } from './locus-client.js'

/**
 * How long the managed main thread may go without a heartbeat before it counts
 * as unresponsive. Must match `native::broker::UNRESPONSIVE_AFTER_MS` and
 * Locus' Windows-side `MAIN_THREAD_UNRESPONSIVE_MS`, otherwise the client and
 * the broker disagree about the same editor.
 */
export const UNRESPONSIVE_AFTER_MS = 30_000

/**
 * Main-thread CPU above which a stall is "busy" (running code) rather than
 * "waiting" (blocked on a lock, a dialog, or an external process). Matches
 * `BUSY_CPU_PERCENT` in native/locus_unix_native/src/hang/mod.rs, which is a
 * port of Locus' `unity_bridge::hang_diagnosis::BUSY_CPU_PERCENT`.
 */
export const BUSY_CPU_PERCENT = 25.0

/** Requests that ask the native broker for health; none of them hit Unity code. */
export const HEALTH_REQUEST = 'dsh_health'
export const HEALTH_SNAPSHOT_REQUEST = 'dsh_health_snapshot'
export const HEALTH_SUBSCRIBE_REQUEST = 'dsh_health_subscribe'
export const MAIN_THREAD_STACK_REQUEST = 'dsh_main_thread_stack'
/** Flip the background scheduling hook; message is `1` or `0`. */
export const SET_BACKGROUND_HOOK_REQUEST = 'dsh_set_background_hook'

/** Capability the Unix broker advertises for the three health requests above. */
export const EDITOR_HEALTH_CAPABILITY = 'broker_editor_health_v1'

/** The stack request must never sit in front of a stuck editor for long. */
const STACK_TIMEOUT_MS = 20_000

/** The health request is answered natively; it should be fast even when wedged. */
const HEALTH_TIMEOUT_MS = 5_000

/** Flipping the hook writes a code page; it is native and fast, but not instant. */
const HOOK_TIMEOUT_MS = 10_000

/** One phase report older than this is history, not evidence of the present. */
const PHASE_STALE_AFTER_MS = 5_000

/**
 * Turn a broker error into one sentence about the editor, or `null` when the
 * error has nothing to do with the editor being wedged.
 *
 * `client-pool.js` calls this while wrapping a failed request, so the message a
 * model reads says "the editor is probably stuck in <phase>" instead of a bare
 * `native_request_timed_out`. It must stay free of awaits: it runs inside an
 * error handler on a request that has already burned its timeout.
 *
 * The same truthfulness rule applies: with no evidence attached to the error
 * this returns `null` rather than inventing a diagnosis. `error.health` (the
 * `editorHealth` snapshot, when the caller had one) is the only evidence used.
 */
export function explainUnresponsive(error) {
  if (!error) return null

  const code = typeof error.code === 'string' ? error.code : null
  const timedOut =
    code === 'native_request_timed_out' ||
    code === 'native_main_thread_unresponsive' ||
    (code === null && /timed? ?out|timeout/i.test(String(error.message ?? '')))
  const notExecuted = typeof error.notExecuted === 'boolean' ? error.notExecuted : undefined

  // A request the editor provably never started is the interesting case: it
  // means the main thread was not draining its queue, not that the snippet is
  // slow.
  const health = error.health && typeof error.health === 'object' ? error.health : null

  if (!timedOut && notExecuted !== true) return null
  if (!health) {
    // No evidence: say what is known (nothing ran) and what is not (whether the
    // editor is stuck). Callers add the pipe and the remedy themselves.
    if (notExecuted === true) {
      return (
        'The request never reached the editor main thread. That usually means the editor is busy or stuck, ' +
        'but this error carries no health snapshot, so it cannot be confirmed: run unity_status to check.'
      )
    }
    return null
  }

  const diagnosis = describeHealth(health)
  if (health.responsive === true) {
    return (
      `The editor main thread is responding (${diagnosis}), so the timeout came from somewhere else: ` +
      'the request may be genuinely slow or the socket may be delayed.'
    )
  }
  if (health.responsive === null || health.responsive === undefined) {
    return `The editor did not answer, and its health could not be measured (${diagnosis}).`
  }
  return `The Unity editor is stuck: ${diagnosis}. ${remedy(health)}`
}

/**
 * Ask the editor how it is doing (contracts.md §4.3).
 *
 * `target` is a `{ projectRoot, pipe }` describe from `client-pool.js`. The
 * `getClient` dependency is injected so tests can supply a client over the fake
 * broker without a real pool; production callers pass the pool's own `getClient`.
 *
 * Result shape (attached to `unity_status` as `editorHealth`):
 *   { supported, responsive, stuckAt?, phase?, cpuPercent?, diagnosis?,
 *     backgroundHook, stateProbe, compiler }
 *
 * `supported` is true when at least one tier could be measured. `responsive` is
 * `true` / `false` only on evidence and `null` when nothing was observed.
 */
export async function editorHealth(target, { getClient, captureStack = true } = {}) {
  const connect = getClient ?? (await defaultGetClient())
  const client = await connect(target)

  const probe = normalizeHealth(await requestHealth(client))

  // Decide from the composed report, not the raw probe: `responsive` is only
  // known once the evidence has been weighed. The stack is asked for only when
  // the editor looks stuck, because capturing it freezes the main thread
  // briefly and a healthy editor must not pay for that.
  const health = composeHealth(probe, null)
  if (!captureStack || health.responsive !== false) return health

  const diagnosis = await requestStack(client)
  // Recompose so the diagnosis sentence and `stuckAt` agree with the frames.
  return composeHealth(probe, diagnosis)
}

/**
 * Turn the background scheduling hook on or off (contracts.md §4.2/§4.3).
 *
 * The hook patches Unity's `IsApplicationActive` so the editor keeps its update
 * loop running when it is not the focused window. Only the Windows broker can
 * patch it; the Unix broker answers a documented "unsupported" and this returns
 * `{ supported: false, reason }` rather than pretending it worked.
 */
export async function enableBackgroundHook(target, enabled, { getClient } = {}) {
  const connect = getClient ?? (await defaultGetClient())
  const client = await connect(target)

  // Ask the broker to flip the patch, then re-read health: the answer to
  // "did it really apply" is the snapshot, never the fact that a request was
  // accepted. An older broker answers `unknown message type`, which must degrade
  // to "not supported" rather than throw.
  let hook = null
  try {
    const answer = await client.request(SET_BACKGROUND_HOOK_REQUEST, enabled ? '1' : '0', { timeoutMs: HOOK_TIMEOUT_MS })
    hook = normalizeHook(parseHookAnswer(answer))
  } catch (error) {
    if (!isUnknownRequest(error)) throw error
  }

  const health = normalizeHealth(await requestHealth(client))
  const current = hook ?? health.backgroundHook

  if (!current.supported) {
    return {
      supported: false,
      enabled: Boolean(enabled),
      patched: false,
      state: current.state ?? 'unsupported',
      reason: current.error ?? 'this platform cannot patch the Unity background scheduling hook',
      backgroundHook: current,
    }
  }

  return {
    supported: true,
    enabled: Boolean(enabled),
    patched: current.patched === true,
    state: current.state ?? 'unknown',
    reason: current.error ?? null,
    backgroundHook: current,
  }
}

// ─────────────────────────────── helpers ───────────────────────────────

let cachedDefault = null

/** Resolve `client-pool.js` lazily: it imports this module, so a static import would cycle. */
async function defaultGetClient() {
  if (!cachedDefault) cachedDefault = await import('./client-pool.js')
  return cachedDefault.getClient
}

/** Parse the answer of `dsh_set_background_hook`: the raw hook snapshot. */
function parseHookAnswer(frame) {
  return decodeJson(frame, SET_BACKGROUND_HOOK_REQUEST)
}

/** An older broker rejects a request it does not know; that is not a failure. */
function isUnknownRequest(error) {
  return /unknown message type|unknown command|unsupported request|unknown request/i.test(error?.message ?? '')
}

async function requestHealth(client) {
  const frame = await client.request(HEALTH_REQUEST, '', { timeoutMs: HEALTH_TIMEOUT_MS })
  return decodeJson(frame, 'dsh_health')
}

async function requestStack(client) {
  try {
    const frame = await client.request(MAIN_THREAD_STACK_REQUEST, '', { timeoutMs: STACK_TIMEOUT_MS })
    if (frame.ok === false) {
      return { status: 'unavailable', summary: `the broker could not capture the stack (${frame.error})` }
    }
    return decodeJson(frame, 'dsh_main_thread_stack')
  } catch (error) {
    // A stack capture that fails is missing evidence, not a health failure.
    return { status: 'unavailable', summary: `the stack could not be captured (${error.message})` }
  }
}

function decodeJson(frame, what) {
  if (frame?.ok === false) throw new LocusError(`${what} failed: ${frame.error}`, { code: frame.error ?? null })
  const text = typeof frame?.message === 'string' ? frame.message : ''
  try {
    return JSON.parse(text)
  } catch {
    throw new LocusError(`${what} returned a non-JSON answer: ${JSON.stringify(text)}`)
  }
}

/**
 * Read the broker's `dsh_health` payload into the fields the client reasons
 * about. Everything missing stays `null`/`undefined`; nothing is defaulted to a
 * value that could be mistaken for a measurement.
 */
export function normalizeHealth(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new LocusError('dsh_health returned no report')
  }

  const tiers = raw.tiers && typeof raw.tiers === 'object' ? raw.tiers : {}
  const phase = raw.phase && typeof raw.phase === 'object' ? raw.phase : { supported: false, freshness: 'missing' }
  const liveness = raw.liveness && typeof raw.liveness === 'object' ? raw.liveness : { supported: false }
  const hook = normalizeHook(raw.backgroundHook)

  const heartbeatAgeMs = numberOrNull(raw.heartbeatAgeMs)
  const cpuPercent = numberOrNull(raw.cpuPercent)

  return {
    pid: numberOrNull(raw.pid),
    processPath: typeof raw.processPath === 'string' ? raw.processPath : null,
    managedState: typeof raw.managedState === 'string' ? raw.managedState : null,
    editorStatus: typeof raw.editorStatus === 'string' ? raw.editorStatus : null,
    mainThreadId: numberOrNull(raw.mainThreadId),
    heartbeatAgeMs,
    cpuPercent,
    cpuWindowMs: numberOrNull(raw.cpuWindowMs),
    // The probe's own verdict first; the raw age is the fallback evidence.
    unresponsive:
      raw.unresponsive === true ||
      (heartbeatAgeMs !== null && heartbeatAgeMs >= UNRESPONSIVE_AFTER_MS),
    phase: {
      supported: phase.supported === true,
      freshness: typeof phase.freshness === 'string' ? phase.freshness : 'missing',
      phase: typeof phase.phase === 'string' ? phase.phase : null,
      sinceMs: numberOrNull(phase.since_ms ?? phase.sinceMs),
      ageMs: numberOrNull(phase.age_ms ?? phase.ageMs),
      playing: phase.playing === true,
      paused: phase.paused === true,
      compiling: phase.compiling === true,
      updating: phase.updating === true,
      importing: phase.importing === true,
      modalDialog: typeof phase.modal_dialog === 'boolean' ? phase.modal_dialog : null,
    },
    liveness: {
      supported: liveness.supported !== false,
      state: typeof liveness.state === 'string' ? liveness.state : 'unknown',
      zombie: liveness.zombie === true,
    },
    tiers: {
      t1: tiers.t1 ?? { supported: false },
      t2: tiers.t2 ?? { supported: false },
      t3: tiers.t3 ?? { supported: false },
    },
    notes: Array.isArray(raw.notes) ? raw.notes.filter((note) => typeof note === 'string') : [],
    backgroundHook: hook,
    stackSupport: raw.stackSupport ?? { supported: false, reason: 'the broker did not report stack support' },
  }
}

function normalizeHook(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      supported: false,
      enabled: false,
      patched: false,
      state: 'unsupported',
      symbolCount: 0,
      error: 'the broker did not report a background hook',
    }
  }
  return {
    supported: raw.supported === true,
    enabled: raw.enabled === true,
    patched: raw.patched === true,
    state: typeof raw.state === 'string' ? raw.state : 'unknown',
    symbolCount: numberOrNull(raw.symbolCount) ?? 0,
    error: typeof raw.error === 'string' ? raw.error : null,
  }
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Fold the probe report plus the stack diagnosis into the `editorHealth` shape.
 *
 * The three extra blocks of §4.3 map onto what was measured:
 *   `stateProbe`   – the tiered T1/T2/T3 report (what the probe could see);
 *   `compiler`     – the editor's own phase snapshot (compiling/importing/...);
 *   `backgroundHook` – the scheduling-hook patch state.
 */
export function composeHealth(health, stack) {
  const diagnosis = stack && typeof stack === 'object' ? stack : null
  const stuckAt = diagnosis && diagnosis.status === 'complete' ? (diagnosis.location ?? null) : null

  const supported =
    health.tiers.t1.supported === true ||
    health.tiers.t2.supported === true ||
    health.tiers.t3.supported === true
  const evidence = health.heartbeatAgeMs !== null || health.cpuPercent !== null || health.phase.freshness === 'fresh'
  const responsive = health.unresponsive === true ? false : evidence ? true : null

  return {
    supported,
    responsive,
    ...(stuckAt ? { stuckAt } : {}),
    ...(health.phase.phase ? { phase: health.phase.phase } : {}),
    ...(health.cpuPercent !== null ? { cpuPercent: health.cpuPercent } : {}),
    // Heartbeat age and liveness are repeated at the top level (they also live
    // under stateProbe) so `describeHealth`/`explainUnresponsive` can read one
    // shape: the composed object is what error decoration attaches.
    heartbeatAgeMs: health.heartbeatAgeMs,
    liveness: health.liveness,
    // The sentence a model reads first; explainUnresponsive builds the same text
    // for a timeout, so both describe the same state the same way.
    diagnosis: describeHealth({ ...health, responsive, stuckAt }, diagnosis),
    backgroundHook: health.backgroundHook,
    stateProbe: {
      supported,
      tiers: health.tiers,
      pid: health.pid,
      processPath: health.processPath,
      managedState: health.managedState,
      mainThreadId: health.mainThreadId,
      heartbeatAgeMs: health.heartbeatAgeMs,
      cpuPercent: health.cpuPercent,
      cpuWindowMs: health.cpuWindowMs,
      liveness: health.liveness,
      phase: health.phase,
      notes: health.notes,
      stackSupport: health.stackSupport,
    },
    compiler: {
      supported: health.phase.supported,
      freshness: health.phase.freshness,
      phase: health.phase.phase,
      sinceMs: health.phase.sinceMs,
      // `ageMs` is what makes "stale" mean something: without it a reader can
      // only say "stale", not "stale by two minutes".
      ageMs: health.phase.ageMs,
      compiling: health.phase.compiling,
      updating: health.phase.updating,
      importing: health.phase.importing,
      playing: health.phase.playing,
      paused: health.phase.paused,
      modalDialog: health.phase.modalDialog,
    },
  }
}

/**
 * One sentence about what the evidence says. Order matters: a stale or missing
 * phase is stated first, because every later claim is weaker without it.
 */
export function describeHealth(health, stack = null) {
  const parts = []
  // Same tolerance as remedy(): flat probe report or composed `editorHealth`.
  const phaseReport = health.compiler ?? health.phase ?? {}
  const liveness = health.liveness ?? health.stateProbe?.liveness
  const tiers = health.stateProbe?.tiers ?? health.tiers ?? {}

  if (phaseReport.freshness === 'fresh' && phaseReport.phase) {
    parts.push(`phase ${phaseReport.phase}`)
  } else if (phaseReport.freshness === 'stale') {
    const age = phaseReport.ageMs
    parts.push(`last phase report is stale${age === null ? '' : ` (${Math.round(age / 1000)} s old)`}`)
  } else if (phaseReport.supported) {
    parts.push('no phase report yet, so what the editor is doing is unknown')
  } else {
    parts.push('the editor phase cannot be reported on this platform')
  }

  if (health.heartbeatAgeMs !== null && health.heartbeatAgeMs !== undefined) {
    if (health.heartbeatAgeMs >= UNRESPONSIVE_AFTER_MS) {
      parts.push(`main-thread heartbeat stopped ${Math.round(health.heartbeatAgeMs / 1000)} s ago`)
    } else {
      parts.push('the main-thread heartbeat is current')
    }
  } else {
    parts.push('the main thread has not heartbeat yet')
  }

  if (health.cpuPercent !== null && health.cpuPercent !== undefined) {
    const verdict = health.cpuPercent >= BUSY_CPU_PERCENT ? 'busy running code' : 'mostly waiting'
    parts.push(`main-thread CPU ${health.cpuPercent.toFixed(0)}% (${verdict})`)
  } else if (tiers.t2?.supported === false) {
    parts.push('CPU activity is not measurable here')
  } else {
    parts.push('CPU activity is not known yet')
  }

  if (liveness) {
    if (liveness.state === 'gone') parts.push('the editor process is gone')
    else if (liveness.zombie) parts.push('the editor process is a zombie')
  }

  if (phaseReport.modalDialog === true) parts.push('a modal dialog is open')

  if (stack && stack.status === 'complete' && stack.location) {
    parts.push(`stuck at ${stack.location}`)
  } else if (health.stuckAt) {
    parts.push(`stuck at ${health.stuckAt}`)
  }

  return parts.join('; ')
}

/** What a human should try next, ordered by how likely it is to help. */
export function remedy(health) {
  // Accept both shapes: the composed `editorHealth` object (which nests the
  // probe under `stateProbe`/`compiler`) and the flat normalized probe report.
  const liveness = health.liveness ?? health.stateProbe?.liveness
  const phaseReport = health.compiler ?? health.phase ?? {}
  if (liveness?.state === 'gone' || liveness?.zombie) {
    return 'Restart Unity: the process is no longer running the editor loop.'
  }
  const phase = phaseReport.phase
  const stale = phaseReport.freshness !== 'fresh'
  if (phase === 'importing' || phase === 'compiling' || phase === 'updating') {
    return `The editor is still working (${phase}). Wait for it to finish; if it has not moved in minutes, check the Console and the Editor.log.`
  }
  if (phase === 'reloading') {
    return 'A script reload is in progress. Wait for it to finish; a reload that never ends usually means a compile error in the Console.'
  }
  if (phaseReport.modalDialog === true) {
    return 'An editor dialog is open and blocking the main thread. Answer it in the Unity window.'
  }
  if (health.cpuPercent !== null && health.cpuPercent >= BUSY_CPU_PERCENT) {
    return 'The editor is running code on its main thread and has not returned. Look at the stack frames for the code that is running.'
  }
  if (stale) {
    return 'The editor is not reporting; check whether its window is responsive, and look at Editor.log if it is not.'
  }
  return 'The editor main thread is blocked. Look at the stack frames for what it is waiting on.'
}