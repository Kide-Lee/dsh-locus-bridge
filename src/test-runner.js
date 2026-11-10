// Unity Test Framework runs over the Locus bridge.
//
// Ported from `Locus/src-tauri/src/unity_bridge/mod.rs::unity_test_run_controlled`
// and the Rust `unity_test_list` wrapper. The Unity half already ships with the
// payload (`Editor/Testing/LocusUnityTestService.cs` registers four extension
// commands), so this module only drives them:
//
//   unity_test_list    {mode, assemblies, tests, groups, categories, max_results}
//   unity_test_start   the same filter + result_detail + run_id  → a snapshot
//   unity_test_status  {run_id}                                  → a snapshot
//   unity_test_cancel  {run_id}                                  → a snapshot
//
// A run is terminal at passed / failed / cancelled / error. Cancellation is a
// separate round trip and is confirmed by polling until terminal, exactly as the
// Rust side does; a timeout cancels too, so a lost caller never leaves a run
// holding the editor.

import { LocusError } from './locus-client.js'

/** Status poll cadence; the Rust client uses the same 250 ms. */
export const TEST_POLL_MS = 250
/** Attempts to observe a cancelled run reaching a terminal state (Rust: 30 s). */
const CANCEL_CONFIRM_TIMEOUT_MS = 30_000
const LIST_TIMEOUT_MS = 120_000
const START_TIMEOUT_MS = 30_000
const STATUS_TIMEOUT_MS = 30_000
const CANCEL_TIMEOUT_MS = 30_000
const TERMINAL = new Set(['passed', 'failed', 'cancelled', 'error'])
export const TEST_MODES = ['edit', 'play', 'edit|play']
export const RESULT_DETAILS = ['summary', 'failures', 'all']
const RESULT_LIMIT_MAX = 5000
const DEFAULT_RESULT_LIMIT = 500

export const UNITY_TEST_CANCELLED = '__locus_test_cancelled__'

/** Whether one snapshot status is final. */
export function isTerminalStatus(status) {
  return TERMINAL.has(String(status ?? ''))
}

/** Build the filter shared by list and start; omitted fields stay omitted. */
export function buildTestFilter({
  mode,
  assemblies,
  tests,
  groups,
  categories,
  maxResults,
  resultDetail,
} = {}) {
  const filter = {}
  if (mode !== undefined && mode !== null && mode !== '') {
    if (!TEST_MODES.includes(mode)) throw new Error(`mode must be one of ${TEST_MODES.join(', ')}.`)
    filter.mode = mode
  }
  for (const [key, value] of Object.entries({ assemblies, tests, groups, categories })) {
    if (value === undefined || value === null) continue
    if (!Array.isArray(value)) throw new Error(`${key} must be an array of strings.`)
    const cleaned = value.map((entry) => String(entry)).filter((entry) => entry.trim().length > 0)
    if (cleaned.length > 0) filter[key] = cleaned
  }
  if (maxResults !== undefined && maxResults !== null) {
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > RESULT_LIMIT_MAX) {
      throw new Error(`max_results must be an integer in 1..${RESULT_LIMIT_MAX}.`)
    }
    filter.max_results = maxResults
  }
  if (resultDetail !== undefined && resultDetail !== null) {
    if (!RESULT_DETAILS.includes(resultDetail)) {
      throw new Error(`result_detail must be one of ${RESULT_DETAILS.join(', ')}.`)
    }
    filter.result_detail = resultDetail
  }
  return filter
}

/** Parse one snapshot; the Unity side answers camelCase-free snake_case JSON. */
export function parseTestSnapshot(message) {
  let parsed
  try {
    parsed = JSON.parse(message || '{}')
  } catch (error) {
    throw new Error(`Unity Test returned invalid JSON: ${error.message}`)
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Unity Test returned an empty snapshot.')
  return {
    runId: String(parsed.run_id ?? ''),
    status: String(parsed.status ?? ''),
    mode: String(parsed.mode ?? ''),
    currentTest: String(parsed.current_test ?? ''),
    total: Number(parsed.total ?? 0),
    passed: Number(parsed.passed ?? 0),
    failed: Number(parsed.failed ?? 0),
    skipped: Number(parsed.skipped ?? 0),
    inconclusive: Number(parsed.inconclusive ?? 0),
    durationMs: Number(parsed.duration_ms ?? 0),
    error: String(parsed.error ?? ''),
    failures: Array.isArray(parsed.failures) ? parsed.failures : [],
    results: Array.isArray(parsed.results) ? parsed.results : [],
  }
}

function unwrap(envelope, what) {
  if (!envelope.ok) {
    throw new LocusError(envelope.error || `${what} failed`, {
      code: envelope.error,
      responses: [envelope],
    })
  }
  return parseTestSnapshot(envelope.message)
}

/** Discover tests through the Unity Test Framework. */
export async function listTests(client, options = {}) {
  const filter = buildTestFilter(options)
  if (filter.max_results === undefined) filter.max_results = DEFAULT_RESULT_LIMIT
  const envelope = await client.request('unity_test_list', JSON.stringify(filter), { timeoutMs: LIST_TIMEOUT_MS })
  if (!envelope.ok) {
    throw new LocusError(envelope.error || 'Unity Test listing failed', {
      code: envelope.error,
      responses: [envelope],
    })
  }
  let parsed
  try {
    parsed = JSON.parse(envelope.message || '{}')
  } catch (error) {
    throw new Error(`Unity Test list returned invalid JSON: ${error.message}`)
  }
  return {
    mode: String(parsed.mode ?? ''),
    matched: Number(parsed.matched ?? 0),
    truncated: parsed.truncated === true,
    tests: Array.isArray(parsed.tests) ? parsed.tests : [],
  }
}

/**
 * Start a run and drive it to a terminal status.
 *
 * `onUpdate(snapshot)` sees every poll, so the caller can publish progress.
 * `signal` aborts: the run is cancelled through the bridge and the promise
 * rejects with {@link UNITY_TEST_CANCELLED} once the cancel is observed.
 */
export async function runTests(client, options = {}, { signal, onUpdate, timeoutMs } = {}) {
  const filter = buildTestFilter(options)
  const runId = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const startRequest = { ...filter, run_id: runId }
  const envelope = await client.request('unity_test_start', JSON.stringify(startRequest), {
    timeoutMs: START_TIMEOUT_MS,
  })
  let snapshot = unwrap(envelope, 'Unity Test start')
  if (!snapshot.runId) snapshot.runId = runId
  onUpdate?.(snapshot)

  const deadline = Number.isFinite(timeoutMs) ? Date.now() + timeoutMs : null
  let abortReason = null
  const onAbort = () => {
    abortReason = abortReason ?? UNITY_TEST_CANCELLED
  }
  signal?.addEventListener?.('abort', onAbort, { once: true })
  if (signal?.aborted) onAbort()

  try {
    while (!isTerminalStatus(snapshot.status)) {
      if (abortReason) return await cancelRun(client, snapshot, onUpdate, abortReason)
      if (deadline !== null && Date.now() >= deadline) {
        return await cancelRun(
          client,
          snapshot,
          onUpdate,
          `Unity Test run timed out after ${Math.round(timeoutMs / 1000)}s` +
            (snapshot.currentTest ? ` (current test: ${snapshot.currentTest})` : ''),
        )
      }
      await sleep(TEST_POLL_MS)
      snapshot = await statusOf(client, snapshot.runId)
      onUpdate?.(snapshot)
    }
    return snapshot
  } finally {
    signal?.removeEventListener?.('abort', onAbort)
  }
}

async function statusOf(client, runId) {
  const envelope = await client.request('unity_test_status', JSON.stringify({ run_id: runId }), {
    timeoutMs: STATUS_TIMEOUT_MS,
  })
  return unwrap(envelope, 'Unity Test status')
}

/**
 * Ask Unity to stop the run, then poll until it is terminal. The last snapshot
 * is returned when the cancel is confirmed; a reason makes the caller reject.
 */
async function cancelRun(client, snapshot, onUpdate, reason) {
  let current = snapshot
  try {
    const envelope = await client.request('unity_test_cancel', JSON.stringify({ run_id: snapshot.runId }), {
      timeoutMs: CANCEL_TIMEOUT_MS,
    })
    current = unwrap(envelope, 'Unity Test cancel')
    onUpdate?.(current)
  } catch {
    // A cancel that could not be delivered still gets the confirmation window:
    // the run may have finished on its own in the meantime.
  }
  const deadline = Date.now() + CANCEL_CONFIRM_TIMEOUT_MS
  while (!isTerminalStatus(current.status) && Date.now() < deadline) {
    await sleep(TEST_POLL_MS)
    current = await statusOf(client, snapshot.runId).catch(() => current)
    onUpdate?.(current)
  }
  const error = new LocusError(
    current.status === 'cancelled' ? reason : `${reason}; Unity Test ended as "${current.status}"`,
    { code: 'cancelled' },
  )
  error.snapshot = current
  throw error
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Render one terminal snapshot for the model. */
export function formatTestRun(snapshot, { resultDetail = 'failures' } = {}) {
  const lines = []
  const verdict = snapshot.status === 'passed' ? 'passed' : snapshot.status
  lines.push(`Unity Test run ${verdict}${snapshot.mode ? ` (${snapshot.mode})` : ''}.`)
  lines.push(
    `Results: ${snapshot.total} total, ${snapshot.passed} passed, ${snapshot.failed} failed, ` +
      `${snapshot.skipped} skipped, ${snapshot.inconclusive} inconclusive ` +
      `(${(snapshot.durationMs / 1000).toFixed(1)}s)`,
  )
  if (snapshot.error) lines.push(`Error: ${snapshot.error}`)
  const reported = resultDetail === 'all' ? snapshot.results : snapshot.failures
  const limit = 40
  for (const result of reported.slice(0, limit)) {
    const name = result.full_name ?? result.fullName ?? '(unnamed)'
    const state = result.result_state ?? result.resultState ?? '?'
    lines.push(`- [${state}] ${name} (${result.duration_ms ?? result.durationMs ?? 0}ms)`)
    const message = String(result.message ?? '').trim()
    if (message && state !== 'Passed') for (const line of message.split('\n').slice(0, 6)) lines.push(`    ${line}`)
    const stack = String(result.stack_trace ?? result.stackTrace ?? '').trim()
    if (stack && state !== 'Passed') {
      for (const line of stack.split('\n').slice(0, 4)) lines.push(`    ${line}`)
    }
  }
  if (reported.length > limit) lines.push(`… (${reported.length - limit} more results not shown)`)
  return lines.join('\n')
}

/** Render one discovery answer for the model. */
export function formatTestList(list) {
  const lines = [
    `${list.matched} test(s) matched${list.mode ? ` in ${list.mode}` : ''}` +
      `${list.truncated ? ' (truncated by max_results)' : ''}.`,
  ]
  for (const test of list.tests.slice(0, 200)) {
    const name = test.full_name ?? test.fullName ?? '(unnamed)'
    const assembly = test.assembly ? ` [${test.assembly}]` : ''
    const mode = test.mode ? ` (${test.mode})` : ''
    lines.push(`- ${name}${mode}${assembly}`)
  }
  if (list.tests.length > 200) lines.push(`… (${list.tests.length - 200} more not shown)`)
  return lines.join('\n')
}

export { CANCEL_CONFIRM_TIMEOUT_MS, DEFAULT_RESULT_LIMIT, RESULT_LIMIT_MAX }
