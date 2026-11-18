// Watching a checkout for changes the language server has to hear about.
//
// Mirrors upstream's `start_file_watcher` (`csharp_lsp/mod.rs`): the server is
// told about `Assets/`, `Packages/` and the project files themselves, and it
// answers two questions that decide what a stale workspace looks like:
//
//   * a `.cs` file changed → the open copy the server holds is stale, so it is
//     re-opened (`textDocument/didOpen` again) or closed if the file is gone;
//   * a `.cs`/`.asmdef`/`.csproj`/`.sln` appeared, or the project files were
//     rewritten → the loaded solution may no longer describe the code at all,
//     so the workspace is reloaded.
//
// Upstream uses the `notify` crate with a debounced batch. Node has no portable
// recursive watcher guarantee (inotify watches are per-directory, and
// `recursive` is only reliable on macOS/Windows), so this module watches the
// three roots non-recursively plus every directory that holds a `.cs` file,
// capped per workspace. Missing a directory means "no live updates there"; the
// per-query staleness check in `refreshProjectFiles` still catches it, so a
// lost watch degrades latency, never correctness.

import { readdirSync, statSync, watch } from 'node:fs'
import { join } from 'node:path'

import { FILE_CHANGED, FILE_CREATED, FILE_DELETED } from './lsp-client.js'

/** Project inputs the server cares about. Upstream's `watched_extension` lists
 * `.cs`/`.csproj`/`.sln`; `.asmdef`/`.asmref` are added here because they move
 * files in and out of an assembly, which changes what the project files say.
 * `.props`/`.rsp` are deliberately absent: editing them is not something the
 * generated project set tracks, and the analyzer `Directory.Build.props` this
 * plugin writes itself would otherwise schedule a reload on every load. */
export const WATCHED_EXTENSIONS = ['.cs', '.csproj', '.sln', '.asmdef', '.asmref']
/** Directories watched per workspace. A larger project still gets the important
 * ones (the roots are always included) plus whatever the per-query staleness
 * check would have caught anyway. */
const MAX_WATCHED_DIRECTORIES = 256
/** Directory depth walked when collecting source folders. */
const MAX_WATCH_DEPTH = 8
/** Upstream's debounce window; a burst of writes (a prefab resave, an IDE
 * format-on-save) must become one notification, not dozens. */
export const WATCH_DEBOUNCE_MS = 250

/** Directories under `root` that can contain a watched file. */
export function watchedDirectories(root) {
  const dirs = []
  const seen = new Set()
  const add = (dir) => {
    const key = dir.replaceAll('\\', '/').replace(/\/+$/, '')
    if (seen.has(key) || dirs.length >= MAX_WATCHED_DIRECTORIES) return
    seen.add(key)
    dirs.push(dir)
  }
  const walk = (dir, depth) => {
    if (depth > MAX_WATCH_DEPTH) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    let holdsSource = false
    const subdirectories = []
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      const lower = entry.name.toLowerCase()
      if (entry.isDirectory()) {
        subdirectories.push(path)
        continue
      }
      if (!entry.isFile()) continue
      // A source directory is worth watching even if it only holds assets: a
      // new `.cs` can appear in it at any time.
      if (WATCHED_EXTENSIONS.some((extension) => lower.endsWith(extension))) holdsSource = true
    }
    if (depth === 0 || holdsSource) add(dir)
    for (const child of subdirectories) walk(child, depth + 1)
  }
  add(root)
  for (const folder of ['Assets', 'Packages']) walk(join(root, folder), 1)
  return dirs
}

/** The LSP change kind for one path event, or `null` when it is not project input. */
export function watchedChangeKind(root, filename, eventType, exists) {
  if (!filename) return null
  const lower = String(filename).toLowerCase()
  if (!WATCHED_EXTENSIONS.some((extension) => lower.endsWith(extension))) return null
  // Rename reports "the name went away"; `exists` distinguishes a rename away
  // from a rename into place (the latter arrives as its own 'rename' too).
  if (eventType === 'rename') return exists ? FILE_CREATED : FILE_DELETED
  return FILE_CHANGED
}

/**
 * Watch one workspace.
 *
 * @param {string} root absolute checkout root
 * @param {(changes: Array<[string, number]>) => void} onBatch debounced batch of `[path, kind]`
 * @returns {{ close: () => void, directories: number }}
 */
export function watchWorkspace(root, onBatch) {
  const handlers = []
  let pending = new Map()
  let timer = null
  const flush = () => {
    timer = null
    if (pending.size === 0) return
    const batch = [...pending]
    pending = new Map()
    try {
      onBatch(batch)
    } catch {
      // A failing consumer must not kill the watcher.
    }
  }
  const enqueue = (path, kind) => {
    if (kind === null) return
    // A create followed by a change collapses to a create: the server reloads
    // the document either way, and the earlier kind is the informative one.
    const previous = pending.get(path)
    pending.set(path, previous === FILE_CREATED ? FILE_CREATED : kind)
    if (timer) return
    timer = setTimeout(flush, WATCH_DEBOUNCE_MS)
    timer.unref?.()
  }
  const directories = watchedDirectories(root)
  for (const dir of directories) {
    try {
      const watcher = watch(dir, { persistent: false }, (eventType, filename) => {
        if (!filename) return
        const path = join(dir, String(filename))
        enqueue(path, watchedChangeKind(root, filename, eventType, isFile(path)))
      })
      watcher.on('error', () => {})
      handlers.push(watcher)
    } catch {
      // Directory vanished or the watch limit is exhausted; skip it.
    }
  }
  return {
    directories: directories.length,
    close() {
      if (timer) clearTimeout(timer)
      timer = null
      pending = new Map()
      for (const watcher of handlers) {
        try {
          watcher.close()
        } catch {
          // Already closed.
        }
      }
      handlers.length = 0
    },
  }
}

/** Whether `path` currently names a regular file. */
function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
