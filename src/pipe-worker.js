// Worker that owns one Locus broker connection: all blocking or evented I/O
// lives here so the DSH main thread never blocks. Protocol: newline-framed JSON
// commands in, newline-framed JSON notifications out.
//
// Two transports, selected by the endpoint shape:
//   `\\.\pipe\…` → blocking Win32 named-pipe fd (`pipe-io.js`)
//   `/…`         → Unix domain socket stream (`socket-io.js`, Linux/macOS port)
//
// in:  {op:'open', pipeName, id} | {op:'write', id, data} | {op:'close', id}
// out: {kind:'opened', id} | {kind:'write-failed', id, error, code}
//      {kind:'frames', frames:[string]}
//      {kind:'closed', reason:'eof'|'error'|'aborted'|'closed', error?}

import { parentPort } from 'node:worker_threads'
import { closePipe, isSocketPath, openPipeClient, readFrames, writeFrame } from './pipe-io.js'
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
 * @type {{ transport: 'pipe', fd, controller, closed } | { transport: 'socket', stream, controller, closed } | null}
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
      close()
      return
    case 'shutdown':
      close()
      return
    default:
      return
  }
})

function open({ id, pipeName }) {
  if (isSocketPath(pipeName)) {
    openSocketSession(id, pipeName)
    return
  }
  let fd
  try {
    fd = openPipeClient(pipeName)
  } catch (error) {
    port.postMessage({ kind: 'closed', id, reason: 'error', error: error.message, code: error.code })
    return
  }
  const current = { transport: 'pipe', fd, controller: new AbortController(), closed: false }
  session = current
  port.postMessage({ kind: 'opened', id })
  readFrames(fd, {
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
  else closePipe(current.fd)
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
  try {
    if (session.transport === 'socket') writeSocketFrame(session.stream, Buffer.from(data, 'utf8'))
    else writeFrame(session.fd, Buffer.from(data, 'utf8'))
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
  else closePipe(current.fd)
  port.postMessage({ kind: 'closed', id, reason: 'closed' })
}
