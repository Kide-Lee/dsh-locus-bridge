// The Linux/macOS transport: a real Unix domain socket served by the fake
// broker, connected through the worker thread and `socket-io.js`. These tests
// exercise the path that `pipe-io.js` cannot (no `readSync` on a stream socket),
// so a regression here would break the whole Linux broker port silently.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocusClient } from '../src/locus-client.js'
import { executeSnippet, readEditorStatus } from '../src/execute.js'
import { connectSocket, readSocketFrames, writeSocketFrame } from '../src/socket-io.js'
import { startFakeBroker } from './fake-broker.js'

const isWindows = process.platform === 'win32'

async function withUnixBroker(fn, options) {
  const broker = await startFakeBroker({ unix: true, ...options })
  try {
    return await fn(broker)
  } finally {
    await broker.close()
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('connects over a real Unix domain socket and completes a ping', { skip: isWindows }, async () => {
  await withUnixBroker(async (broker) => {
    assert.ok(broker.path.endsWith('.sock'), broker.path)
    const client = new LocusClient({ pipe: broker.path })
    try {
      await client.connect()
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

test('routes replies and streams progress frames over the socket', { skip: isWindows }, async () => {
  await withUnixBroker(async (broker) => {
    const client = new LocusClient({ pipe: broker.path })
    try {
      await client.connect()
      await executeSnippet(client, { code: 'print(1);', executionId: 'e1', timeoutMs: 5_000 })
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.ok(client.events.some((event) => event.type === 'locus-request-accepted'))
    } finally {
      await client.close()
    }
  })
})

test('a missing socket rejects fast instead of waiting for the connect timeout', { skip: isWindows }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'locus-missing-'))
  const socketPath = join(dir, 'nope.sock')
  const started = Date.now()
  try {
    await assert.rejects(
      () => connectSocket(socketPath, { timeoutMs: 5_000 }),
      (error) => error.code === 'ENOENT' && /cannot connect/.test(error.message),
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  // The OS answers immediately; the guard keeps a regression from eating the suite.
  assert.ok(Date.now() - started < 2_000, 'a missing socket must not wait for the timeout')
})

test('a closed socket ends the read loop with eof, not a hang', { skip: isWindows }, async () => {
  const broker = await startFakeBroker({ unix: true })
  let stream
  try {
    ;({ stream } = await connectSocket(broker.path))
    const reading = readSocketFrames(stream, { onFrames: () => {} })
    writeSocketFrame(stream, Buffer.from(JSON.stringify({ id: 'a', type: 'ping', message: '' }) + '\n'))
    await broker.close()
    const result = await Promise.race([
      reading,
      new Promise((resolve) => setTimeout(() => resolve({ reason: 'hung' }), 3_000)),
    ])
    assert.notEqual(result.reason, 'hung', 'the read loop must observe the close')
    assert.ok(['eof', 'error'].includes(result.reason), result.reason)
  } finally {
    await broker.close().catch(() => {})
    stream?.destroy?.()
  }
})

test('the socket transport never leaves a stray socket behind', { skip: isWindows }, async () => {
  const broker = await startFakeBroker({ unix: true })
  const socketPath = broker.path
  assert.equal(existsSync(socketPath), true)
  await broker.close()
  assert.equal(existsSync(socketPath), false, 'the fake broker removes its socket directory')
})
