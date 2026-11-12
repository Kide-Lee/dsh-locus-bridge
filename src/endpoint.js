// Is anything listening on a Locus broker endpoint?
//
// This is the "connected" test, and it exists as its own module because the
// answer has to come back *fast and without side effects*: a settings page polls
// it for several projects at once, and none of those calls may start an editor,
// open an edit session, or block the Host's main thread.
//
// The two transports answer differently, and that difference is load-bearing:
//
//   * Win32 named pipe — a failed connect on Windows reports `ENOENT` when no
//     server created the name, and `EPERM`/`EACCES` when one exists but refuses
//     the handle (a sandbox blocking it, or a broker that is mid-shutdown). Only
//     "the name does not exist" is a definite `false`; a permission error means
//     the name *does* exist, which is evidence of a broker and must not be
//     reported as "nothing listening".
//   * Unix domain socket — `ENOENT` means the socket file is gone, and
//     `ECONNREFUSED` means the file is there but no process accepts on it (a
//     stale socket left by a crashed editor). Both are "nothing listening".
//
// Everything is bounded by a timeout: a broker that accepts TCP-like but never
// finishes a handshake must not hang a page.

import { connect } from 'node:net'

/** Errors that prove nobody is listening on a Unix socket. */
const UNIX_ABSENT = new Set(['ENOENT', 'ECONNREFUSED', 'ENOTSOCK', 'EACCES'])

/**
 * Errors on Windows that mean "the pipe name does not exist".
 *
 * `ENOENT` is the plain one. `EPERM`/`EACCES` are deliberately NOT here: on
 * Windows they mean the name was found but the handle was refused, which is the
 * opposite conclusion.
 */
const PIPE_ABSENT = new Set(['ENOENT'])

/** True when `endpoint` is an absolute Unix socket path rather than a pipe name. */
export function isSocketEndpoint(endpoint) {
  return String(endpoint ?? '').trim().startsWith('/')
}

/**
 * Whether something answers on `endpoint`.
 *
 * @param endpoint - a bare or full Win32 pipe name, or an absolute socket path.
 * @param options.timeoutMs - bound on the connect attempt (default 1500 ms).
 * @returns true when a connection was established.
 */
export function probeEndpoint(endpoint, { timeoutMs = 1500 } = {}) {
  const target = String(endpoint ?? '').trim()
  if (!target) return Promise.resolve(false)
  const path = isSocketEndpoint(target) ? target : toPipePath(target)

  return new Promise((resolveResult) => {
    let settled = false
    const finish = (value, socket) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket?.destroy?.()
      } catch {
        // already gone
      }
      resolveResult(value)
    }

    const timer = setTimeout(() => finish(false), timeoutMs)
    // `unref` so a pending probe never keeps the Host process alive.
    timer.unref?.()

    let socket
    try {
      socket = connect(path)
    } catch {
      // A synchronous throw (malformed name) is a definite "no".
      finish(false)
      return
    }

    socket.once('connect', () => finish(true, socket))
    socket.once('error', (error) => {
      const code = String(error?.code ?? '')
      if (isSocketEndpoint(target)) {
        finish(!UNIX_ABSENT.has(code))
        return
      }
      // On the pipe transport only "the name is absent" is a definite no; any
      // other error is left as "not proven listening", which reads as
      // not-connected but is reported through `probeError` by callers that care.
      finish(!PIPE_ABSENT.has(code))
    })
    // A socket that closes without ever connecting is not listening either.
    socket.once('close', () => finish(false, socket))
  })
}

/** `\\.\pipe\<name>` for a bare or already-prefixed pipe name. */
function toPipePath(value) {
  const text = String(value).trim()
  if (text.startsWith('\\\\')) return text
  return `\\\\.\\pipe\\${text.replace(/^\\+/, '')}`
}

/**
 * The probe plus the reason, for a UI that has to explain itself.
 *
 * `probeEndpoint` collapses every failure into `false` because that is what the
 * state machine needs. A page offering "why?" needs the errno, so this variant
 * keeps it.
 */
export function probeEndpointDetailed(endpoint, { timeoutMs = 1500 } = {}) {
  const target = String(endpoint ?? '').trim()
  if (!target) return Promise.resolve({ listening: false, code: 'no_endpoint' })
  const path = isSocketEndpoint(target) ? target : toPipePath(target)

  return new Promise((resolveResult) => {
    let settled = false
    const finish = (value, socket) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket?.destroy?.()
      } catch {
        // already gone
      }
      resolveResult(value)
    }

    const timer = setTimeout(() => finish({ listening: false, code: 'ETIMEDOUT' }), timeoutMs)
    timer.unref?.()

    let socket
    try {
      socket = connect(path)
    } catch (error) {
      finish({ listening: false, code: String(error?.code ?? 'EINVAL') })
      return
    }

    socket.once('connect', () => finish({ listening: true, code: 'connected' }, socket))
    socket.once('error', (error) => {
      const code = String(error?.code ?? '')
      finish({ listening: !(PIPE_ABSENT.has(code) || UNIX_ABSENT.has(code)), code })
    })
    socket.once('close', () => finish({ listening: false, code: 'ECLOSED' }, socket))
  })
}