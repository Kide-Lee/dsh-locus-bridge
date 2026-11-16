// A narrow, tolerant HTML→Markdown converter for Unity's offline documentation.
//
// Why self-written instead of a dependency: section 0.3 of the internal
// contracts forbids new runtime dependencies. Why narrow instead of general: the
// input is not the web at large, it is the one page layout Unity's documentation
// generator emits (a `#content-wrap` wrapper holding `h1..h4`, `p`, `ul/ol`,
// `pre`, `table`, `figure`, and links that are always page-relative). The
// converter therefore handles exactly that subset, and everything it does not
// understand degrades to its text content instead of leaking tags.
//
// The three properties that matter for this plugin:
//
//   1. **It never throws.** A documentation file is untrusted input in the
//      sense that its generator changes between Unity releases; a page that
//      surprises the scanner must still produce *some* text, because failing one
//      page out of thirty thousand would abort a twenty-minute import.
//   2. **It is linear.** Pages are scanned once; no regex is applied to text
//      that was already emitted, so a page with ten thousand links costs one
//      pass, not a rewrite storm.
//   3. **Blocks stay separated.** Inline text is accumulated per block and only
//      flushed when the block ends, so a paragraph that happens to contain a
//      `<code>` or a link cannot lose its surrounding whitespace.

/** Tags that open a new block, with their Markdown rendering. */
const HEADING_TAGS = new Map([
  ['h1', '# '],
  ['h2', '## '],
  ['h3', '### '],
  ['h4', '#### '],
  ['h5', '##### '],
  ['h6', '###### '],
])

/**
 * Blocks whose contents are noise on an offline page: navigation, breadcrumbs,
 * the previous/next pager, the feedback widget and the footer. Their *text* is
 * not content the model needs and, worse, several of them would look like real
 * sentences in a snippet.
 */
const SKIP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'head',
  'nav',
  'aside',
  'footer',
  'form',
  'template',
  'select',
  'textarea',
  'button',
  'svg',
  'iframe',
  'object',
  'map',
])

/** Class names that mark a wrapper worth dropping whole (Unity's own furniture). */
const SKIP_CLASSES = ['footer-wrapper', 'breadcrumbs', 'nextprev', 'scrollToFeedback', 'feedback', 'toc', 'sidebar', 'search']

/** Block-level tags: they close the open paragraph and start a new line. */
const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'main', 'br', 'hr', 'figure', 'figcaption',
  'dl', 'dt', 'dd', 'blockquote', 'center', 'tbody', 'thead', 'tr', 'td', 'th', 'ul', 'ol', 'li',
  'table', 'pre', 'img', 'video', 'source', 'span',
])

/** Named entities worth decoding; the rest are left as text rather than guessed. */
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', lsquo: '‘',
  rsquo: '’', ldquo: '“', rdquo: '”', times: '×', middot: '·', bull: '•', deg: '°',
  rarr: '→', larr: '←', uarr: '↑', darr: '↓', harr: '↔', le: '≤', ge: '≥', ne: '≠',
}

/**
 * Decode the entity subset above.
 *
 * Numeric entities are decoded too — Unity's Chinese pages use them for CJK
 * punctuation that the generator could not emit directly. An unknown named
 * entity is left verbatim: inventing a replacement is worse than showing
 * `&foo;`, which is at least reproducible.
 */
export function decodeEntities(text) {
  if (!text.includes('&')) return text
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]{1,31});/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole
      try {
        return String.fromCodePoint(code)
      } catch {
        return whole
      }
    }
    return ENTITIES[body] ?? whole
  })
}

/**
 * Collapse the whitespace HTML treats as insignificant.
 *
 * Browsers collapse runs of spaces and newlines, but `<pre>` never does — the
 * code-block path keeps its text untouched and only this inline path collapses.
 */
function collapse(text) {
  return text.replace(/[\t\n\r\f ]+/g, ' ')
}

/**
 * The HTML tag scanner.
 *
 * Returns a flat token list: `{kind:'text'|'open'|'close'|'void', name, attrs, raw}`.
 * Comments, doctypes and processing instructions are dropped. This is not an
 * HTML parser: it deliberately does not build a tree, because the converter only
 * needs to know *which* tags appear in reading order, and a stack is built in
 * the renderer where skipping decisions live.
 */
export function tokenizeHtml(html) {
  const tokens = []
  const source = String(html ?? '')
  let index = 0
  while (index < source.length) {
    const lt = source.indexOf('<', index)
    if (lt < 0) {
      tokens.push({ kind: 'text', raw: source.slice(index) })
      break
    }
    if (lt > index) tokens.push({ kind: 'text', raw: source.slice(index, lt) })
    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4)
      index = end < 0 ? source.length : end + 3
      continue
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9)
      tokens.push({ kind: 'text', raw: source.slice(lt + 9, end < 0 ? source.length : end) })
      index = end < 0 ? source.length : end + 3
      continue
    }
    const next = source[lt + 1] ?? ''
    if (next === '!' || next === '?') {
      const end = source.indexOf('>', lt + 1)
      index = end < 0 ? source.length : end + 1
      continue
    }
    const close = source.indexOf('>', lt + 1)
    // An unterminated tag is not markup; emit it as text so no content is lost.
    if (close < 0) {
      tokens.push({ kind: 'text', raw: source.slice(lt) })
      break
    }
    const body = source.slice(lt + 1, close)
    index = close + 1
    if (body.startsWith('/')) {
      const name = body.slice(1).trim().toLowerCase()
      if (name) tokens.push({ kind: 'close', name })
      continue
    }
    const selfClosing = body.endsWith('/')
    const inner = selfClosing ? body.slice(0, -1) : body
    const match = /^([A-Za-z][A-Za-z0-9:-]*)/.exec(inner)
    if (!match) {
      tokens.push({ kind: 'text', raw: source.slice(lt, close + 1) })
      continue
    }
    const name = match[1].toLowerCase()
    tokens.push({
      kind: selfClosing || VOID_TAGS.has(name) ? 'void' : 'open',
      name,
      attrs: parseAttributes(inner.slice(match[1].length)),
    })
  }
  return tokens
}

/** Elements that never have a closing tag, so the stack must not wait for one. */
const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])

const ATTRIBUTE_PATTERN = /([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

/** Attribute map of one tag body; unquoted and valueless forms both supported. */
export function parseAttributes(text) {
  const attrs = Object.create(null)
  for (const match of String(text ?? '').matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1].toLowerCase()
    if (name in attrs) continue
    attrs[name] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '')
  }
  return attrs
}

/** One class token looked up case-insensitively; Unity's names are stable but be tolerant. */
function hasClass(attrs, names) {
  const raw = attrs?.class
  if (!raw) return false
  const classes = raw.toLowerCase().split(/\s+/)
  return names.some((name) => classes.includes(name))
}

/**
 * The renderer: turns the token stream into Markdown.
 *
 * State is three stacks — skip reasons, list depth, and table-cell buffering —
 * plus the inline buffer for the block being built. Every entry point is total:
 * an unmatched close tag pops only when it matches, and anything unexpected is
 * ignored rather than thrown.
 */
class MarkdownRenderer {
  constructor() {
    this.out = []
    this.line = ''
    // [b] the element that closes the current skip, [c] how many elements were
    // opened inside it so far. Push `[name, 0]` on an open and bump the counter
    // on a void; a close either ends the skip (counter 0) or spends one nesting.
    this.skipping = null
    this.listStack = []
    this.pre = null
    this.table = null
    this.anchors = 0
    this.linkHref = null
    this.linkText = null
    this.codeDepth = 0
  }

  /** Start a new output line, flushing whatever the current one holds. */
  flush() {
    const text = this.line.replace(/[ \t]+$/g, '')
    this.line = ''
    if (text.trim() === '') return
    this.out.push(text)
  }

  /** Ensure a blank line before the next block (Markdown needs it for lists/quotes). */
  blank() {
    this.flush()
    if (this.out.length > 0 && this.out[this.out.length - 1] !== '') this.out.push('')
  }

  append(text) {
    if (!text) return
    // Collapse the space that sits between a block boundary and inline text:
    // `<p>a <strong>b</strong></p>` must not become `a  **b**`.
    if (this.linkHref === null && (this.line === '' || this.line.endsWith(' ') || this.line.endsWith('\n'))) text = text.replace(/^ +/, '')
    if (this.table?.cell) {
      // Inside a table row the text belongs to the cell being built, not to the
      // free-standing line buffer.
      this.table.cell.text += text
      return
    }
    this.line += text
  }

  handle(token) {
    const { kind, name } = token
    if (kind === 'text') {
      if (this.skipping !== null) return
      if (this.pre !== null) {
        this.pre.text += token.raw
        return
      }
      const text = collapse(decodeEntities(token.raw))
      if (!text) return
      if (this.linkHref !== null) {
        this.linkText += text
        return
      }
      this.append(text)
      return
    }
    if (kind === 'open') return this.open(token)
    if (kind === 'close') return this.close(name)
    return this.void(token)
  }

  /** `open` and `void` share the start logic; only the stack push differs. */
  open(token) {
    const { name, attrs } = token
    if (this.skipping !== null) {
      this.skipping[1] += 1
      return
    }
    if (SKIP_TAGS.has(name) || hasClass(attrs, SKIP_CLASSES)) {
      this.skipping = [name, 0]
      return
    }
    // Unity's pager and breadcrumb containers are `div`s, not semantic tags;
    // their class check above catches them, and their text is pure navigation.
    if (HEADING_TAGS.has(name)) {
      this.blank()
      this.append(HEADING_TAGS.get(name))
      return
    }
    switch (name) {
      case 'ul':
      case 'ol':
        // A blank line depends on what comes next: a list inside a list item must
        // stay attached to it (otherwise the nesting is lost), so `li` decides.
        this.flush()
        // The depth is recorded on open; `li` renders the marker for its own level.
        this.listStack.push({ ordered: name === 'ol', count: 0 })
        return
      case 'li': {
        this.blank()
        const level = Math.max(0, this.listStack.length - 1)
        // Every item starts on its own line; the marker carries its indentation.
        
        const frame = this.listStack[level]
        if (!frame) {
          this.append('- ')
          return
        }
        if (frame.ordered) {
          frame.count = (frame.count ?? 0) + 1
          this.append(`${'  '.repeat(level)}${frame.count}. `)
        } else {
          this.append(`${'  '.repeat(level)}- `)
        }
        return
      }
      case 'pre':
        this.blank()
        this.pre = { text: '' }
        return
      case 'code':
        if (this.pre === null) this.codeDepth += 1
        return
      case 'blockquote':
        this.blank()
        return
      case 'table':
        this.blank()
        this.table = { rows: [], row: null, cell: null }
        return
      case 'tr':
        if (this.table) {
          this.table.row = []
          this.table.cell = null
        }
        return
      case 'td':
      case 'th':
        if (this.table) {
          this.table.cell = { text: '', header: name === 'th' }
          this.table.row ??= []
          this.table.row.push(this.table.cell)
        }
        return
      case 'a':
        this.linkHref = attrs?.href ?? ''
        this.linkText = ''
        return
      case 'strong':
      case 'b':
        // A link's label is plain text; emphasis inside it must not leak out.
        if (this.linkHref === null) this.append('**')
        return
      case 'em':
      case 'i':
        if (this.linkHref === null) this.append('*')
        return
      case 'br':
        this.blank()
        return
      case 'img':
        this.append(this.imageMarkdown(attrs))
        return
      case 'p':
        this.blank()
        return
      case 'figcaption':
        this.blank()
        return
      case 'hr':
        this.blank()
        this.out.push('---')
        this.out.push('')
        return
      default:
        if (BLOCK_TAGS.has(name)) this.blank()
        return
    }
  }

  close(name) {
    if (this.skipping !== null) {
      // Spend one nesting level, or end the skip when this is the tag that
      // opened it. A void tag or a stray closer inside a skipped subtree must
      // not end the skip early, so only matching names count down.
      if (name === this.skipping[0]) {
        if (this.skipping[1] > 0) this.skipping[1] -= 1
        else this.skipping = null
      } else if (this.skipping[1] > 0) {
        this.skipping[1] -= 1
      }
      return
    }
    if (this.pre !== null && name !== 'pre') {
      // Inside a code block only `</pre>` matters.
      return
    }
    if (this.table !== null && name !== 'table' && name !== 'tr' && name !== 'td' && name !== 'th') {
      // Cell text goes through the plain inline path; markup inside a cell is
      // kept as text so a stray `</strong>` cannot unbalance the row.
      return
    }
    switch (name) {
      case 'pre':
        if (this.pre !== null) {
          this.emitCode(this.pre.text)
          this.pre = null
        }
        return
      case 'code':
        if (this.codeDepth > 0) this.codeDepth -= 1
        return
      case 'ul':
      case 'ol':
        this.flush()
        this.listStack.pop()
        return
      case 'li':
        this.flush()
        return
      case 'td':
      case 'th':
        this.flushCell()
        return
      case 'tr':
        this.flushRow()
        return
      case 'table':
        this.flushRow()
        this.emitTable()
        this.table = null
        return
      case 'a': {
        const href = this.linkHref ?? ''
        const label = collapse(this.linkText ?? '').trim()
        this.linkHref = null
        this.linkText = null
        if (label && href && !href.toLowerCase().startsWith('javascript:')) {
          this.append(`[${label}](${href})`)
        } else if (label) {
          this.append(label)
        }
        return
      }
      case 'strong':
      case 'b':
        this.append('**')
        return
      case 'em':
      case 'i':
        this.append('*')
        return
      default:
        if (HEADING_TAGS.has(name) || BLOCK_TAGS.has(name)) this.blank()
        return
    }
  }

  void(token) {
    if (this.skipping !== null) return
    const { name, attrs } = token
    if (name === 'br') {
      if (this.pre !== null) this.pre.text += '\n'
      else this.blank()
      return
    }
    if (name === 'hr') {
      this.blank()
      this.out.push('---')
      this.out.push('')
      return
    }
    if (name === 'img' && this.table === null) {
      this.append(this.imageMarkdown(attrs))
      return
    }
    if (name === 'img' && this.table?.cell) {
      this.table.cell.text += this.imageMarkdown(attrs)
      return
    }
    if (this.pre !== null) {
      // `<source>`/`<wbr>` inside a pre: nothing worth keeping.
      return
    }
    if (BLOCK_TAGS.has(name)) this.blank()
  }

  /** Keep a figure's image as a link, and its alt text as the label. */
  imageMarkdown(attrs) {
    const src = attrs?.src ?? ''
    if (!src) return ''
    const alt = collapse(decodeEntities(attrs?.alt ?? '')).trim() || 'image'
    return `![${alt}](${src})`
  }

  emitCode(text) {
    const body = decodeEntities(String(text ?? '')).replace(/\r\n/g, '\n').replace(/^\n+|\s+$/g, '')
    this.blank()
    this.out.push('```', body, '```', '')
  }

  flushCell() {
    if (!this.table?.cell) return
    const text = collapse(this.table.cell.text).trim().replace(/(?<!\\)\|/g, '\\|')
    this.table.cell.text = text
    this.line = ''
  }

  flushRow() {
    if (!this.table) return
    this.flushCell()
    if (this.table.row && this.table.row.length > 0) {
      this.table.rows.push(this.table.row.map((cell) => (cell.isHeader ? cell.text : cell.text)))
    }
    this.table.row = null
    this.table.cell = null
  }

  emitTable() {
    const table = this.table
    if (!table || table.rows.length === 0) return
    const header = table.rows[0]
    const columns = Math.max(...table.rows.map((row) => row.length))
    const pad = (row) => {
      const cells = row.map((cell) => (typeof cell === 'string' ? cell : ''))
      while (cells.length < columns) cells.push('')
      return `| ${cells.join(' | ')} |`
    }
    this.blank()
    this.out.push(pad(header))
    this.out.push(`| ${Array.from({ length: columns }, () => '---').join(' | ')} |`)
    for (const row of table.rows.slice(1)) this.out.push(pad(row))
    this.out.push('')
  }

  finish() {
    if (this.pre !== null) {
      this.emitCode(this.pre.text)
      this.pre = null
    }
    if (this.table !== null) {
      this.flushRow()
      this.emitTable()
      this.table = null
    }
    // A table whose `</table>` never arrived still should not lose its rows.
    if (this.table !== null) {
      this.flushRow()
      this.emitTable()
      this.table = null
    }
    this.blank()
    // Collapse runs of blank lines: a page with deeply nested divs produces one
    // per closing tag, and the model reads the Markdown, not the nesting.
    return this.out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  }
}

/**
 * Convert one HTML fragment to Markdown.
 *
 * Never throws: any internal surprise degrades to the text that was already
 * collected. Callers therefore do not need a try/catch around a page, only
 * around the whole import.
 */
export function htmlToMarkdown(html) {
  const renderer = new MarkdownRenderer()
  try {
    for (const token of tokenizeHtml(html)) renderer.handle(token)
    return renderer.finish()
  } catch {
    return renderer.finish()
  }
}

/**
 * Plain text of a fragment, for titles and snippets.
 *
 * Reuses the Markdown path and strips the markup it produces: one converter, one
 * idea of what a page says, and no second tokenizer to keep in sync.
 */
export function htmlToText(html) {
  return htmlToMarkdown(html)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}