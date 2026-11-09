// `unity_get_console_log` request shaping and result formatting.
//
// The managed side answers `{entries:[{level,message,count}], matchedCount,
// uniqueCount, truncated}` (LocusBridge.Console.cs); this module validates the
// tool arguments the same way the tool schema advertises them and renders the
// compact form the desktop agent sees.

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

export { DEFAULT_LIMIT, MAX_LIMIT }
