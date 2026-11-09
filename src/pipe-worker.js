// Worker that owns one Locus pipe handle: all blocking fs I/O lives here so the
// DSH main thread never blocks. Protocol: newline-framed JSON commands in,
// newline-framed JSON notifications out.
//
// in:  {op:'open', pipeName, id} | {op:'write', id, data} | {op:'close', id}
// out: {kind:'opened', id} | {kind:'write-failed', id, error, code}
//      {kind:'frames', frames:[string]}
//      {kind:'closed', reason:'eof'|'error'|'aborted'|'closed', error?}

import { parentPort } from 'node:worker_threads'
import { closePipe, openPipeClient, readFrames, writeFrame } from './pipe-io.js'

const port = parentPort
const sessions = new Map()

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
      for (const id of [...sessions.keys()]) close(id)
      return
    default:
      return
  }
})

function open({ id, pipeName }) {
  let fd
  try {
    fd = openPipeClient(pipeName)
  } catch (error) {
    port.postMessage({ kind: 'closed', id, reason: 'error', error: error.message, code: error.code })
    return
  }
  const session = { fd, controller: new AbortController(), closed: false }
  sessions.set(id, session)
  port.postMessage({ kind: 'opened', id })
  readFrames(fd, {
    signal: session.controller.signal,
    onFrames: (frames) => port.postMessage({ kind: 'frames', id, frames }),
  }).then((result) => {
    if (session.closed) return
    session.closed = true
    sessions.delete(id)
    closePipe(fd)
    port.postMessage({
      kind: 'closed',
      id,
      reason: result.reason,
      error: result.error?.message,
      code: result.error?.code,
    })
  })
}

function write({ id, data }) {
  const session = sessions.get(id)
  if (!session) {
    port.postMessage({ kind: 'write-failed', id, error: 'pipe is closed' })
    return
  }
  try {
    writeFrame(session.fd, Buffer.from(data, 'utf8'))
  } catch (error) {
    port.postMessage({ kind: 'write-failed', id, error: error.message, code: error.code })
  }
}

function close(id) {
  const session = sessions.get(id)
  if (!session) return
  session.closed = true
  sessions.delete(id)
  session.controller.abort()
  closePipe(session.fd)
  port.postMessage({ kind: 'closed', id, reason: 'closed' })
}
