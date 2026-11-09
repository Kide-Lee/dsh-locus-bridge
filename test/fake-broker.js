/**
 * Fake Locus native broker for tests.
 *
 * The Locus broker is a Windows named pipe server; Windows lets a client use
 * `fs` on `\\.\pipe\…`, but on Linux/macOS `fs.open` on a Unix socket fails.
 * The fake therefore speaks the same newline-JSON protocol over a stream pair:
 *   - on non-Windows it is an in-process Duplex pair (`clientStream`), which the
 *     test pipes into `LocusClient` through its `stream` test seam;
 *   - on Windows it is a real TCP loopback server whose address can be opened
 *     with `fs` (pass `{ tcp: true }`).
 *
 * It reproduces the broker behaviour the client depends on: ping /
 * bridge_capabilities / status answered without the executor, `ok:false`
 * envelopes, the `locus-request-accepted` broadcast, reply_to routing and
 * broadcast events.
 */
import { createServer } from 'node:net'
import { Duplex, Transform } from 'node:stream'
import { LineAssembler } from '../src/line-framer.js'

export async function startFakeBroker({ onMessage, tcp = false } = {}) {
  const clients = new Set()
  let server = null
  let path = null

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
        // A generated scene-set snippet prints one JSON line; echo it so callers
        // parse exactly what a real edit returns.
        const synthetic = /printJson\(new Dictionary<string, object>/.test(message)
          ? JSON.stringify({ ok: true, scene: 'Assets/Scenes/Main.unity', objectPath: 'Root/Player', component: 'Transform', propertyPath: 'm_LocalPosition', operation: 'set', value: '0,1,0' })
          : null
        const output = synthetic ?? `ran: ${message.split('\n')[0]}`
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
      default:
        return reply(socket, request, { ok: false, error: `unknown command ${type}` })
    }
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
  if (!tcp) {
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
    },
  }
  // The test never reads this end directly; an unhandled 'error' from a
  // dropped/replaced pipeline would crash the process.
  brokerApi.stream?.on('error', () => {})
  return brokerApi
}
