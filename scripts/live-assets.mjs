// Pick real assets out of a Unity project for the live Sidebar checks.
//
// The repository ships no fixture assets: `unity-test/` is a disposable local
// checkout (git-ignored) and may hold anything from a two-object sample to a
// full game. Both live scripts therefore *discover* what they need instead of
// naming it, so the same checks run against any project.
//
// Discovery is by suffix only and never edits or even opens a file; ordering is
// deterministic (shortest path first, then lexicographic) so a run is
// repeatable and the reported path is stable.

import { readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** Directory names a project never wants walked during discovery. */
const SKIP_DIRS = new Set(['Library', 'Temp', 'Logs', 'obj', 'Build', 'Builds', 'UserSettings', 'MemoryCaptures', 'Recordings'])

/**
 * Project-relative paths of files under `Assets/` whose suffix is in `suffixes`.
 *
 * @param projectRoot - Unity project root.
 * @param suffixes - lowercase suffixes without a dot (`prefab`, `asset`, …).
 * @param options.limit - stop after this many candidates (default 4000).
 * @returns paths in ascending (length, path) order; never throws on an unreadable subdirectory.
 */
export function findAssets(projectRoot, suffixes, { limit = 4000 } = {}) {
  const wanted = new Set(suffixes.map((suffix) => suffix.toLowerCase()))
  const found = []
  const walk = (dir) => {
    if (found.length >= limit) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= limit) return
      if (entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(full)
        continue
      }
      if (!entry.isFile()) continue
      const dot = entry.name.lastIndexOf('.')
      if (dot <= 0) continue
      if (!wanted.has(entry.name.slice(dot + 1).toLowerCase())) continue
      found.push({ full, path: relative(projectRoot, full).split(sep).join('/') })
    }
  }
  walk(join(projectRoot, 'Assets'))
  found.sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path))
  return found.map((entry) => entry.path)
}

/** First asset with any of `suffixes`, or null. */
export function pickAsset(projectRoot, suffixes, options) {
  return findAssets(projectRoot, suffixes, options)[0] ?? null
}

/**
 * The largest `.prefab` under a size cap.
 *
 * A property tree worth exercising has components; a 200-byte prefab is a
 * prefab-shaped stub. The cap keeps a 2 GB project's biggest prefab (a whole
 * level merged into one object) out of the HTTP body.
 *
 * @param projectRoot - Unity project root.
 * @param options.maxBytes - ignore anything larger (default 512 KiB).
 * @returns the chosen path, or null.
 */
export function pickRichPrefab(projectRoot, { maxBytes = 512 * 1024 } = {}) {
  const candidates = findAssets(projectRoot, ['prefab'], { limit: 800 })
  let best = null
  let bestSize = 0
  for (const path of candidates) {
    let size
    try {
      size = statSync(join(projectRoot, path)).size
    } catch {
      continue
    }
    if (size > maxBytes) continue
    if (size > bestSize) {
      best = path
      bestSize = size
    }
  }
  return best
}

/** A `.unity` scene that is safe to read (suffix only; the panel never writes one). */
export function pickScene(projectRoot) {
  return pickAsset(projectRoot, ['unity'])
}
