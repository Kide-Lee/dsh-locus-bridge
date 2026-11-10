import { test } from 'node:test'
import assert from 'node:assert/strict'

import { LineAssembler, normalizeFrame } from '../src/line-framer.js'
import {
  EXECUTE_DEFAULT_TIMEOUT_MS,
  EXECUTE_IDLE_LIMIT_MS,
  clampExecuteTimeout,
  executePayload,
  isNotExecuted,
  isReloading,
  parseStatusMessage,
  splitCapabilities,
} from '../src/protocol.js'

test('assembler splits frames across chunk boundaries and strips CR/BOM', () => {
  const assembler = new LineAssembler()
  assert.deepEqual(assembler.push(Buffer.from('{"a":1}\r\n{"b"')), ['{"a":1}'])
  assert.deepEqual(assembler.push(Buffer.from(':2}\n\n')), ['{"b":2}'])
  assert.deepEqual(assembler.push(Buffer.from('\uFEFF {"c":3}')), [])
  assert.deepEqual(assembler.push(Buffer.from('\n')), ['{"c":3}'])
})

test('assembler handles multibyte characters split across chunks', () => {
  const assembler = new LineAssembler()
  const text = Buffer.from('{"m":"引擎"}\n', 'utf8')
  const cut = text.indexOf(Buffer.from('引', 'utf8')) + 1
  assert.deepEqual(assembler.push(text.subarray(0, cut)), [])
  assert.deepEqual(JSON.parse(assembler.push(text.subarray(cut))[0]).m, '引擎')
})

test('assembler rejects oversized frames instead of growing forever', () => {
  const assembler = new LineAssembler({ maxLineBytes: 8 })
  assert.throws(() => assembler.push(Buffer.from('123456789')), /frame exceeds/)
})

test('normalizeFrame trims BOM and whitespace', () => {
  assert.equal(normalizeFrame('\uFEFF  {"id":1}\r'), '{"id":1}')
  assert.equal(normalizeFrame('   \n'), '')
})

test('execute payload appends the sentinel markers Unity scans', () => {
  const payload = executePayload('return 1;\n', { executionId: 'abc', timeoutMs: 5000 })
  assert.equal(payload, 'return 1;\n//__LOCUS_EXECUTION_ID__:abc\n//__LOCUS_TIMEOUT_MS__:5000')
  assert.equal(executePayload('print(1);'), 'print(1);')
})

test('execute timeout clamps to the Locus budget', () => {
  assert.equal(clampExecuteTimeout(500), 1_000)
  assert.equal(clampExecuteTimeout(9_999_999), 3_600_000)
  assert.equal(clampExecuteTimeout(undefined), EXECUTE_DEFAULT_TIMEOUT_MS)
  assert.equal(EXECUTE_IDLE_LIMIT_MS, 30_000)
})

test('status parsing keeps the active scene first and de-duplicates', () => {
  assert.deepEqual(parseStatusMessage('playing|Assets/A.unity|Assets/B.unity'), {
    status: 'playing',
    scenes: ['Assets/A.unity', 'Assets/B.unity'],
    activeScene: 'Assets/A.unity',
  })
  assert.deepEqual(parseStatusMessage('editing'), { status: 'editing', scenes: [], activeScene: null })
  assert.equal(parseStatusMessage('bogus').status, 'disconnected')
})

test('broker error classification drives retry safety', () => {
  assert.equal(isNotExecuted('managed_reloading'), true)
  assert.equal(isNotExecuted(' native_main_thread_unresponsive '), true)
  assert.equal(isNotExecuted('domain_reload_interrupted'), false)
  assert.equal(isNotExecuted('native_request_timed_out'), false)
  assert.equal(isReloading('domain_reload_interrupted'), true)
  assert.equal(isReloading('managed_reloading'), true)
  assert.equal(isReloading('empty code'), false)
})

test('capabilities split on commas', () => {
  assert.deepEqual(splitCapabilities('broker_v1, broker_compile_result_v1,'), ['broker_v1', 'broker_compile_result_v1'])
})

test('isTransientBrokerError matches exactly the three reload codes', async () => {
  const { isTransientBrokerError } = await import('../src/recompile.js')
  // Upstream `is_transient_broker_error` (unity_bridge/mod.rs) is an exact match
  // on these three. A `native_*` prefix used to be accepted by a regex here,
  // which turned real broker refusals into infinite convergence polling.
  for (const code of ['managed_reloading', 'managed_not_ready', 'domain_reload_interrupted']) {
    assert.equal(isTransientBrokerError(code), true, `${code} is a reload boundary`)
  }
  for (const code of ['native_payload_too_large', 'native_queue_full', 'error CS1002', '', null]) {
    assert.equal(isTransientBrokerError(code), false, `${code} must surface, not be retried`)
  }
})

test('longBlockNote uses upstream 15s threshold, not 5s', async () => {
  const { longBlockNote } = await import('../src/execute.js')
  // Upstream `UNITY_EXECUTE_LONG_BLOCK_NOTE_MS = 15_000`.
  assert.equal(longBlockNote(5_000), '', '5s of editor work is not worth a warning')
  assert.equal(longBlockNote(14_999), '')
  assert.match(longBlockNote(15_000), /held Unity's main thread for 15\.0s/)
})

test('the broker asset-extension refusal is restated as the real rule', async () => {
  const { explainAssetBlocker } = await import('../src/tools.js')
  // Verified live: a Force Text project with a plain-YAML .physicsMaterial2D is
  // still refused, because the gate is an extension whitelist. The broker's own
  // wording blames "serialization format", which sends callers to the wrong fix.
  const text = explainAssetBlocker('unsupported_capability: asset serialization format .physicsMaterial2D')
  assert.match(text, /extension whitelist, not a serialization-format limit/)
  assert.match(text, /\.physicsMaterial2D assets are refused even when the project is Force Text/)
  assert.match(text, /unity_execute/)
  // Anything else passes through untouched.
  assert.equal(explainAssetBlocker('asset_not_found: Assets/X.asset'), 'asset_not_found: Assets/X.asset')
})

test('unregistered unity_test commands explain the test-framework version rule', async () => {
  const { explainTestCommandError } = await import('../src/test-runner.js')
  const text = explainTestCommandError('unknown message type: unity_test_list')
  assert.match(text, /not registered/)
  assert.match(text, /com\.unity\.test-framework >= 1\.4\.0/)
  assert.match(text, /LOCUS_HAS_UNITY_TEST_FRAMEWORK/)
  // A different unknown type is not this problem and must not be rewritten.
  assert.equal(explainTestCommandError('unknown message type: unity_other'), 'unknown message type: unity_other')
})

test('readEditorStatus waits out managed_reloading instead of calling it disconnected', async () => {
  const { readEditorStatus } = await import('../src/execute.js')
  // Live observation: right after a compile the broker answers
  // `managed_reloading` for a moment while the pipe is perfectly healthy. A
  // precondition check that treats that as "disconnected" fails a call for a
  // transient state.
  let calls = 0
  const client = {
    async request() {
      calls += 1
      if (calls <= 2) return { ok: false, error: 'managed_reloading' }
      return { ok: true, message: 'editing|Assets/Scenes/Level.unity' }
    },
  }
  const state = await readEditorStatus(client, { waitForReloadMs: 5_000 })
  assert.equal(state.connected, true)
  assert.equal(state.status, 'editing')
  assert.equal(calls, 3, 'retried until the reload finished')
})

test('readEditorStatus reports disconnected immediately when not told to wait', async () => {
  const { readEditorStatus } = await import('../src/execute.js')
  let calls = 0
  const client = {
    async request() {
      calls += 1
      return { ok: false, error: 'managed_reloading' }
    },
  }
  const state = await readEditorStatus(client)
  assert.equal(state.connected, false)
  assert.equal(calls, 1, 'unity_status stays immediate')
})

test('readEditorStatus stops waiting at its window for a genuine outage', async () => {
  const { readEditorStatus } = await import('../src/execute.js')
  let calls = 0
  const client = {
    async request() {
      calls += 1
      return { ok: false, error: 'managed_reloading' }
    },
  }
  const started = Date.now()
  const state = await readEditorStatus(client, { waitForReloadMs: 400 })
  assert.equal(state.connected, false)
  assert.equal(state.error, 'managed_reloading')
  assert.ok(Date.now() - started >= 300, 'did not give up before the window')
  assert.ok(calls > 1)
})

test('recompile tolerates a run of register mismatches before calling it superseded', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { resolvePipeName } = await import('../src/pipe-name.js')
  const projectRoot = mkdtempSync(join(tmpdir(), 'locus-mismatch-'))
  // Upstream RECOMPILE_OPERATION_MISMATCH_LIMIT = 20: Unity can answer mismatch
  // for a moment while our own compile is still being registered, so one read is
  // not proof another request replaced us.
  const { recompile } = await import('../src/recompile.js')
  const { startFakeBroker } = await import('./fake-broker.js')
  const { LocusClient } = await import('../src/locus-client.js')
  const { __resetPoolForTest, __setClientForTest, shutdownPool } = await import('../src/client-pool.js')

  let polls = 0
  const broker = await startFakeBroker({
    onMessage(request, _helpers, socket) {
      const respond = (body) =>
        socket.write(JSON.stringify({ type: 'response', reply_to: request.id, ...body }) + '\n')
      if (request.type === 'request_recompile') {
        respond({ ok: true, message: 'recompile_started' })
        return true
      }
      if (request.type === 'get_compile_result') {
        polls += 1
        if (polls <= 5) respond({ ok: false, error: 'recompile_result_operation_mismatch' })
        else respond({ ok: true, message: 'ok' })
        return true
      }
      return undefined
    },
  })
  const client = new LocusClient({ pipe: 'fake-mismatch', stream: broker.stream })
  await client.connect()
  __resetPoolForTest()
  __setClientForTest(resolvePipeName({ projectRoot }), client)
  try {
    const out = await recompile({ projectRoot }, { convergeTimeoutMs: 20_000 })
    assert.equal(out.status, 'ok')
    assert.ok(polls > 5, `expected several mismatch reads, got ${polls}`)
  } finally {
    await shutdownPool()
    __resetPoolForTest()
    await broker.close()
  }
})

test('isBusyError waits out an unresponsive main thread instead of failing', async () => {
  const { isBusyError } = await import('../src/recompile.js')
  // Upstream is_main_thread_unresponsive_error: the broker could not queue the
  // read because the editor holds the main thread (a compile does exactly that).
  assert.equal(isBusyError('native_main_thread_unresponsive'), true)
  for (const code of ['managed_reloading', 'recompile_result_operation_mismatch', 'error CS1002', '']) {
    assert.equal(isBusyError(code), false)
  }
})
