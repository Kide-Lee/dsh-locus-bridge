import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LocusClient, LocusError } from '../src/locus-client.js'
import { executeSnippet, readEditorStatus, assertRequestedStatus } from '../src/execute.js'
import { setPlayMode, playModeMessage } from '../src/play-mode.js'
import { consoleLogMessage, formatConsoleLog } from '../src/console.js'
import { startFakeBroker } from './fake-broker.js'

async function withBroker(fn, options) {
  const broker = await startFakeBroker(options)
  try {
    return await fn(broker)
  } finally {
    // One synchronous pipeline teardown: destroying only one Duplex handle
    // leaves the broker-side readable alive, and an `end()` between the
    // handles races an in-flight write.
    await broker.close()
    // Let abort listeners and in-flight awaits settle before the next test.
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function connected(broker, options) {
  const client = new LocusClient({ pipe: 'fake', stream: broker.stream, ...options })
  await client.connect()
  return client
}

test('connects, pings, collects capabilities and reports status', async () => {
  await withBroker(async (broker) => {
    const client = await connected(broker)
    try {
      assert.equal(client.connected, true)
      assert.ok(client.capabilities.includes('broker_compile_result_v1'))
      const state = await readEditorStatus(client)
      assert.equal(state.status, 'editing')
      assert.deepEqual(state.scenes, ['Assets/Scenes/Main.unity'])
    } finally {
      await client.close()
    }
  })
})

test('routes replies by reply_to and records broker events', async () => {
  await withBroker(async (broker) => {
    const client = await connected(broker)
    try {
      const [a, b] = await Promise.all([
        client.request('bridge_capabilities'),
        client.request('ping'),
      ])
      assert.ok(a.message.includes('broker_v1'))
      assert.equal(b.message, 'pong')
      await executeSnippet(client, { code: 'print(1);', executionId: 'e1', timeoutMs: 5_000 })
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.ok(client.events.some((event) => event.type === 'locus-request-accepted'))
      assert.ok(client.events.some((event) => event.type === 'status-changed'))
    } finally {
      await client.close()
    }
  })
})

test('executeSnippet sends the execution-id sentinel and returns print output', async () => {
  const seen = []
  await withBroker(
    async (broker) => {
      const client = await connected(broker)
      try {
        const result = await executeSnippet(client, {
          code: 'print(Application.dataPath);',
          executionId: 'exec-42',
          timeoutMs: 5_000,
        })
        assert.equal(result.output, 'ran: print(Application.dataPath);')
        assert.ok(seen[0].message.includes('//__LOCUS_EXECUTION_ID__:exec-42'))
        assert.ok(seen[0].message.includes('//__LOCUS_TIMEOUT_MS__:5000'))
      } finally {
        await client.close()
      }
    },
    {
      onMessage: (request) => {
        if (request.type === 'execute_code') seen.push(request)
        return undefined
      },
    },
  )
})

test('executeSnippet surfaces managed errors as LocusError', async () => {
  await withBroker(
    async (broker) => {
      const client = await connected(broker)
      try {
        await assert.rejects(
          executeSnippet(client, { code: 'nope', executionId: 'e2', timeoutMs: 5_000 }),
          (error) => error instanceof LocusError && error.message.includes('CS1002'),
        )
      } finally {
        await client.close()
      }
    },
    {
      onMessage: (request, _helpers, socket) => {
        if (request.type !== 'execute_code') return undefined
        socket.write(
          JSON.stringify({ type: 'response', reply_to: request.id, ok: false, error: 'CS1002: ; expected' }) + '\n',
        )
        return true
      },
    },
  )
})

test('aborting a call sends cancel_execute_code', async () => {
  const cancelled = []
  await withBroker(
    async (broker) => {
      const client = await connected(broker)
      try {
        const controller = new AbortController()
        const run = executeSnippet(client, {
          code: 'Thread.Sleep(10000);',
          executionId: 'exec-cancel',
          timeoutMs: 30_000,
          signal: controller.signal,
        })
        setTimeout(() => controller.abort(), 30)
        await assert.rejects(run, /__locus_execute_cancelled__/)
        // cancel_execute_code is only guaranteed to be in flight at reject time.
        for (let i = 0; i < 50 && cancelled.length === 0; i += 1) await new Promise((r) => setTimeout(r, 10))
        assert.deepEqual(cancelled, ['exec-cancel'])
      } finally {
        await client.close()
      }
    },
    {
      onMessage: (request, _helpers, socket) => {
        if (request.type === 'cancel_execute_code') cancelled.push(request.message)
        if (request.type !== 'execute_code') return undefined
        // Never complete: the caller must give up via cancellation + timeout.
        return true
      },
    },
  )
})

test('disconnect fails pending requests and reports a reload code', async () => {
  await withBroker(async (broker) => {
    const client = await connected(broker)
    const pending = client.request('bridge_capabilities')
    await broker.close()
    await assert.rejects(pending, (error) => error instanceof LocusError)
    assert.equal(client.connected, false)
    // A disconnected client still accepts a ping (it may race a reconnect) but
    // the write fails fast instead of queueing forever.
    await assert.rejects(client.request('ping'), /locus write failed|pipe is closed|stream closed/)
    await client.close()
  })
})

test('status gate refuses mismatched request_editor_status', () => {
  assert.throws(() => assertRequestedStatus('playing', 'editing'), /requires "playing"/)
  assert.throws(() => assertRequestedStatus('bogus', 'editing'), /Invalid request_editor_status/)
  assert.doesNotThrow(() => assertRequestedStatus('editing', 'editing'))
})

test('setPlayMode is a no-op when the editor already matches', async () => {
  await withBroker(async (broker) => {
    const client = await connected(broker)
    try {
      const result = await setPlayMode(client, 'edit')
      assert.deepEqual(result, {
        mode: 'edit',
        changed: false,
        status: 'editing',
        scenes: ['Assets/Scenes/Main.unity'],
      })
      assert.equal(playModeMessage(result), 'Unity Editor is already in Edit Mode (editing).')
    } finally {
      await client.close()
    }
  })
})

test('console log request validation and formatting', () => {
  assert.equal(consoleLogMessage({ level: 'error', limit: 5 }).message, '{"level":"error","limit":5}')
  assert.equal(consoleLogMessage({ levels: ['warn', 'error'] }).message, '{"levels":["warn","error"]}')
  assert.equal(consoleLogMessage({}).message, '')
  assert.throws(() => consoleLogMessage({ level: 'fatal' }), /Invalid level/)
  assert.throws(() => consoleLogMessage({ limit: 0 }), /limit/)
  assert.throws(() => consoleLogMessage({ levels: [] }), /non-empty/)
  const text = formatConsoleLog(
    JSON.stringify({
      entries: [
        { level: 'error', message: 'NullReferenceException', count: 3 },
        { level: 'warn', message: 'slow', count: 1 },
      ],
      matchedCount: 4,
      uniqueCount: 2,
      truncated: false,
    }),
  )
  assert.match(text, /Unity Console: 2 entries/)
  assert.match(text, /\[error\] \(x3\) NullReferenceException/)
  assert.match(text, /\[warn\] slow$/)
  assert.match(formatConsoleLog('{"entries":[],"matchedCount":0,"uniqueCount":0}'), /<empty>/)
})

test('setPlayMode reconnects and keeps polling through a domain reload', async () => {
  // Entering Play Mode reloads the scripting domain: the status poll right after
  // the request reports the reload. The flow must hand control to `reconnect`
  // and converge instead of surfacing "disconnected", which callers cannot act on.
  let statusCalls = 0
  const reload = {
    onMessage(request, { broadcast }, socket) {
      const respond = (body) =>
        socket.write(JSON.stringify({ type: 'response', reply_to: request.id, ...body }) + '\n')
      if (request.type === 'set_editor_status') {
        respond({ ok: true, message: 'set_editor_status:ok' })
        return true
      }
      if (request.type !== 'status') return undefined
      statusCalls += 1
      // Poll 1 = the `before` read, poll 2 = first poll after the request.
      if (statusCalls === 2) {
        respond({ ok: false, error: 'managed_reloading' })
        return true
      }
      if (statusCalls >= 3) {
        respond({ ok: true, message: 'playing|Assets/Scenes/Main.unity' })
        return true
      }
      return undefined
    },
  }
  await withBroker(async (broker) => {
    const client = await connected(broker)
    let reconnects = 0
    const reconnect = async () => {
      reconnects += 1
      return client
    }
    const result = await setPlayMode(client, 'play', { reconnect })
    assert.equal(result.mode, 'play')
    assert.equal(result.status, 'playing')
    assert.equal(reconnects, 1, 'the reload must hand over to the reconnect exactly once')
    await client.close()
  }, reload)
})

test('setPlayMode without a reconnect still fails loudly on disconnect', async () => {
  let statusCalls = 0
  const drop = {
    onMessage(request, { broadcast }, socket) {
      if (request.type === 'set_editor_status') {
        socket.write(JSON.stringify({ type: 'response', reply_to: request.id, ok: true, message: 'set_editor_status:ok' }) + '\n')
        return true
      }
      if (request.type !== 'status') return undefined
      statusCalls += 1
      if (statusCalls === 3) {
        socket.write(JSON.stringify({ type: 'response', reply_to: request.id, ok: false, error: 'managed_reloading' }) + '\n')
        return true
      }
      return undefined
    },
  }
  await withBroker(async (broker) => {
    const client = await connected(broker)
    try {
      await assert.rejects(() => setPlayMode(client, 'play'), /disconnected while entering "play" mode/)
    } finally {
      await client.close()
    }
  }, drop)
})

test('setPlayMode survives more reloads than the old 8-attempt cap', async () => {
  // Bug report BUG-7: a large project reloads the domain many times while Play
  // Mode starts, so a fixed attempt cap reported "kept disconnecting" even
  // though the editor HAD entered Play Mode. Upstream's `set_editor_status`
  // bounds this by the 30s budget alone, so only the deadline may stop it.
  const RELOADS = 12
  let statusCalls = 0
  const reload = {
    onMessage(request, { broadcast }, socket) {
      const respond = (body) =>
        socket.write(JSON.stringify({ type: 'response', reply_to: request.id, ...body }) + '\n')
      if (request.type === 'set_editor_status') {
        respond({ ok: true, message: 'set_editor_status:ok' })
        return true
      }
      if (request.type !== 'status') return undefined
      statusCalls += 1
      // Poll 1 is the `before` read and must report the pre-change state.
      if (statusCalls === 1) {
        respond({ ok: true, message: 'editing|Assets/Scenes/Main.unity' })
        return true
      }
      // Then RELOADS disconnects, then convergence.
      if (statusCalls < 2 + RELOADS) {
        respond({ ok: false, error: 'managed_reloading' })
        return true
      }
      respond({ ok: true, message: 'playing|Assets/Scenes/Main.unity' })
      return true
    },
  }
  await withBroker(async (broker) => {
    const client = await connected(broker)
    let reconnects = 0
    const reconnect = async () => {
      reconnects += 1
      return client
    }
    const result = await setPlayMode(client, 'play', { reconnect })
    assert.equal(result.status, 'playing')
    assert.equal(reconnects, RELOADS, 'every reload is retried, not capped')
    await client.close()
  }, reload)
})
