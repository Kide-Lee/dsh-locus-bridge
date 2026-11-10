// Unix domain socket client for the Linux/macOS Locus broker port.
//
// `Locus/locus_unix_native` serves the exact same newline-JSON protocol as the
// Win32 named pipe. A stream socket cannot be read with `readSync`, so this
// transport uses `node:net` and hands complete lines to the same
// `LineAssembler` the pipe transport uses. Runs inside the worker thread like
// the pipe path, so the DSH main thread never blocks on connect or I/O.

import { createConnection } from 'node:net'
import { LineAssembler } from './line-framer.js'

const CONNECT_TIMEOUT_MS = 10_000

/** A socket-level failure, shaped like `PipeError` so callers branch identically. */
export class SocketError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'SocketError'
    this.code = code ?? null
  }
}

/**
 * Connect one Unix socket.
 * Resolves with `{ stream }`; rejects with `SocketError` carrying the OS code
 * (`ENOENT` when the editor is not running, `ECONNREFUSED` for a stale socket).
 */
export function connectSocket(socketPath, { timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    const stream = createConnection(socketPath)

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      stream.destroy()
      reject(new SocketError(`connect ${socketPath} timed out after ${timeoutMs} ms`, 'ETIMEDOUT'))
    }, timeoutMs)

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream.removeListener('error', onError)
      fn(value)
    }

    function onError(error) {
      finish(reject, new SocketError(`cannot connect ${socketPath}: ${error.message}`, error.code ?? null))
    }

    stream.once('error', onError)
    stream.once('connect', () => {
      stream.setNoDelay?.(true)
      finish(resolve, { stream })
    })
  })
}

/**
 * Read frames from an established socket until it closes or `signal` aborts.
 * Resolves with `{ reason: 'eof'|'error'|'aborted', error? }`, matching the pipe
 * reader's contract so the worker can report one shape to `LocusClient`.
 */
export function readSocketFrames(stream, { onFrames, signal, assembler = new LineAssembler() } = {}) {
  return new Promise((resolve) => {
    let done = false
    const finish = (result) => {
      if (done) return
      done = true
      clearListeners()
      resolve(result)
    }

    function onData(chunk) {
      if (done) return
      let frames
      try {
        frames = assembler.push(chunk)
      } catch (error) {
        stream.destroy()
        finish({ reason: 'error', error })
        return
      }
      if (frames.length > 0) {
        try {
          onFrames?.(frames)
        } catch (error) {
          finish({ reason: 'error', error })
        }
      }
    }

    function onEnd() {
      finish({ reason: 'eof' })
    }

    function onError(error) {
      finish({ reason: 'error', error })
    }

    function onClose() {
      finish({ reason: 'eof' })
    }

    function onAbort() {
      stream.destroy()
      finish({ reason: 'aborted' })
    }

    function clearListeners() {
      stream.removeListener('data', onData)
      stream.removeListener('end', onEnd)
      stream.removeListener('error', onError)
      stream.removeListener('close', onClose)
      signal?.removeEventListener?.('abort', onAbort)
    }

    stream.on('data', onData)
    stream.once('end', onEnd)
    stream.on('error', onError)
    stream.once('close', onClose)
    signal?.addEventListener?.('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

/** Write one already-newline-terminated frame, honouring socket backpressure. */
export function writeSocketFrame(stream, buffer) {
  if (!stream || stream.destroyed) throw new SocketError('socket is closed', 'EPIPE')
  stream.write(buffer)
}

/** Close the socket; a socket already closed elsewhere is tolerated. */
export function closeSocket(stream) {
  try {
    stream?.destroy?.()
  } catch {
    // already destroyed
  }
}
