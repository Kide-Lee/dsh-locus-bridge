// File-level hot-reload classification, in the plugin process.
//
// This is a port of the editor-side classifier that used to live in
// `packages/unity-bridge/Editor/HotReload/DshHotReloadClassifier.cs`: it reads
// the edited sources from disk and answers "can this file be detoured without a
// compile, and which methods would the patch target". Doing it here removes the
// `dsh_hot_reload_classify` round-trip and lets `unity_hot_reload`'s dry run work
// with no Editor at all; only applying a patch still needs the bridge.
//
// The rules are deliberately conservative and match upstream's HotDiff verdicts at
// file granularity, without an old syntax tree:
//
//   * a file with a record, interface, enum (not after its first class/struct),
//     a field declaration at member position, or a field-like event is cold;
//   * `.asmdef` / `.asmref` / `.rsp`, a deleted file, a file with no `.meta`
//     yet, and a type name declared by more than one script are cold;
//   * everything else is hot, with one identity per method/constructor/accessor
//     body that can be detoured (generics and expression-bodied members are left
//     to a real compile).

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** The note the tool surfaces next to a classification. */
export const CLASSIFICATION_NOTE =
  'file-level classification: method identities come from the current source; ' +
  'signature-level diffs need a real compile (use unity_recompile)'

const MEMBER_DECLARATION = /[A-Za-z_][A-Za-z0-9_]*\s*\(/

const TYPE_DECLARATION = /\b(class|struct|interface|record|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/

const METHOD_LINE = new RegExp(
  '^(?<mods>(?:(?:public|private|protected|internal|static|virtual|override|abstract|sealed|extern|async|unsafe|new|partial|readonly|required)\\s+)*)' +
    '(?<ret>[A-Za-z_][A-Za-z0-9_.,<>\\[\\]?: ]*?)\\s+' +
    '(?<name>[A-Za-z_][A-Za-z0-9_]*)\\s*' +
    '(?:<(?<generic>[^>]*)>)?\\s*\\((?<params>[^)]*)\\)\\s*' +
    '(?<tail>.*)$',
)

const NOT_METHODS = new Set([
  'if', 'for', 'foreach', 'while', 'switch', 'lock', 'using', 'catch', 'return', 'new',
  'get', 'set', 'init', 'add', 'remove', 'var', 'await', 'yield', 'throw', 'else', 'do',
  'try', 'finally', 'fixed', 'checked', 'unchecked', 'when', 'nameof', 'typeof', 'sizeof',
])

const TYPE_LINE = /\b(class|struct|record)\s+[A-Za-z_]|\binterface\s+[A-Za-z_]|\benum\s+[A-Za-z_]/

const FIELD_LINE = new RegExp(
  '^(?:\\[[^\\]]*\\]\\s*)*(?:(?:public|private|protected|internal|static|readonly|volatile|new|unsafe|extern)\\s+)*' +
    '(?:[A-Za-z_][A-Za-z0-9_.]*\\s+)+[A-Za-z_][A-Za-z0-9_]*\\s*(?:=[^;]*)?;\\s*$',
)

const ALIASES = Object.freeze({
  int: 'Int32', uint: 'UInt32', long: 'Int64', ulong: 'UInt64',
  short: 'Int16', ushort: 'UInt16', byte: 'Byte', sbyte: 'SByte',
  bool: 'Boolean', string: 'String', char: 'Char', float: 'Single',
  double: 'Double', decimal: 'Decimal', object: 'Object', void: 'Void',
})

const SYSTEM_NAMESPACES = new Set([
  'System', 'System.IO', 'System.Text', 'System.Linq', 'System.Collections',
  'System.Collections.Generic', 'System.Threading', 'System.Threading.Tasks',
  'UnityEngine', 'UnityEditor',
])

/** Directories a script scan must never enter (Unity-generated or VCS noise). */
const SKIP_DIRS = new Set([
  'Library', 'Temp', 'obj', 'Obj', 'Logs', 'UserSettings', 'Build', 'Builds',
  'node_modules', '.git', '.svn', '.hg', '.vs', '.idea', '.vscode', 'target', 'dist',
])

/** Paths a classification reports, in the order the caller gave them. */
export function classifyHotPaths(projectRoot, paths) {
  const results = []
  const seen = new Set()
  for (const raw of Array.isArray(paths) ? paths : []) {
    const path = normalizeAssetPath(projectRoot, raw)
    if (path === null) {
      results.push({ path: String(raw ?? ''), state: 'failed', error: 'path is not a project-relative Assets/ or Packages/ path' })
      continue
    }
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    results.push(classifyOne(projectRoot, path))
  }
  return summarize(results)
}

/** Shape the per-file results into the tool's three buckets plus `files`. */
export function summarize(results) {
  const hot = []
  const needCompile = []
  const failed = []
  const files = []
  for (const file of results) {
    const methods = Array.isArray(file.hot) ? file.hot : []
    files.push({ path: file.path, state: file.state, reason: file.reason ?? '', method_count: methods.length })
    if (file.state === 'hot') hot.push(...methods)
    else if (file.state === 'need-compile') needCompile.push({ path: file.path, reason: file.reason ?? '' })
    else failed.push({ path: file.path, error: file.error ?? file.reason ?? '' })
  }
  return {
    hot,
    needCompile,
    failed,
    files,
    supported: true,
    reason: CLASSIFICATION_NOTE,
  }
}

/** Classify one project-relative script path. */
function classifyOne(projectRoot, path) {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase()

  // Assembly layout changed: no detour can be reliable.
  if (extension === '.asmdef' || extension === '.asmref' || extension === '.rsp') {
    return result(path, 'need-compile', `assembly definition changed (${path}); adding, removing or moving assemblies needs a real compile`)
  }
  if (extension !== '.cs') {
    return result(path, 'failed', `not a C# source file: ${path}`)
  }

  const absolute = toAbsolutePath(projectRoot, path)
  if (absolute === null) {
    return result(path, 'failed', `cannot map ${path} into this Unity project`)
  }

  if (!existsSync(absolute)) {
    // A deleted file: its types leave the assembly, so there is nothing to detour.
    return result(path, 'need-compile', 'file was deleted; removing types or members needs a real compile')
  }

  if (!existsSync(`${absolute}.meta`)) {
    // Still importing (Unity writes the .meta afterwards). Retrying after the
    // import finishes is the answer, not an error.
    return result(path, 'need-compile', 'the asset has no .meta yet; Unity is still importing it (retry once the import finishes)')
  }

  const duplicate = countSameTypeName(projectRoot, path)
  if (duplicate > 1) {
    return result(
      path,
      'need-compile',
      `another script in this project declares the same type name (${duplicate} files match); the compiled type is ambiguous until a real compile resolves it`,
    )
  }

  let index
  try {
    index = readSourceIndex(absolute)
  } catch (error) {
    return result(path, 'failed', `${error?.name ?? 'Error'}: ${error?.message ?? error}`)
  }

  if (!index.hasTypeDeclaration) {
    // Only usings/comments: nothing to detour, and nothing to compile either.
    return result(path, 'hot', null, [])
  }

  if (index.structuralReason !== null) {
    return result(path, 'need-compile', index.structuralReason)
  }

  // Unity message methods are not treated as cold: rewriting an Update() body is
  // the most common hot edit, and upstream only forbids *adding* one.
  if (index.methods.length === 0) {
    return result(path, 'hot', null, [])
  }

  const hot = index.methods.map((method) => method.toHotMethod(path))
  return result(path, 'hot', hot.length > 0 ? 'compiled method bodies changed' : 'no detour target found in this file', hot)
}

function result(path, state, reason, hot = []) {
  return { path, state, reason, hot }
}

// ─── paths ──────────────────────────────────────────────────────────────────

/** Fold a caller path into `Assets/…` or `Packages/…`; null when impossible. */
export function normalizeAssetPath(projectRoot, value) {
  let path = String(value ?? '').trim().replaceAll('\\', '/')
  if (path === '') return null
  while (path.startsWith('./')) path = path.slice(2)
  path = path.replace(/^\/+/, '')
  const lower = path.toLowerCase()
  if (!lower.startsWith('assets/') && !lower.startsWith('packages/')) {
    const root = String(projectRoot ?? '').replaceAll('\\', '/').replace(/\/+$/, '')
    if (root === '') return null
    const rootLower = root.toLowerCase()
    if (!lower.startsWith(`${rootLower}/`)) return null
    path = path.slice(root.length + 1)
  }
  const relative = path.toLowerCase()
  return relative.startsWith('assets/') || relative.startsWith('packages/') ? path : null
}

/** Absolute path of one project-relative asset path. */
function toAbsolutePath(projectRoot, assetPath) {
  if (!assetPath) return null
  return join(projectRoot, ...assetPath.split('/'))
}

// ─── duplicate type names ───────────────────────────────────────────────────

/**
 * How many scripts declare any of this file's type names.
 *
 * The editor version asked `AssetDatabase.FindAssets("t:MonoScript")`; the plugin
 * process has no asset database, so the same two roots are walked on disk. A
 * project with thousands of scripts pays a bounded directory walk per call.
 */
function countSameTypeName(projectRoot, assetPath) {
  let text
  try {
    text = readFileSync(toAbsolutePath(projectRoot, assetPath), 'utf8')
  } catch {
    return 0
  }
  const names = new Set()
  for (const match of text.matchAll(/\b(?:class|struct|interface|record|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
    names.add(match[1])
  }
  if (names.size === 0) return 0

  let count = 0
  for (const relative of listScripts(projectRoot)) {
    if (relative.toLowerCase() === assetPath.toLowerCase()) {
      count += 1
      continue
    }
    let other
    try {
      other = readFileSync(toAbsolutePath(projectRoot, relative), 'utf8')
    } catch {
      continue
    }
    for (const name of names) {
      if (new RegExp(`\\b(class|struct|interface|record|enum)\\s+${escapeRegExp(name)}\\b`).test(other)) {
        count += 1
        break
      }
    }
  }
  return count
}

/** Project-relative `.cs` files under Assets/ and Packages/. */
function listScripts(projectRoot) {
  const out = []
  const walk = (absolute, relative) => {
    let entries
    try {
      entries = readdirSync(absolute, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.endsWith('~')) continue
      const childRelative = relative === '' ? entry.name : `${relative}/${entry.name}`
      const childAbsolute = join(absolute, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(childAbsolute, childRelative)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.cs')) {
        out.push(childRelative)
      }
    }
  }
  for (const root of ['Assets', 'Packages']) {
    walk(join(projectRoot, root), root)
  }
  return out
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ─── source index ───────────────────────────────────────────────────────────

/** One script's type declaration, structural verdict and detourable methods. */
function readSourceIndex(absolute) {
  const index = { hasTypeDeclaration: false, structuralReason: null, methods: [] }
  const text = readFileSync(absolute, 'utf8')
  const code = stripCommentsAndStrings(text)
  if (!TYPE_DECLARATION.test(code)) return index
  index.hasTypeDeclaration = true
  index.structuralReason = structuralReason(code)

  let currentType = null
  let currentMethod = null
  let pendingMethod = null
  let depth = 0

  for (const rawLine of code.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue

    if (pendingMethod !== null) {
      // Allman signature: the next line's `{` opens the body. Anything else (`;`
      // bodyless member, accessor, multi-line parameters) yields no detour.
      const pending = pendingMethod
      pendingMethod = null
      if (line.startsWith('{')) {
        pending.pendingBody = false
        pending.hasBody = true
        pending.openBody = true
        pending.eligible = true
        depth = countChar(line, '{') - countChar(line, '}')
        if (depth <= 0) {
          pending.close()
          if (pending.eligible) index.methods.push(pending)
        } else {
          currentMethod = pending
        }
      }
      continue
    }

    if (currentMethod !== null) {
      depth += countChar(line, '{') - countChar(line, '}')
      if (depth <= 0) {
        currentMethod.close()
        if (currentMethod.eligible) index.methods.push(currentMethod)
        currentMethod = null
        depth = 0
      }
      continue
    }

    const declaration = TYPE_DECLARATION.exec(line)
    if (declaration !== null) {
      const namespace = lastNamespace(code)
      currentType = {
        name: declaration[2],
        metadataName: namespace === '' ? declaration[2] : `${namespace}.${declaration[2]}`,
      }
      index.methods.push(...scanMethods(currentType, line))
      continue
    }

    if (currentType !== null) {
      // Signatures ending in `;` (abstract/interface members, auto-properties)
      // have no body and cannot be detoured.
      for (const method of scanMethods(currentType, line)) {
        if (method.hasBody && method.openBody) {
          currentMethod = method
          depth = 1
          break
        }
        if (method.pendingBody) {
          pendingMethod = method
          break
        }
        if (method.eligible) index.methods.push(method)
      }
    }
  }

  return index
}

function lastNamespace(code) {
  let value = ''
  for (const match of code.matchAll(/\bnamespace\s+([A-Za-z0-9_.]+)/g)) value = match[1]
  return value
}

function countChar(text, char) {
  let total = 0
  for (const current of text) if (current === char) total += 1
  return total
}

// ─── structural signals ─────────────────────────────────────────────────────

/**
 * Cold verdicts that upstream's HotDiff reaches without a syntax tree.
 *
 * `struct`/`override`/`virtual`/`abstract`/`sealed` also appear inside method
 * bodies, so only signals that are unambiguous at file level are used; the rest
 * is left to a real compile.
 */
export function structuralReason(code) {
  if (/\brecord\b/.test(code)) return 'record types are not hot-reloadable; use unity_recompile'
  if (/\binterface\s+[A-Za-z_]/.test(code)) return 'interface changed: interface dispatch cannot be hot-patched; use unity_recompile'

  const classLike = /\b(class|struct)\s+[A-Za-z_]/.exec(code)
  const enumDecl = /\benum\s+[A-Za-z_]/.exec(code)
  if (enumDecl !== null && (classLike === null || enumDecl.index < classLike.index)) {
    return 'enum changed: values are inlined at compile time; only appended members are hot, which this bridge cannot verify — use unity_recompile'
  }

  // Field declarations are only cold at member position; the same shape inside
  // a method/accessor body is a local. `depth` tracks that: a block namespace
  // does not push a type body.
  let depth = 0
  let memberDepth = -1
  let pendingType = false
  for (const rawLine of code.split('\n')) {
    const line = rawLine.trim()
    const opens = countChar(line, '{')
    const closes = countChar(line, '}')
    const inMemberPosition = memberDepth >= 0 && depth === memberDepth
    if (TYPE_LINE.test(line)) pendingType = true

    if (pendingType && opens > 0) {
      pendingType = false
      memberDepth = depth + 1
      depth += opens - closes
      continue
    }

    if (
      inMemberPosition &&
      line.length > 0 &&
      !line.includes('(') &&
      !line.startsWith('using ') &&
      !line.startsWith('return') &&
      !line.startsWith('throw') &&
      !line.startsWith('yield') &&
      FIELD_LINE.test(line)
    ) {
      return 'field layout changed: a field declaration is present in this file and field layout is metadata, immutable without a real compile; use unity_recompile'
    }

    depth += opens - closes
    if (memberDepth >= 0 && depth < memberDepth) memberDepth = -1
  }

  if (/\bevent\s+[A-Za-z_][A-Za-z0-9_.]*\s+[A-Za-z_]/.test(code)) {
    return 'field-like event added: event declarations are metadata; use unity_recompile'
  }

  return null
}

// ─── method identities ──────────────────────────────────────────────────────

/** Candidate method identities on one line, for the scanner to place. */
function scanMethods(type, line) {
  if (line.length === 0 || !MEMBER_DECLARATION.test(line)) return []
  const match = METHOD_LINE.exec(line)
  if (match === null) return []

  const name = match.groups.name
  const modifiers = match.groups.mods
  const tail = match.groups.tail.trim()
  const isCtor = name === type.name
  if (!isCtor && NOT_METHODS.has(name)) return []
  // Generic methods need closed generic arguments the detour cannot name.
  if (match.groups.generic !== undefined && match.groups.generic.length > 0) return []
  if (tail.startsWith('=>') || tail.startsWith(':')) return []

  const hasBody = tail.startsWith('{') || tail.includes('{')
  const pendingBody = !hasBody && tail.length === 0
  if (!hasBody && !pendingBody && !tail.endsWith(';')) return []

  const identity = {
    declaringType: type,
    name: isCtor ? '.ctor' : name,
    isCtor,
    isStatic: /\bstatic\b/.test(modifiers),
    hasBody,
    openBody: hasBody,
    pendingBody,
    eligible: hasBody, // bodyless members cannot be detoured
    paramTypeNames: [],
    paramTypeSigs: [],
    close() {
      this.openBody = false
    },
    toHotMethod(path) {
      return {
        path,
        declaring_type: this.declaringType.metadataName,
        patch_declaring_type: this.declaringType.metadataName,
        name: this.name,
        param_type_names: this.paramTypeNames,
        param_type_sigs: this.paramTypeSigs,
        is_static: this.isStatic,
        is_ctor: this.isCtor,
        source_path: path,
        method_key: this.methodKey(),
      }
    },
    methodKey() {
      return `${this.declaringType.metadataName}|${this.name}|${this.paramTypeNames.join(',')}${this.isStatic ? '|s' : '|i'}`
    },
  }

  for (const rawParameter of splitParameters(match.groups.params)) {
    let parameter = rawParameter
    let byRef = false
    for (;;) {
      const modifier = /^(ref|out|in|params|this|scoped)\s+/.exec(parameter)
      if (modifier === null) break
      if (modifier[1] === 'ref' || modifier[1] === 'out' || modifier[1] === 'in') byRef = true
      parameter = parameter.slice(modifier[0].length)
    }
    // The last top-level word is the parameter name; everything before it is the type.
    const boundary = lastTypeBoundary(parameter)
    let typeText = boundary > 0 ? parameter.slice(0, boundary).trim() : parameter.trim()
    if (typeText.length === 0) typeText = 'object'
    identity.paramTypeNames.push(reflectionName(typeText) + (byRef ? '&' : ''))
    identity.paramTypeSigs.push(normalizeTypeText(typeText) + (byRef ? '&' : ''))
  }

  return [identity]
}

/** Split a parameter list on top-level commas (generic arguments stay whole). */
function splitParameters(text) {
  if (text === undefined || text === null || text.trim() === '') return []
  const parts = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if (char === '<' || char === '(' || char === '[') depth += 1
    else if (char === '>' || char === ')' || char === ']') depth -= 1
    if (char === ',' && depth <= 0) {
      if (current.trim() !== '') parts.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  if (current.trim() !== '') parts.push(current.trim())
  return parts
}

/** Index of the last top-level space in a parameter, or -1. */
function lastTypeBoundary(text) {
  let depth = 0
  let boundary = -1
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (char === '<' || char === '(' || char === '[') depth += 1
    else if (char === '>' || char === ')' || char === ']') depth -= 1
    else if (char === ' ' && depth <= 0) boundary = i
  }
  return boundary
}

/** Source type text → the reflection shape (`List<int>` → ``List`1``). */
export function reflectionName(typeText) {
  let text = typeText.replaceAll(' ', '')
  while (text.endsWith('?')) text = 'Nullable`1'
  const arrayStart = text.indexOf('[')
  if (arrayStart >= 0) return reflectionName(text.slice(0, arrayStart)) + text.slice(arrayStart)
  const genericStart = text.indexOf('<')
  if (genericStart >= 0) {
    const head = simpleName(text.slice(0, genericStart))
    const argumentsText = text.slice(genericStart + 1, Math.max(genericStart + 1, text.lastIndexOf('>')))
    const count = splitParameters(argumentsText).length
    return `${head}\`${count}`
  }
  return ALIASES[text] ?? simpleName(text)
}

/** Source type text → the best-effort qualified name reflection reports. */
export function normalizeTypeText(typeText) {
  const text = typeText.replaceAll(' ', '')
  const alias = ALIASES[text]
  if (alias !== undefined) return `System.${alias}`
  if (SYSTEM_NAMESPACES.has(text) || text.startsWith('System.') || text.startsWith('UnityEngine.') || text.startsWith('UnityEditor.')) {
    return text
  }
  return text
}

function simpleName(qualified) {
  const generic = qualified.indexOf('<')
  const head = generic >= 0 ? qualified.slice(0, generic) : qualified
  const dot = head.lastIndexOf('.')
  return (dot >= 0 ? head.slice(dot + 1) : head).replace(/\?+$/, '')
}

// ─── lexer ──────────────────────────────────────────────────────────────────

/**
 * Drop comments, string/char literals and preprocessor lines, keeping newlines
 * so the line scanner still sees the original shape. The goal is only that
 * `class Foo` inside a comment cannot be mistaken for a declaration.
 */
export function stripCommentsAndStrings(text) {
  const source = String(text ?? '')
  let out = ''
  let i = 0
  while (i < source.length) {
    const char = source[i]
    if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (char === '/' && source[i + 1] === '*') {
      i += 2
      while (i + 1 < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out += '\n'
        i += 1
      }
      i += 2
      continue
    }
    if (char === '"' || char === "'") {
      const quote = char
      i += 1
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i += 1
        i += 1
      }
      i += 1
      out += quote + quote
      continue
    }
    if (char === '#' && (i === 0 || source[i - 1] === '\n')) {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    out += char
    i += 1
  }
  return out
}