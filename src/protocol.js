// Locus wire protocol constants and helpers.
//
// Mirrors:
//   crates/locus-native-protocol/src/{envelope,errors,capabilities}.rs
//   locus_unity/Editor/LocusBridge*.cs   (managed executor answers)
//
// One connection carries newline-delimited JSON envelopes. `message` is
// ALWAYS a string; structured parameters are JSON.stringify()-ed into it.

/** Envelope type of a response to a request (`reply_to` names the request). */
export const RESPONSE_KIND = 'response'
/** Broker event: the managed executor queued a request (`message` = JSON). */
export const REQUEST_ACCEPTED_EVENT = 'locus-request-accepted'

/** Error codes the broker answers itself (crates/locus-native-protocol/src/errors.rs). */
export const BROKER_ERRORS = Object.freeze({
  MANAGED_RELOADING: 'managed_reloading',
  MANAGED_NOT_READY: 'managed_not_ready',
  QUEUE_FULL: 'native_queue_full',
  INFLIGHT_FULL: 'native_inflight_full',
  PAYLOAD_TOO_LARGE: 'native_payload_too_large',
  REQUEST_TIMED_OUT: 'native_request_timed_out',
  MAIN_THREAD_UNRESPONSIVE: 'native_main_thread_unresponsive',
  RELOAD_INTERRUPTED: 'domain_reload_interrupted',
  STACK_FAILED: 'main_thread_stack_failed',
  INVALID_REQUEST: 'native_invalid_request',
  UNITY_PROCESS_EXITING: 'unity_process_exiting',
})

/** The request never reached the host's executor, so retrying it is safe. */
const NOT_EXECUTED = new Set([
  BROKER_ERRORS.MANAGED_RELOADING,
  BROKER_ERRORS.MANAGED_NOT_READY,
  BROKER_ERRORS.QUEUE_FULL,
  BROKER_ERRORS.INFLIGHT_FULL,
  BROKER_ERRORS.PAYLOAD_TOO_LARGE,
  BROKER_ERRORS.MAIN_THREAD_UNRESPONSIVE,
  BROKER_ERRORS.UNITY_PROCESS_EXITING,
])

export function isNotExecuted(code) {
  return NOT_EXECUTED.has(String(code ?? '').trim())
}

export function isReloading(code) {
  const value = String(code ?? '').trim()
  return value === BROKER_ERRORS.MANAGED_RELOADING || value === BROKER_ERRORS.RELOAD_INTERRUPTED
}

/** Capability identifiers a client may gate on (`bridge_capabilities`). */
export const CAPABILITIES = Object.freeze({
  BROKER_V1: 'broker_v1',
  REQUEST_ACCEPTED_V1: 'broker_request_accepted_v1',
  MULTI_CLIENT_V1: 'broker_multi_client_v1',
  MAIN_THREAD_LIVENESS_V1: 'broker_main_thread_liveness_v1',
  MAIN_THREAD_STACK_V1: 'broker_main_thread_stack_v1',
  EXECUTION_CANCEL_V1: 'broker_execution_cancel_v1',
  EXECUTION_PROGRESS_V1: 'broker_execution_progress_v1',
  REQUEST_STATE_V1: 'broker_request_state_v1',
  COMPILE_RESULT_V1: 'broker_compile_result_v1',
})

export function splitCapabilities(capabilities) {
  return String(capabilities ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
}

/** Execute-code sentinel comments scanned by Unity (`unity_execute_code_with_markers`). */
export const EXECUTION_ID_MARKER = '//__LOCUS_EXECUTION_ID__:'
export const TIMEOUT_MARKER = '//__LOCUS_TIMEOUT_MS__:'

/** Total run budget of one execution (`unity_execute` `timeout`, clamped by Locus). */
export const EXECUTE_DEFAULT_TIMEOUT_MS = 600_000
export const EXECUTE_MIN_TIMEOUT_MS = 1_000
export const EXECUTE_MAX_TIMEOUT_MS = 3_600_000
/** Unity stops a snippet that produces no output for this long (`ExecuteTimeoutMs`). */
export const EXECUTE_IDLE_LIMIT_MS = 30_000

export function clampExecuteTimeout(timeoutMs) {
  const value = Number.isFinite(timeoutMs) ? Math.trunc(timeoutMs) : EXECUTE_DEFAULT_TIMEOUT_MS
  return Math.min(EXECUTE_MAX_TIMEOUT_MS, Math.max(EXECUTE_MIN_TIMEOUT_MS, value))
}

/** Append the execution-id / timeout sentinels the managed executor scans for. */
export function executePayload(code, { executionId, timeoutMs } = {}) {
  let payload = String(code ?? '').trimEnd()
  if (executionId) payload += `\n${EXECUTION_ID_MARKER}${executionId}`
  if (Number.isFinite(timeoutMs)) payload += `\n${TIMEOUT_MARKER}${Math.trunc(timeoutMs)}`
  return payload
}

// ─── enable_non_public_access ────────────────────────────────────────────────

/**
 * Upstream implements non-public access entirely on the **compiler** side: its
 * compile server compiles the snippet with `MetadataImportOptions.All`, an
 * `IgnoresAccessChecksTo` allow-list over the reference set and (in the
 * production mode) `SkipVerification`. It never prepends anything to the
 * snippet source — and the in-editor Roslyn path has no such mechanism at all.
 *
 * This bridge compiles snippets in the editor, so it cannot offer the
 * capability. It must therefore not fake it either: an earlier version
 * prepended `using __LocusNonPublicAccess.<assembly>;` lines, which no Unity
 * assembly defines, so every snippet failed to compile (CS0246) while the
 * argument claimed the opposite. The honest behaviour is what upstream does
 * when its compile server is unavailable: report the limitation and compile the
 * snippet as written (`enable_non_public_access` is accepted for schema
 * compatibility and the private access itself stays unavailable).
 *
 * The bundled sidecar (tools/dsh-finish/Compiler) does not provide this either.
 * `MetadataImportOptions.All` would only make private member *metadata* visible
 * to Roslyn; the compile would still fail on accessibility, because the
 * `IgnoresAccessChecksTo` allow-list it would need only takes effect in a
 * runtime that skips accessibility verification — and a snippet runs in the
 * editor's Mono domain, which does not.
 */
export const NON_PUBLIC_ACCESS_LIMITATION =
  'Private and internal members are not accessible from snippets in this bridge: it compiles them ' +
  "with the editor's own Roslyn, which has no IgnoresAccessChecksTo allow-list (upstream needs its " +
  'CoreCLR compile server for that). The snippet is compiled exactly as written; use reflection for ' +
  'non-public members.'

/**
 * Resolve upstream's `resolve_tool_non_public_access`: an omitted parameter
 * means true, anything but a boolean is rejected, and the user's global switch
 * always wins.
 *
 * @param value - the raw argument (`undefined` when the model omitted it).
 * @param opts.globalEnabled - the global Hot Reload & Compile switch.
 * @returns `true` only when both the call and the global switch ask for it.
 */
export function resolveNonPublicAccess(value, { globalEnabled = true } = {}) {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new TypeError('enable_non_public_access must be a boolean when provided.')
  }
  const requested = value === undefined ? true : value
  return Boolean(globalEnabled) && requested
}


/** Editor status values (`editing`, `playing`, `playing_paused`), plus `disconnected` for clients. */
export const EDITOR_STATUSES = Object.freeze(['editing', 'playing', 'playing_paused'])
export const EDITOR_STATUS_DISCONNECTED = 'disconnected'

export function isKnownEditorStatus(status) {
  return EDITOR_STATUSES.includes(status) || status === EDITOR_STATUS_DISCONNECTED
}

/**
 * Parse a `status` response message: `"editing|Assets/Scenes/Main.unity|Other.unity"`.
 * Returns the canonical status plus every open scene path (active first).
 */
export function parseStatusMessage(message) {
  const [rawStatus = '', ...sceneParts] = String(message ?? '').split('|')
  const status = isKnownEditorStatus(rawStatus.trim()) ? rawStatus.trim() : EDITOR_STATUS_DISCONNECTED
  const scenes = []
  for (const part of sceneParts) {
    const scene = part.trim()
    if (!scene) continue
    if (!scenes.some((existing) => existing.toLowerCase() === scene.toLowerCase())) scenes.push(scene)
  }
  return { status, scenes, activeScene: scenes[0] ?? null }
}
