// Incremental newline framing for the Locus pipe (byte mode, one JSON per line).

/** A frame larger than this is treated as protocol corruption (broker caps at 16 MiB). */
export const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024

/**
 * Split a byte stream into newline-delimited lines. LF is the terminator (Bytes
 * mode, not Lines mode), so a trailing CR is stripped; leading UTF-8 BOM and
 * surrounding ASCII whitespace are ignored like `trim_frame` in the protocol
 * crate. Empty frames are skipped.
 */
export class LineAssembler {
  #pending = []
  #pendingBytes = 0

  constructor({ maxLineBytes = DEFAULT_MAX_LINE_BYTES } = {}) {
    this.maxLineBytes = maxLineBytes
  }

  /**
   * Feed one chunk and return every complete frame it finished.
   * @throws when a single frame exceeds `maxLineBytes` (the stream is unusable).
   */
  push(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const frames = []
    let start = 0
    while (start < bytes.length) {
      const newline = bytes.indexOf(0x0a, start)
      if (newline === -1) {
        this.#append(bytes.subarray(start))
        return frames
      }
      const tail = bytes.subarray(start, newline)
      const frame = this.#pendingBytes === 0 ? tail : Buffer.concat([...this.#pending, tail])
      this.#pending = []
      this.#pendingBytes = 0
      const text = normalizeFrame(frame.toString('utf8'))
      if (text) frames.push(text)
      start = newline + 1
    }
    return frames
  }

  /** Flush one unterminated trailing frame (only used for diagnostics/tests). */
  flush() {
    if (this.#pendingBytes === 0) return null
    const text = normalizeFrame(Buffer.concat(this.#pending).toString('utf8'))
    this.#pending = []
    this.#pendingBytes = 0
    return text || null
  }

  #append(chunk) {
    if (chunk.length === 0) return
    this.#pendingBytes += chunk.length
    if (this.#pendingBytes > this.maxLineBytes) {
      this.#pending = []
      this.#pendingBytes = 0
      throw new Error(`locus protocol: frame exceeds ${this.maxLineBytes} bytes`)
    }
    this.#pending.push(chunk)
  }
}

/** Strip BOM/whitespace and a trailing CR; empty frames become null. */
export function normalizeFrame(text) {
  let value = String(text ?? '')
  if (value.charCodeAt(0) === 0xfeff) value = value.slice(1)
  return value.trim()
}
