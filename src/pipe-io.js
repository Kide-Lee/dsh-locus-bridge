// Windows named-pipe I/O for the Locus broker.
//
// Node's `net` module DOES open a Win32 named pipe path (`createConnection` on
// `\\.\pipe\…`), so this transport is evented: the worker thread keeps its event
// loop free to receive `{op:'write'}` messages while data arrives asynchronously.
//
// History: this used to open the pipe with `openSync(…, 'r+')` and read it with
// a blocking `readSync` loop. That cannot work, for two independent reasons:
//
//   1. `readFrames` derived its handle from `fstatSync(fd).fd`, but a `Stats`
//      object has no `fd` property, so every read threw "The \"fd\" argument
//      must be of type number".
//   2. Even with a correct handle, a blocking read loop occupies the worker's
//      single thread, so a `{op:'write'}` message posted by `LocusClient` is
//      never dispatched: the ping could not be sent and every request timed out.
//
// The names/shapes below stay compatible with `socket-io.js` so the worker
// handles both transports identically.

import { createConnection } from 'node:net'
import { LineAssembler } from './line-framer.js'

const CONNECT_TIMEOUT_MS = 10_000

export function isWindows() {
  return process.platform === 'win32'
}

/** True for an absolute Unix socket path (`/…`). Win32 pipes start with `\\.\pipe\`. */
export function isSocketPath(endpoint) {
  return String(endpoint ?? '').trim().startsWith('/')
}

export class PipeError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'PipeError'
    this.code = code ?? null
  }
}

/** Normalise the endpoint to the path `net.createConnection` expects. */
export function pipePath(pipeName) {
  const target = String(pipeName ?? '').trim()
  if (!target) throw new PipeError('a broker pipe name is required', 'EINVAL')
  // `locus_unity_native_<key>` is the bare form Unity records in the marker;
  // `\\.\pipe\…` is the full Win32 path. Accept both.
  if (target.startsWith('\\\\.\\pipe\\') || target.startsWith('//./pipe/')) return target
  return `\\\\.\\pipe\\${target}`
}

/**
 * Open the client end of one broker pipe.
 *
 * Unix socket paths are refused here because the worker routes those to
 * `socket-io.js`; this module is the Win32 pipe transport.
 *
 * @returns {Promise<{stream: import('node:net').Socket}>}
 */
export function connectPipe(pipeName, { timeoutMs = CONNECT_TIMEOUT_MS } = {}) {
  if (isSocketPath(pipeName)) {
    return Promise.reject(
      new PipeError(`a Unix socket path needs the stream transport, not the pipe transport: ${pipeName}`, 'EUSESTREAM'),
    )
  }
  if (!isWindows()) {
    return Promise.reject(
      new PipeError(
        `Win32 named pipes are Windows-only (got ${pipeName}); a Locus broker on this host listens on a Unix socket path`,
        'ENOTWINDOWS',
      ),
    )
  }
  const target = pipePath(pipeName)
  return new Promise((resolve, reject) => {
    let settled = false
    const stream = createConnection(target)

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      stream.destroy()
      reject(new PipeError(`connect ${target} timed out after ${timeoutMs} ms`, 'ETIMEDOUT'))
    }, timeoutMs)

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stream.removeListener('error', onError)
      fn(value)
    }

    function onError(error) {
      finish(reject, new PipeError(`cannot connect ${target}: ${error.message}`, error.code ?? null))
    }

    stream.once('error', onError)
    stream.once('connect', () => {
      stream.setNoDelay?.(true)
      finish(resolve, { stream })
    })
  })
}

/**
 * Read frames from an established pipe until it closes or `signal` aborts.
 * Resolves with `{ reason: 'eof'|'error'|'aborted', error? }`, the contract the
 * worker reports to `LocusClient`.
 */
export function readPipeFrames(stream, { onFrames, signal, assembler = new LineAssembler() } = {}) {
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

/** Write one already-newline-terminated frame; honours socket backpressure. */
export function writePipeFrame(stream, buffer) {
  if (!stream || stream.destroyed) throw new PipeError('pipe is closed', 'EPIPE')
  stream.write(buffer)
}

/** Close the pipe; a handle already closed elsewhere is tolerated. */
export function closePipe(stream) {
  try {
    stream?.destroy?.()
  } catch {
    // already destroyed
  }
}

/**
 * Legacy blocking helpers, kept because `test/` and `scripts/` import them.
 * They are no longer used by the worker: see the header for why.
 */
export function openPipeClient(pipeName) {
  throw new PipeError(
    `openPipeClient is a blocking Win32 handle reader and is no longer used; use connectPipe(${pipeName})`,
    'EUSESTREAM',
  )
}

export function writeFrame() {
  throw new PipeError('writeFrame is unused; use writePipeFrame', 'EUSESTREAM')
}

export function readFrames() {
  return Promise.reject(new PipeError('readFrames is unused; use readPipeFrames', 'EUSESTREAM'))
}
