// Lightweight static checks for plain-ESM modules (no TypeScript in this repo):
//   - every relative import resolves to an existing file
//   - no module imports a name it does not export
//   - no undefined top-level binding is referenced in a module body (syntax-level,
//     catches the "renamed helper" class of bug the tests also guard against)
// Usage: node scripts/typecheck.mjs

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const files = []
for (const dir of ['src', 'scripts', 'test']) {
  for (const name of readdirSync(resolve(root, dir))) {
    if (name.endsWith('.js') || name.endsWith('.mjs')) files.push(resolve(root, dir, name))
  }
}

/** Named exports of one module (static, best effort). */
function exportsOf(file) {
  const source = readFileSync(file, 'utf8')
  const names = new Set()
  for (const match of source.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(match[1])
  }
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(',')) {
      const piece = part.trim()
      if (!piece) continue
      const asMatch = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(piece)
      names.add(asMatch ? asMatch[1] : piece.split(/\s+/)[0])
    }
  }
  if (/export\s+default\b/.test(source)) names.add('default')
  return names
}

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof', 'await', 'new', 'throw', 'yield', 'delete', 'void', 'super'])
const GLOBALS = new Set(['async', 'Object', 'Array', 'String', 'Number', 'Boolean', 'JSON', 'Math', 'Map', 'Set', 'WeakMap', 'Promise', 'Error', 'TypeError', 'RangeError', 'Buffer', 'AbortController', 'AbortSignal', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'setImmediate', 'structuredClone', 'parseInt', 'parseFloat', 'isNaN', 'encodeURIComponent', 'decodeURIComponent', 'Symbol', 'RegExp', 'Date', 'Intl', 'URL', 'Int32Array', 'SharedArrayBuffer', 'Atomics', 'print', 'describe', 'it'])

// Inside C# snippet sources, these are snippet globals (Locus ScriptGlobals).
const SNIPPET_HELPERS = new Set(['print', 'printJson', 'clear'])

const problems = []
const exportCache = new Map()
for (const file of files) {
  const source = readFileSync(file, 'utf8')
  // Statement-level import declarations only (`import ... from '...'`), so
  // strings such as {"action":"read"} inside data are never parsed as imports.
  for (const match of source.matchAll(/^\s*import\s+([^'"\n]+?)\s*from\s+['"]([^'"]+)['"]/gm)) {
    const clause = match[1] ?? ''
    const specifier = match[2]
    if (!specifier.startsWith('.') && !specifier.startsWith('node:')) continue
    if (specifier.startsWith('node:')) continue
    const target = resolve(dirname(file), specifier)
    if (!existsSync(target)) {
      problems.push(`${file}: import '${specifier}' does not resolve`)
      continue
    }
    if (!exportCache.has(target)) exportCache.set(target, exportsOf(target))
    const exported = exportCache.get(target)
    const names = []
    const named = /\{([^}]*)\}/.exec(clause)
    if (named) for (const part of named[1].split(',')) {
      const piece = part.trim().replace(/^type\s+/, '')
      if (piece) names.push(piece.split(/\s+as\s+/)[0])
    }
    const def = /\bdefault\b/.exec(clause.replace(/\{[^}]*\}/g, ''))
    if (def) names.push('default')
    for (const name of names) {
      if (!exported.has(name)) problems.push(`${file}: '${name}' is not exported by ${specifier}`)
    }
  }
  // Syntax-only consistency check (line based, deliberately conservative):
  //   a statement that STARTS with a call must name something that is
  //   declared, imported, a parameter, or a global. Catches the
  //   "renamed/removed helper" class of bug without a real type checker.
  const relative = file.slice(root.length + 1)
  const lines = source.split('\n')
  let inBlockComment = false
  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false
      return
    }
    if (trimmed.startsWith('/*')) {
      inBlockComment = !trimmed.includes('*/')
      return
    }
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('#')) return
    // Method / function / class-member definitions are not calls.
    if (/^(?:static\s+|async\s+|get\s+|set\s+)?[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{\s*$/.test(trimmed)) return
    const statement = /^(?:(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:await\s+)?)?([A-Za-z_$][\w$]*)\s*\(/.exec(trimmed)
    const returning = statement ? null : /^(?:return|await|void)\s+([A-Za-z_$][\w$]*)\s*\(/.exec(trimmed)
    const name0 = statement ? statement[1] : returning ? returning[1] : null
    if (!name0) return
    const name = name0
    if (KEYWORDS.has(name) || GLOBALS.has(name) || SNIPPET_HELPERS.has(name)) return
    const declared = new RegExp(`(?:function|const|let|var|class)\\s+${name}\\b`).test(source)
    const parameter = new RegExp(`[(,]\\s*${name}\\s*[,)=]`).test(source)
    const imported = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`).test(source) ||
      new RegExp(`\\{[^}]*\\b${name}\\b[^}]*\\}\\s*=\\s*[\\w$.]+`).test(source) ||
      new RegExp(`import\\s+${name}\\b`).test(source)
    if (!declared && !parameter && !imported) {
      problems.push(`${relative}:${index + 1}: "${name}(" is not declared or imported`)
    }
  })
}

if (problems.length > 0) {
  for (const problem of [...new Set(problems)]) console.error(problem)
  console.error(`${problems.length} problem(s)`)
  process.exitCode = 1
} else {
  console.log(`typecheck: ${files.length} modules, imports and call sites look consistent`)
}
