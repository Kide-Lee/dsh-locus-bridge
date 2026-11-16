// Editor health: the JS half of contracts.md §4.3.
//
// Everything runs against test/fake-broker.js with `onMessage` interception, so
// no Unity editor is needed: `dsh_health` and `dsh_main_thread_stack` are
// answered from fixtures shaped exactly like
// native/locus_unix_native/src/broker.rs `respond_health` answers them.
//
// The point of these tests is not just "the happy path parses". Half of them
// assert the honesty rule: a tier that could not be measured must be reported
// as unmeasured (with its reason), and a timeout must not turn into a
// confident diagnosis.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocusClient, LocusError } from '../src/locus-client.js'
import {
  BUSY_CPU_PERCENT,
  UNRESPONSIVE_AFTER_MS,
  composeHealth,
  describeHealth,
  editorHealth,
  enableBackgroundHook,
  explainUnresponsive,
  normalizeHealth,
  remedy,
} from '../src/health.js'
import { startFakeBroker } from './fake-broker.js'

const PROJECT = mkdtempSync(join(tmpdir(), 'locus-health-test-'))
mkdirSync(join(PROJECT, 'Assets'), { recursive: true })
mkdirSync(join(PROJECT, 'ProjectSettings'), { recursive: true })
process.on('exit', () => rmSync(PROJECT, { recursive: true, force: true }))

const TARGET = { projectRoot: PROJECT, pipe: 'fake' }

/**
 * Wire-shaped fixtures (snake_case, exactly what native/locus_unix_native replies
 * with) folded through `normalizeHealth`, which is the client's internal shape.
 */
function health(overrides = {}) {
  return normalizeHealth(healthReport(overrides))
}

/** A healthy, freshly-reported editing editor on Linux. */
function healthReport(overrides = {}) {
  return {
    pid: 4242,
    processPath: '/opt/Unity/Editor/Unity',
    observedAtMs: 1_700_000_000_000,
    managedState: 'ready',
    editorStatus: 'editing|Assets/Scenes/Main.unity',
    domainGeneration: 7,
    mainThreadId: 4300,
    mainThreadHeartbeatSeq: 120,
    heartbeatAgeMs: 40,
    supported: true,
    unresponsive: false,
    cpuPercent: 3.5,
    cpuWindowMs: 1_000,
    liveness: { supported: true, state: 'alive', zombie: false },
    tiers: {
      t2: { supported: true, platform: 'linux', reason: null, windowMs: 1_000 },
      t3: { supported: true, state: 'alive', zombie: false },
    },
    notes: [],
    backgroundHook: {
      enabled: false,
      supported: false,
      state: 'unsupported',
      patched: false,
      symbolCount: 0,
      error: 'the background scheduling hook needs Unity\u2019s PDB symbols for IsApplicationActive, which linux builds do not ship',
    },
    stackSupport: { platform: 'linux', supported: true },
    ...overrides,
  }
}

/** A wedged editor: the heartbeat stopped and the CPU is pegged. */
function stuckReport(overrides = {}) {
  return healthReport({
    heartbeatAgeMs: 45_000,
    unresponsive: true,
    cpuPercent: 97.0,
    ...overrides,
  })
}

function stackDiagnosis(overrides = {}) {
  return {
    status: 'complete',
    process_id: 4242,
    main_thread_id: 4300,
    captured_at_ms: 1_700_000_000_000,
    heartbeat_age_ms: 45_000,
    verdict: 'busy',
    cpu_percent: 97.0,
    location: 'Game.Player.Tick()',
    location_reason: 'user_code',
    summary: 'Stuck at Game.Player.Tick(): the main thread is busy executing code (main-thread CPU 97%) (7 frames captured).',
    frames: [
      { index: 0, kind: 'managed', ip: '0x7f00', method: 'Game.Player.Tick()', assembly: 'Assembly-CSharp', display: 'Game.Player.Tick()' },
    ],
    notes: [],
    ...overrides,
  }
}

function unavailableStack(reason = 'ptrace is not permitted (kernel.yama.ptrace_scope=2)') {
  return {
    status: 'unavailable',
    process_id: 4242,
    main_thread_id: 4300,
    captured_at_ms: 1_700_000_000_000,
    heartbeat_age_ms: 45_000,
    verdict: 'unknown',
    summary: `The main thread stack is unavailable: ${reason}.`,
    frames: [],
    notes: [],
    error: { kind: 'unavailable', reason, platform: 'linux' },
  }
}

/**
 * Run `fn` against a fake broker that answers the three health requests from
 * `answers`. A handler may throw to simulate a broker timeout.
 */
async function withEditor(fn, answers = {}, { requests = [] } = {}) {
  const broker = await startFakeBroker({
    onMessage: (request, helpers, socket) => {
      requests.push(request)
      const answer = answers[request.type]
      if (answer === undefined) return undefined // fall through to the fake broker's own defaults
      // A function answer may write its own reply (return true) when the test
      // needs a non-ok or non-JSON frame; otherwise its return value is the body.
      if (typeof answer === 'function') {
        const body = answer(request, helpers, socket)
        if (body === true) return true
        socket.write(JSON.stringify({ type: 'response', reply_to: request.id, ok: true, message: JSON.stringify(body) }) + '\n')
        return true
      }
      socket.write(JSON.stringify({ type: 'response', reply_to: request.id, ok: true, message: JSON.stringify(answer) }) + '\n')
      return true
    },
  })
  const client = new LocusClient({ pipe: 'fake', stream: broker.stream })
  await client.connect()
  const getClient = async () => client
  try {
    return await fn({ broker, client, getClient, requests })
  } finally {
    await client.close('test done')
    await broker.close()
  }
}

test('UNRESPONSIVE_AFTER_MS and BUSY_CPU_PERCENT match the native thresholds', () => {
  // These two numbers are mirrored in native/locus_unix_native (broker.rs,
  // hang/mod.rs) and in Locus' own hang diagnosis. Drift here means the client
  // and the broker disagree about the same editor.
  assert.equal(UNRESPONSIVE_AFTER_MS, 30_000)
  assert.equal(BUSY_CPU_PERCENT, 25.0)
})

test('editorHealth reports a live editor as responsive', async () => {
  await withEditor(
    async ({ getClient }) => {
      const health = await editorHealth(TARGET, { getClient })
      assert.equal(health.supported, true)
      assert.equal(health.responsive, true)
      assert.equal(health.cpuPercent, 3.5)
      assert.equal(health.stuckAt, undefined, 'a healthy editor gets no stuck location')
      assert.match(health.diagnosis, /heartbeat is current/)
    },
    { dsh_health: healthReport() },
  )
})

test('editorHealth reports a wedged editor with the stack location', async () => {
  const requests = []
  await withEditor(
    async ({ getClient }) => {
      const health = await editorHealth(TARGET, { getClient })
      assert.equal(health.responsive, false)
      assert.equal(health.stuckAt, 'Game.Player.Tick()')
      assert.equal(health.cpuPercent, 97)
      assert.match(health.diagnosis, /heartbeat stopped 45 s ago/)
      assert.match(health.diagnosis, /CPU 97% \(busy running code\)/)
      assert.match(health.diagnosis, /stuck at Game\.Player\.Tick\(\)/)
      // The stack request is only made when the editor looks stuck.
      assert.ok(requests.some((request) => request.type === 'dsh_main_thread_stack'))
    },
    { dsh_health: stuckReport(), dsh_main_thread_stack: stackDiagnosis() },
    { requests },
  )
})

test('editorHealth never asks for a stack while the editor is healthy', async () => {
  const requests = []
  await withEditor(
    async ({ getClient }) => {
      await editorHealth(TARGET, { getClient })
      assert.equal(
        requests.some((request) => request.type === 'dsh_main_thread_stack'),
        false,
        'capturing a stack freezes the main thread; a healthy editor must not pay for it',
      )
    },
    { dsh_health: healthReport() },
    { requests },
  )
})

test('an unavailable stack stays unavailable instead of inventing a location', async () => {
  await withEditor(
    async ({ getClient }) => {
      const health = await editorHealth(TARGET, { getClient })
      assert.equal(health.responsive, false)
      assert.equal(health.stuckAt, undefined)
      assert.match(health.diagnosis, /heartbeat stopped/)
      assert.doesNotMatch(health.diagnosis, /stuck at/, 'no location may be reported without a capture')
    },
    { dsh_health: stuckReport(), dsh_main_thread_stack: unavailableStack() },
  )
})

test('a stack request that errors is missing evidence, not a health failure', async () => {
  await withEditor(
    async ({ getClient }) => {
      const health = await editorHealth(TARGET, { getClient })
      // The health answer is still usable; only the location is missing.
      assert.equal(health.responsive, false)
      assert.equal(health.stuckAt, undefined)
    },
    {
      dsh_health: stuckReport(),
      dsh_main_thread_stack: (request, helpers, socket) => {
        socket.write(JSON.stringify({ type: 'response', reply_to: request.id, ok: false, error: 'native_request_timed_out' }) + '\n')
        return true
      },
    },
  )
})

test('an unsupported CPU tier is reported as unmeasurable, not as 0%', async () => {
  const unsupported = healthReport({
    cpuPercent: null,
    cpuWindowMs: null,
    tiers: {
      t2: { supported: false, platform: 'darwin', reason: 'proc_pidinfo is unavailable in this sandbox', windowMs: null },
      t3: { supported: true, state: 'alive', zombie: false },
    },
    notes: ['CPU accounting is unsupported: proc_pidinfo is unavailable in this sandbox'],
  })
  await withEditor(
    async ({ getClient }) => {
      const health = await editorHealth(TARGET, { getClient })
      assert.equal(health.cpuPercent, undefined, 'no fabricated 0%')
      assert.equal(health.stateProbe.tiers.t2.supported, false)
      assert.match(health.stateProbe.tiers.t2.reason, /proc_pidinfo/)
      assert.match(health.diagnosis, /CPU activity is not measurable here/)
      assert.deepEqual(health.stateProbe.notes, ['CPU accounting is unsupported: proc_pidinfo is unavailable in this sandbox'])
    },
    { dsh_health: unsupported },
  )
})

test('a report with no evidence at all yields responsive: null', () => {
  // Nothing measured: no heartbeat, no CPU sample. Claiming "fine" and
  // claiming "stuck" would both be fabricated.
  const health = composeHealth(
    normalizeHealth({
      pid: 1,
      heartbeatAgeMs: null,
      cpuPercent: null,
      tiers: { t2: { supported: false }, t3: { supported: true, state: 'alive' } },
      liveness: { supported: true, state: 'alive', zombie: false },
      backgroundHook: { supported: false, state: 'unsupported' },
    }),
    null,
  )
  assert.equal(health.responsive, null)
  assert.equal(health.supported, true, 'T3 still measured something')
})

test('a dead or zombie process is reported and the remedy is to restart', () => {
  const normalized = health({ heartbeatAgeMs: 90_000, liveness: { supported: true, state: 'gone', zombie: false } })
  const report = composeHealth(normalized, null)
  assert.equal(report.responsive, false)
  assert.match(report.diagnosis, /the editor process is gone/)
  assert.match(remedy(report), /Restart Unity/)
})

test('a zombie editor is called out even though kill(pid, 0) succeeds', () => {
  const normalized = health({ heartbeatAgeMs: 90_000, liveness: { supported: true, state: 'alive', zombie: true } })
  const report = composeHealth(normalized, null)
  assert.match(report.diagnosis, /zombie/)
  assert.match(remedy(report), /Restart Unity/)
})

test('editorHealth surfaces a non-JSON answer as a LocusError', async () => {
  await withEditor(
    async ({ getClient }) => {
      await assert.rejects(() => editorHealth(TARGET, { getClient }), (error) => {
        assert.ok(error instanceof LocusError)
        assert.match(error.message, /non-JSON/)
        return true
      })
    },
    {
      dsh_health: (request, helpers, socket) => {
        socket.write(JSON.stringify({ type: 'response', reply_to: request.id, ok: true, message: 'this is not json' }) + '\n')
        return true
      },
    },
  )
})

test('the stateProbe block keeps every tier and its reason', async () => {
  await withEditor(
    async ({ getClient }) => {
      const health = await editorHealth(TARGET, { getClient })
      assert.equal(health.stateProbe.pid, 4242)
      assert.equal(health.stateProbe.mainThreadId, 4300)
      assert.equal(health.stateProbe.liveness.state, 'alive')
      assert.deepEqual(health.stateProbe.tiers.t3, { supported: true, state: 'alive', zombie: false })
      assert.equal(health.stateProbe.stackSupport.supported, true)
      assert.deepEqual(health.stateProbe.notes, [])
    },
    { dsh_health: healthReport() },
  )
})

// ─────────────────────── background hook ───────────────────────

test('enableBackgroundHook reports the platform cannot patch, never a fake success', async () => {
  await withEditor(
    async ({ getClient }) => {
      const result = await enableBackgroundHook(TARGET, true, { getClient })
      assert.equal(result.supported, false)
      assert.equal(result.patched, false)
      assert.equal(result.state, 'unsupported')
      assert.match(result.reason, /PDB symbols/)
    },
    { dsh_health: healthReport() },
  )
})

test('enableBackgroundHook asks the broker to flip the patch and reports its snapshot', async () => {
  // The flip request is answered by the native broker with the hook snapshot the
  // patch produced; the tool must report that, not the request's acceptance.
  await withEditor(
    async ({ getClient, requests }) => {
      const result = await enableBackgroundHook(TARGET, true, { getClient })
      assert.equal(result.supported, true)
      assert.equal(result.patched, true)
      assert.equal(result.state, 'patched')
      assert.equal(result.reason, null)
      const flip = requests.find((request) => request.type === 'dsh_set_background_hook')
      assert.ok(flip, 'the tool must send the flip request, not only read health')
      assert.equal(flip.message, '1')
    },
    {
      dsh_health: healthReport({ backgroundHook: { enabled: true, supported: true, state: 'patched', patched: true, symbolCount: 2, processId: 4242, error: null } }),
      dsh_set_background_hook: (request, helpers, socket) => {
        socket.write(
          JSON.stringify({
            type: 'response',
            reply_to: request.id,
            ok: true,
            message: JSON.stringify({ enabled: true, supported: true, state: 'patched', patched: true, symbolCount: 2, processId: 4242, error: null }),
          }) + '\n',
        )
        return true
      },
    },
  )
})

test('enableBackgroundHook reports an unsupported platform from the flip answer', async () => {
  await withEditor(
    async ({ getClient }) => {
      const result = await enableBackgroundHook(TARGET, true, { getClient })
      assert.equal(result.supported, false)
      assert.equal(result.patched, false)
      assert.equal(result.state, 'unsupported')
      assert.match(result.reason, /PDB symbols/)
    },
    {
      dsh_health: healthReport(),
      dsh_set_background_hook: { enabled: false, supported: false, state: 'unsupported', patched: false, symbolCount: 0, error: 'the background scheduling hook needs Unity\'s PDB symbols' },
    },
  )
})

test('enableBackgroundHook survives a broker that does not know the flip request', async () => {
  await withEditor(
    async ({ getClient }) => {
      const result = await enableBackgroundHook(TARGET, true, { getClient })
      // The older broker's refusal degrades to "not supported", never a throw.
      assert.equal(result.supported, false)
      assert.equal(result.state, 'unsupported')
    },
    {
      dsh_health: healthReport(),
      dsh_set_background_hook: (request, helpers, socket) => {
        socket.write(JSON.stringify({ type: 'response', reply_to: request.id, ok: false, error: 'unknown message type: dsh_set_background_hook' }) + '\n')
        return true
      },
    },
  )
})

test('enableBackgroundHook reflects the patch state the broker reports', async () => {
  const patched = healthReport({
    backgroundHook: {
      enabled: true,
      supported: true,
      state: 'patched',
      patched: true,
      symbolCount: 2,
      processId: 4242,
      error: null,
    },
  })
  await withEditor(
    async ({ getClient }) => {
      const result = await enableBackgroundHook(TARGET, true, { getClient })
      assert.equal(result.supported, true)
      assert.equal(result.patched, true)
      assert.equal(result.state, 'patched')
      assert.equal(result.reason, null)
    },
    { dsh_health: patched },
  )
})

test('a failed hook keeps its error text so the user sees why it is off', async () => {
  const failed = healthReport({
    backgroundHook: {
      enabled: true,
      supported: true,
      state: 'failed',
      patched: false,
      symbolCount: 0,
      error: 'Unity engine module was not found in this process',
    },
  })
  await withEditor(
    async ({ getClient }) => {
      const result = await enableBackgroundHook(TARGET, true, { getClient })
      assert.equal(result.patched, false)
      assert.equal(result.state, 'failed')
      assert.match(result.reason, /Unity engine module was not found/)
    },
    { dsh_health: failed },
  )
})

// ─────────────────────── explainUnresponsive ───────────────────────

test('explainUnresponsive returns null for errors that are not about the editor', () => {
  assert.equal(explainUnresponsive(null), null)
  assert.equal(explainUnresponsive(undefined), null)
  assert.equal(explainUnresponsive(new LocusError('scene not found', { code: 'native_invalid_request' })), null)
  assert.equal(
    explainUnresponsive(new LocusError('some timeout without health', { code: 'native_request_timed_out' })),
    null,
    'a timeout with no health snapshot must not become a confident diagnosis',
  )
})

test('explainUnresponsive explains a timeout using an attached health snapshot', () => {
  const error = new LocusError('timed out after 60000 ms', { code: 'native_request_timed_out' })
  error.health = composeHealth(health(stuckReport()), stackDiagnosis())
  const text = explainUnresponsive(error)
  assert.match(text, /stuck/)
  assert.match(text, /heartbeat stopped 45 s ago/)
  assert.match(text, /CPU 97%/)
  assert.match(text, /running code|blocked/)
})

test('explainUnresponsive says the editor was answering when the health snapshot says so', () => {
  const error = new LocusError('timed out', { code: 'native_request_timed_out' })
  error.health = composeHealth(health(), null)
  const text = explainUnresponsive(error)
  assert.match(text, /main thread is responding/)
  assert.match(text, /somewhere else/)
})

test('explainUnresponsive admits when the editor health could not be measured', () => {
  const error = new LocusError('timed out', { code: 'native_request_timed_out' })
  error.health = composeHealth(
    normalizeHealth({
      pid: 1,
      heartbeatAgeMs: null,
      cpuPercent: null,
      tiers: { t2: { supported: false }, t3: { supported: false } },
      backgroundHook: { supported: false },
    }),
    null,
  )
  const text = explainUnresponsive(error)
  assert.match(text, /could not be measured/)
})

test('explainUnresponsive treats a not-executed request as a wedged main thread', () => {
  // `notExecuted` means the editor never started the work: the queue it drains
  // from was not drained. Without a health snapshot we can still say that much,
  // and must say that the health itself is unknown.
  // `notExecuted` is a getter on LocusError, derived from the response kinds;
  // tests set the private field the getter reads.
  const error = new LocusError('request never started', { code: 'native_queue_full' })
  Object.defineProperty(error, 'notExecuted', { value: true })
  const text = explainUnresponsive(error)
  assert.match(text, /never reached the editor main thread/)
  assert.match(text, /cannot be confirmed/)
})

test('normalizeHealth rejects a malformed report instead of half-reading it', () => {
  assert.throws(() => normalizeHealth(null), LocusError)
  assert.throws(() => normalizeHealth('nope'), LocusError)
})

