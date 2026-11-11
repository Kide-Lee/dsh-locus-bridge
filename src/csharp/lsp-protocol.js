// Language Server Protocol framing, URIs and symbol positions.
//
// The Roslyn server (`Microsoft.CodeAnalysis.LanguageServer`) speaks JSON-RPC
// 2.0 over stdio with byte-exact `Content-Length` framing:
//
//   Content-Length: 123\r\n
//   \r\n
//   {"jsonrpc":"2.0", ...}
//
// Everything here is transport shape with no policy: `lsp-client.js` owns the
// state machine, this module only turns bytes into messages and back.
//
// Position convention: LSP defaults to UTF-16 code units, and JavaScript string
// indices are already UTF-16 code units — so a column is `line.indexOf(symbol)`
// with no conversion. (Rust needed `encode_utf16().count()` because its string
// indices are UTF-8 bytes; that step does not apply here.)

import { fileURLToPath, pathToFileURL } from 'node:url'

const HEADER_END = Buffer.from('\r\n\r\n', 'ascii')
const MAX_HEADER_BYTES = 8 * 1024
const MAX_MESSAGE_BYTES = 256 * 1024 * 1024

/** A malformed frame or an unparseable body. */
export class LspProtocolError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LspProtocolError'
  }
}

/** Read `Content-Length` out of one header block. */
function contentLengthOf(header) {
  for (const rawLine of header.split('\r\n')) {
    const separator = rawLine.indexOf(':')
    if (separator < 0) continue
    if (rawLine.slice(0, separator).trim().toLowerCase() !== 'content-length') continue
    const value = Number.parseInt(rawLine.slice(separator + 1).trim(), 10)
    if (!Number.isInteger(value) || value < 0) {
      throw new LspProtocolError(`invalid Content-Length: ${rawLine}`)
    }
    return value
  }
  throw new LspProtocolError(`missing Content-Length in header: ${JSON.stringify(header)}`)
}

/**
 * Incremental decoder for one server stdout stream.
 *
 * A pipe hands over arbitrary chunk boundaries, so a message may arrive split
 * across reads. Push every chunk; the reader yields only complete messages.
 */
export class LspReader {
  #buffer = Buffer.alloc(0)

  /** Feed one stdout chunk; returns the messages it completed (usually zero or one). */
  push(chunk) {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])
    const messages = []
    for (;;) {
      const headerEnd = this.#buffer.indexOf(HEADER_END)
      if (headerEnd < 0) {
        if (this.#buffer.length > MAX_HEADER_BYTES) {
          throw new LspProtocolError('LSP header exceeded 8 KiB without a terminator')
        }
        return messages
      }
      const length = contentLengthOf(this.#buffer.subarray(0, headerEnd).toString('ascii'))
      if (length > MAX_MESSAGE_BYTES) {
        throw new LspProtocolError(`LSP message of ${length} bytes exceeds the 256 MiB cap`)
      }
      const bodyStart = headerEnd + HEADER_END.length
      if (this.#buffer.length < bodyStart + length) return messages
      const body = this.#buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
      this.#buffer = this.#buffer.subarray(bodyStart + length)
      let message
      try {
        message = JSON.parse(body)
      } catch (error) {
        throw new LspProtocolError(`LSP body is not JSON: ${error.message}`)
      }
      if (!message || typeof message !== 'object') {
        throw new LspProtocolError('LSP body must be a JSON object')
      }
      messages.push(message)
    }
  }
}

/** Encode one JSON-RPC message as a framed Buffer. */
export function encodeLspMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii')
  return Buffer.concat([header, body])
}

/** Absolute filesystem path → `file://` URI the server accepts. */
export function pathToFileUri(path) {
  return pathToFileURL(path).href
}

/** `file://` URI → absolute path, or `null` for a non-file scheme. */
export function fileUriToPath(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file:')) return null
  try {
    return fileURLToPath(uri)
  } catch {
    return null
  }
}

const IDENTIFIER = /[\p{L}\p{Nd}_]/u

function isIdentifierChar(char) {
  return char !== undefined && IDENTIFIER.test(char)
}

/**
 * Column of `symbol` in `line` as UTF-16 code units.
 *
 * A whole-word hit always wins; `allowSubstring` adds a substring fallback for
 * the line the caller pointed at (agents quote `List<Foo>` as `Foo`). The
 * fallback is deliberately not used during the file-wide scan: substring hits
 * there turn `Save` into a match inside `SaveAll` and resolve the wrong symbol.
 */
export function symbolColumnInLine(line, symbol, allowSubstring = false) {
  if (!symbol || !line) return null
  let fallback = null
  let from = 0
  for (;;) {
    const found = line.indexOf(symbol, from)
    if (found < 0) break
    const end = found + symbol.length
    const beforeOk = found === 0 || !isIdentifierChar(line[found - 1])
    const afterOk = end >= line.length || !isIdentifierChar(line[end])
    if (beforeOk && afterOk) return found
    if (fallback === null) fallback = found
    from = end
  }
  return allowSubstring ? fallback : null
}

function describeLine(lines, lineNumber) {
  const text = lines[lineNumber - 1]
  if (text === undefined) return ''
  const trimmed = text.trim()
  const preview = trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed
  return ` Line ${lineNumber} content: ${preview}`
}

/**
 * Resolve `symbol` to a 0-based LSP line and UTF-16 column.
 *
 * The line hint is forgiving: agents rarely know exact line numbers. When the
 * symbol is not on the hinted line, the nearest whole-word occurrence in the
 * file is used and the returned anchor records the adjustment. Without a hint
 * the occurrence must be unique; several candidates are listed so one retry
 * with `line` disambiguates.
 *
 * @returns {{ line: number, character: number, anchor: { line: number, requestedLine: number|null } }}
 */
export function locateSymbol(text, lineHint, symbol) {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))

  if (lineHint !== null && lineHint !== undefined) {
    if (!Number.isInteger(lineHint) || lineHint < 1) {
      throw new Error('line must be a 1-based integer')
    }
    const hintedLine = lines[lineHint - 1]
    if (hintedLine !== undefined) {
      const column = symbolColumnInLine(hintedLine, symbol, true)
      if (column !== null) {
        return {
          line: lineHint - 1,
          character: column,
          anchor: { line: lineHint, requestedLine: lineHint },
        }
      }
    }
  }

  const occurrences = []
  lines.forEach((line, index) => {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return
    const column = symbolColumnInLine(line, symbol, false)
    if (column !== null) occurrences.push({ index, column })
  })

  if (occurrences.length === 0) {
    throw new Error(
      `Symbol '${symbol}' not found in the file.${describeLine(lines, lineHint ?? 0)}`,
    )
  }
  if (lineHint !== null && lineHint !== undefined) {
    const target = lineHint - 1
    const nearest = occurrences.reduce((best, candidate) =>
      Math.abs(candidate.index - target) < Math.abs(best.index - target) ? candidate : best,
    )
    return {
      line: nearest.index,
      character: nearest.column,
      anchor: { line: nearest.index + 1, requestedLine: lineHint },
    }
  }
  if (occurrences.length === 1) {
    const only = occurrences[0]
    return { line: only.index, character: only.column, anchor: { line: only.index + 1, requestedLine: null } }
  }
  const listing = occurrences
    .slice(0, 10)
    .map((occurrence) => `\n  ${occurrence.index + 1}: ${lines[occurrence.index].trim()}`)
    .join('')
  const more = occurrences.length > 10 ? `\n  … and ${occurrences.length - 10} more` : ''
  throw new Error(`Symbol '${symbol}' appears on ${occurrences.length} lines; pass \`line\` to pick one:${listing}${more}`)
}

/** One-line note for a forgiving line hint that landed elsewhere. */
export function anchorNote(symbol, anchor) {
  if (!anchor) return ''
  if (anchor.requestedLine !== null && anchor.requestedLine !== anchor.line) {
    return `(Note: '${symbol}' was not on line ${anchor.requestedLine}; used the nearest occurrence at line ${anchor.line}.)\n\n`
  }
  if (anchor.requestedLine === null) return `(Resolved '${symbol}' at line ${anchor.line}.)\n\n`
  return ''
}