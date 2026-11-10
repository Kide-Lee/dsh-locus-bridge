// Tool argument normalization shared by all Locus tools.
//
// Project resolution mirrors the Locus desktop client rather than blindly
// trusting a process cwd:
//   * `unity_bridge::is_unity_project` treats a directory as a Unity project
//     only when it holds both `Assets/` and `ProjectSettings/`;
//   * `cli_driver::resolve_project_path` fails with an explicit error when no
//     project is named instead of inventing one.
// The one deliberate difference is the fallback: a DSH Session rarely starts in
// the Unity project, so when the Session cwd is not one we look one level deep
// and accept an unambiguous hit. Everything else (validate, then derive) matches.

import { readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

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

/** Direct child directories of `dir` that are Unity projects (dot dirs skipped). */
export function unityProjectChildren(dir) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => join(dir, entry.name))
    .filter(isUnityProject)
}

/**
 * Resolve the Unity project root for a call.
 *
 * Precedence:
 *   1. explicit `project_path` (absolute, or relative to the Session cwd);
 *   2. the Session working directory when it already is a Unity project;
 *   3. the single Unity project one level below the Session working directory;
 *   4. an error naming the candidates / asking for `project_path`.
 *
 * Every branch validates before returning, so a wrong path fails here instead of
 * deriving a project key that silently matches no broker socket.
 */
export function resolveProjectRoot(projectPath, ctx = {}) {
  const cwd = sessionCwd(ctx) ?? process.cwd()
  const requested = typeof projectPath === 'string' ? projectPath.trim() : ''

  if (requested) {
    // `resolve()` collapses `.`/`..` but deliberately does not follow symlinks:
    // Unity derives the project key from the path it opened, so a realpath()
    // here could disagree with the editor for projects opened through a link.
    const raw = requested === '.' ? cwd : isAbsoluteProjectPath(requested) ? requested : resolve(cwd, requested)
    const root = isAbsolute(raw) ? resolve(raw) : raw
    if (!isUnityProject(root)) {
      throw new Error(
        `project_path "${requested}" is not a Unity project (expected Assets/ and ProjectSettings/ in ${root}).`,
      )
    }
    return root
  }

  if (isUnityProject(cwd)) return resolve(cwd)

  const found = unityProjectChildren(cwd)
  if (found.length === 1) return found[0]
  if (found.length > 1) {
    throw new Error(
      `The working directory ${cwd} contains several Unity projects (${found.join(', ')}); ` +
        'pass project_path to choose one.',
    )
  }
  throw new Error(
    `The working directory ${cwd} is not a Unity project and has no Unity project directly inside it; ` +
      'pass project_path (the folder containing Assets/ and ProjectSettings/).',
  )
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
