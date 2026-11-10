// Which Unity project a tool call targets.
//
// Precedence (highest first):
//   1. an explicit `project_path` argument;
//   2. the nearest Locus project config found in the Session cwd or above it
//      (`.locus.json` / `.locus.yaml`-free simple JSON, see `locus.json` below);
//   3. the Session cwd when it is a Unity project;
//   4. the shallowest Unity project found within `PROJECT_SEARCH_DEPTH` levels;
//   5. an error that lists the candidates.
//
// Step 2 exists so a repository can name its editor project once — either in a
// checked-in config file or by pointing AGENTS.md at it — instead of the agent
// having to ask a human on every call.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'

/** Names the Locus project config may use, nearest one wins. */
export const PROJECT_CONFIG_FILES = ['.locus.json', 'locus.json']

/** Windows drive / UNC paths are absolute even when the host is Linux or macOS. */
export function isAbsoluteProjectPath(value) {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]/.test(value)
}

/**
 * True when `root` is a Unity project directory.
 *
 * Direct port of `unity_bridge::is_unity_project`: both `Assets/` and
 * `ProjectSettings/` must be directories. Checking the serialized version file
 * instead would reject freshly created projects before Unity first opens them.
 */
export function isUnityProject(root) {
  if (!root) return false
  try {
    return statSync(join(root, 'Assets')).isDirectory() && statSync(join(root, 'ProjectSettings')).isDirectory()
  } catch {
    return false
  }
}

/** How deep the implicit search looks below the Session working directory. */
export const PROJECT_SEARCH_DEPTH = 3

/**
 * Directory names never worth descending into while looking for a project.
 *
 * These are either huge generated trees (a Unity `Library/` is tens of thousands
 * of files) or package caches. Skipping them keeps the implicit search cheap
 * without affecting correctness: a real project is recognised by its own
 * `Assets/` + `ProjectSettings/`, never by what sits underneath it.
 */
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  'Library',
  'Temp',
  'Obj',
  'obj',
  'Build',
  'Builds',
  'Logs',
  'UserSettings',
  'MemoryCaptures',
  'Recordings',
  '.git',
  '.svn',
  '.hg',
  '.vs',
  '.idea',
  '.vscode',
  'target',
  'dist',
])

/**
 * Unity projects at or below `dir`, searched breadth-first up to `maxDepth`.
 *
 * Breadth-first matters: a project one level down is a better answer than one
 * three levels down, so the caller can prefer the shallowest hit instead of
 * reporting a false ambiguity. The search never descends into a directory it
 * already identified as a project (a project's own subtree cannot contain a
 * better answer, only nested packages).
 *
 * Returns `[{ path, depth }]` ordered by depth, then path, so the result is
 * deterministic. Symlinked directories are not followed: that would need cycle
 * detection and would disagree with the path Unity itself opened.
 */
export function findUnityProjects(dir, { maxDepth = PROJECT_SEARCH_DEPTH } = {}) {
  const found = []
  let frontier = [{ path: dir, depth: 0 }]
  const limit = Number.isInteger(maxDepth) && maxDepth > 0 ? maxDepth : PROJECT_SEARCH_DEPTH

  while (frontier.length > 0) {
    const next = []
    for (const node of frontier) {
      if (isUnityProject(node.path)) {
        // Record it and stop: nothing inside a project is a better candidate.
        found.push({ path: node.path, depth: node.depth })
        continue
      }
      if (node.depth >= limit) continue
      for (const child of subdirectories(node.path)) {
        next.push({ path: child, depth: node.depth + 1 })
      }
    }
    frontier = next
  }

  return found.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))
}

/** Child directory paths worth visiting: no dot dirs, no generated trees. */
function subdirectories(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIP_DIR_NAMES.has(entry.name))
    .map((entry) => join(dir, entry.name))
}

/**
 * Read the Locus project config from `dir`, or `null` when there is none.
 *
 * Only `project` is consumed here; the file is intentionally tiny and shared
 * with other tooling, so unknown keys are ignored rather than rejected.
 * `project` is resolved relative to the config file, which is what a checked-in
 * `{ "project": "unity-test" }` at a repository root means.
 */
export function readProjectConfig(dir) {
  for (const name of PROJECT_CONFIG_FILES) {
    const file = join(dir, name)
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(stripJsonComments(text))
    } catch (error) {
      throw new Error(`${file} is not valid JSON: ${error.message}`)
    }
    const value = typeof parsed?.project === 'string' ? parsed.project.trim() : ''
    if (!value) continue
    const project = isAbsoluteProjectPath(value) ? value : resolve(dir, value)
    return { file, project: isAbsolute(project) ? resolve(project) : project, raw: value }
  }
  return null
}

/**
 * The nearest project config at or above `dir`.
 *
 * Stops at the filesystem root. A config whose `project` names something that is
 * not a Unity project is reported rather than skipped: silently ignoring a
 * deliberate setting would send the agent back to guessing.
 */
export function findProjectConfig(dir) {
  let current = resolve(dir)
  const root = parse(current).root
  for (;;) {
    const config = readProjectConfig(current)
    if (config) return config
    if (current === root) return null
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** Strip `//` and `/* *\/` comments so a config may be annotated. */
function stripJsonComments(text) {
  let out = ''
  let index = 0
  let inString = false
  let escaped = false
  while (index < text.length) {
    const ch = text[index]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      index += 1
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      index += 1
      continue
    }
    if (ch === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1
      continue
    }
    if (ch === '/' && text[index + 1] === '*') {
      index += 2
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index += 1
      index += 2
      continue
    }
    out += ch
    index += 1
  }
  return out
}

/**
 * Resolve the Unity project root for a call.
 *
 * Precedence:
 *   1. explicit `project_path`;
 *   2. the nearest project config at or above the Session cwd;
 *   3. the Session cwd when it already is a Unity project;
 *   4. the shallowest Unity project within `PROJECT_SEARCH_DEPTH` levels;
 *   5. an error naming the candidates / asking for `project_path`.
 *
 * Every branch validates before returning, so a wrong path fails here instead of
 * deriving a project key that silently matches no broker socket.
 */
export function resolveProjectRoot(projectPath, ctx = {}) {
  const cwd = sessionCwd(ctx) ?? process.cwd()
  const requested = typeof projectPath === 'string' ? projectPath.trim() : ''

  if (requested) {
    const root = normalizeProjectPath(requested, cwd)
    if (!isUnityProject(root)) {
      throw new Error(
        `project_path "${requested}" is not a Unity project (expected Assets/ and ProjectSettings/ in ${root}).`,
      )
    }
    return root
  }

  const config = findProjectConfig(cwd)
  if (config) {
    if (!isUnityProject(config.project)) {
      throw new Error(
        `${config.file} names project "${config.raw}", which is not a Unity project ` +
          `(expected Assets/ and ProjectSettings/ in ${config.project}).`,
      )
    }
    return config.project
  }

  if (isUnityProject(cwd)) return resolve(cwd)

  const found = findUnityProjects(cwd)
  if (found.length > 0) {
    // Only the shallowest tier is a real candidate set: a project three levels
    // down never beats one found closer to the working directory.
    const shallowest = found[0].depth
    const nearest = found.filter((candidate) => candidate.depth === shallowest)
    if (nearest.length === 1) return nearest[0].path
    throw new Error(
      `The working directory ${cwd} contains several Unity projects ${shallowest} level(s) down ` +
        `(${nearest.map((candidate) => candidate.path).join(', ')}); pick one with project_path, ` +
        `or record it once in ${join(cwd, PROJECT_CONFIG_FILES[0])} as {"project": "<name>"} ` +
        '(or name it in AGENTS.md) so later calls need no choice.',
    )
  }
  throw new Error(
    `The working directory ${cwd} is not a Unity project and has none within ${PROJECT_SEARCH_DEPTH} levels ` +
      'below it; pass project_path (the folder containing Assets/ and ProjectSettings/).',
  )
}

/**
 * Make `value` absolute against `cwd` and collapse `.`/`..`.
 *
 * Deliberately not `realpath()`: Unity derives the broker key from the path it
 * opened, so following a symlink could disagree with the editor.
 */
export function normalizeProjectPath(value, cwd) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  const raw = text === '.' ? cwd : isAbsoluteProjectPath(text) ? text : resolve(cwd, text)
  return isAbsolute(raw) ? resolve(raw) : raw
}

function sessionCwd(ctx) {
  try {
    const agent = ctx?.agent
    if (agent) {
      const live = ctx?.workingDirectory?.get?.(agent.session)
      if (live) return live
    }
    return agent?.session?.header?.cwd ?? null
  } catch {
    return null
  }
}

/** Normalize a code string: reject empty snippets and normalize newlines to LF. */
export function normalizeCode(code) {
  if (typeof code !== 'string' || code.trim().length === 0) {
    throw new Error('Missing required parameter: code (a non-empty C# method body).')
  }
  return code.replace(/\r\n/g, '\n')
}

/** Extract `maxMainThreadBlockedMs` from an execute progress snapshot. */
export function blockedMs(progress) {
  const value = Number(progress?.maxMainThreadBlockedMs)
  return Number.isFinite(value) ? value : 0
}
