// Blocking Windows named-pipe I/O. Runs inside a worker thread only.
//
// Node's `net` module cannot open a Win32 named pipe path, but fs open/read/write
// on `\\.\pipe\…` map to CreateFile/ReadFile/WriteFile and work on Windows.
// There are no file events for pipes, so reads are blocking reads on the same
// worker that owns the handle; the main thread only sends newline-framed lines.
//
// NOTE: unverified on Windows (the checkout was researched on Linux). The
// shape follows the Tauri client (duplex open, `read_until(b'\n')`, whole-line
// writes); the live-smoke script exists to validate it on a real editor.

import { closeSync, fstatSync, openSync, readSync, writeSync } from 'node:fs'
import { LineAssembler } from './line-framer.js'

const READ_SIZE = 64 * 1024
const IDLE_RETRY_MS = 50
const WRITE_RETRY_MS = 5
const WRITE_RETRY_LIMIT = 2000

export function isWindows() {
  return process.platform === 'win32'
}

export class PipeError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'PipeError'
    this.code = code ?? null
  }
}

/** Open the client end of a named pipe. Throws PipeError with the raw OS code. */
export function openPipeClient(pipeName) {
  // Real Locus brokers are Windows named pipes; nothing equivalent exists on
  // other platforms (tests use the LocusClient Stream seam instead).
  if (!isWindows()) {
    throw new PipeError('Locus native broker pipes are Windows-only', 'ENOTWINDOWS')
  }
  try {
    // 'r+' = read + write on the same handle; Win32 requires both for a duplex pipe.
    return openSync(pipeName, 'r+')
  } catch (error) {
    throw new PipeError(`cannot open ${pipeName}: ${error.message}`, error.code ?? null)
  }
}

/**
 * Write one already-newline-terminated frame. `writeSync` may accept only part of
 * the buffer on a pipe; the remainder is retried until written or rejected.
 */
export function writeFrame(fd, buffer) {
  let offset = 0
  let attempts = 0
  while (offset < buffer.length) {
    try {
      const written = writeSync(fd, buffer, offset, buffer.length - offset)
      offset += written
      attempts = 0
    } catch (error) {
      if (!isTransient(error) || ++attempts > WRITE_RETRY_LIMIT) {
        throw new PipeError(`pipe write failed: ${error.message}`, error.code ?? null)
      }
      sleepSync(WRITE_RETRY_MS)
    }
  }
}

/**
 * Read frames from the pipe until it closes or `signal` aborts.
 * Calls `onFrames(string[])` with every complete batch; resolves with a reason.
 */
export async function readFrames(fd, { onFrames, signal, assembler = new LineAssembler() } = {}) {
  const buffer = Buffer.allocUnsafe(READ_SIZE)
  let handle = fd
  try {
    handle = fstatSync(fd).fd
  } catch {
    handle = fd
  }
  while (!signal?.aborted) {
    let bytesRead
    try {
      bytesRead = readSync(handle, buffer, 0, READ_SIZE, null)
    } catch (error) {
      // A duplex pipe with nothing pending may report EAGAIN/EOF on Windows.
      if (error?.code === 'EAGAIN' || error?.code === 'EINTR') {
        await sleep(IDLE_RETRY_MS, signal)
        continue
      }
      return { reason: error?.code === 'EOF' ? 'eof' : 'error', error }
    }
    if (bytesRead === 0) return { reason: 'eof' }
    // Copy out of the reused buffer before the next read overwrites it.
    const chunk = Buffer.from(buffer.subarray(0, bytesRead))
    let frames
    try {
      frames = assembler.push(chunk)
    } catch (error) {
      return { reason: 'error', error }
    }
    if (frames.length > 0) onFrames?.(frames)
  }
  return { reason: 'aborted' }
}

/** Close the handle; a handle already closed by the worker is tolerated. */
export function closePipe(fd) {
  try {
    closeSync(fd)
  } catch {
    // already closed
  }
}

function isTransient(error) {
  return error?.code === 'EAGAIN' || error?.code === 'EPIPE' || error?.code === 'EINTR'
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function sleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', done)
      resolve()
    }
    signal?.addEventListener?.('abort', done, { once: true })
  })
}
