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
