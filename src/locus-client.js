// The Locus native broker client.
//
// One `LocusClient` owns one pipe connection (a worker thread owns the blocking
// handle) and one pending-request table. It speaks the exact wire shape the
// Tauri desktop client uses (`src-tauri/src/unity_bridge/transport.rs`):
// newline JSON envelopes, `reply_to` routing, `locus-request-accepted` events,
// broker events, and reconnect after a domain reload.

import { Worker } from 'node:worker_threads'
import { LineAssembler } from './line-framer.js'
import {
  BROKER_ERRORS,
  RESPONSE_KIND,
  REQUEST_ACCEPTED_EVENT,
  isNotExecuted,
  splitCapabilities,
} from './protocol.js'

const WORKER_URL = new URL('./pipe-worker.js', import.meta.url)
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const EVENT_BUFFER_LIMIT = 64
const BACKOFF_MS = [0, 100, 200, 400, 800, 1_000]

/** A request that failed at the transport or broker level. */
export class LocusError extends Error {
  constructor(message, { code = null, responses = [] } = {}) {
    super(message)
    this.name = 'LocusError'
    this.code = code
    this.responses = responses
  }

  /** True when the broker guarantees the request never ran (safe to resend). */
  get notExecuted() {
    return isNotExecuted(this.code)
  }
}

export class LocusClient {
  #worker = null
  #stream = null
  #useStream = false
  #seq = 0
  #pending = new Map()
  #events = []
  #listeners = new Set()
  #state = 'new'
  #closing = false
  #connectPromise = null
  #opened = null
  #openFailed = null
  #lastDisconnect = null

  /**
   * @param opts.pipe      pipe name the worker opens (`\\.\pipe\…` on Windows)
   * @param opts.stream    test seam: a Duplex to use instead of a worker/pipe
   */
  constructor({ pipe, stream = null, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = {}) {
    if (!pipe && !stream) throw new Error('LocusClient requires a pipe name')
    this.pipe = pipe
    this.connectTimeoutMs = connectTimeoutMs
    this.#stream = stream
    this.#useStream = stream !== null
    /** Capabilities reported by `bridge_capabilities` after connect (may be empty). */
    this.capabilities = []
  }

  get state() {
    return this.#state
  }

  get connected() {
    return this.#state === 'connected'
  }

  get pendingCount() {
    return this.#pending.size
  }

  /** Connect (idempotent while connected). Throws LocusError on failure. */
  async connect() {
    if (this.#state === 'connected') return
    if (this.#state === 'connecting') return this.#connectPromise
    this.#closing = false
    this.#state = 'connecting'
    this.#connectPromise = this.#doConnect()
    try {
      await this.#connectPromise
    } finally {
      this.#connectPromise = null
    }
  }

  async #doConnect() {
    const opened = new Promise((resolve, reject) => {
      this.#opened = resolve
      this.#openFailed = reject
    })
    if (this.#useStream) this.#startStream()
    else this.#startWorker()
    let timer = null
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new LocusError('locus_connect_timeout')), this.connectTimeoutMs)
    })
    try {
      await Promise.race([opened, timeout])
    } finally {
      clearTimeout(timer)
      this.#opened = null
      this.#openFailed = null
    }
    this.#state = 'connected'
    let response
    try {
      response = await this.#send('ping', '', { timeoutMs: 10_000 })
    } catch (error) {
      await this.close('locus ping failed').catch(() => {})
      throw error
    }
    if (!response.ok) {
      await this.close('locus ping rejected').catch(() => {})
      throw new LocusError(response.error || 'locus ping failed', { code: response.error })
    }
    try {
      const caps = await this.request('bridge_capabilities', '', { timeoutMs: 10_000 })
      this.capabilities = splitCapabilities(caps.ok ? caps.message : '')
    } catch {
      this.capabilities = []
    }
  }

  /**
   * Send one request and resolve with the raw response envelope.
   * Broker rejections resolve with `ok: false` (they are normal outcomes);
   * transport failures reject with LocusError.
   */
  request(type, message = '', { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
    if (this.#state !== 'connected' && type !== 'ping') {
      return Promise.reject(new LocusError('locus_not_connected', { code: BROKER_ERRORS.MANAGED_NOT_READY }))
    }
    return this.#send(type, message, { timeoutMs })
  }

  /** Send and require `ok: true`; rejects with LocusError carrying `response.message` otherwise. */
  async call(type, message = '', options) {
    const envelope = await this.request(type, message, options)
    if (!envelope.ok) {
      throw new LocusError(envelope.error || `${type} failed`, {
        code: envelope.error,
        responses: [envelope],
      })
    }
    return envelope
  }

  /** Bridge events (`type` != response) in arrival order, bounded. */
  get events() {
    return [...this.#events]
  }

  onEvent(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** The error that ended the last connection, or null. */
  get lastDisconnect() {
    return this.#lastDisconnect
  }

  /** Close the pipe and fail every pending request. */
  async close(reason = 'client closed') {
    this.#closing = true
    this.#state = 'closed'
    this.#failAll(new LocusError(reason))
    if (this.#useStream) {
      this.#stream?.destroy?.()
      this.#stream = null
      return
    }
    const worker = this.#worker
    this.#worker = null
    if (worker) {
      try {
        worker.postMessage({ op: 'shutdown' })
      } catch {
        // worker already gone
      }
      await worker.terminate().catch(() => {})
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  #send(type, message, { timeoutMs }) {
    return new Promise((resolve, reject) => {
      const id = `dsh-${process.pid}-${++this.#seq}`
      const entry = { resolve, reject, accepted: false }
      entry.timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new LocusError('locus_request_timeout', { code: BROKER_ERRORS.REQUEST_TIMED_OUT }))
      }, timeoutMs)
      this.#pending.set(id, entry)
      const frame = JSON.stringify({ id, type, message: String(message ?? '') }) + '\n'
      try {
        if (this.#useStream) {
          if (!this.#stream || this.#stream.destroyed) throw new Error('stream closed')
          this.#stream.write(frame)
        } else {
          this.#worker.postMessage({ op: 'write', id, data: frame })
        }
      } catch (error) {
        clearTimeout(entry.timer)
        this.#pending.delete(id)
        reject(new LocusError(`locus write failed: ${error.message}`))
      }
    })
  }

  /** Test seam: run the protocol over an in-process Duplex. */
  #startStream() {
    const stream = this.#stream
    const assembler = new LineAssembler()
    // A replaced or disposed stream may emit late 'error' events (destroy);
    // they must not surface as unhandled rejections.
    const guard = (fn) => {
      try {
        fn()
      } catch {
        // transport loss already reported by the read loop / other handlers
      }
    }
    stream.on('data', (chunk) => {
      try {
        for (const frame of assembler.push(chunk)) this.#onFrame(frame)
      } catch (error) {
        guard(() => this.#onDisconnected(new LocusError(`locus frame error: ${error.message}`), { report: false }))
      }
    })
    stream.on('error', (error) =>
      guard(() => this.#onDisconnected(new LocusError(`locus stream error: ${error.message}`), { report: false })),
    )
    stream.on('close', () => guard(() => this.#onDisconnected(new LocusError('locus stream closed'), { report: false })))
    queueMicrotask(() => this.#opened?.())
  }

  #startWorker() {
    const worker = new Worker(WORKER_URL)
    this.#worker = worker
    worker.on('message', (message) => this.#onWorkerMessage(message))
    worker.on('error', (error) => this.#onDisconnected(new LocusError(`locus worker crashed: ${error.message}`)))
    worker.on('exit', (code) => {
      if (this.#worker === worker) this.#onDisconnected(new LocusError(`locus worker exited (${code})`))
    })
    worker.postMessage({ op: 'open', id: 0, pipeName: this.pipe })
  }

  #onWorkerMessage(message) {
    switch (message?.kind) {
      case 'opened':
        this.#opened?.()
        return
      case 'frames':
        for (const frame of message.frames) this.#onFrame(frame)
        return
      case 'write-failed':
        this.#onDisconnected(new LocusError(`locus pipe write failed: ${message.error}`, { code: message.code }))
        return
      case 'closed':
        this.#onDisconnected(
          message.reason === 'closed'
            ? new LocusError('locus connection closed')
            : new LocusError(`locus pipe closed (${message.reason})${message.error ? `: ${message.error}` : ''}`, {
                code: message.code ?? BROKER_ERRORS.RELOAD_INTERRUPTED,
              }),
          { report: message.reason !== 'closed' },
        )
        return
      default:
        return
    }
  }

  #onFrame(frame) {
    let envelope
    try {
      envelope = JSON.parse(frame)
    } catch {
      return
    }
    if (!envelope || typeof envelope !== 'object') return
    const kind = typeof envelope.type === 'string' ? envelope.type : ''
    const replyTo = typeof envelope.reply_to === 'string' ? envelope.reply_to.trim() : ''
    if (kind === REQUEST_ACCEPTED_EVENT) {
      const requestId = parseAcceptedRequestId(envelope.message)
      const entry = requestId ? this.#pending.get(requestId) : null
      if (entry) entry.accepted = true
      this.#recordEvent(envelope)
      return
    }
    if (replyTo) {
      const entry = this.#pending.get(replyTo)
      if (entry) {
        this.#pending.delete(replyTo)
        clearTimeout(entry.timer)
        entry.resolve(envelope)
      }
      return
    }
    this.#recordEvent(envelope)
  }

  #recordEvent(envelope) {
    this.#events.push(envelope)
    if (this.#events.length > EVENT_BUFFER_LIMIT) this.#events.shift()
    for (const listener of this.#listeners) {
      try {
        listener(envelope)
      } catch {
        // a listener fault must not break the read loop
      }
    }
  }

  #onDisconnected(error, { report = true } = {}) {
    const wasConnectedOrConnecting = this.#state === 'connected' || this.#state === 'connecting'
    this.#state = this.#closing ? 'closed' : 'disconnected'
    if (wasConnectedOrConnecting && report) this.#lastDisconnect = error
    if (this.#state === 'connecting') {
      const fail = this.#openFailed
      this.#openFailed = null
      fail?.(error)
    }
    this.#failAll(error)
  }

  #failAll(error) {
    // Clear the table first: a rejection handler may immediately retry.
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const entry of pending) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  }
}

function parseAcceptedRequestId(message) {
  try {
    const parsed = typeof message === 'string' ? JSON.parse(message) : message
    const id = parsed?.requestId
    return typeof id === 'string' ? id.trim() : ''
  } catch {
    return ''
  }
}

export { BACKOFF_MS }
export { RESPONSE_KIND }
