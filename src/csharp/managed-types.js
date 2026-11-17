// Managed-type resolution for `[SerializeReference]` payloads.
//
// Ports `Locus/src-tauri/src/tool/builtins/code_unity_managed.rs` together with
// the parts of `asset_db` it leans on. A `SerializedReference` field stores the
// concrete type by *name* — `{class, ns, asm}` in a `references: RefIds` block —
// not by GUID. Nothing links that name back to a script at load time, so a
// rename, a move between assemblies, or a deletion compiles cleanly and silently
// turns every existing instance into "missing type" at run time.
//
// The check is therefore: take every identity serialized assets ask for, find the
// C# declaration it names, and report the ones that no longer match. Two shapes
// of "no longer match" matter, and upstream treats them differently:
//
//   * `missing` — no declaration of that name exists at all;
//   * `moved`   — the declaration exists but now compiles into a different
//                 assembly, which is just as fatal and much easier to mistake
//                 for "the type is still there".
//
// `[MovedFrom]` is Unity's own escape hatch: a renamed or relocated type records
// its old identity so old payloads still bind. A declaration carrying one
// resolves the *old* identity, not the new one, which is why it is parsed here
// rather than left to Roslyn.
//
// Everything below reads plain files. The asset side comes from the durable
// index (`src/asset-index-sync.js::lookupManagedRefs`), the code side from a
// directory scan, so the check needs no language server and no editor.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Unity's four built-in assemblies, always present in a project. */
export const PREDEFINED_ASSEMBLIES = [
  'Assembly-CSharp',
  'Assembly-CSharp-firstpass',
  'Assembly-CSharp-Editor',
  'Assembly-CSharp-Editor-firstpass',
]

/** How many sample locations to print per unresolved identity (upstream: `MAX_SAMPLES_PER_TYPE`). */
export const MAX_SAMPLES_PER_TYPE = 3

/** How many issues one report may carry. */
const MAX_ISSUES = 50

/** How many C# files one declaration scan may read. */
const MAX_SOURCE_FILES = 20_000

/** A C# file larger than this is not a plausible source file. */
const MAX_SOURCE_BYTES = 2_000_000

/** Directories that never hold project C# (mirrors the asset walk's own skip list). */
const SKIP_DIRS = new Set(['library', 'temp', 'obj', 'bin', 'logs', 'usersettings', 'node_modules', '.git'])

// ---------------------------------------------------------------------------
// C# declaration scanning
// ---------------------------------------------------------------------------

/**
 * Every type declaration in one C# file.
 *
 * A hand-written scanner rather than a parser: the only facts needed are the
 * fully qualified name, the namespace, and the attributes/base list, and adding
 * a C# grammar (or a Roslyn dependency) for that would dwarf the question. It
 * tracks `namespace` blocks (both forms), the brace depth each type sits at, and
 * the attributes that decorate it — `[MovedFrom]` above all, since its arguments
 * are what make an old identity resolvable.
 *
 * @param {string} text file contents.
 * @returns {Array<{name: string, path: string[], namespace: string, kind: string,
 *   bases: string[], attributes: Array<{text: string}>, line: number}>}
 */
export function scanDeclarations(text) {
  const declarations = []
  /** One frame per open namespace or type, so a `}` knows what it closed. */
  const stack = []
  /** Attribute lists seen since the last declaration, keyed by the brace depth they sat at. */
  let pendingAttributes = []
  let pendingDepth = -1

  const lines = stripComments(text).split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripLineComment(lines[index]).trim()
    if (line === '') continue

    // A declaration and its opening brace may share a line, so the whole line is
    // inspected and its braces counted afterwards.
    const namespaceOf = () => {
      for (let cursor = stack.length - 1; cursor >= 0; cursor -= 1) {
        if (stack[cursor].kind === 'namespace') return stack[cursor].name
      }
      return ''
    }

    const attributeOnly = /^\[[\s\S]*\]$/.test(line)
    if (attributeOnly) {
      pendingAttributes.push({ text: line.slice(1, line.lastIndexOf(']')) })
      pendingDepth = stack.length
      continue
    }

    const namespaceMatch = /^namespace\s+([A-Za-z_][\w.]*)\s*([{;])?$/.exec(line)
    if (namespaceMatch !== null) {
      pendingAttributes = []
      // A file-scoped `namespace A.B;` replaces whatever came before.
      if (namespaceMatch[2] !== '{') {
        stack.length = 0
        stack.push({ kind: 'namespace', name: namespaceMatch[1] })
        continue
      }
      stack.push({ kind: 'namespace', name: namespaceMatch[1] })
      consumeBraces(line.slice(line.indexOf('{') + 1))
      continue
    }

    const header = parseTypeHeader(line)
    if (header !== null) {
      const path = [...stack.filter((frame) => frame.kind === 'type').map((frame) => frame.name), header.name]
      declarations.push({
        name: header.name,
        path,
        namespace: namespaceOf(),
        kind: header.kind,
        bases: header.bases,
        attributes: [...(pendingDepth === stack.length ? pendingAttributes : []), ...header.attributes],
        line: index + 1,
      })
      pendingAttributes = []
      if (header.opensBody) {
        stack.push({ kind: 'type', name: header.name })
        const open = line.indexOf('{')
        if (open !== -1) consumeBraces(line.slice(open + 1), true)
      } else if (/;\s*$/.test(line)) {
        // `public record Foo(int X);` — a bodied-less declaration closes with `;`.
        pendingAttributes = []
      }
      continue
    }

    // Anything else that opens or closes a brace moves the depth; a statement
    // that opens a block without being a type (a method, a property, an
    // initializer, a lambda) must still be counted so the `}` matches.
    const before = stack.length
    consumeBraces(line)
    // An attribute list inside an expression (`new[] { [0] = 1 }`) must not leak
    // into the next declaration: pending attributes only survive a line with no
    // braces at all.
    if (stack.length !== before) pendingAttributes = []
  }
  return declarations

  /**
   * Track `{`/`}` on the remainder of one line.
   *
   * `justOpenedType` means the caller already pushed this line's type frame, so
   * the first `}` may close that exact frame; without it a `}` on a
   * single-line declaration (`class Foo { }`) would pop the frame it just made.
   */
  function consumeBraces(line, justOpenedType = false) {
    let opened = justOpenedType
    for (const character of line) {
      if (character === '{') {
        stack.push({ kind: 'block', name: '' })
        opened = true
        continue
      }
      if (character === '}') {
        stack.pop()
        opened = false
      }
    }
    return opened
  }
}

/**
 * `public sealed partial class Foo<T> : Bar, IBaz where T : new()` →
 * `{name, kind, bases, attributes, opensBody}`.
 *
 * A header that carries its attributes inline (`[MovedFrom(...)] class Foo`) is
 * accepted too, because a file may put them on the declaration's own line.
 */
function parseTypeHeader(line) {
  let rest = line
  const attributes = []
  for (;;) {
    if (!rest.startsWith('[')) break
    const close = matching(rest, 0)
    if (close === -1) break
    attributes.push({ text: rest.slice(1, close) })
    rest = rest.slice(close + 1).trim()
  }
  // Modifiers may interleave with attributes, so search anywhere past a
  // modifier boundary rather than requiring the keyword at position 0.
  const match = /(?:^|[\s\]])(class|struct|interface|record(?:\s+(?:class|struct))?|enum)\s+([A-Za-z_]\w*)/.exec(` ${rest}`)
  if (match === null) return null
  const keyword = match[1].replace(/\s+/g, ' ')
  const name = match[2]
  const opensBody = rest.endsWith('{') || /:\s*\S[\s\S]*\{$/.test(rest)
  if (keyword === 'enum') return { name, kind: 'enum', bases: [], attributes, opensBody }
  const after = rest.slice(match.index + match[0].length)
  const bases = []
  // The base list starts at the first colon that is not part of `::` and is not
  // inside a generic argument list or a primary-constructor parameter list.
  const colon = topLevelColon(after)
  if (colon !== -1) {
    const tail = after.slice(colon + 1).replace(/\{?\s*$/, '')
    const constraint = tail.search(/\bwhere\b/)
    for (const part of splitTopLevel(constraint === -1 ? tail : tail.slice(0, constraint))) {
      const simple = baseName(part)
      if (simple !== null) bases.push(simple)
    }
  }
  return { name, kind: keyword, bases, attributes, opensBody }
}

/** The first `:` that separates a base list (not `::`, not inside brackets). */
function topLevelColon(text) {
  let depth = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === '(' || character === '<' || character === '[') depth += 1
    if (character === ')' || character === '>' || character === ']') depth -= 1
    if (character === ':' && depth === 0 && text[index + 1] !== ':' && text[index - 1] !== ':') return index
  }
  return -1
}

/** The simple type name of one base-list entry (`global::A.B<C>` → `B`, `IFoo` → `IFoo`). */
function baseName(part) {
  const match = /([A-Za-z_]\w*)\s*(?:<|$|,|\s)/.exec(`${part.trim()} `)
  return match === null ? null : match[1]
}

function splitTopLevel(text) {
  const parts = []
  let current = ''
  let depth = 0
  for (const character of text) {
    if (character === '(' || character === '<' || character === '[') depth += 1
    if (character === ')' || character === '>' || character === ']') depth -= 1
    if (character === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += character
  }
  if (current.trim() !== '') parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

function matching(text, open) {
  let depth = 0
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1
    else if (text[index] === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

// ---------------------------------------------------------------------------
// Attributes
// ---------------------------------------------------------------------------

/**
 * Locate the argument list of one attribute by name.
 *
 * The scanner stores each attribute list as its bracket contents, so a single
 * attribute may be `MovedFrom(...)` or, when bracketed with others,
 * `Serializable, MovedFrom(...)`. Returns `null` when the name is absent and
 * `{open: -1}` when it appears without arguments.
 *
 * @param {string} text the attribute list contents.
 * @param {RegExp} pattern the attribute name, anchored at the list start.
 */
function parseAttribute(text, pattern) {
  // No anchors on either side: the scanner may hand over the contents of one
  // attribute list, which can hold several comma-separated attributes.
  const match = pattern.exec(text)
  if (match === null) return null
  const end = match.index + match[0].length
  return { open: match[0].endsWith('(') ? end - 1 : -1 }
}

/**
 * The `[MovedFrom]` arguments of one declaration, or null.
 *
 * `MovedFromAttribute(bool autoUpdateAPI, string sourceNamespace = null, string
 * sourceAssembly = null, string sourceClassName = null)` in the modern form, and
 * `[MovedFrom(true, sourceAssembly: "Old")]` by name. A `null` argument means
 * "keep the declaration's own value", which is exactly how Unity treats it. A
 * single string argument is the pre-Unity-5.6 form naming only the assembly.
 *
 * @param {{attributes: Array<{text: string}>}} declaration
 * @returns {{namespace: string|null, assembly: string|null, className: string|null, autoUpdate: boolean|null}|null}
 */
export function movedFromOf(declaration) {
  for (const attribute of declaration.attributes ?? []) {
    // Free the bracket wrapper: the scanner keeps one attribute with its
    // brackets and strips them only when they hold several attributes.
    const source = attribute.text.trim().replace(/^\[/, '').replace(/\]$/, '')
    const parsed = parseAttribute(source, /(?:^|[\s,.(])(?:UnityEngine\s*\.\s*)?MovedFrom(?:Attribute)?\s*(?:\(|(?=[\s,)]|$))/)

    if (parsed === null) continue
    const { open } = parsed
    if (open === -1) return { autoUpdate: null, namespace: null, assembly: null, className: null }
    const close = matching(source, open)
    const call = source.slice(open + 1, close === -1 ? source.length : close)
    const positional = []
    const named = new Map()
    const parts = splitTopLevel(call)
    let leadingBoolean = null
    for (const part of parts) {
      // C# named arguments use a colon; `=` is not valid there.
      const assignment = /^([A-Za-z_]\w*)\s*:\s*([\s\S]*)$/.exec(part)
      if (assignment !== null) named.set(assignment[1], stringLiteral(assignment[2]))
      else positional.push(stringLiteral(part))
    }
    const first = parts[0]?.trim()
    leadingBoolean = first === 'true' || first === 'false' ? first === 'true' : null
    if (leadingBoolean !== null) {
      // Modern form: a leading bool shifts every positional argument by one.
      const at = (name, index) => (named.has(name) ? named.get(name) : index < positional.length ? positional[index] : null)
      return {
        autoUpdate: leadingBoolean,
        namespace: at('sourceNamespace', 1),
        assembly: at('sourceAssembly', 2),
        className: at('sourceClassName', 3),
      }
    }
    // The pre-Unity-5.6 form takes the source assembly alone.
    if (positional.length === 1 && named.size === 0) {
      return { autoUpdate: null, namespace: null, assembly: positional[0], className: null }
    }
    // Something else: honour whatever was named and leave the rest to the
    // declaration, which is what Unity does with an unspecified argument.
    if (named.size === 0) return { autoUpdate: null, namespace: null, assembly: null, className: null }
    const only = (name) => (named.has(name) ? named.get(name) : null)
    return {
      autoUpdate: named.has('autoUpdateAPI') ? named.get('autoUpdateAPI') === 'true' : null,
      namespace: only('sourceNamespace'),
      assembly: only('sourceAssembly'),
      className: only('sourceClassName'),
    }
  }
  return null
}

/** A C# string literal to its value; `null` and non-literals become null. */
function stringLiteral(text) {
  const trimmed = text.trim()
  if (trimmed === 'null' || trimmed === '') return null
  if (/^[A-Za-z_]\w*$/.test(trimmed)) return null
  const verbatim = /^@"((?:[^"]|"")*)"$/.exec(trimmed)
  if (verbatim !== null) return verbatim[1].replace(/""/g, '"')
  const normal = /^"((?:[^"\\]|\\.)*)"$/.exec(trimmed)
  if (normal === null) return null
  return normal[1].replace(/\\(.)/g, '$1')
}

// Characters compared against source text, as named constants rather than
// quoted literals: quote characters spelled out inline are what made this
// scanner's own syntax hard to read.
const QUOTE = String.fromCharCode(34)
const APOSTROPHE = String.fromCharCode(39)
const BACKSLASH = String.fromCharCode(92)
const NEWLINE = String.fromCharCode(10)
const AT = String.fromCharCode(64)

/** Strip line and block comments, keeping newlines so line numbers survive. */
export function stripComments(text) {
  let out = ''
  let index = 0
  let block = false
  while (index < text.length) {
    const character = text[index]
    const next = text[index + 1]
    if (block) {
      if (character === '*' && next === '/') {
        block = false
        index += 2
        continue
      }
      if (character === NEWLINE) out += character
      index += 1
      continue
    }
    if (character === '/' && next === '/') {
      const end = text.indexOf(NEWLINE, index)
      index = end === -1 ? text.length : end
      continue
    }
    if (character === '/' && next === '*') {
      block = true
      index += 2
      continue
    }
    // A string literal may itself contain slash-slash or slash-star; copying it
    // verbatim keeps that from being read as a comment.
    if (character === QUOTE || character === APOSTROPHE) {
      const verbatim = character === QUOTE && text[index - 1] === AT
      let cursor = index + 1
      out += character
      while (cursor < text.length) {
        const inner = text[cursor]
        if (!verbatim && inner === BACKSLASH) {
          out += inner + (text[cursor + 1] ?? '')
          cursor += 2
          continue
        }
        if (inner === character) {
          if (verbatim && text[cursor + 1] === character) {
            out += inner + inner
            cursor += 2
            continue
          }
          out += inner
          cursor += 1
          break
        }
        if (inner === NEWLINE && !verbatim) break
        out += inner
        cursor += 1
      }
      index = cursor
      continue
    }
    out += character
    index += 1
  }
  return out
}

/** Drop a trailing `//` comment from one already-comment-free line. */
function stripLineComment(line) {
  const index = line.indexOf('//')
  return index === -1 ? line : line.slice(0, index)
}

// ---------------------------------------------------------------------------
// Assemblies
// ---------------------------------------------------------------------------

/** Read a JSON file, returning null for anything unreadable. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Paths inside `Assets/`, `Packages/` (a project package) or any directory,
 * normalised to `/` separators relative to the project root.
 */
function projectRelative(root, absolute) {
  return relative(root, absolute).split(sep).join('/')
}

/** The `.asmdef` / `.asmref` nearest to a script, walking up to its package root. */
function findAssemblyDefinition(root, scriptPath) {
  const relativePath = projectRelative(root, scriptPath)
  const packages = relativePath.startsWith('Packages/')
  // A script in an immutable package (`Library/PackageCache`, `node_modules`) or
  // outside the project belongs to an assembly this check cannot see.
  if (!relativePath.startsWith('Assets/') && !packages) return null
  const floor = packages ? relativePath.split('/').slice(0, 2).join('/') : 'Assets'
  let directory = dirname(scriptPath)
  for (;;) {
    let names
    try {
      names = readdirSync(directory)
    } catch {
      return null
    }
    const definite = names.filter((name) => name.endsWith('.asmdef')).sort()
    const reference = names.filter((name) => name.endsWith('.asmref')).sort()
    const candidate = definite[0] ?? reference[0]
    if (candidate !== undefined) {
      return { path: join(directory, candidate), kind: candidate.endsWith('.asmref') ? 'reference' : 'definition' }
    }
    // A sibling folder's definition does not cover this script, so the walk
    // stops at the top of `Assets/` (or the package folder) rather than reading
    // one above it.
    const parent = dirname(directory)
    if (parent === directory || projectRelative(root, directory) === floor) return null
    directory = parent
  }
}

/** Unity's implicit assembly for a script with no `.asmdef` above it. */
function predefinedAssembly(root, scriptPath) {
  const parts = projectRelative(root, scriptPath)
    .split('/')
    .slice(0, -1)
    .map((part) => part.toLowerCase())
  // The first folder decides first-pass or not; an `Editor` folder anywhere
  // decides Editor or not.
  const first = parts[1] ?? ''
  const firstPass = first === 'plugins' || first === 'standard assets' || first === 'pro standard assets'
  const editor = parts.some((part) => part === 'editor')
  if (firstPass && editor) return 'Assembly-CSharp-Editor-firstpass'
  if (firstPass) return 'Assembly-CSharp-firstpass'
  if (editor) return 'Assembly-CSharp-Editor'
  return 'Assembly-CSharp'
}

/**
 * The assembly a script compiles into.
 *
 * `.asmdef` names come from the definition's `name`; an `.asmref` borrows the
 * name of the definition it points at (by GUID through `guidToPath`, or by
 * name). A script with neither falls back to Unity's implicit assemblies.
 *
 * @param {{root: string, guidToPath?: Map<string, string>}} context
 * @param {string} absolute absolute path to the `.cs` file.
 * @returns {{name: string, definition: string|null}|null}
 */
export function resolveAssembly(context, absolute) {
  const found = findAssemblyDefinition(context.root, absolute)
  if (found === null) {
    const relativePath = projectRelative(context.root, absolute)
    if (!relativePath.startsWith('Assets/') && !relativePath.startsWith('Packages/')) return null
    return { name: predefinedAssembly(context.root, absolute), definition: null }
  }
  const json = readJson(found.path)
  if (found.kind === 'definition') {
    const name = typeof json?.name === 'string' && json.name !== '' ? json.name : null
    return name === null ? null : { name, definition: found.path }
  }
  const target = typeof json?.reference === 'string' ? json.reference : ''
  if (target === '') return null
  if (target.startsWith('GUID:')) {
    const resolved = context.guidToPath?.get(target.slice(5).toLowerCase()) ?? null
    if (resolved === null) return null
    const definition = readJson(resolve(context.root, resolved))
    return typeof definition?.name === 'string' ? { name: definition.name, definition: resolve(context.root, resolved) } : null
  }
  return { name: target, definition: null }
}

// ---------------------------------------------------------------------------
// Type catalog
// ---------------------------------------------------------------------------

/** Every `.cs` file under `Assets/` and `Packages/`, project-relative, sorted. */
export function listSourceFiles(root, { limit = MAX_SOURCE_FILES } = {}) {
  const files = []
  const visit = (directory) => {
    if (files.length >= limit) return
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (files.length >= limit) return
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue
        visit(join(directory, entry.name))
        continue
      }
      if (entry.isFile() && entry.name.endsWith('.cs')) {
        const absolute = join(directory, entry.name)
        try {
          if (statSync(absolute).size > MAX_SOURCE_BYTES) continue
        } catch {
          continue
        }
        files.push(absolute)
      }
    }
  }
  // `Packages/` is only the project's own embedded packages: the immutable cache
  // under `Library/PackageCache` is skipped by SKIP_DIRS.
  for (const top of ['Assets', 'Packages']) {
    const directory = join(root, top)
    if (existsSync(directory)) visit(directory)
  }
  return files
}

/**
 * A lazy index over the project's C# declarations.
 *
 * Nothing is read until a lookup needs it: a project whose serialized types all
 * resolve from the file-name fast path never pays for the full scan, which is
 * what keeps this check affordable on a large project.
 */
export class TypeCatalog {
  /**
   * @param {{root: string, guidToPath?: Map<string, string>}} context
   */
  constructor(context) {
    this.root = context.root
    this.guidToPath = context.guidToPath ?? new Map()
    /** Managed class key → absolute paths whose file name matches it. */
    this.byFileName = new Map()
    /** Managed class key → declarations found by scanning source text. */
    this.byName = null
    /**
     * Class keys named by a `[MovedFrom]` somewhere in the project. A moved
     * type's old identity does not overlap with any file name, so it needs its
     * own index or every legacy lookup would pay for the full scan.
     */
    this.legacyKeys = null
    this.assemblyCache = new Map()
    this.assemblies = null
  }

  /** Index the file names (the fast path: `Foo.cs` holds `Foo`). */
  indexFileNames() {
    if (this.byFileName.size > 0) return this
    for (const absolute of listSourceFiles(this.root)) {
      const base = absolute.split(sep).pop() ?? ''
      const name = base.slice(0, -3)
      const key = managedClassKey(name)
      if (key === '') continue
      const existing = this.byFileName.get(key)
      if (existing === undefined) this.byFileName.set(key, [absolute])
      else existing.push(absolute)
    }
    return this
  }

  /** Scan every source file for declarations (the slow path). */
  ensureScan() {
    if (this.byName !== null) return this
    this.byName = new Map()
    this.legacyKeys = new Map()
    this.indexFileNames()
    for (const absolute of listSourceFiles(this.root)) {
      const text = readSource(absolute)
      if (text === null) continue
      for (const declaration of scanDeclarations(text)) {
        const key = managedClassKey(declaration.name)
        if (key === '') continue
        const entry = { ...declaration, file: absolute, assembly: this.assemblyOf(absolute) }
        const existing = this.byName.get(key)
        if (existing === undefined) this.byName.set(key, [entry])
        else existing.push(entry)
        const moved = movedFromOf(declaration)
        if (moved === null) continue
        const legacySources = [moved.className, ...(moved.namespace === null || moved.className === null ? [declaration.name] : [])]
        for (const source of legacySources) {
          const legacyKey = source === null ? '' : managedClassKey(source)
          if (legacyKey === '') continue
          const found = this.legacyKeys.get(legacyKey)
          if (found === undefined) this.legacyKeys.set(legacyKey, [entry])
          else found.push(entry)
        }
      }
    }
    return this
  }

  /** The assembly name of one script, memoised per file. */
  assemblyOf(absolute) {
    if (this.assemblyCache.has(absolute)) return this.assemblyCache.get(absolute)
    const resolved = resolveAssembly({ root: this.root, guidToPath: this.guidToPath }, absolute)
    this.assemblyCache.set(absolute, resolved)
    return resolved
  }

  /** Assembly names a serialized identity could legitimately use. */
  projectAssemblies() {
    if (this.assemblies !== null) return this.assemblies
    const names = new Set(PREDEFINED_ASSEMBLIES)
    for (const absolute of listSourceFiles(this.root)) {
      const resolved = this.assemblyOf(absolute)
      if (resolved !== null) names.add(resolved.name)
    }
    // Assembly names from the definitions themselves, including ones that
    // currently hold no script: an identity may legitimately name them.
    const visit = (directory) => {
      let entries
      try {
        entries = readdirSync(directory, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name.toLowerCase())) continue
          visit(join(directory, entry.name))
          continue
        }
        if (!entry.name.endsWith('.asmdef')) continue
        const json = readJson(join(directory, entry.name))
        if (typeof json?.name === 'string' && json.name !== '') names.add(json.name)
      }
    }
    for (const top of ['Assets', 'Packages']) {
      const directory = join(this.root, top)
      if (existsSync(directory)) visit(directory)
    }
    this.assemblies = names
    return names
  }

  /** Declarations that could carry `key`, cheapest source first. */
  candidates(key, allowScan) {
    const paths = new Set(this.indexFileNames().byFileName.get(key) ?? [])
    const scanned = allowScan ? this.ensureScan() : null
    for (const entry of scanned === null ? [] : [...(scanned.byName.get(key) ?? []), ...(scanned.legacyKeys.get(key) ?? [])]) {
      paths.add(entry.file)
    }
    return [...paths].sort()
  }

  /** The declarations of one candidate file whose managed key is `key`, with their assembly. */
  declarationsIn(absolute, key) {
    const scanned = this.byName
    if (scanned !== null) {
      // Either index can be why this file was a candidate: it declares the key
      // under that name, or a `[MovedFrom]` in it names the old identity.
      const found = [...(scanned.get(key) ?? []), ...(this.legacyKeys?.get(key) ?? [])].filter((entry) => entry.file === absolute)
      if (found.length > 0) return found
    }
    const text = readSource(absolute)
    if (text === null) return []
    const assembly = this.assemblyOf(absolute)
    return scanDeclarations(text)
      .filter((declaration) => managedClassKey(declaration.name) === key)
      .map((declaration) => ({ ...declaration, file: absolute, assembly }))
  }
}

function readSource(absolute) {
  try {
    return readFileSync(absolute, 'utf8')
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Identity resolution
// ---------------------------------------------------------------------------

/** `Outer/Inner` and `Outer+Inner` split into segments, generic arguments dropped. */
export function managedClassSegments(className) {
  const bare = String(className ?? '').split(/[[`]/)[0]
  return bare
    .split(/[/+]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')
}

/**
 * The lookup key for a managed class name: the last segment, lowercased.
 *
 * `Game.Foo/Inner` keys to `inner`, the same key the file name `Inner.cs` gets,
 * which is what makes the fast path overlap with the scan.
 */
export function managedClassKey(className) {
  const segments = managedClassSegments(className)
  return (segments[segments.length - 1] ?? '').toLowerCase()
}

/** `ns.class`, or the bare class when the identity has no namespace. */
export function displayName(identity) {
  return identity.namespace === '' ? identity.className : `${identity.namespace}.${identity.className}`
}

/** Same namespace, same segment names. Generic arity is not part of the comparison. */
function namesMatch(identity, declaration) {
  if ((declaration.namespace ?? '') !== identity.namespace) return false
  const wanted = managedClassSegments(identity.className)
  if (wanted.length !== declaration.path.length) return false
  for (let index = 0; index < wanted.length; index += 1) {
    if (wanted[index].split('`')[0] !== declaration.path[index].split('`')[0]) return false
  }
  return true
}

/**
 * Whether a declaration's `[MovedFrom]` covers `identity`.
 *
 * Unity reads the attribute as "this type used to be known by this identity":
 * any field the attribute leaves null defaults to the declaration's own value.
 */
function legacyMatch(identity, declaration) {
  const moved = movedFromOf(declaration)
  if (moved === null) return false
  const namespace = moved.namespace ?? declaration.namespace ?? ''
  if (namespace !== identity.namespace) return false
  const sourceName = moved.className
  const segments =
    sourceName === null
      ? (() => {
          const own = [...declaration.path]
          const target = managedClassSegments(identity.className)
          own[own.length - 1] = target[target.length - 1] ?? own[own.length - 1]
          return own
        })()
      : sourceName.includes('/') || sourceName.includes('+')
        ? managedClassSegments(sourceName)
        : (() => {
            const own = [...declaration.path]
            own[own.length - 1] = sourceName
            return own
          })()
  const wanted = managedClassSegments(identity.className)
  if (segments.length !== wanted.length) return false
  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index].split('`')[0] !== wanted[index].split('`')[0]) return false
  }
  const assembly = moved.assembly ?? declaration.assembly?.name ?? null
  if (assembly === null) return true
  return assembly === identity.assembly
}

/**
 * Resolve one serialized identity against the project's declarations.
 *
 * Mirrors upstream's two-round search: the file-name index first, and only when
 * that finds nothing does the full declaration scan run. The result is one of
 * `exact` (declaration exists in the same assembly), `legacy` (it moved, but a
 * `[MovedFrom]` says so), `moved` (it compiles into another assembly now) or
 * `missing`.
 *
 * @returns {{kind: 'exact'|'legacy'|'moved'|'missing', declaration?: object, assembly?: string|null}}
 */
export function resolveIdentity(catalog, identity) {
  const key = managedClassKey(identity.className)
  let mismatch = null
  for (const allowScan of [false, true]) {
    for (const file of catalog.candidates(key, allowScan)) {
      for (const declaration of catalog.declarationsIn(file, key)) {
        const assembly = declaration.assembly?.name ?? null
        if (namesMatch(identity, declaration)) {
          if (assembly === identity.assembly) return { kind: 'exact', declaration, assembly }
          if (legacyMatch(identity, declaration)) return { kind: 'legacy', declaration, assembly }
          mismatch ??= { declaration, assembly }
          continue
        }
        if (legacyMatch(identity, declaration)) return { kind: 'legacy', declaration, assembly }
      }
    }
  }
  if (mismatch !== null) return { kind: 'moved', declaration: mismatch.declaration, assembly: mismatch.assembly }
  return { kind: 'missing' }
}



// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * Check every `[SerializeReference]` identity the project's assets ask for.
 *
 * The input is the asset index's `managed_refs` summaries (one row per identity,
 * with how many instances and assets carry it). Identities in assemblies the
 * project cannot see — a package in `Library/PackageCache`, Unity itself, a
 * third-party DLL — are counted as skipped, not as failures: this check can only
 * answer for code it can read.
 *
 * @param {{types: Array<{className: string, namespace: string, assembly: string,
 *   instanceCount: number, assetCount: number}>}} types from `lookupManagedRefs`.
 * @param {string} root project root.
 * @param {{scopeFile?: string|null, guidToPath?: Map<string, string>}} [options]
 *   `scopeFile` limits the check to identities the file itself could own.
 * @returns {{checkedTypes: number, checkedInstances: number, skippedExternalTypes: number,
 *   issues: Array<object>}}
 */
export function checkManagedReferenceTypes(types, root, { scopeFile = null, guidToPath = new Map() } = {}) {
  return inspectManagedTypes(types, root, { scopeFile, guidToPath })
}

/**
 * Build the `code_diagnostics` section from the asset index, or from nothing.
 *
 * The index is the only source of identities: without a scanned project there is
 * nothing serialized to check, and upstream says the same by skipping the
 * section entirely when no asset database exists. Any failure inside the check
 * is reported as a line in the output rather than an error for the whole tool —
 * Roslyn diagnostics already answered, and one unavailable subsystem should not
 * take them down with it.
 *
 * @param {string} root project root.
 * @param {{scopeFile?: string|null, lookup?: (root: string, options: object) => object}} [options]
 *   `lookup` is the index reader (injected so tests need no database).
 * @returns {string} the section to append to the diagnostics output (may be empty).
 */
export function managedTypeSection(root, { scopeFile = null, lookup = null } = {}) {
  const read = lookup
  if (typeof read !== 'function') return ''
  let snapshot
  try {
    snapshot = read(root, {})
  } catch (error) {
    return `\n\n(SerializeReference type check skipped: ${error instanceof Error ? error.message : String(error)})`
  }
  if (!snapshot?.available) return ''
  const types = snapshot.types ?? []
  if (types.length === 0) return ''
  let report
  try {
    report = inspectManagedTypes(types, root, { scopeFile, guidToPath: snapshot.guidToPath ?? new Map() })
    // Sample locations come from the index as a second query, keyed by the
    // identities that actually failed: one read for the whole section.
    const failed = report.issues.map((issue) => managedClassKey(issue.identity.className))
    if (failed.length > 0) {
      const entries = read(root, { classKeys: failed })?.entries ?? []
      for (const issue of report.issues) {
        issue.samples = entries
          .filter((entry) => entry.className === issue.identity.className && (entry.namespace ?? '') === issue.identity.namespace)
          .slice(0, MAX_SAMPLES_PER_TYPE)
          .map((entry) => ({ path: entry.path, line: entry.line }))
      }
    }
  } catch (error) {
    return `\n\n(SerializeReference type check failed: ${error instanceof Error ? error.message : String(error)})`
  }
  return formatManagedTypeSection(report)
}

/**
 * The body of the check, shared by the exported wrapper and the section builder.
 *
 * `scopeFile` narrows the answer to what that file's own assembly owns: an
 * identity declared elsewhere is not this file's problem, which is how upstream
 * keeps a file-scoped answer about the file.
 */
function inspectManagedTypes(types, root, { scopeFile = null, guidToPath = new Map() } = {}) {
  const catalog = new TypeCatalog({ root, guidToPath })
  const report = { checkedTypes: 0, checkedInstances: 0, skippedExternalTypes: 0, issues: [] }
  const assemblies = catalog.projectAssemblies()
  const scopeAssembly = scopeFile === null ? null : catalog.assemblyOf(scopeFile)?.name ?? null
  for (const identity of types) {
    const normalized = { className: identity.className, namespace: identity.namespace ?? '', assembly: identity.assembly ?? '' }
    if (!assemblies.has(normalized.assembly)) {
      report.skippedExternalTypes += 1
      continue
    }
    const resolution = resolveIdentity(catalog, normalized)
    const owned = scopeAssembly !== null && normalized.assembly !== scopeAssembly
    const namesFile = resolution.declaration !== undefined && resolution.declaration.path === scopeFile
    if (owned && !namesFile) continue
    report.checkedTypes += 1
    report.checkedInstances += identity.instanceCount ?? 0
    if (resolution.kind === 'exact' || resolution.kind === 'legacy') continue
    report.issues.push({
      identity: normalized,
      instanceCount: identity.instanceCount ?? 0,
      assetCount: identity.assetCount ?? 0,
      movedTo: resolution.kind === 'moved' ? { displayName: displayName(normalized), assembly: resolution.assembly } : null,
      samples: [],
    })
  }
  return report
}

const plural = (count, singular, pluralForm = `${singular}s`) => `${count} ${count === 1 ? singular : pluralForm}`

/**
 * The `[SerializeReference]` section appended to `code_diagnostics` output.
 *
 * Wording follows upstream: silence when nothing was checked, a single
 * confirmation line when everything resolves, and one line per broken identity
 * with its sample locations when it does not.
 */
export function formatManagedTypeSection(report, maxIssues = MAX_ISSUES) {
  if (report === null || report === undefined) return ''
  if (report.checkedTypes === 0 && report.issues.length === 0) {
    if (report.skippedExternalTypes > 0) {
      return `\n\nSerializeReference types: ${plural(report.skippedExternalTypes, 'identity', 'identities')} from assemblies outside the project were not checked.`
    }
    return ''
  }
  if (report.issues.length === 0) {
    return `\n\nSerializeReference types: all ${report.checkedTypes} serialized project ${report.checkedTypes === 1 ? 'type resolves' : 'types resolve'} (${plural(report.checkedInstances, 'instance')}).`
  }
  const shown = Math.min(report.issues.length, maxIssues)
  const truncated = report.issues.length > shown ? `, showing first ${shown}` : ''
  let out = `\n\nSerializeReference types: ${report.issues.length} unresolved of ${report.checkedTypes} checked${truncated} — Unity loads these instances as missing types\n`
  for (const issue of report.issues.slice(0, shown)) {
    const reason =
      issue.movedTo !== null
        ? `'${issue.movedTo.displayName}' now compiles into '${issue.movedTo.assembly}', not '${issue.identity.assembly}' — add [MovedFrom(sourceAssembly: "${issue.identity.assembly}")] or move it back`
        : 'no such type in code — restore it or add [MovedFrom] to its replacement'
    out += `  ${displayName(issue.identity)} [asm ${issue.identity.assembly}]: ${reason} (${plural(issue.instanceCount, 'instance')} in ${plural(issue.assetCount, 'asset')})\n`
    for (const sample of issue.samples.slice(0, MAX_SAMPLES_PER_TYPE)) {
      out += `    ${sample.path}:${sample.line}\n`
    }
  }
  return out
}
