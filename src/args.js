// Tool argument normalization shared by all Locus tools.

import { isAbsolute, resolve } from 'node:path'

/** Windows drive / UNC paths are absolute even when the host is Linux or macOS. */
export function isAbsoluteProjectPath(value) {
  return isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]/.test(value)
}

/**
 * Resolve the Unity project root for a call.
 *
 * Precedence: explicit `project_path` → the Session's working directory
 * (`ctx.workingDirectory`, which follows `working_directory` calls; falls back
 * to the Session header cwd) → the process cwd.
 */
export function resolveProjectRoot(projectPath, ctx = {}) {
  const cwd = sessionCwd(ctx)
  if (projectPath && projectPath.trim()) {
    const value = projectPath.trim()
    if (value === '.') return cwd ?? process.cwd()
    if (isAbsoluteProjectPath(value)) return value
    return resolve(cwd ?? process.cwd(), value)
  }
  return cwd ?? process.cwd()
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
