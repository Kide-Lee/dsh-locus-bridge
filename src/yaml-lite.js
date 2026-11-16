// A read-mostly parser for Unity's serialized YAML.
//
// Unity does not write general YAML. It writes a fixed dialect:
//
//   %YAML 1.1
//   %TAG !u! tag:unity3d.com,2011:
//   --- !u!114 &1234567
//   MonoBehaviour:
//     m_ObjectHideFlags: 0
//     speed: 5
//     m_Script: {fileID: 11500000, guid: 0123…, type: 3}
//     m_Text: 'HP {
//
// Two properties of that dialect matter more than completeness:
//
//   * a document header (`--- !u!<classId> &<fileId>`) is a *separator*, and the
//     same `<fileId>` appears again inside stripped documents and prefab
//     modifications — so identity lives in the header, not in the body;
//   * values contain braces, quotes and `#` freely (`'HP {'`,
//     `m_Name: #ff0000`), and block scalars (`m_Text: |`) span lines with a
//     continuation indent Unity computes from the first non-empty line.
//
// So this is a line-oriented parser and an *edit-by-line* writer, not a
// round-tripping YAML library:
//
//   * `parseUnityYaml(text)` keeps the byte range of every node
//     (`textStart`/`textEnd`), so a scalar can be replaced in place and the rest
//     of the file — comments, ordering, odd indentation, unknown keys, the
//     exact float formatting Unity chose — is never re-serialized;
//   * `compileEdit` turns one edit into `{start, end, text}` on the source
//     string, which is what a write path should apply (see `editYamlText`).
//
// No dependency: `js-yaml` is a general parser that rejects or misreads several
// of the shapes above, and upstream Locus has its own tokenizer for the same
// reason (`Locus/src-tauri/src/unity_yaml/tokenizer.rs`, read for the rules).

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** The document header: `--- !u!<classId> &<fileId>` (fileId may be negative). */
const DOC_HEADER = /^-{3}\s*(?:!u!(-?\d+))?\s*(?:&(-?\d+))?/
/** A `--- ` line at column zero starts a document even when it carries no tag. */
const DOC_SEPARATOR = /^---(?:\s|$)/
/** `key: value`, `key:`, `- key: value` — a mapping entry. */
const MAPPING_ENTRY = /^([ \t]*)(- )?([^\s#:][^:]*?):(?:[ \t]+(.*))?$/
/** `- value` / `-` — a sequence entry. */
const SEQUENCE_ENTRY = /^([ \t]*)-(?:[ \t]+(.*))?$/
/** `key: |`, `key: >-` — a block scalar with an optional chomping/indent hint. */
const BLOCK_HEADER = /^([|>])([+-]?)(\d?)([+-]?)$/

/**
 * Parse every document in a Unity YAML file.
 *
 * @param {string} text - the file's text (UTF-8, already decoded).
 * @returns {{documents: Array<object>}} documents in file order. Each one is
 *   `{classId, fileId, stripped, tree, headerLine, lineStart, lineEnd}`; a
 *   document that holds only one top-level key (Unity always writes exactly one)
 *   has `tree` pointing at the nodes *inside* that key, and that key's name is
 *   reported as `typeName`. Use `queryDocument` to address fields by name.
 */
export function parseUnityYaml(text) {
  const source = String(text ?? '').replaceAll('\r\n', '\n')
  const lineStarts = [0]
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') lineStarts.push(index + 1)
  }
  const documents = []
  // Collect the header line numbers first: a body parser needs to know where
  // the next document starts before it can decide the current tree ends.
  const headers = []
  for (let line = 0; line < lineStarts.length; line += 1) {
    const start = lineStarts[line]
    const end = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : source.length
    const content = source.slice(start, end)
    if (!DOC_SEPARATOR.test(content)) continue
    headers.push({ line, start, end: line + 1 < lineStarts.length ? lineStarts[line + 1] : source.length })
  }
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index]
    const headerText = source.slice(header.start, header.end)
    const match = DOC_HEADER.exec(headerText.trimEnd())
    const classId = match?.[1] === undefined ? null : Number.parseInt(match[1], 10)
    const fileId = match?.[2] === undefined ? null : Number.parseInt(match[2], 10)
    const bodyEnd = index + 1 < headers.length ? headers[index + 1].start : source.length
    const body = new LineScanner(source, header.line + 1, bodyEnd)
    const entries = body.parseMapping(0)
    // Unity always nests the body under a single type key (`MonoBehaviour:`,
    // `GameObject:`). Flatten it so `/MonoBehaviour/speed` and `/speed` agree,
    // and record the class name and the stripped marker from that key.
    let tree = entries
    let typeName = null
    if (entries.length === 1 && entries[0].kind === 'map') {
      tree = entries[0].children
      typeName = entries[0].key
    }
    // `stripped` is a marker on the header line (`--- !u!224 &300000 stripped`),
    // not a field in the body.
    const stripped = /(?:^|\s)stripped\s*$/.test(headerText.trimEnd())
    documents.push({
      classId,
      fileId,
      stripped,
      tree,
      typeName,
      headerLine: header.line + 1,
      lineStart: header.line + 1,
      lineEnd: countLines(source, header.start, bodyEnd),
      // Byte range of the whole document, so a caller can slice it out.
      start: header.start,
      end: bodyEnd,
    })
  }
  return { documents }
}

/** A cursor over one document body, producing nodes with exact byte ranges. */
class LineScanner {
  constructor(source, firstLine, end) {
    this.source = source
    this.end = end
    this.baseLine = firstLine
    // Split the body into {start, end, indent, text} records once: the parser is
    // recursive and every level needs the same line view.
    this.lines = []
    let offset = 0
    for (let line = 0; line < firstLine; line += 1) {
      const next = source.indexOf('\n', offset)
      if (next < 0 || next >= end) {
        offset = end
        break
      }
      offset = next + 1
    }
    while (offset < end) {
      let next = source.indexOf('\n', offset)
      if (next < 0 || next > end) next = end
      const raw = source.slice(offset, next)
      this.lines.push({ start: offset, end: next, indent: indentOf(raw), text: raw.trim() })
      offset = next + 1
    }
  }

  /** The 1-based line number in the whole file (the scanner starts mid-file). */
  lineNumber(index) {
    return this.baseLine + index + 1
  }

  /** Parse the block that follows a `key:` or `-` opener. */
  parseBlock(index) {
    if (this.isSequenceStart(index)) {
      const child = this.parseSequence(index, this.lines[index].indent)
      return { kind: 'seq', nodes: child.nodes, next: child.next }
    }
    const nodes = this.parseMapping(index, nextContentIndent(this.lines, index))
    return { kind: nodes.length > 0 ? 'map' : null, nodes, next: this.lines.length }
  }

  isSequenceStart(index) {
    const line = this.lines[index]
    if (line === undefined || line.text === '' || line.text.startsWith('#')) return false
    // `- target: {…}` matches both patterns; the leading dash is what decides.
    return SEQUENCE_ENTRY.test(line.text)
  }

  parseMapping(startIndex, indent) {
    const nodes = []
    let index = startIndex
    while (index < this.lines.length) {
      const line = this.lines[index]
      if (line.text === '' || line.text.startsWith('#')) {
        index += 1
        continue
      }
      if (line.indent < indent) break
      if (line.indent > indent) {
        // Over-indented without an opener: Unity does not write this, so skip
        // the line instead of inventing a node.
        index += 1
        continue
      }
      if (SEQUENCE_ENTRY.test(line.text)) break
      const match = MAPPING_ENTRY.exec(line.text)
      if (!match || match[2]) {
        index += 1
        continue
      }
      const key = match[3].trim()
      const rest = (match[4] ?? '').trim()
      // `line.text` is trimmed, so the value starts `rest.length` before the
      // line ends — never at `line.start + trimmed.length`.
      const valueStart = line.end - rest.length
      if (rest === '') {
        const child = this.parseBlock(index + 1)
        nodes.push({ kind: child.kind ?? 'map', key, children: child.nodes, line: this.lineNumber(index), start: line.start, end: line.end, indent })
        index = child.nodes.length === 0 ? index + 1 : child.next
        continue
      }
      const value = this.readValue(index, rest, valueStart, key)
      nodes.push(value.node)
      index = value.next
    }
    return nodes
  }

  parseSequence(startIndex, indent) {
    const nodes = []
    let index = startIndex
    while (index < this.lines.length) {
      const line = this.lines[index]
      if (line.text === '' || line.text.startsWith('#')) {
        index += 1
        continue
      }
      if (line.indent !== indent) break
      const match = SEQUENCE_ENTRY.exec(line.text)
      if (!match) break
      const rest = (match[2] ?? '').trim()
      if (rest === '') {
        const child = this.parseBlock(index + 1)
        nodes.push({ kind: child.kind ?? 'seq', children: child.nodes, line: this.lineNumber(index), start: line.start, end: line.end, indent })
        index = child.nodes.length === 0 ? index + 1 : child.next
        continue
      }
      // `- key: value` opens a mapping whose entries start two columns past the
      // dash and line up with it. Unity writes prefab modifications exactly so.
      // `line.text` is trimmed, so the dash sits at `line.indent`.
      const innerIndent = line.indent + 2
      const inner = MAPPING_ENTRY.exec(rest)
      if (inner && !inner[2] && !/^[[{]/.test(rest)) {
        const virtualLine = { start: line.end - rest.length, end: line.end, indent: innerIndent, text: rest }
        const saved = this.lines[index]
        this.lines[index] = virtualLine
        const children = this.parseMapping(index, innerIndent)
        this.lines[index] = saved
        // The block ends where the mapping ended; every entry line is consumed
        // by it, so continue from the returned scanner index.
        const endIndex = this.lastLineAfter(children, index)
        nodes.push({ kind: 'map', children, line: this.lineNumber(index), start: line.start, end: this.lines[endIndex - 1]?.end ?? line.end, indent })
        index = endIndex
        continue
      }
      const value = this.readValue(index, rest, line.end - rest.length, null)
      nodes.push(value.node)
      index = value.next
    }
    return { nodes, next: index }
  }

  /**
   * Scanner line index one past the deepest node in `children`.
   *
   * Children carry absolute file line numbers while the scanner indexes from
   * the document's first line, so the walk compares byte offsets instead of
   * doing arithmetic on `line`.
   */
  lastLineAfter(children, fallbackIndex) {
    let maxEnd = -1
    const walk = (nodes) => {
      for (const node of nodes ?? []) {
        if (typeof node.end === 'number') maxEnd = Math.max(maxEnd, node.end)
        walk(containerOfNode(node))
      }
    }
    walk(children)
    if (maxEnd < 0) return fallbackIndex + 1
    for (let cursor = fallbackIndex + 1; cursor < this.lines.length; cursor += 1) {
      if (this.lines[cursor].start > maxEnd) return cursor
    }
    return this.lines.length
  }

  /** Turn the text after `key:` (or `- `) into a node. */
  readValue(index, rest, valueStart, key) {
    const line = this.lines[index]
    const block = BLOCK_HEADER.exec(rest)
    if (block) return this.readBlockScalar(index, block, key)
    if (rest.startsWith('{') || rest.startsWith('[')) {
      const inline = this.readFlow(index, rest, valueStart, key)
      if (inline) return inline
    }
    return {
      node: {
        kind: 'scalar',
        key,
        value: unquote(rest),
        raw: rest,
        line: this.lineNumber(index),
        start: line.start,
        end: line.end,
        textStart: valueStart,
        textEnd: valueStart + rest.length,
        indent: line.indent,
      },
      next: index + 1,
    }
  }

  /**
   * A `|`/`>` block scalar: every following line indented deeper than the key
   * belongs to it, blank lines included. The content range is what an edit
   * replaces, so the header line and the indentation stay as written.
   */
  readBlockScalar(index, block, key) {
    const line = this.lines[index]
    let cursor = index + 1
    while (cursor < this.lines.length) {
      const next = this.lines[cursor]
      if (next.text === '') {
        cursor += 1
        continue
      }
      if (next.indent <= line.indent) break
      cursor += 1
    }
    // Trailing blank lines are not content.
    let contentEnd = cursor
    while (contentEnd > index + 1 && this.lines[contentEnd - 1].text === '') contentEnd -= 1
    const textEnd = contentEnd > index + 1 ? this.lines[contentEnd - 1].end : line.end
    const raw = contentEnd > index + 1 ? this.source.slice(line.end + 1, textEnd) : ''
    const chomp = block[2] === '-' || block[4] === '-'
    const fold = block[1] === '>'
    return {
      node: {
        kind: 'scalar',
        key,
        // `|-` keeps no trailing newline; everything else keeps one. `>` folds
        // newlines to spaces, which no Unity asset relies on, so the raw text
        // is preserved and the fold is reported as metadata only.
        value: chomp ? raw : `${raw}\n`,
        block: fold ? 'folded' : 'literal',
        line: this.lineNumber(index),
        start: line.start,
        end: textEnd,
        textStart: line.end + 1,
        textEnd,
        indent: line.indent,
      },
      next: Math.max(cursor, index + 1),
    }
  }

  /**
   * A `{fileID: 1, guid: ab, type: 3}` flow mapping may wrap onto further lines
   * (Unity does that for long lists), so depth counting has to be quote-aware —
   * `'HP {'` must not look like an opening brace.
   */
  readFlow(index, rest, valueStart, key) {
    const opening = rest[0]
    const closing = opening === '{' ? '}' : ']'
    let depth = flowDepth(rest, opening, closing)
    let cursor = index
    let end = this.lines[index].end
    while (depth > 0 && cursor + 1 < this.lines.length) {
      cursor += 1
      const line = this.lines[cursor]
      depth += flowDepth(line.text, opening, closing)
      end = line.end
    }
    if (depth > 0) return null
    const raw = this.source.slice(valueStart, end)
    const text = raw.trimEnd()
    const body = text.length >= 2 && text[text.length - 1] === closing ? text.slice(1, -1) : text.slice(1)
    const parts = splitTopLevel(body, ',')
    if (opening === '[') {
      return {
        node: {
          kind: 'seq',
          key,
          flow: true,
          children: parts.map((part, partIndex) => ({
            kind: 'scalar',
            key: null,
            value: unquote(part.trim()),
            raw: part.trim(),
            line: this.lineNumber(index),
            start: valueStart,
            end,
            textStart: valueStart,
            textEnd: valueStart + text.length,
            index: partIndex,
          })),
          line: this.lineNumber(index),
          start: this.lines[index].start,
          end,
          textStart: valueStart,
          textEnd: valueStart + text.length,
          indent: this.lines[index].indent,
        },
        next: cursor + 1,
      }
    }
    const children = []
    for (const part of parts) {
      const separator = part.indexOf(':')
      if (separator < 0) continue
      const entryKey = part.slice(0, separator).trim()
      if (entryKey === '') continue
      const entryValue = part.slice(separator + 1).trim()
      children.push({
        kind: 'scalar',
        key: entryKey,
        value: unquote(entryValue),
        raw: entryValue,
        line: this.lineNumber(index),
        start: valueStart,
        end,
        textStart: valueStart,
        textEnd: valueStart + text.length,
        flow: true,
      })
    }
    return {
      node: {
        kind: 'map',
        key,
        children,
        flow: true,
        line: this.lineNumber(index),
        start: this.lines[index].start,
        end,
        textStart: valueStart,
        textEnd: valueStart + text.length,
        indent: this.lines[index].indent,
      },
      next: cursor + 1,
    }
  }
}

/** The child array of a node (no dependency on the exported helpers). */
function containerOfNode(node) {
  if (!node || node.kind === 'scalar') return []
  return node.children ?? []
}


/** The indent of the first content line at or after `index` (0 when none). */
function nextContentIndent(lines, index) {
  for (let cursor = index; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]
    if (line.text === '' || line.text.startsWith('#')) continue
    return line.indent
  }
  return 0
}

function indentOf(line) {
  let count = 0
  while (count < line.length && line[count] === ' ') count += 1
  return count
}

function trimmed(line) {
  return line.text
}

/**
 * Count `{`/`}` outside single and double quotes.
 *
 * The quote rules are Unity's own tokenizer: single quotes escape by doubling
 * (`''`), double quotes use a backslash, and an *unclosed* quote means the
 * value continues on the next line, so every brace after it is ignored.
 */
export function countBraces(text) {
  let depth = 0
  let inSingle = false
  let inDouble = false
  const source = String(text ?? '')
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (inSingle) {
      if (character === "'") {
        if (source[index + 1] === "'") {
          index += 1
          continue
        }
        inSingle = false
      }
      continue
    }
    if (inDouble) {
      if (character === '\\') {
        index += 1
        continue
      }
      if (character === '"') inDouble = false
      continue
    }
    if (character === "'") {
      inSingle = true
      continue
    }
    if (character === '"') {
      inDouble = true
      continue
    }
    if (character === '{') depth += 1
    else if (character === '}') depth -= 1
  }
  return depth
}

/**
 * Net depth of `opening`/`closing` in one line, ignoring anything inside quotes
 * and an unclosed quote (a multi-line quoted scalar, which swallows the rest).
 *
 * A balanced one-line value (`{fileID: 0}`) nets to 0, so a caller that starts
 * from the opening character already knows the whole value fit on that line.
 */
function flowDepth(text, opening, closing) {
  let depth = 0
  let inSingle = false
  let inDouble = false
  const source = String(text ?? '')
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (inSingle) {
      if (character === "'") {
        if (source[index + 1] === "'") {
          index += 1
          continue
        }
        inSingle = false
      }
      continue
    }
    if (inDouble) {
      if (character === '\\') {
        index += 1
        continue
      }
      if (character === '"') inDouble = false
      continue
    }
    if (character === "'") {
      inSingle = true
      continue
    }
    if (character === '"') {
      inDouble = true
      continue
    }
    if (character === opening) depth += 1
    else if (character === closing) depth -= 1
  }
  return depth
}

/**
 * Split on `separator` outside quotes, braces and brackets.
 *
 * The caller passes the *inner* text (the braces already stripped), so
 * `splitTopLevel('fileID: 1, guid: ab', ',')` splits into two parts while a
 * nested `{…}` in one of them stays intact.
 */
function splitTopLevel(text, separator) {
  const parts = []
  let current = ''
  let depth = 0
  let inSingle = false
  let inDouble = false
  const source = String(text ?? '')
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (inSingle) {
      current += character
      if (character === "'") {
        if (source[index + 1] === "'") {
          current += source[index + 1]
          index += 1
          continue
        }
        inSingle = false
      }
      continue
    }
    if (inDouble) {
      current += character
      if (character === '\\') {
        current += source[index + 1] ?? ''
        index += 1
        continue
      }
      if (character === '"') inDouble = false
      continue
    }
    if (character === "'") {
      inSingle = true
      current += character
      continue
    }
    if (character === '"') {
      inDouble = true
      current += character
      continue
    }
    if (character === '{' || character === '[') depth += 1
    else if (character === '}' || character === ']') depth -= 1
    if (character === separator && depth === 0 && !inSingle && !inDouble) {
      parts.push(current)
      current = ''
      continue
    }
    current += character
  }
  parts.push(current)
  return parts.filter((part) => part.trim() !== '')
}

/** Strip one pair of matching quotes from a scalar, honouring YAML escapes. */
export function unquote(value) {
  const text = String(value ?? '')
  if (text.length < 2) return text
  if (text[0] === "'" && text[text.length - 1] === "'") return text.slice(1, -1).replaceAll("''", "'")
  if (text[0] === '"' && text[text.length - 1] === '"') {
    return text
      .slice(1, -1)
      .replaceAll('\\"', '"')
      .replaceAll('\\\\', '\\')
      .replaceAll('\\n', '\n')
      .replaceAll('\\t', '\t')
  }
  return text
}

/** Quote a scalar so `parseUnityYaml` reads it back as the same string. */
export function quoteScalar(value) {
  const text = String(value ?? '')
  if (text === '') return "''"
  if (/^[A-Za-z0-9_./+\- ]*$/.test(text) && !/^[ ]|[ ]$/.test(text) && !/^[-+]?[0-9.eE+-]+$/.test(text) && text !== 'null' && text !== 'true' && text !== 'false' && !text.includes(': ')) {
    return text
  }
  if (!text.includes("'") && !text.includes('\n')) return `'${text}'`
  return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\t', '\\t')}"`
}

/**
 * Resolve a document-relative field path.
 *
 * `'/MonoBehaviour/speed'` is the documented form; the leaf type name is
 * optional because Unity always writes exactly one top-level key, so
 * `'/speed'` and `'/speed'` resolve to the same node. Array elements are
 * addressed by index (`'/m_Modifications/0/value'`). A leading key that is a
 * document type name is dropped only when it matches `doc.typeName`.
 *
 * @returns {object|null} the node, or `null` when the path does not resolve.
 */
export function queryDocument(document, path) {
  const segments = splitPointer(path)
  // The document root is the *field list* of the (single) type block, which is
  // a bare array rather than a node — `containerOf` knows how to read it.
  const root = { kind: 'map', key: null, children: document?.tree ?? [], synthetic: true }
  let node = root
  const rest = document?.typeName && segments[0] === document.typeName ? segments.slice(1) : segments
  for (const segment of rest) {
    const children = containerOf(node)
    if (!Array.isArray(children)) return null
    if (node.kind === 'seq') {
      const index = Number.parseInt(segment, 10)
      if (String(index) !== segment || index < 0 || index >= children.length) return null
      node = children[index]
    } else {
      node = children.find((entry) => entry.key === segment) ?? null
    }
    if (!node) return null
  }
  return node
}

/** The child list of a node; a document root (`synthetic`) is already one. */
export function containerOf(node) {
  if (!node) return null
  if (node.synthetic) return node.children ?? []
  if (node.kind === 'scalar') return null
  return node.children ?? []
}

/** Split `/a/b` or RFC 6901 `/a/b` (with `~1`, `~0` escapes) into segments. */
export function splitPointer(path) {
  const text = String(path ?? '').trim()
  if (text === '' || text === '/') return []
  const body = text.startsWith('/') ? text.slice(1) : text
  return body
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
}

/** A node's scalar-wise display value (a map or sequence summarises as a count). */
export function nodeValue(node) {
  if (!node) return null
  if (node.kind === 'scalar') return node.value
  const count = containerOf(node)?.length ?? 0
  return node.kind === 'seq' ? `[${count} item(s)]` : `{${count} field(s)}`
}

/**
 * Search every document's fields.
 *
 * `query` is a case-insensitive substring by default and a case-insensitive
 * regular expression when it starts with `re:` (the same switch upstream's
 * `unity_yaml_search` uses). `matchFields` limits which part of a field can
 * match: `path`, `field_name`, `field_value`, `type`; `all` (the default) means
 * every part. Returned pointers are document-fielded: `/<typeName>/<pointer>`.
 */
export function searchDocuments(documents, { query, matchFields, limit = 50, match = null } = {}) {
  const text = String(query ?? '')
  if (text === '') throw new Error('query is required.')
  const matcher = match ?? buildMatcher(text)
  const fields = parseMatchFields(matchFields)
  const matches = []
  const total = { value: 0 }
  for (const document of documents) {
    walkFields(document, (pointer, node, parentKey) => {
      const fieldName = node.key ?? (parentKey === null ? '' : `[${parentKey}]`)
      const value = nodeValue(node)
      const scope = `/${document.typeName ?? ''}${pointer}`
      const fieldParts = []
      if (fields.path) fieldParts.push(scope, pointer)
      if (fields.fieldName) fieldParts.push(fieldName)
      if (fields.fieldValue) fieldParts.push(typeof value === 'string' ? value : String(value))
      if (fields.type) fieldParts.push(document.typeName ?? '')
      const hit = fieldParts.some((part) => matcher(String(part ?? '')))
      if (!hit) return true
      total.value += 1
      if (matches.length < limit) {
        matches.push({
          pointer: scope,
          field: fieldName,
          value: node.kind === 'scalar' ? String(value) : value,
          kind: node.kind,
          classId: document.classId,
          fileId: document.fileId,
          line: node.line,
          type: document.typeName ?? null,
        })
      }
      return false
    })
  }
  return { total: total.value, matches, truncated: total.value > matches.length }
}

/** Build the predicate `searchDocuments` uses (also exported for asset-db). */
export function buildMatcher(query) {
  const text = String(query ?? '')
  if (text.startsWith('re:')) {
    const pattern = text.slice(3)
    let regex
    try {
      regex = new RegExp(pattern, 'i')
    } catch (error) {
      throw new Error(`query is not a valid regular expression after "re:": ${error.message}`)
    }
    return (value) => regex.test(value)
  }
  const needle = text.toLowerCase()
  return (value) => value.toLowerCase().includes(needle)
}

/** `matchFields` is a comma-separated list; `undefined`/`all` means everything. */
export function parseMatchFields(matchFields) {
  const allowed = { path: false, fieldName: false, fieldValue: false, type: false }
  const raw = Array.isArray(matchFields) ? matchFields.join(',') : String(matchFields ?? '')
  const parts = raw
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part !== '')
  if (parts.length === 0 || parts.includes('all')) return { path: true, fieldName: true, fieldValue: true, type: true }
  for (const part of parts) {
    const key = part.replaceAll('_', '')
    if (key === 'path' || key === 'scope') allowed.path = true
    else if (key === 'fieldname' || key === 'field') allowed.fieldName = true
    else if (key === 'fieldvalue' || key === 'value') allowed.fieldValue = true
    else if (key === 'type') allowed.type = true
    else throw new Error(`match_fields entry '${part}' is not one of path, field_name, field_value, type, all.`)
  }
  return allowed
}

/** Visit every node with its document-relative pointer, depth first. */
export function walkFields(document, visit) {
  const walk = (nodes, prefix) => {
    const list = Array.isArray(nodes) ? nodes : []
    for (let index = 0; index < list.length; index += 1) {
      const node = list[index]
      const pointer = node.key ? `${prefix}/${node.key}` : `${prefix}/${index}`
      const descend = visit(pointer, node, node.key ? null : index)
      if (descend === false) continue
      walk(containerOf(node), pointer)
    }
  }
  walk(document.tree ?? [], '')
}

/** Every top-level object name in a Unity YAML file (`m_Name` of any document). */
export function documentNames(document) {
  const node = queryDocument(document, '/m_Name')
  return typeof node?.value === 'string' ? [node.value] : []
}

/**
 * Find the document `object` names: a numeric fileId, `fileID:<id>`, a
 * `m_Name`, or `Type/<name>` (the last one only distinguishes by class name).
 *
 * @returns {{document: object, index: number}|null}
 */
export function selectDocument(documents, object) {
  const wanted = String(object ?? '').trim()
  if (wanted === '' || wanted.toLowerCase() === 'all') return null
  const fileIdMatch = /^(?:fileID:)?(-?\d+)$/i.exec(wanted)
  if (fileIdMatch) {
    const fileId = Number.parseInt(fileIdMatch[1], 10)
    const index = documents.findIndex((document) => document.fileId === fileId)
    return index < 0 ? null : { document: documents[index], index }
  }
  // A bare type name (`MonoBehaviour`) selects the first document of that class;
  // `Type/Name` narrows by both.
  const bareType = documents.findIndex((document) => document.typeName === wanted)
  if (bareType >= 0 && !wanted.includes('/')) return { document: documents[bareType], index: bareType }
  const typePrefix = /^([A-Za-z_][\w.]*)\/(.+)$/.exec(wanted)
  const name = typePrefix ? typePrefix[2] : wanted
  const typeName = typePrefix ? typePrefix[1] : null
  const index = documents.findIndex((document) => {
    if (typeName !== null && document.typeName !== typeName) return false
    return documentNames(document).includes(name)
  })
  return index < 0 ? null : { document: documents[index], index }
}

/**
 * Render one node as the compact indented text `unity_yaml_read` returns.
 *
 * `depth` bounds how many levels are expanded (0 = this node only); a level
 * deeper than `depth` renders as a size hint. Arrays longer than `maxItems`
 * are cut with a `… n more` line, matching the "bounded expansion" rule both
 * upstream and this plugin follow.
 */
export function renderNode(node, { depth = 2, maxItems = 20 } = {}) {
  // The document root is a bare field list, so it renders as a mapping body
  // without a wrapper line.
  if (!node) return ''
  if (node.synthetic) {
    return renderMappingChildren(node.children ?? [], 0, depth, maxItems)
  }
  if (node.kind === 'scalar') return `${node.key ? `${node.key}: ` : ''}${formatScalarNode(node)}`
  if (node.kind === 'map') {
    if (node.flow) {
      const inline = (node.children ?? []).map((child) => `${child.key}: ${formatScalarNode(child)}`).join(', ')
      return `${node.key ? `${node.key}: ` : ''}{${inline}}`
    }
    const head = node.key ? `${node.key}:` : ''
    const body = renderMappingChildren(node.children ?? [], 0, depth, maxItems)
    if (head === '') return body
    return body === '' ? head : `${head}\n${body}`
  }
  return renderSequence(node, 0, depth, maxItems)
}

/** Render a mapping's entries at `level`; each child owns its own key. */
function renderMappingChildren(children, level, depth, maxItems) {
  const lines = []
  if (level > depth) return `${indent(level)}… ${children.length} field(s) not expanded (depth ${depth})`
  for (const entry of limitItems(children, maxItems)) {
    if (entry.truncated) {
      lines.push(`${indent(level)}… ${entry.count} more`)
      continue
    }
    const child = entry.node
    if (child.kind === 'scalar') {
      lines.push(`${indent(level)}${renderNode(child, { depth, maxItems })}`)
    } else if (child.kind === 'map' && child.flow) {
      lines.push(`${indent(level)}${renderNode(child, { depth, maxItems })}`)
    } else if (child.kind === 'map') {
      const head = `${indent(level)}${child.key}:`
      const body = (child.children ?? []).length === 0 ? ' {}' : `\n${renderMappingChildren(child.children ?? [], level + 2, depth, maxItems)}`
      lines.push(`${head}${body}`)
    } else {
      const head = `${indent(level)}${child.key}:`
      const body = (child.children ?? []).length === 0 ? ' []' : `\n${renderSequence(child, level + 2, depth, maxItems)}`
      lines.push(`${head}${body}`)
    }
  }
  return lines.join('\n')
}

/** Render a sequence at `level`, one `- ` per item. */
function renderSequence(node, level, depth, maxItems) {
  const children = node.children ?? []
  if (children.length === 0) return `${indent(level)}[]`
  if (level > depth) return `${indent(level)}… ${children.length} item(s) not expanded (depth ${depth})`
  const lines = []
  for (const entry of limitItems(children, maxItems)) {
    if (entry.truncated) {
      lines.push(`${indent(level)}… ${entry.count} more`)
      continue
    }
    const child = entry.node
    if (child.kind === 'scalar') {
      lines.push(`${indent(level)}- ${formatScalarNode(child)}`)
    } else if (child.kind === 'map' && child.flow) {
      lines.push(`${indent(level)}- ${renderNode(child, { depth, maxItems })}`)
    } else if (child.kind === 'map') {
      const body = renderMappingChildren(child.children ?? [], level + 2, depth, maxItems)
      if (body === '') {
        lines.push(`${indent(level)}- {}`)
      } else {
        // `- ` and the first field share a line, as Unity writes it.
        lines.push(`${indent(level)}- ${body.replace(/^\s+/, '')}`.split('\n').map((text, index) => (index === 0 ? text : text)).join('\n'))
      }
    } else {
      const body = renderSequence(child, level + 2, depth, maxItems)
      lines.push(`${indent(level)}-` + (body === '' ? ' []' : `\n${body}`))
    }
  }
  return lines.join('\n')
}

function limitItems(items, maxItems) {
  const list = items ?? []
  const size = Number.isInteger(maxItems) && maxItems > 0 ? maxItems : 20
  if (list.length <= size) return list.map((node) => ({ node }))
  return [...list.slice(0, size).map((node) => ({ node })), { truncated: true, count: list.length - size }]
}

function formatScalarNode(node) {
  if (!node) return 'null'
  if (node.block) {
    // Show a block scalar the way the file holds it, so the reader sees the
    // indentation Unity will compute rather than an escaped one-liner.
    const body = String(node.value ?? '').replace(/\n$/, '')
    const marker = node.block === 'folded' ? '>' : '|'
    return body === '' ? `${marker} ''` : `${marker}\n${body}`
  }
  return String(node.raw !== undefined ? node.raw : node.value ?? '')
}

function indent(level) {
  return ' '.repeat(Math.max(0, level))
}

/** Count lines between two byte offsets (for `lineEnd`). */
function countLines(source, start, end) {
  let count = 1
  for (let index = start; index < end; index += 1) if (source[index] === '\n') count += 1
  return count
}

// ─── disk read path (used by the Lead's unity_yaml_read / unity_yaml_search) ──

/** Project-relative path refused when it escapes the project root. */
export function resolveProjectFile(projectRoot, assetPath) {
  const text = String(assetPath ?? '').trim()
  if (text === '') throw new Error('path is required, for example Assets/Scenes/Main.unity.')
  const root = resolve(projectRoot)
  const absolute = isAbsolute(text) ? resolve(text) : resolve(root, text)
  const rel = relative(root, absolute)
  if (rel === '' || rel.startsWith('..') || rel.split(sep).includes('..') || isAbsolute(rel)) {
    throw new Error(`${assetPath} is outside the Unity project ${root}.`)
  }
  return absolute
}

/** Extensions that hold Unity YAML; anything else has nothing to parse. */
export const YAML_ASSET_EXTENSIONS = Object.freeze(['.unity', '.prefab', '.asset', '.mat', '.anim', '.controller', '.overridecontroller', '.mixer', '.physicmaterial', '.preset', '.rendertexture', '.mask', '.spriteatlas', '.terrainlayer', '.lighting', '.signal', '.playable'])

export function isUnityYamlPath(assetPath) {
  const text = String(assetPath ?? '').toLowerCase()
  const dot = text.lastIndexOf('.')
  if (dot < 0) return false
  return YAML_ASSET_EXTENSIONS.includes(text.slice(dot))
}

/**
 * Whether the bytes are clearly not text.
 *
 * Unity stores scenes and prefabs either as text YAML or as an *AssetBundle*
 * serialization (project setting "Asset Serialization" / force-binary), which
 * starts with NUL padding and is never parseable as YAML. Detecting it lets the
 * reader explain the real reason instead of "no --- header", which suggests a
 * corrupt text file.
 */
export function looksBinary(buffer) {
  const probe = buffer.subarray(0, 512)
  for (let index = 0; index < probe.length; index += 1) {
    if (probe[index] === 0) return true
  }
  return false
}

/**
 * Read and parse one Unity YAML file from disk.
 *
 * The `%YAML`/`%TAG` preamble is arbitrary for a reader, so a file that does
 * not start with one is still parsed — a hand-edited `.asset` without the
 * preamble is legal input for this reader.
 *
 * @returns {{path: string, absolute: string, text: string, documents: Array<object>}}
 */
export function readYamlFile(projectRoot, assetPath) {
  const absolute = resolveProjectFile(projectRoot, assetPath)
  if (!isUnityYamlPath(absolute)) {
    throw new Error(
      `${assetPath} is not a Unity YAML asset (${YAML_ASSET_EXTENSIONS.join(', ')}). ` +
        'References inside binary assets cannot be read as text.',
    )
  }
  let buffer
  try {
    buffer = readFileSync(absolute)
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`${assetPath} does not exist in ${resolve(projectRoot)}.`)
    throw error
  }
  const text = buffer.toString('utf8')
  return {
    path: projectRelativePath(projectRoot, absolute),
    absolute,
    text,
    binary: looksBinary(buffer),
    ...parseUnityYaml(text),
  }
}

/** The project-relative form with forward slashes. */
export function projectRelativePath(projectRoot, absolute) {
  return relative(resolve(projectRoot), resolve(absolute)).split(sep).join('/')
}

/** `1998-12-31 23:59:59` for a file, or `unknown` when it cannot be stat'ed. */
function describeDiskTime(absolute) {
  try {
    const stamp = statSync(absolute).mtime
    const pad = (value) => String(value).padStart(2, '0')
    return `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}:${pad(stamp.getMinutes())}:${pad(stamp.getSeconds())}`
  } catch {
    return 'unknown'
  }
}

/**
 * Render one editor object from the live snapshot in the same shape the disk
 * renderer produces, so the two sources can be compared field by field.
 *
 * `fields` is `[{name, type, value, reference?, size?, children?}]` from
 * `dsh_live_read`. Returns null when the snapshot has nothing for this object.
 */
export function renderLiveObject(object, { depth = 2, maxItems = 20, header = true } = {}) {
  if (!object || !Array.isArray(object.fields)) return null
  const lines = header ? [`# live values (${object.type ?? '?'} ${object.name ?? ''})`.trimEnd()] : []
  const render = (fields, indent) => {
    let shown = 0
    for (const field of fields) {
      if (shown >= maxItems) {
        lines.push(`${indent}… ${fields.length - shown} more field(s) not shown`)
        return
      }
      shown += 1
      const label = indent + (field.name ?? '?')
      let text = `${label}: ${field.value ?? ''}`.trimEnd()
      if (field.reference) text += `  {${field.reference}}`
      if (typeof field.size === 'number') text += `  [${field.size}]`
      lines.push(text)
      if (Array.isArray(field.children) && field.children.length > 0 && indent.length < depth * 2) {
        render(field.children, `${indent}  `)
      } else if (Array.isArray(field.children) && field.children.length > 0) {
        lines.push(`${indent}  … ${field.children.length} child field(s) not expanded (depth ${depth})`)
      }
    }
  }
  render(object.fields, '  ')
  return lines.join('\n')
}

/**
 * Render a live snapshot as the answer of `unity_yaml_read`.
 *
 * The Editor's objects are keyed by FileID, the same identity the disk parser
 * puts in each `--- !u!<class> &<fileID>` header, so the two can be compared
 * object by object. When the disk file is not text (an AssetBundle binary) the
 * live snapshot is not a comparison, it is the only answer there is — which is
 * why this path never reports "binary asset".
 */
function renderLiveAsset(file, documents, live, { object = null, depth = 2, maxItems = 20 } = {}) {
  const wanted = object === null || object === undefined ? null : String(object).trim()
  const entries = []
  for (const document of documents) {
    const snapshot = live.objects?.[String(document.fileId)] ?? live.objects?.[document.liveKey]
    if (snapshot !== undefined) entries.push({ document, snapshot })
  }
  for (const snapshot of Object.values(live.objects ?? {})) {
    if (entries.some((entry) => entry.snapshot === snapshot)) continue
    entries.push({ document: null, snapshot })
  }
  const lines = [
    `Unity YAML: ${file.path} (live Unity Editor, ${entries.length} object(s); disk file last modified ${describeDiskTime(file.absolute)})`,
  ]
  if (documents.length === 0) {
    lines.push('# the file on disk is not text YAML, so every value below comes from the Editor')
  } else {
    lines.push('# values are from the Editor, not from the file on disk')
  }
  let shown = 0
  for (const { document, snapshot } of entries) {
    if (wanted !== null && !matchesObjectIdentity(snapshot, document, wanted)) continue
    shown += 1
    const header = document === null
      ? `--- ${snapshot.type ?? '?'} ${snapshot.file_id ?? ''}`.trimEnd()
      : `--- !u!${document.classId} &${document.fileId} (${document.typeName ?? snapshot.type ?? '?'})`
    lines.push('', header)
    lines.push(renderLiveObject(snapshot, { depth, maxItems, header: false }))
  }
  if (shown === 0 && wanted !== null) lines.push('', `<no object matching "${wanted}" in the live snapshot>`)
  return {
    text: lines.join('\n'),
    path: file.path,
    source: 'live',
    total: shown,
    live: true,
  }
}

/** `object` selects one FileID, one `!u!<classId>` selector, or one type name. */
function matchesObjectIdentity(snapshot, document, wanted) {
  if (document !== null && (wanted === String(document.fileId) || wanted === `!u!${document.classId}`)) return true
  const type = snapshot.type ?? document?.typeName
  return typeof type === 'string' && type.toLowerCase() === wanted.toLowerCase()
}

/**
 * `unity_yaml_read`: the text for one asset (or one object inside it).
 *
 * `source` is always `'disk'` here: the live path belongs to the tool layer,
 * which owns the broker connection. Keeping the fallback in this module means
 * the tool works with no Editor running at all.
 */
export function readYamlText(projectRoot, { path, object, depth = 2, maxItems = 20, live = null } = {}) {
  const file = readYamlFile(projectRoot, path)
  const selected = selectDocument(file.documents, object)
  if (object !== undefined && String(object ?? '').trim() !== '' && selected === null) {
    const known = file.documents
      .map((document) => `${document.typeName ?? '?'} ${document.lineStart ? `line ${document.lineStart}` : ''}${document.fileId === null ? '' : ` &${document.fileId}`}`)
      .slice(0, 40)
      .join('; ')
    throw new Error(`No document in ${file.path} matches object '${object}'. Documents: ${known || '<none>'}.`)
  }
  const documents = selected === null ? file.documents : [selected.document]
  if (live !== null) {
    return renderLiveAsset(file, documents, live, { object, depth, maxItems })
  }
  const lines = [`Unity YAML: ${file.path} (disk, ${file.documents.length} document(s), ${file.text.length} bytes)`]
  if (documents.length === 0) {
    lines.push(
      file.binary
        ? '<binary asset: this scene or prefab is stored as an AssetBundle serialization, not as text YAML. ' +
            'Switch the project to text serialization (Editor > Project Settings > Editor > Asset Serialization) ' +
            'or read it through Unity instead.>'
        : '<no documents: the file has no "---" header>',
    )
  }
  for (const document of documents) {
    const typeName = document.typeName ?? 'document'
    lines.push('')
    lines.push(`--- !u!${document.classId ?? '?'} &${document.fileId ?? '?'} (${typeName})`)
    const body = renderNode({ kind: 'map', key: null, children: document.tree ?? [] }, { depth, maxItems })
    if (body.trim() !== '') lines.push(body)
    if (document.stripped) lines.push('(stripped)')
  }
  return {
    text: lines.join('\n'),
    source: 'disk',
    path: file.path,
    total: file.documents.length,
    documents: documents.map((document) => ({
      classId: document.classId,
      fileId: document.fileId,
      typeName: document.typeName ?? null,
      stripped: document.stripped,
      lineStart: document.lineStart,
      lineEnd: document.lineEnd,
      name: documentNames(document).find(() => true) ?? null,
    })),
  }
}

/**
 * `unity_yaml_search`: match fields across one file, a directory, the whole
 * project (`.unity`/`.prefab`/`.asset` only), or an already-loaded document
 * list.
 *
 * @param {object} options
 * @param {string} options.query - substring, or `re:<pattern>`.
 * @param {string} [options.scope] - project-relative file or directory.
 * @param {string[]} [options.extensions] - extension allow-list inside a directory.
 * @param {number} [options.limit]
 * @param {string} [options.matchFields]
 * @param {(path:string)=>boolean} [options.include] - directory filter.
 */
export function searchYamlFiles(projectRoot, { query, scope, limit = 50, matchFields, extensions = ['.unity', '.prefab', '.asset'], include = null, live = null } = {}) {
  const matcher = buildMatcher(query)
  const fields = parseMatchFields(matchFields)
  const size = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 50
  const absolute = scope === undefined || scope === null || String(scope).trim() === '' ? null : resolveProjectFile(projectRoot, scope)
  const files = []
  if (absolute === null) {
    collect(projectRoot, files, extensions, include)
  } else {
    const stat = statSync(absolute, { throwIfNoEntry: false })
    if (stat === undefined) throw new Error(`${scope} does not exist in ${resolve(projectRoot)}.`)
    if (stat.isDirectory()) collect(absolute, files, extensions, include)
    else files.push(absolute)
  }
  const matches = []
  let total = 0
  let liveFiles = 0
  for (const file of files) {
    let parsed
    const relativePath = projectRelativePath(projectRoot, file)
    const liveText = live?.texts?.[relativePath]
    try {
      // The live Editor only ever supplies one file (the one being read), but a
      // search over that same file must see the live text too, otherwise
      // `unity_yaml_search` on a modified-but-unsaved asset contradicts
      // `unity_yaml_read`.
      if (typeof liveText === 'string') {
        parsed = parseUnityYaml(liveText)
        liveFiles += 1
      } else {
        parsed = parseUnityYaml(readFileSync(file, 'utf8'))
      }
    } catch {
      // A binary or unreadable file inside the scope is skipped, not fatal.
      continue
    }
    for (const document of parsed.documents) {
      walkFields(document, (pointer, node) => {
        const value = nodeValue(node)
        const fieldName = node.key ?? ''
        const parts = []
        if (fields.path) parts.push(`/${relativePath}${pointer}`, pointer)
        if (fields.fieldName) parts.push(fieldName)
        if (fields.fieldValue) parts.push(String(value ?? ''))
        if (fields.type) parts.push(document.typeName ?? '')
        if (!parts.some((part) => matcher(part))) return true
        total += 1
        if (matches.length < size) {
          matches.push({
            path: relativePath,
            pointer: `/${document.typeName ?? ''}${pointer}`,
            field: fieldName,
            value: node.kind === 'scalar' ? String(value ?? '') : String(value),
            type: document.typeName ?? null,
            classId: document.classId,
            fileId: document.fileId,
            line: node.line,
          })
        }
        return false
      })
    }
  }
  const lines = [`Unity YAML search "${query}" in ${absolute === null ? 'the project' : projectRelativePath(projectRoot, absolute)}: ${total} match(es) in ${files.length} file(s)`]
  for (const match of matches) lines.push(`- ${match.path}:${match.line} ${match.pointer} = ${match.value}`)
  if (total > matches.length) lines.push(`… showing ${matches.length} of ${total}`)
  if (liveFiles > 0) lines.push(`(${liveFiles} file(s) read from the live Editor, not from disk)`)
  if (total === 0) lines.push('<no matches>')
  if (liveFiles > 0) lines.push(`(${liveFiles} file(s) read from the live Editor, not from disk)`)
  return {
    text: lines.join('\n'),
    source: liveFiles > 0 ? 'live' : 'disk',
    total,
    matches,
    files: files.length,
    liveFiles,
    truncated: total > matches.length,
  }
}

/** Walk a directory for YAML assets, one symlink-safe level at a time. */
function collect(directory, output, extensions, include) {
  let entries
  try {
    entries = readdirSync(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      if (include !== null && !include(full)) continue
      collect(full, output, extensions, include)
      continue
    }
    if (!entry.isFile()) continue
    const lower = entry.name.toLowerCase()
    const dot = lower.lastIndexOf('.')
    if (dot < 0) continue
    if (extensions.includes(lower.slice(dot))) output.push(full)
  }
}

// ─── edit-by-line writer ────────────────────────────────────────────────────

/**
 * One edit against a parsed file, expressed as a byte range on the source text.
 *
 * `setScalar` replaces only the scalar's own text, `insertField` adds a line
 * inside an existing mapping (or creates the mapping), and `removeField`
 * deletes the node's lines. Nothing else in the file is re-serialized, which is
 * the whole point: comments, Unity's number formatting and every unknown key
 * survive untouched.
 */
/**
 * Pick the document an edit addresses.
 *
 * The first segment is a type name only when it matches a document type; when
 * it does not (or the file is a single-document asset), the first document that
 * resolves the path wins. `/MonoBehaviour/speed` therefore works on a prefab
 * whose MonoBehaviour is not document #0.
 */
export function resolveEditTarget(documents, segments, _identity = (type) => type) {
  const typed = documents.filter((document) => document.typeName === segments[0])
  const candidates = typed.length > 0 ? typed : documents
  for (const document of candidates) {
    const rest = typed.length > 0 ? segments.slice(1) : segments
    const pointer = `/${[document.typeName, ...rest].filter(Boolean).join('/')}`
    if (queryDocument(document, pointer) !== null) return { document, rest }
  }
  return { document: candidates[0] ?? documents[0], rest: typed.length > 0 ? segments.slice(1) : segments }
}

export function compileEdit(file, { pointer, operation = 'set', value } = {}) {
  const segments = splitPointer(pointer)
  if (segments.length === 0) throw new Error('property_path is required, for example /MonoBehaviour/speed or /m_Name.')
  const documents = file.documents ?? []
  if (documents.length === 0) throw new Error('the file has no Unity YAML document to edit.')
  // The document is whichever one holds the field: a `.prefab` has several, and
  // `/MonoBehaviour/speed` names the type, not an index.
  const resolved = resolveEditTarget(documents, segments, type => type)
  const document = resolved.document
  let rest = resolved.rest
  // The leading segment may name the document (a type name or a fileId).
  let typeName = document.typeName
  if (typeName !== null && rest[0] === typeName) rest = rest.slice(1)
  const parentSegments = rest.slice(0, -1)
  const leaf = rest[rest.length - 1]
  const parentPointer = typeName === null ? `/${parentSegments.join('/')}` : `/${[typeName, ...parentSegments].join('/')}`
  const parent = queryDocument(document, typeName === null ? `/${parentSegments.join('/')}` : `/${[typeName, ...parentSegments].join('/')}`)
  const existing = queryDocument(document, typeName === null ? `/${rest.join('/')}` : `/${[typeName, ...rest].join('/')}`)
  if (operation === 'remove') {
    if (!existing) throw new Error(`${pointer} does not exist in ${file.path}.`)
    return { start: existing.start, end: existing.end, text: '', removed: existing.line, updated: 0 }
  }
  if (operation === 'set') {
    if (!existing) throw new Error(`${pointer} does not exist in ${file.path}; use operation "insert" to add it.`)
    if (existing.kind !== 'scalar') {
      throw new Error(`${pointer} is a ${existing.kind === 'seq' ? 'list' : 'mapping'}, not a scalar; edit one of its fields instead.`)
    }
    if (existing.flow) {
      // Children of a `{fileID: …}` mapping share the mapping's byte range, so
      // there is no safe in-place edit: the whole `{…}` value would be
      // rewritten and any other key in it lost.
      throw new Error(`${pointer} sits inside a flow mapping (\{…\}), which this writer does not edit field by field; set ${parentPointer} as a whole instead.`)
    }
    const replacement = formatValue(existing, value)
    return { start: existing.textStart, end: existing.textEnd, text: replacement, updated: 1, pointer: parentPointer }
  }
  if (operation === 'insert' || operation === 'add') {
    if (existing) throw new Error(`${pointer} already exists in ${file.path}; use operation "set".`)
    if (parent && parent.kind !== 'map' && parent.kind !== 'seq') {
      throw new Error(`${parentPointer} is not a mapping, so ${pointer} cannot be inserted.`)
    }
    const rendered = `${quoteScalar(value)}`
    if (parent && parent.kind === 'map') {
      // Insert after the last child so Unity's field order stays grouped.
      const anchor = [...(parent.children ?? [])].reverse().find((node) => typeof node.end === 'number')
      const lineIndent = ' '.repeat((anchor?.indent ?? parent.indent ?? 0) + 2)
      const at = anchor ? anchor.end : parent.start ?? 0
      return { start: at, end: at, text: `\n${lineIndent}${leaf}: ${rendered}`, updated: 1, pointer: parentPointer, inserted: true }
    }
    // No parent: append a new top-level field to the document's type block.
    if (typeName === null) throw new Error(`${file.path} has no type block to extend.`)
    const block = queryDocument(document, `/${typeName}`)
    const anchor = [...(block?.children ?? [])].reverse().find((node) => typeof node.end === 'number')
    const at = anchor ? anchor.end : block?.start ?? document.start ?? 0
    const indent = ' '.repeat((anchor?.indent ?? 0) + 2)
    return { start: at, end: at, text: `\n${indent}${leaf}: ${rendered}`, updated: 1, pointer: '/', inserted: true }
  }
  throw new Error(`operation must be one of set, insert, remove (got '${operation}').`)
}

/** Format `value` in the style the target scalar already uses. */
export function formatValue(node, value) {
  const text = String(value ?? '')
  if (node.block) return text
  const current = String(node.raw ?? node.value ?? '')
  // Keep an existing numeric/bool literal unquoted; Unity re-parses by type and
  // a quoted number would become a string field.
  if (/^-?\d+$/.test(current) && /^-?\d+$/.test(text)) return text
  if (/^-?\d*\.\d+(?:[eE][-+]?\d+)?$/.test(current) && /^-?\d*\.?\d+(?:[eE][-+]?\d+)?$/.test(text)) return text
  if ((current === '0' || current === '1') && (text === '0' || text === '1') && node.key?.startsWith('m_')) return text
  if (current.startsWith("'") || current.startsWith('"')) {
    const quote = current[0]
    if (quote === "'" && !text.includes("'")) return `'${text}'`
    if (quote === '"') return `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
  }
  if (text.includes('\n')) {
    const indent = ' '.repeat((node.indent ?? 0) + 2)
    return `|\n${text.split('\n').map((line) => `${indent}${line}`).join('\n')}`
  }
  return quoteScalar(text)
}

/** Apply a compiled edit to text (pure; the caller decides whether to write). */
export function applyEdit(text, edit) {
  const source = String(text ?? '')
  if (edit.start < 0 || edit.end < edit.start || edit.end > source.length) {
    throw new Error(`edit range ${edit.start}..${edit.end} is outside the file (${source.length} bytes).`)
  }
  return source.slice(0, edit.start) + edit.text + source.slice(edit.end)
}

/**
 * Read, compile and apply one edit, re-parsing the result before returning it.
 *
 * The re-parse is the guard that matters: if the edit produced text this
 * parser can no longer read, the write is refused instead of corrupting an
 * asset. A failed re-parse leaves the file untouched.
 *
 * @returns {{text: string, applied: boolean, preview: string, path: string}}
 */
export function editYamlText(projectRoot, { path, propertyPath, value, operation = 'set', write = true } = {}) {
  const absolute = resolveProjectFile(projectRoot, path)
  if (!isUnityYamlPath(absolute)) throw new Error(`${path} is not a Unity YAML asset, so it has no text to edit.`)
  const before = readFileSync(absolute, 'utf8')
  const parsed = parseUnityYaml(before)
  const edit = compileEdit({ ...parsed, path }, { pointer: propertyPath, operation, value })
  const after = applyEdit(before, edit)
  if (after !== before) parseUnityYaml(after)
  if (write && after !== before) writeFileSync(absolute, after, 'utf8')
  const relativePath = projectRelativePath(projectRoot, absolute)
  const changed = after === before
  return {
    text: changed
      ? `${relativePath}: no change (${propertyPath} already holds that value).`
      : `${relativePath}: ${operation === 'remove' ? 'removed' : 'updated'} ${propertyPath}${write ? '' : ' (dry run)'}.`,
    applied: !changed && write,
    preview: diffLines(before, after),
    path: relativePath,
    operation,
    propertyPath,
  }
}

/** A tiny unified-diff preview: only the changed lines, with their numbers. */
export function diffLines(before, after) {
  const left = String(before ?? '').split('\n')
  const right = String(after ?? '').split('\n')
  let prefix = 0
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1
  let suffix = 0
  while (suffix < left.length - prefix && suffix < right.length - prefix && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]) suffix += 1
  const removed = left.slice(prefix, left.length - suffix)
  const added = right.slice(prefix, right.length - suffix)
  const lines = [`@@ line ${prefix + 1}`]
  for (const line of removed) lines.push(`- ${line}`)
  for (const line of added) lines.push(`+ ${line}`)
  return lines.join('\n')
}