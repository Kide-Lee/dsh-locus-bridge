// Worker that owns one Locus broker connection: all I/O lives here so the DSH
// main thread never blocks. Protocol: newline-framed JSON commands in,
// newline-framed JSON notifications out.
//
// Two transports, selected by the endpoint shape:
//   `\\.\pipe\…` / bare `locus_*` name → Win32 named pipe (`pipe-io.js`)
//   `/…`                               → Unix domain socket stream (`socket-io.js`)
//
// Both are evented. A blocking read loop here would starve the very
// `{op:'write'}` messages this worker exists to service.

import { parentPort } from 'node:worker_threads'
import { closePipe, connectPipe, isSocketPath, readPipeFrames, writePipeFrame } from './pipe-io.js'
import { closeSocket, connectSocket, readSocketFrames, writeSocketFrame } from './socket-io.js'

const port = parentPort
/**
 * The one open connection.
 *
 * `LocusClient` opens exactly one connection per worker (`{op:'open', id: 0}`)
 * and then addresses every write with its own request id, so keying the session
 * table by that request id would never match — the connection is a worker-wide
 * singleton, not a per-message session.
 *
 * @type {{ transport: 'pipe', stream, controller, closed } | { transport: 'socket', stream, controller, closed } | null}
 */
let session = null

port.on('message', (message) => {
  if (!message || typeof message !== 'object') return
  switch (message.op) {
    case 'open':
      open(message)
      return
    case 'write':
      write(message)
      return
    case 'close':
      close(message.id)
      return
    case 'shutdown':
      close(message.id)
      return
    default:
      return
  }
})

async function open({ id, pipeName }) {
  if (isSocketPath(pipeName)) {
    await openSocketSession(id, pipeName)
    return
  }
  let stream
  try {
    ;({ stream } = await connectPipe(pipeName))
  } catch (error) {
    port.postMessage({ kind: 'closed', id, reason: 'error', error: error.message, code: error.code })
    return
  }
  const current = { transport: 'pipe', stream, controller: new AbortController(), closed: false }
  session = current
  port.postMessage({ kind: 'opened', id })
  readPipeFrames(stream, {
    signal: current.controller.signal,
    onFrames: (frames) => port.postMessage({ kind: 'frames', id, frames }),
  }).then((result) => settle(id, current, result))
}

async function openSocketSession(id, socketPath) {
  let stream
  try {
    ;({ stream } = await connectSocket(socketPath))
  } catch (error) {
    port.postMessage({ kind: 'closed', id, reason: 'error', error: error.message, code: error.code })
    return
  }
  const current = { transport: 'socket', stream, controller: new AbortController(), closed: false }
  session = current
  port.postMessage({ kind: 'opened', id })
  readSocketFrames(stream, {
    signal: current.controller.signal,
    onFrames: (frames) => port.postMessage({ kind: 'frames', id, frames }),
  }).then((result) => settle(id, current, result))
}

function settle(id, current, result) {
  if (current.closed) return
  current.closed = true
  if (session === current) session = null
  if (current.transport === 'socket') closeSocket(current.stream)
  else closePipe(current.stream)
  port.postMessage({
    kind: 'closed',
    id,
    reason: result.reason,
    error: result.error?.message,
    code: result.error?.code,
  })
}

function write({ id, data }) {
  if (!session) {
    port.postMessage({ kind: 'write-failed', id, error: 'connection is closed' })
    return
  }
  const buffer = Buffer.from(data, 'utf8')
  try {
    if (session.transport === 'socket') writeSocketFrame(session.stream, buffer)
    else writePipeFrame(session.stream, buffer)
  } catch (error) {
    port.postMessage({ kind: 'write-failed', id, error: error.message, code: error.code })
  }
}

function close(id = 0) {
  const current = session
  if (!current) return
  session = null
  current.closed = true
  current.controller.abort()
  if (current.transport === 'socket') closeSocket(current.stream)
  else closePipe(current.stream)
  port.postMessage({ kind: 'closed', id, reason: 'closed' })
}
