// Which Unity project a tool call targets.
//
// Precedence (highest first):
//   1. an explicit `project_path` argument;
//   2. the Session cwd when it is a Unity project;
//   3. the shallowest Unity project found within `PROJECT_SEARCH_DEPTH` levels,
//      which covers a repository whose project sits in a subdirectory;
//   4. an error that lists the candidates.
//
// There is deliberately no recorded-project file: workspace instructions
// (AGENTS.md and friends) already tell the model which project a repository
// drives, and an explicit `project_path` is how that choice becomes concrete.
// A second, machine-readable copy would only be able to contradict the prose.

import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

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
 * Resolve the Unity project root for a call.
 *
 * Precedence:
 *   1. explicit `project_path`;
 *   2. the Session cwd when it already is a Unity project;
 *   3. the shallowest Unity project within `PROJECT_SEARCH_DEPTH` levels below
 *      the cwd, then below each ancestor up to the repository root — covering a
 *      session that starts inside `src/` or inside the project itself;
 *   4. an error naming the candidates / asking for `project_path`.
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
        `(${nearest.map((candidate) => candidate.path).join(', ')}); pass project_path to choose one.`,
    )
  }
  // Nothing below the cwd: a session started inside a subdirectory of the
  // repository (`src/`, or the project's own `Assets/`) should still find the
  // project its repository drives, so look below each ancestor in turn.
  for (const ancestor of ancestors(cwd)) {
    const up = findUnityProjects(ancestor, { maxDepth: 1 })
    if (up.length === 1) return up[0].path
    if (up.length > 1) break
  }

  throw new Error(
    `The working directory ${cwd} is not a Unity project and has none within ${PROJECT_SEARCH_DEPTH} levels ` +
      'below it or beside its ancestors; pass project_path (the folder containing Assets/ and ProjectSettings/).',
  )
}

/**
 * Parent directories of `dir`, nearest first, stopping below the repository root
 * (the directory holding `.git`) so a search never escapes the project.
 */
function ancestors(dir) {
  const chain = []
  let current = resolve(dir)
  for (;;) {
    const parent = dirname(current)
    if (parent === current) break
    chain.push(parent)
    if (existsSync(join(parent, '.git'))) break
    current = parent
  }
  return chain
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
