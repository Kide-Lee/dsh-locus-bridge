// Tool-level tests: the definitions run end-to-end through the shared protocol
// against the fake broker, covering editor-status gating, edit-session wrapping
// for writes, output rendering, and the disconnected path.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocusClient } from '../src/locus-client.js'
import { __resetPoolForTest, __setClientForTest, shutdownPool } from '../src/client-pool.js'
import { toolDefinitions } from '../src/tools.js'
import { resolvePipeName } from '../src/pipe-name.js'
import { startFakeBroker } from './fake-broker.js'

const tools = Object.fromEntries(toolDefinitions.map((definition) => [definition.name, definition]))

// A real directory tree: project resolution now validates `Assets/` +
// `ProjectSettings/` the way `unity_bridge::is_unity_project` does, so a made-up
// `F:/Projects/Game` is correctly rejected before any socket work.
const PROJECT = mkdtempSync(join(tmpdir(), 'locus-tools-test-'))
mkdirSync(join(PROJECT, 'Assets'), { recursive: true })
mkdirSync(join(PROJECT, 'ProjectSettings'), { recursive: true })
process.on('exit', () => rmSync(PROJECT, { recursive: true, force: true }))

function execContext(overrides = {}) {
  return {
    agent: { session: { header: { cwd: PROJECT } } },
    signal: new AbortController().signal,
    publish: () => {},
    ...overrides,
  }
}

async function withFakeClient(fn, options) {
  const broker = await startFakeBroker(options)
  const client = new LocusClient({ pipe: 'fake', stream: broker.stream })
  await client.connect()
  // Tool calls resolve `\\.\pipe\<derived>` for the Session cwd; the seeded
  // connection is the stream-backed client, so nothing is opened on disk.
  __resetPoolForTest()
  __setClientForTest(resolvePipeName({ projectRoot: PROJECT }), client)
  try {
    return await fn(client, broker)
  } finally {
    await shutdownPool()
    __resetPoolForTest()
    await broker.close()
  }
}

test('unity_status reports connected state, scenes and capabilities', async () => {
  await withFakeClient(async () => {
    const result = await tools.unity_status.execute({}, execContext())
    assert.equal(result.connected, true)
    assert.equal(result.status, 'editing')
    assert.deepEqual(result.scenes, ['Assets/Scenes/Main.unity'])
    assert.match(result.text, /Unity Editor: connected \(editing\)/)
    assert.match(result.text, /broker_compile_result_v1/)
  })
})

test('unity_execute runs a snippet and keeps an edit session for writes', async () => {
  const seen = []
  await withFakeClient(
    async () => {
      const result = await tools.unity_execute.execute(
        { code: 'print(Application.dataPath);', request_editor_status: 'editing', readonly: false },
        execContext(),
      )
      assert.equal(result.cancelled, false)
      assert.equal(result.output, 'ran: print(Application.dataPath);')
      const order = seen.map((request) => request.type)
      assert.ok(order.indexOf('begin_edit_session') < order.indexOf('execute_code'))
      assert.ok(order.indexOf('end_edit_session') > order.indexOf('execute_code'))
      const execute = seen.find((request) => request.type === 'execute_code')
      assert.match(execute.message, /\/\/__LOCUS_EXECUTION_ID__:/)
      assert.match(execute.message, /\/\/__LOCUS_TIMEOUT_MS__:600000/)
    },
    {
      onMessage: (request) => {
        if (['begin_edit_session', 'execute_code', 'end_edit_session'].includes(request.type)) seen.push(request)
        return undefined
      },
    },
  )
})

test('unity_execute refuses a snippet when the editor status does not match', async () => {
  await withFakeClient(async () => {
    const result = await tools.unity_execute.execute(
      { code: 'print(1);', request_editor_status: 'playing', readonly: true },
      execContext(),
    )
    assert.equal(result.cancelled, false)
    assert.match(result.output, /^Error: Unity Editor status is "editing"/)
    assert.match(result.output, /requires "playing"/)
  })
})

test('unity_execute rejects an empty snippet and a bogus requested status', async () => {
  await withFakeClient(async () => {
    const empty = await tools.unity_execute.execute({ code: '   ', request_editor_status: 'editing' }, execContext())
    assert.match(empty.output, /Missing required parameter: code/)
    const bogus = await tools.unity_execute.execute({ code: 'print(1);', request_editor_status: 'nope' }, execContext())
    assert.match(bogus.output, /Invalid request_editor_status/)
  })
})

test('unity_play_mode returns the matching-mode wording', async () => {
  await withFakeClient(async () => {
    const result = await tools.unity_play_mode.execute({ mode: 'edit' }, execContext())
    assert.equal(result.status, 'editing')
    assert.equal(result.text, 'Unity Editor is already in Edit Mode (editing).')
    await assert.rejects(tools.unity_play_mode.execute({ mode: 'pause' }, execContext()), /Invalid mode/)
  })
})

test('unity_console_log validates levels and renders entries', async () => {
  await withFakeClient(
    async () => {
      const result = await tools.unity_console_log.execute({ levels: ['error'], limit: 10 }, execContext())
      assert.match(result.text, /Unity Console: 1 entry \(1 matched, 1 unique\)/)
      assert.match(result.text, /\[error\] NullReferenceException/)
      await assert.rejects(tools.unity_console_log.execute({ level: 'fatal' }, execContext()), /Invalid level/)
    },
    {
      onMessage: (request, _helpers, socket) => {
        if (request.type !== 'unity_get_console_log') return undefined
        socket.write(
          JSON.stringify({
            type: 'response',
            reply_to: request.id,
            ok: true,
            message: JSON.stringify({
              entries: [{ level: 'error', message: 'NullReferenceException', count: 1 }],
              matchedCount: 1,
              uniqueCount: 1,
              truncated: false,
            }),
          }) + '\n',
        )
        return true
      },
    },
  )
})

test('a caller abort surfaces as a cancelled result, not an error', async () => {
  await withFakeClient(
    async () => {
      const controller = new AbortController()
      const run = tools.unity_execute.execute(
        { code: 'Thread.Sleep(10000);', request_editor_status: 'editing', readonly: true },
        execContext({ signal: controller.signal }),
      )
      setTimeout(() => controller.abort(), 30)
      const result = await run
      assert.equal(result.cancelled, true)
      assert.match(result.output, /cancelled/)
    },
    { onMessage: (request) => (request.type === 'execute_code' ? true : undefined) },
  )
})

test('a mid-flight transport loss surfaces as an error result', async () => {
  await withFakeClient(
    async (client) => {
      const run = tools.unity_execute.execute(
        { code: 'print(1);', request_editor_status: 'editing', readonly: true },
        execContext(),
      )
      setTimeout(() => client.close('simulated reload'), 20)
      const result = await run
      assert.equal(result.cancelled, false)
      assert.match(result.output, /^Error: /)
    },
    { onMessage: (request) => (request.type === 'execute_code' ? true : undefined) },
  )
})

test('tools report a disconnected editor instead of throwing', async () => {
  __resetPoolForTest()
  const previous = process.env.LOCUS_UNITY_TEST_PIPE_NAMESPACE
  process.env.LOCUS_UNITY_TEST_PIPE_NAMESPACE = 'nothing-listening'
  try {
    const result = await tools.unity_status.execute({ project_path: PROJECT }, execContext())
    assert.equal(result.connected, false)
    assert.equal(result.status, 'disconnected')
    // The generic "install the package" hint was replaced by the project's own
    // diagnosis, which names the piece that is actually missing.
    assert.match(result.text, /com\.farlocus\.locus is not installed/)
  } finally {
    __resetPoolForTest()
    if (previous === undefined) delete process.env.LOCUS_UNITY_TEST_PIPE_NAMESPACE
    else process.env.LOCUS_UNITY_TEST_PIPE_NAMESPACE = previous
  }
})

test('status reports the project-derived pipe when it is the one in use', async () => {
  await withFakeClient(async () => {
    const result = await tools.unity_status.execute({}, execContext())
    assert.equal(result.connected, true)
    assert.equal(result.pipe, resolvePipeName({ projectRoot: PROJECT }))
  })
})
