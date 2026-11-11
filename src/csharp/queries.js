// Semantic C# queries against a workspace language server.
//
// Mirrors `Locus/src-tauri/src/csharp_lsp/mod.rs` + `tool/builtins/code.rs`:
// the same five capabilities, the same forgiving symbol anchor, and the same
// result formatting, so an answer reads identically in both clients.
//
// One deliberate difference: upstream's `code_diagnostics` file scope also
// validates tags, layers, build-scene references, Resources paths and legacy
// Input axes against project configuration. That lives in the desktop app's
// asset database and is not reachable over the broker, so this client reports
// the Roslyn view only (compiler + analyzer + Unity analyzers) and says so.

import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

import { fileUriToPath, locateSymbol, pathToFileUri } from './lsp-protocol.js'
import { fileInProject } from './project-sync.js'
import { formatProjectRefsSection, scanProjectRefs } from './project-refs.js'
import {
  markWorkspaceWarm,
  queryWithReadyRetry,
  withWorkspace,
  workspaceIsRestored,
  workspaceIsWarming,
} from './lsp-pool.js'

const MAX_RESULT_LOCATIONS = 200
const DEFAULT_SYMBOL_LIMIT = 50
const DEFAULT_WORKSPACE_LIMIT = 200
/**
 * Settle budget for the first pull on a freshly opened document.
 *
 * Restore guarantees the compiler provider *can* answer, but the very first
 * `didOpen` still races its semantic model by a few hundred milliseconds; the
 * loop exits the moment a compiler diagnostic appears, so this only costs
 * anything on a file with no compiler errors.
 */
const DIAGNOSTIC_SETTLE_MS = 4_000
const DIAGNOSTIC_POLL_MS = 500
/** Upper bound on the post-load wait for a non-empty symbol index. */
const SYMBOL_READY_TIMEOUT_MS = 15_000

/** Severity labels, ordered by importance (LSP numbers 1..4). */
export const SEVERITIES = ['error', 'warning', 'info', 'hint']

export function severityLabel(severity) {
  switch (severity) {
    case 1:
      return 'error'
    case 2:
      return 'warning'
    case 3:
      return 'info'
    default:
      return 'hint'
  }
}

export function severityRank(label) {
  const index = SEVERITIES.indexOf(String(label ?? '').toLowerCase())
  return index < 0 ? null : index + 1
}

/** Workspace-relative display path, forward-slashed. */
export function displayPath(root, path) {
  const absolute = isAbsolute(path) ? path : resolve(root, path)
  const rel = relative(root, absolute).replaceAll('\\', '/')
  if (rel && !rel.startsWith('..')) return rel
  const normalized = absolute.replaceAll('\\', '/')
  // Roslyn materializes decompiled framework sources under its
  // MetadataAsSource cache. The full cache path is noise — and leaks the asset
  // root — so report the type file by name, matching upstream's
  // `[decompiled] Name.cs` convention.
  if (normalized.includes('/MetadataAsSource/')) {
    const name = normalized.slice(normalized.lastIndexOf('/') + 1)
    return `[decompiled] ${name}`
  }
  return normalized
}

function resolveSourcePath(root, filePath) {
  const candidate = String(filePath ?? '').trim()
  if (!candidate) throw new Error('file_path is required')
  const absolute = isAbsolute(candidate) ? candidate : resolve(root, candidate)
  try {
    readFileSync(absolute)
  } catch {
    throw new Error(`File not found: ${absolute}`)
  }
  return absolute
}

/** The one C#-file gate upstream applies (`is_unity_managed_csharp_file`). */
export function isUnityManagedCsharp(root, filePath) {
  const display = displayPath(root, filePath)
  if (!/\.cs$/i.test(display)) return false
  return /^(Assets|Packages)\//i.test(display)
}

function readSource(path) {
  return readFileSync(path, 'utf8')
}

function lineTextOf(root, counts, uri, line0) {
  const path = fileUriToPath(uri)
  if (!path) return { path: `[external] ${uri}`, line: 0, text: '' }
  let lines = counts.get(path)
  if (!lines) {
    try {
      lines = readSource(path).split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    } catch {
      lines = []
    }
    counts.set(path, lines)
  }
  const text = (lines[line0] ?? '').trim()
  return { path: displayPath(root, path), line: line0 + 1, text }
}

/** Turn raw LSP `Location`s into deduped, sorted, capped display entries. */
export function collectLocations(root, raw) {
  const seen = new Set()
  const locations = []
  let truncated = false
  const counts = new Map()
  for (const item of raw ?? []) {
    const uri = item?.uri ?? item?.targetUri
    if (!uri) continue
    const line0 = item?.range?.start?.line ?? item?.targetRange?.start?.line ?? 0
    const entry = lineTextOf(root, counts, uri, line0)
    const key = `${entry.path.toLowerCase()}\u0000${entry.line}`
    if (seen.has(key)) continue
    if (locations.length >= MAX_RESULT_LOCATIONS) {
      truncated = true
      break
    }
    seen.add(key)
    locations.push(entry)
  }
  locations.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line))
  return { locations, truncated }
}

/** Grouped `path` / `  line: text` rendering, matching upstream. */
export function formatLocations(locations) {
  let output = ''
  let currentFile = ''
  for (const location of locations) {
    if (location.path !== currentFile) {
      if (output) output += '\n'
      output += location.path + '\n'
      currentFile = location.path
    }
    output += location.line > 0 ? `  ${location.line}: ${location.text}\n` : '  (external)\n'
  }
  return output
}

function anchorNote(symbol, anchor) {
  if (!anchor) return ''
  if (anchor.requestedLine !== null && anchor.requestedLine !== anchor.line) {
    return `(Note: '${symbol}' was not on line ${anchor.requestedLine}; used the nearest occurrence at line ${anchor.line}.)\n\n`
  }
  if (anchor.requestedLine === null) return `(Resolved '${symbol}' at line ${anchor.line}.)\n\n`
  return ''
}

/**
 * Resolve `(file_path, symbol, line?)` to an LSP position on the workspace
 * server.
 */
async function locatePosition(connection, root, { filePath, symbol, line }) {
  const absolute = resolveSourcePath(root, filePath)
  const text = readSource(absolute)
  const position = locateSymbol(text, line ?? null, symbol)
  const uri = connection.syncDocument(absolute)
  return { absolute, uri, position, displayFile: displayPath(root, absolute) }
}

// ─── code_symbol_search ─────────────────────────────────────────────────────

/**
 * Search symbols by name.
 *
 * `workspace/symbol` is the server's own fuzzy index. Unlike the position
 * queries it does NOT fail while analysis is still running — it answers with an
 * empty array — so an empty result is retried for a bounded window before being
 * reported as "no such symbol". Verified against 5.4.0: the first query after
 * `projectInitializationComplete` returned 0 matches and the same query 3s
 * later returned the type.
 */
export async function searchSymbols(root, { query, maxResults = DEFAULT_SYMBOL_LIMIT, signal = null, ...options }) {
  const text = String(query ?? '').trim()
  if (!text) throw new Error('query is required')
  const limit = Number.isInteger(maxResults) ? Math.min(Math.max(maxResults, 1), 200) : DEFAULT_SYMBOL_LIMIT
  return withWorkspace(
    root,
    (connection) =>
      queryWithReadyRetry(
        connection,
        async () => {
          const result = await connection.request('workspace/symbol', { query: text })
          if ((result ?? []).length > 0) markWorkspaceWarm(root)
          return (result ?? []).slice(0, limit).map((item) => {
            const uri = item?.location?.uri ?? ''
            const line0 = item?.location?.range?.start?.line ?? 0
            const path = fileUriToPath(uri)
            return {
              name: item?.name ?? '',
              kind: symbolKindName(item?.kind ?? 0),
              container: item?.containerName ?? null,
              path: path ? displayPath(root, path) : `[external] ${uri}`,
              line: path ? line0 + 1 : 0,
            }
          })
        },
        {
          ...options,
          signal,
          // A symbol that genuinely does not exist costs this wait; the window
          // is short enough to be acceptable and long enough to cover the
          // observed analysis lag.
          timeoutMs: options.readyTimeoutMs ?? SYMBOL_READY_TIMEOUT_MS,
          // Empty is only ambiguous while the index may still be filling; once
          // a query has proven the workspace warm, an empty answer is final.
          isReady: (symbols) => symbols.length > 0 || !workspaceIsWarming(root),
        },
      ),
    options,
  )
}


/** LSP `SymbolKind` → a readable label. */
export function symbolKindName(kind) {
  switch (kind) {
    case 1:
      return 'File'
    case 2:
      return 'Module'
    case 3:
      return 'Namespace'
    case 5:
      return 'Class'
    case 6:
      return 'Method'
    case 7:
      return 'Property'
    case 8:
      return 'Field'
    case 9:
      return 'Constructor'
    case 10:
      return 'Enum'
    case 11:
      return 'Interface'
    case 12:
      return 'Function'
    case 13:
      return 'Variable'
    case 14:
      return 'Constant'
    case 22:
      return 'EnumMember'
    case 23:
      return 'Struct'
    case 24:
      return 'Event'
    case 25:
      return 'Operator'
    default:
      return 'Symbol'
  }
}

export function formatSymbols(query, symbols) {
  if (symbols.length === 0) {
    return `No C# symbols matched '${query}'. The server indexes the loaded assemblies; a type added since the last ` +
      'project sync may not be visible yet (unity_recompile, then retry).'
  }
  const lines = [`${symbols.length} symbol(s) matching '${query}':`]
  for (const symbol of symbols) {
    const container = symbol.container ? ` (${symbol.container})` : ''
    lines.push(`  ${symbol.kind.padEnd(10)} ${symbol.name}${container}  ${symbol.path}:${symbol.line}`)
  }
  return lines.join('\n')
}

// ─── code_goto_definition ───────────────────────────────────────────────────

export async function gotoDefinition(root, { filePath, symbol, line, ...options }) {
  const name = String(symbol ?? '').trim()
  if (!name) throw new Error('symbol is required')
  return withWorkspace(
    root,
    (connection) =>
      queryWithReadyRetry(connection, async () => {
        const located = await locatePosition(connection, root, { filePath, symbol: name, line })
        const result = await connection.request('textDocument/definition', {
          textDocument: { uri: located.uri },
          position: { line: located.position.line, character: located.position.character },
        })
        const raw = Array.isArray(result) ? result : result ? [result] : []
        const { locations, truncated } = collectLocations(root, raw)
        return { file: located.displayFile, anchor: located.position.anchor, locations, truncated }
      }),
    options,
  )
}

export function formatDefinition(symbol, result) {
  const note = anchorNote(symbol, result.anchor)
  if (result.locations.length === 0) {
    return `${note}No definition found for '${symbol}' in ${result.file}. It may come from a compiled assembly the ` +
      'server has not loaded, or the symbol is declared in a file added since the last project sync.'
  }
  const external = result.locations.every((entry) => entry.line === 0)
  const heading = external
    ? `'${symbol}' is defined in a compiled assembly (no source on disk):\n\n`
    : `'${symbol}' is defined at:\n\n`
  return note + heading + formatLocations(result.locations) + (result.truncated ? '\n(Results truncated.)' : '')
}

// ─── code_find_references ───────────────────────────────────────────────────

export async function findReferences(root, { filePath, symbol, line, includeDeclaration = false, ...options }) {
  const name = String(symbol ?? '').trim()
  if (!name) throw new Error('symbol is required')
  return withWorkspace(
    root,
    (connection) =>
      queryWithReadyRetry(connection, async () => {
        const located = await locatePosition(connection, root, { filePath, symbol: name, line })
        const result = await connection.request('textDocument/references', {
          textDocument: { uri: located.uri },
          position: { line: located.position.line, character: located.position.character },
          context: { includeDeclaration: includeDeclaration === true },
        })
        const { locations, truncated } = collectLocations(root, result ?? [])
        return { file: located.displayFile, anchor: located.position.anchor, locations, truncated }
      }),
    options,
  )
}

export function formatReferences(symbol, result, { includeDeclaration }) {
  const note = anchorNote(symbol, result.anchor)
  if (result.locations.length === 0) {
    return `${note}No references to '${symbol}' in the workspace. This is semantic (Roslyn) references only: ` +
      'serialized uses in scenes, prefabs and assets are not visible here — use unity_code_usages for those.'
  }
  const heading =
    `${result.locations.length} reference(s) to '${symbol}'` +
    (includeDeclaration ? ' (including the declaration)' : '') +
    ':\n\n'
  return note + heading + formatLocations(result.locations) + (result.truncated ? '\n(Results truncated.)' : '')
}

// ─── code_hover ─────────────────────────────────────────────────────────────

export async function hover(root, { filePath, symbol, line, ...options }) {
  const name = String(symbol ?? '').trim()
  if (!name) throw new Error('symbol is required')
  return withWorkspace(
    root,
    (connection) =>
      queryWithReadyRetry(connection, async () => {
        const located = await locatePosition(connection, root, { filePath, symbol: name, line })
        const result = await connection.request('textDocument/hover', {
          textDocument: { uri: located.uri },
          position: { line: located.position.line, character: located.position.character },
        })
        return { file: located.displayFile, anchor: located.position.anchor, contents: hoverText(result?.contents) }
      }),
    options,
  )
}

function hoverText(contents) {
  if (!contents) return ''
  if (typeof contents === 'string') return contents
  if (Array.isArray(contents)) return contents.map(hoverText).filter(Boolean).join('\n\n')
  if (typeof contents === 'object') {
    if (typeof contents.value === 'string') return contents.value
    if (typeof contents.language === 'string') return '```' + contents.language + '\n' + contents.value + '\n```'
  }
  return ''
}

export function formatHover(symbol, result) {
  const note = anchorNote(symbol, result.anchor)
  if (!result.contents) {
    return `${note}No hover information for '${symbol}' in ${result.file}.`
  }
  return `${note}${result.contents.trim()}\n`
}

// ─── code_diagnostics ───────────────────────────────────────────────────────

function pushDiagnostics(root, uri, items, out) {
  const path = fileUriToPath(uri)
  const display = path ? displayPath(root, path) : `[external] ${uri}`
  for (const item of items ?? []) {
    const line = (item?.range?.start?.line ?? 0) + 1
    const column = (item?.range?.start?.character ?? 0) + 1
    const severity = Math.min(Math.max(item?.severity ?? 3, 1), 4)
    const code = item?.code === undefined || item?.code === null ? null : String(item.code)
    const message = String(item?.message ?? '').trim()
    if (!message) continue
    out.push({ path: display, line, column, severity, code, message })
  }
}

function dedupeSort(diagnostics) {
  const seen = new Set()
  const unique = diagnostics.filter((entry) => {
    const key = `${entry.path.toLowerCase()}\u0000${entry.line}\u0000${entry.column}\u0000${entry.code ?? ''}\u0000${entry.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  unique.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || a.column - b.column,
  )
  return unique
}

/**
 * Pull diagnostics for one document.
 *
 * The analyzer providers answer before the compiler provider has a semantic
 * model, so a single pull on a freshly opened document can return style
 * suggestions and no errors. A short settle loop repeats the pull until a
 * compiler diagnostic appears or the budget runs out; it exits immediately once
 * one is present, so the cost only materializes on a broken file.
 */
export async function fileDiagnostics(root, { filePath, settleMs = DIAGNOSTIC_SETTLE_MS, ...options }) {
  const absolute = resolveSourcePath(root, filePath)
  if (!isUnityManagedCsharp(root, absolute)) {
    throw new Error(
      `C# diagnostics only support Unity-managed source files under Assets/ or Packages/: ${displayPath(root, absolute)}`,
    )
  }
  const membership = fileInProject(root, absolute)
  return withWorkspace(
    root,
    async (connection) => {
      const uri = pathToFileUri(absolute)
      const deadline = Date.now() + settleMs
      let diagnostics = []
      for (;;) {
        const items = await queryWithReadyRetry(connection, () => connection.documentDiagnostics(absolute))
        diagnostics = []
        pushDiagnostics(root, uri, items, diagnostics)
        // Any compiler diagnostic proves the semantic model is live. Waiting for
        // a *specific* severity would keep polling a file with only warnings.
        const compilerAnswered = diagnostics.some((entry) => entry.code?.startsWith('CS'))
        if (compilerAnswered || Date.now() >= deadline) break
        await new Promise((done) => setTimeout(done, DIAGNOSTIC_POLL_MS))
      }
      // Upstream's file scope also validates string references that compile but
      // fail at run time (tags, layers, scenes, Resources, Input axes). It reads
      // ProjectSettings text only, so the bridge can do the same; the
      // `[SerializeReference]` half of upstream's check needs the desktop
      // asset_db and is deliberately absent.
      let projectRefs = null
      try {
        projectRefs = scanProjectRefs(root, absolute)
      } catch {
        projectRefs = null
      }
      return {
        scope: 'file',
        file: displayPath(root, absolute),
        diagnostics: dedupeSort(diagnostics),
        projectRefs,
        // Without restore artifacts the compiler provider reports nothing at
        // all, so "no errors" would be a false all-clear.
        restored: workspaceIsRestored(root),
        // Unity lists every file explicitly in its csproj, so a file written
        // after the last project sync is outside the compilation and yields no
        // diagnostics whatsoever.
        member: membership,
      }
    },
    options,
  )
}

/** Pull solution-wide diagnostics (the server's background analysis scope). */
export async function workspaceDiagnostics(root, { ...options }) {
  return withWorkspace(
    root,
    (connection) =>
      queryWithReadyRetry(
        connection,
        async () => {
          const diagnostics = []
          const result = await connection.request('workspace/diagnostic', { previousResultIds: [] }, { timeoutMs: 180_000 })
          for (const item of result?.items ?? []) {
            pushDiagnostics(root, item?.uri ?? '', item?.items ?? [], diagnostics)
          }
          return { scope: 'workspace', file: null, diagnostics: dedupeSort(diagnostics), restored: workspaceIsRestored(root) }
        },
        { timeoutMs: 180_000 },
      ),
    options,
  )
}

export function formatDiagnostics(result, { minSeverity = 'warning', maxResults = 100 } = {}) {
  const threshold = severityRank(minSeverity) ?? 2
  const filtered = result.diagnostics.filter((entry) => entry.severity <= threshold)
  // File scope carries string-reference findings; they are not Roslyn
  // diagnostics, so they are appended rather than counted in the summary.
  const refsSection = result.projectRefs ? formatProjectRefsSection(result.projectRefs) : ''
  if (filtered.length === 0) {
    const where = result.scope === 'file' ? result.file : 'the workspace'
    // Upstream reports how many diagnostics were suppressed by the threshold:
    // "no problems" and "nothing above your threshold" are different answers.
    const belowThreshold = result.diagnostics.filter((entry) => entry.severity > threshold).length
    const suppressed = belowThreshold > 0 ? ` (${belowThreshold} below the severity threshold.)` : ''
    if (result.member === 'absent') {
      return (
        `No C# diagnostics at or above '${minSeverity}' in ${where} — but the file is not in any project's ` +
        'compile set, so Roslyn never analyzes it. Unity writes each file into its generated .csproj explicitly; ' +
        'a file created after the last project sync is missing until Unity regenerates them (open the editor, or ' +
        'call unity_recompile).'
      ) + refsSection
    }
    if (result.restored === false) {
      return (
        `No C# diagnostics at or above '${minSeverity}' in ${where} — but the project has no restore artifacts ` +
        '(project.assets.json), so the compiler provider reports nothing. Run `dotnet restore` for the solution ' +
        '(or let code_analysis action "install"/a fresh query retry it) before trusting this result.'
      ) + refsSection
    }
    return `No C# diagnostics at or above '${minSeverity}' in ${where}.${suppressed}${refsSection}`
  }
  const shown = filtered.slice(0, maxResults)
  const counts = { error: 0, warning: 0, info: 0, hint: 0 }
  for (const entry of filtered) counts[severityLabel(entry.severity)] += 1
  const summary = SEVERITIES.filter((label) => counts[label] > 0)
    .map((label) => `${counts[label]} ${label}${counts[label] === 1 ? '' : 's'}`)
    .join(', ')
  const lines = [`${filtered.length} C# diagnostic(s): ${summary}`]
  for (const entry of shown) {
    const code = entry.code ? ` ${entry.code}` : ''
    lines.push(`  ${entry.path}:${entry.line}:${entry.column}  ${severityLabel(entry.severity)}${code}: ${entry.message}`)
  }
  if (filtered.length > shown.length) {
    lines.push(`  … ${filtered.length - shown.length} more (raise max_results to see them)`)
  }
  return lines.join('\n') + refsSection
}