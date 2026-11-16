// `unity_get_console_log` request shaping and result formatting.
//
// The managed side answers `{entries:[{level,message,count}], matchedCount,
// uniqueCount, truncated}` (LocusBridge.Console.cs); this module validates the
// tool arguments the same way the tool schema advertises them and renders the
// compact form the desktop agent sees.

import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, join, relative } from 'node:path'

const LEVELS = new Set(['error', 'warn', 'info'])
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/** Validate tool args and build the JSON `message` for `unity_get_console_log`. */
export function consoleLogMessage({ level, levels, limit } = {}) {
  const filters = []
  if (level !== undefined) {
    if (!LEVELS.has(level)) throw new Error(`Invalid level '${level}'. Allowed values: error, warn, info.`)
    filters.push(level)
  }
  if (levels !== undefined) {
    if (!Array.isArray(levels) || levels.length === 0) {
      throw new Error('levels must be a non-empty array of error, warn, info.')
    }
    for (const value of levels) {
      if (!LEVELS.has(value)) throw new Error(`Invalid levels entry '${value}'. Allowed values: error, warn, info.`)
      if (!filters.includes(value)) filters.push(value)
    }
  }
  const request = {}
  if (level !== undefined) request.level = level
  if (levels !== undefined) request.levels = levels
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new Error(`limit must be an integer in 1..${MAX_LIMIT}.`)
    }
    request.limit = limit
  }
  return { message: Object.keys(request).length ? JSON.stringify(request) : '', filters }
}

/** Render the managed ConsoleLogResult payload for the model. */
export function formatConsoleLog(rawMessage) {
  let result
  try {
    result = JSON.parse(rawMessage || '{}')
  } catch (error) {
    throw new Error(`unity_get_console_log returned invalid JSON: ${error.message}`)
  }
  const entries = Array.isArray(result.entries) ? result.entries : []
  const header =
    `Unity Console: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}` +
    ` (${result.matchedCount ?? 0} matched, ${result.uniqueCount ?? 0} unique` +
    `${result.truncated ? ', truncated' : ''})`
  if (entries.length === 0) return `${header}\n<empty>`
  const lines = entries.map((entry) => {
    const count = Number(entry.count) > 1 ? ` (x${entry.count})` : ''
    const body = String(entry.message ?? '')
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')
    return `[${entry.level}]${count} ${body.trimStart()}`
  })
  return `${header}\n${lines.join('\n')}`
}

/**
 * Read the Unity Editor's own log file.
 *
 * The in-Editor Console only knows what the Editor sent us while attached: a
 * project that failed to compile *before* the broker came up has its errors in
 * `Editor.log` and nowhere else. Upstream `unity_bridge/editor_log.rs` reads the
 * tail of that file for the same reason, with the same conventions, which this
 * function keeps:
 *
 * - only the last 1 MiB is read, and the first (probably partial) line is
 *   dropped, so a multi-gigabyte log costs nothing;
 * - Unity's own order is the project-local copy (`<project>/Logs/Editor.log`)
 *   first, then the per-user log — but the per-user one is shared by *every*
 *   project on the machine. Reading a different project's errors because they
 *   happen to be newer is worse than saying "no log", so the per-user log is only
 *   used when its contents are actually about this project;
 * - a line is an entry only if it looks like a diagnostic (`: error `, `error
 *   CS`, `Exception`, `: warning `, …), which keeps the build chatter out;
 * - duplicates collapse into one entry with a `count`.
 *
 * @param {string} projectRoot - absolute Unity project root.
 * @param {{levels?: string|string[], limit?: number, since?: string}} [options]
 * @returns {Promise<{source: 'Editor.log', path: string|null, entries: Array<{level: string, message: string, count: number}>,
 *   supported: boolean, reason?: string, matched: number, unique: number, truncated: boolean}>}
 */
export async function readEditorLogEntries(projectRoot, { levels, limit, since } = {}) {
  const wanted = normalizeLevels(levels)
  const size = limit === undefined ? DEFAULT_LIMIT : clampLogLimit(limit)
  const cutoff = parseSince(since)
  const candidates = editorLogCandidates(projectRoot)
  const chosen = chooseLog(candidates, projectRoot)
  if (chosen === null) {
    return {
      source: 'Editor.log',
      path: null,
      entries: [],
      supported: false,
      reason:
        'No Editor.log found. Looked in ' +
        `${candidates.map((candidate) => quote(candidate)).join(', ')}. ` +
        'Unity writes it while the Editor runs; a project that was never opened has none.',
      matched: 0,
      unique: 0,
      truncated: false,
    }
  }

  const tail = readLogTail(chosen)
  const counts = new Map()
  let matched = 0
  let lastTimestamp = null
  for (const line of tail.lines) {
    const stamp = timestampOf(line)
    if (stamp !== null) lastTimestamp = stamp
    const level = classifyLogLine(line)
    if (level === null) continue
    if (wanted !== null && !wanted.has(level)) continue
    const entryTimestamp = stamp ?? lastTimestamp
    if (cutoff !== null) {
      if (entryTimestamp === null) continue
      if (Date.parse(entryTimestamp) < cutoff) continue
    }
    matched += 1
    // Deduplicate on the diagnostic itself, not on the timestamped raw line: a
    // recompile logs the same error again second later, and the model cares that
    // it happened twice, not that the clock moved. The prefix is stripped from
    // the rendered message for the same reason.
    const body = stripTimestamp(line)
    const key = `${level}\u0000${body}`
    const existing = counts.get(key)
    if (existing === undefined) counts.set(key, { level, message: body, count: 1, time: entryTimestamp })
    else existing.count += 1
  }
  const all = [...counts.values()]
  const entries = all.slice(-size)
  return {
    source: 'Editor.log',
    path: chosen,
    entries,
    supported: true,
    matched,
    unique: all.length,
    truncated: all.length > entries.length,
    bytesRead: tail.bytes,
  }
}

/** Render `readEditorLogEntries` for the model, matching `formatConsoleLog`'s shape. */
export function formatEditorLog(result) {
  if (result?.supported === false) return `[source: Editor.log]\nunavailable: ${result.reason}`
  const entries = result?.entries ?? []
  const header =
    `[source: Editor.log] ${result?.path ?? ''}`.trimEnd() +
    `\nUnity Console: ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}` +
    ` (${result?.matched ?? 0} matched, ${result?.unique ?? 0} unique` +
    `${result?.truncated ? ', truncated' : ''})`
  if (entries.length === 0) return `${header}\n<empty>`
  const lines = entries.map((entry) => {
    const count = Number(entry.count) > 1 ? ` (x${entry.count})` : ''
    const time = typeof entry.time === 'string' ? ` ${entry.time}` : ''
    return `[${entry.level}]${count}${time} ${String(entry.message ?? '').trimStart()}`
  })
  return `${header}\n${lines.join('\n')}`
}

// ─── Editor.log ────────────────────────────────────────────────────────────

/** The readable tail of the log; upstream's `MAX_TAIL_BYTES`. */
const MAX_TAIL_BYTES = 1024 * 1024

/**
 * Where Unity keeps `Editor.log`, project-local first.
 *
 * The project copy (`<project>/Logs/Editor.log`) is what a build or a `-logFile`
 * run leaves behind; the per-user path is where the Editor itself writes.
 */
function editorLogCandidates(projectRoot) {
  const root = String(projectRoot ?? '').trim()
  const inside = root === '' ? [] : [join(root, 'Logs', 'Editor.log'), join(root, 'Editor.log')]
  const home = homedir()
  if (process.platform === 'win32') {
    const appData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    return [...inside, join(appData, 'Unity', 'Editor', 'Editor.log')]
  }
  if (process.platform === 'darwin') return [...inside, join(home, 'Library', 'Logs', 'Unity', 'Editor.log')]
  return [...inside, join(process.env.XDG_CONFIG_HOME || join(home, '.config'), 'unity3d', 'Editor.log')]
}

/**
 * Pick the log to read: the project's own first, otherwise a shared per-user log
 * whose tail mentions this project.
 *
 * `candidates` is ordered project-local-first, which is Unity's own order.
 */
function chooseLog(candidates, projectRoot) {
  const root = String(projectRoot ?? '').trim()
  for (const [index, candidate] of candidates.entries()) {
    if (!existsSync(candidate)) continue
    if (index === 0 || root === '' || isProjectLocal(candidate, root)) return candidate
    if (mentionsProject(candidate, root)) return candidate
  }
  return null
}

/** Whether a log path sits inside the project (the project-local copies do). */
function isProjectLocal(candidate, root) {
  const relativePath = relative(root, candidate)
  return !relativePath.startsWith('..') && !isAbsolute(relativePath)
}

/**
 * Whether a shared log's tail is about this project.
 *
 * The Editor writes its project path into `Editor.log` at startup and echoes it
 * in load/compile lines, so a substring test on the project's own directory name
 * is enough to tell "this project's session" from another project's.
 */
function mentionsProject(candidate, root) {
  const name = basename(root)
  if (name === '' || name === '.' || name === '..') return true
  try {
    const { lines } = readLogTail(candidate)
    return lines.some((line) => line.includes(`/${name}/`) || line.includes(`\\${name}\\`) || line.includes(root))
  } catch {
    return false
  }
}

/**
 * Read at most the last `MAX_TAIL_BYTES` bytes and split them into lines.
 *
 * When the file was longer than the window the first line is not a line: it
 * starts mid-way through some other line, so it is dropped.
 */
function readLogTail(path) {
  let handle
  try {
    handle = openSync(path, 'r')
    const stats = fstatSync(handle)
    const size = stats.size
    const start = Math.max(0, size - MAX_TAIL_BYTES)
    const length = size - start
    const buffer = Buffer.alloc(length)
    if (length > 0) readSync(handle, buffer, 0, length, start)
    const text = buffer.toString('utf8')
    const lines = text.split(/\r?\n/)
    if (start > 0 && lines.length > 0) lines.shift()
    return { lines: lines.filter((line) => line !== ''), bytes: length }
  } finally {
    if (handle !== undefined) closeSync(handle)
  }
}

/**
 * Classify one log line, following upstream `classify_log_line`.
 *
 * The strings are Unity's own wording: an error is reported as `X.cs(1,2): error
 * CS1234: …` or as an exception, a warning as `: warning CS…`. Everything else
 * (imports, recompiles, `[Locus]` chatter) is not an entry.
 */
export function classifyLogLine(line) {
  const text = String(line ?? '')
  if (text === '') return null
  const lower = text.toLowerCase()
  if (
    lower.includes(': error ') ||
    lower.includes('error cs') ||
    lower.includes('script compilation error') ||
    lower.includes('tundra build failed') ||
    lower.includes('compilation failed') ||
    lower.includes('crash!!!') ||
    lower.includes('fatal error') ||
    lower.includes('exception')
  ) {
    return 'error'
  }
  if (lower.includes(': warning ') || lower.includes('warning cs') || lower.startsWith('warning:')) return 'warn'
  if (lower.includes('safe mode') || lower.startsWith('[scriptcompilation]') || lower.startsWith('[locus]')) return 'info'
  return null
}

/** A log line without its leading `[timestamp]` marker. */
function stripTimestamp(line) {
  return String(line ?? '').replace(/^\[\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?\]\s?/, '')
}

/**
 * The timestamp a Unity log line starts with, if it has one.
 *
 * Unity 6 prefixes entries with `[2026-11-16 01:23:45.678] `; older lines have
 * none, in which case the last timestamp seen still applies to them.
 */
function timestampOf(line) {
  const match = /^\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?)\]/.exec(String(line ?? ''))
  return match === null ? null : match[1]
}

function normalizeLevels(levels) {
  if (levels === undefined || levels === null) return null
  const list = Array.isArray(levels) ? levels : [levels]
  if (list.length === 0) throw new Error('levels must be a non-empty array of error, warn, info.')
  const wanted = new Set()
  for (const value of list) {
    if (!LEVELS.has(value)) throw new Error(`Invalid levels entry '${value}'. Allowed values: error, warn, info.`)
    wanted.add(value)
  }
  return wanted
}

function clampLogLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be an integer in 1..${MAX_LIMIT}.`)
  }
  return limit
}

/** `since` accepts an ISO date/time or epoch milliseconds; anything else is an error. */
function parseSince(since) {
  if (since === undefined || since === null || since === '') return null
  if (typeof since === 'number' && Number.isFinite(since)) return since
  const text = String(since).trim()
  if (/^\d{10,}$/.test(text)) return Number(text)
  const parsed = Date.parse(text)
  if (Number.isNaN(parsed)) {
    throw new Error(`since must be an ISO timestamp or epoch milliseconds; got '${since}'.`)
  }
  return parsed
}

function quote(text) {
  return `'${text}'`
}

export { DEFAULT_LIMIT, MAX_LIMIT, MAX_TAIL_BYTES }
