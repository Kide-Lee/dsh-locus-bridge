/**
 * Fake Locus native broker for tests.
 *
 * Three transports, one protocol:
 *   - `{ unix: true }` — a real Unix domain socket server in a temporary
 *     directory. This exercises the actual Linux/macOS transport (`socket-io.js`
 *     + the worker) end to end, including connect, framing and EOF;
 *   - `{ tcp: true }` — a TCP loopback server (the Windows pipe path can be
 *     opened with `fs`, so this is what the Windows transport test uses);
 *   - default — an in-process Duplex pair (`clientStream`) piped into
 *     `LocusClient` through its `stream` test seam.
 *
 * It reproduces the broker behaviour the client depends on: ping /
 * bridge_capabilities / status answered without the executor, `ok:false`
 * envelopes, the `locus-request-accepted` broadcast, reply_to routing and
 * broadcast events.
 */
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex, Transform } from 'node:stream'
import { LineAssembler } from '../src/line-framer.js'

export async function startFakeBroker({ onMessage, tcp = false, unix = false } = {}) {
  const clients = new Set()
  let server = null
  let path = null
  let unixDir = null

  const broadcast = (envelope) => {
    const line = JSON.stringify(envelope) + '\n'
    for (const socket of clients) socket.write(line)
  }

  const attach = (socket) => {
    clients.add(socket)
    const assembler = new LineAssembler()
    socket.on('data', (chunk) => {
      for (const frame of assembler.push(chunk)) {
        let request
        try {
          request = JSON.parse(frame)
        } catch {
          continue
        }
        handle(request, socket)
      }
    })
    socket.on('close', () => clients.delete(socket))
    socket.on('error', () => clients.delete(socket))
  }

  const reply = (socket, request, body) => {
    if (socket.destroyed) return
    socket.write(JSON.stringify({ type: 'response', reply_to: request.id, ...body }) + '\n')
  }

  function handle(request, socket) {
    const type = request.type
    const message = request.message ?? ''
    if (onMessage?.(request, { broadcast }, socket) !== undefined) return
    switch (type) {
      case 'ping':
        return reply(socket, request, { ok: true, message: 'pong', processId: 4242, processPath: 'Unity.exe' })
      case 'bridge_capabilities':
        return reply(socket, request, {
          ok: true,
          message: 'broker_v1,broker_multi_client_v1,broker_compile_result_v1,managed_executor_v1',
        })
      case 'status':
        return reply(socket, request, { ok: true, message: 'editing|Assets/Scenes/Main.unity' })
      case 'execute_code': {
        const accepted = { requestId: request.id, requestType: type }
        socket.write(JSON.stringify({ type: 'locus-request-accepted', ok: true, message: JSON.stringify(accepted) }) + '\n')
        broadcast({ type: 'status-changed', ok: true, message: JSON.stringify({ editorStatus: 'playing' }) })
        // The asset-graph scan also prints JSON, so it has to be recognised
        // first; otherwise the generic printJson branch claims it and answers
        // with a scene-set shape.
        const scan = /MonoScript\.FromMonoBehaviour/.test(message)
          ? JSON.stringify({
              attachPoints: 1,
              returned: 1,
              truncated: false,
              results: [
                {
                  scenePath: 'Assets/Scenes/Main.unity',
                  objectPath: 'Root/Player',
                  component: 'PlayerController',
                  componentIndex: 1,
                },
              ],
            })
          : null
        // A generated scene-set snippet prints one JSON line; echo it so callers
        // parse exactly what a real edit returns.
        const synthetic = /printJson\(new Dictionary<string, object>/.test(message)
          ? JSON.stringify({ ok: true, scene: 'Assets/Scenes/Main.unity', objectPath: 'Root/Player', component: 'Transform', propertyPath: 'm_LocalPosition', operation: 'set', value: '0,1,0' })
          : null
        const output = scan ?? synthetic ?? `ran: ${message.split('\n')[0]}`
        setTimeout(() => reply(socket, request, { ok: true, message: output }), 5)
        return
      }
      case 'begin_edit_session':
      case 'end_edit_session':
      case 'cancel_execute_code':
        return reply(socket, request, { ok: true, message: `${type}:ok` })
      case 'status':
        return reply(socket, request, { ok: true, message: 'editing|Assets/Scenes/Main.unity' })
      case 'get_reload_state':
        return reply(socket, request, {
          ok: true,
          message: JSON.stringify({
            session_id: 'session',
            domain_generation: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            converged_serial: 3,
            is_compiling: false,
            is_updating: false,
          }),
        })
      case 'search_scene_objects': {
        const query = String(JSON.parse(message || '{}').query ?? '')
        const results = [{ scenePath: 'Assets/Scenes/Main.unity', objectPath: `Root/${query}`, name: query, matchScore: 100 }]
        return reply(socket, request, { ok: true, message: JSON.stringify({ results }) })
      }
      case 'property_tree_read':
        return reply(socket, request, { ok: true, message: JSON.stringify(sceneTree(message)) })
      case 'select_scene_object':
        return reply(socket, request, { ok: true, message: 'ok' })
      case 'request_recompile':
        return reply(socket, request, { ok: true, message: 'recompile_started' })
      case 'get_compile_result':
        return reply(socket, request, { ok: true, message: 'ok' })
      case 'asset_api':
        return reply(socket, request, { ok: true, message: JSON.stringify(fakeAssetApi(JSON.parse(message || '{}'))) })
      case 'search_yaml':
        return reply(socket, request, {
          ok: true,
          message: fakeYamlSearch(JSON.parse(message || '{}')),
        })
      case 'capture_viewport':
        return reply(socket, request, {
          ok: true,
          message: JSON.stringify({
            target: JSON.parse(message || '{}').target,
            title: 'Game',
            path: 'Temp/LocusCapture/fake.png',
            width: 1280,
            height: 720,
            originalWidth: 2560,
            originalHeight: 1440,
            sourceWidth: 2560,
            sourceHeight: 1440,
            outputWidth: 1280,
            outputHeight: 720,
            maxLongEdge: 1280,
            pixelsPerPoint: 1,
            captureArea: 'viewport',
            mimeType: 'image/png',
          }),
        })
      case 'unity_test_list':
        return reply(socket, request, {
          ok: true,
          message: JSON.stringify({
            mode: JSON.parse(message || '{}').mode ?? 'edit|play',
            matched: 2,
            truncated: false,
            tests: [
              { name: 'Damage', full_name: 'Game.Tests.CombatTests.Damage', assembly: 'Game.Tests', mode: 'Edit', path: ['Game', 'Combat'], categories: [] },
              { name: 'Heal', full_name: 'Game.Tests.CombatTests.Heal', assembly: 'Game.Tests', mode: 'Edit', path: ['Game', 'Combat'], categories: [] },
            ],
          }),
        })
      case 'unity_test_start':
        return reply(socket, request, {
          ok: true,
          message: JSON.stringify(testSnapshot({ status: 'running', runId: JSON.parse(message || '{}').run_id })),
        })
      case 'unity_test_status':
        return reply(socket, request, {
          ok: true,
          message: JSON.stringify(testSnapshot({ status: 'passed', runId: JSON.parse(message || '{}').run_id })),
        })
      case 'unity_test_cancel':
        return reply(socket, request, {
          ok: true,
          message: JSON.stringify(testSnapshot({ status: 'cancelled', runId: JSON.parse(message || '{}').run_id })),
        })
      default:
        return reply(socket, request, { ok: false, error: `unknown command ${type}` })
    }
  }

  /** A completed Unity Test snapshot in the shape the Unity service emits. */
  function testSnapshot({ status, runId }) {
    return {
      run_id: runId ?? 'run-1',
      status,
      mode: 'Edit',
      current_test: status === 'running' ? 'Game.Tests.CombatTests.Damage' : '',
      total: 2,
      passed: status === 'running' ? 0 : 2,
      failed: 0,
      skipped: 0,
      inconclusive: 0,
      duration_ms: 42,
      error: '',
      failures: [],
      results: [
        { full_name: 'Game.Tests.CombatTests.Damage', result_state: 'Passed', duration_ms: 10, message: '', stack_trace: '' },
        { full_name: 'Game.Tests.CombatTests.Heal', result_state: 'Passed', duration_ms: 10, message: '', stack_trace: '' },
      ],
    }
  }

  /** Render a `search_yaml` answer the way the Unity side does: a text report. */
  function fakeYamlSearch(body) {
    const lines = [`file: ${body.file_path ?? '?'}`]
    if (body.query) lines.push(`match value "${body.query}":`)
    else if (body.match_fields) lines.push(`match field "${body.match_fields}":`)
    else lines.push('listing:')
    lines.push('  - Game/Player (PlayerController) m_Script -> 0123456789abcdef0123456789abcdef')
    lines.push('  - Game/Player (PlayerController) maxHealth = 100')
    return lines.join('\n')
  }

  /** Minimal asset api: read returns a snapshot, any apply reports success. */
  function fakeAssetApi(body) {
    if (body.action === 'read') {
      return {
        revision: `live:${body.path}`,
        path: body.path,
        objects: [{ object_id: '11400000', class_id: 114, root_type: 'MySO', fields: [] }],
        fields: [
          { property_path: 'm_Name', kind: 'string', value: 'Balance' },
          { property_path: 'maxHealth', kind: 'integer', value: 100 },
        ],
        diagnostics: [],
      }
    }
    if (body.action === 'disk_reload') return { reloaded: true, imported: body.paths ?? [], reloaded_scenes: [], stale: [], pending_refresh: [] }
    return { applied: true, persisted: true, transaction_id: 'tx-fake', timings: { writeMs: 1, importMs: 2 } }
  }

  /** A one-node property tree; the scene-set snippet prints its own JSON line. */
  function sceneTree(message) {
    const request = JSON.parse(message || '{}')
    const target = request.target ?? {}
    return {
      ok: true,
      bindingId: null,
      target,
      propertyPath: '',
      displayName: 'GameObject',
      name: target.objectPath?.split('/').pop() ?? 'GameObject',
      type: 'GameObject',
      value: null,
      editable: false,
      isArray: false,
      arraySize: -1,
      children: [
        { propertyPath: 'm_LocalPosition', displayName: 'Local Position', type: 'Vector3', value: '0,1,0', isArray: false, children: [] },
        { propertyPath: 'm_Text', displayName: 'Text', type: 'string', value: 'Hello', isArray: false, children: [] },
      ],
    }
  }

  let clientStream = null
  let sides = null
  if (unix) {
    // A real Unix domain socket: the transport the Linux/macOS broker port uses.
    unixDir = mkdtempSync(join(tmpdir(), 'locus-fake-broker-'))
    const socketPath = join(unixDir, 'broker.sock')
    server = createServer((socket) => {
      socket.setNoDelay(true)
      attach(socket)
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        path = socketPath
        resolve()
      })
    })
  } else if (!tcp) {
    // broker side (duplex) <-> client side exposed to the test
    // Object-mode Transform stages: PassThrough in object mode drops string
    // writes (`typeof chunk !== 'string|Buffer'`), Transform keeps them.
    const passThrough = () => new Transform({ objectMode: true, transform: (chunk, _encoding, done) => done(null, chunk) })
    const toBroker = passThrough()
    const toClient = passThrough()
    clientStream = Duplex.from({ writable: toBroker, readable: toClient })
    const brokerSide = Duplex.from({ writable: toClient, readable: toBroker })
    sides = new Map([
      ['client', clientStream],
      ['broker', brokerSide],
    ])
    attach(brokerSide)
    // start "connected"
    await new Promise((resolve) => setImmediate(resolve))
  } else {
    server = createServer((socket) => {
      socket.setNoDelay(true)
      attach(socket)
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address()
        path = `127.0.0.1:${port}`
        resolve()
      })
    })
  }

  const brokerApi = {
    get path() {
      return path
    },
    get stream() {
      return clientStream
    },
    get clientCount() {
      return clients.size
    },
    // Test-only browser-side handle, so an open Duplex is torn down with the broker.
    get closeableStream() {
      return clientStream
    },
    /** Client-side Duplex handle (for deterministic teardown in tests). */
    get side() {
      return sides?.get('client') ?? clientStream
    },
    /**
     * Test seam: after `socket.destroy()` (a simulated domain reload), accept
     * new connections on a fresh client-side stream exposed by `stream`.
     */
    acceptAfterDrop: () => {
      // The old broker-side handle is already destroyed by the dropped socket
      // (destroying the other end here would raise an unhandled stream error).
      sides?.get('client')?.destroy()
      const passThrough = () => new Transform({ objectMode: true, transform: (chunk, _encoding, done) => done(null, chunk) })
      const toBroker = passThrough()
      const toClient = passThrough()
      clientStream = Duplex.from({ writable: toBroker, readable: toClient })
      const brokerSide = Duplex.from({ writable: toClient, readable: toBroker })
      sides = new Map([
        ['client', clientStream],
        ['broker', brokerSide],
      ])
      attach(brokerSide)
      return clientStream
    },
    close: async () => {
      for (const socket of [...clients]) {
        try {
          socket.destroy()
        } catch {
          // already destroyed
        }
      }
      if (clientStream) {
        clientStream.destroy()
        clientStream = null
      }
      if (server) {
        await new Promise((resolve) => server.close(resolve))
        server = null
      }
      if (unixDir) {
        rmSync(unixDir, { recursive: true, force: true })
        unixDir = null
      }
    },
  }
  // The test never reads this end directly; an unhandled 'error' from a
  // dropped/replaced pipeline would crash the process.
  brokerApi.stream?.on('error', () => {})
  return brokerApi
}
