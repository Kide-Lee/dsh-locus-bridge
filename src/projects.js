// Which Unity projects this machine has, and which of them the bridge can reach.
//
// Three states the settings page has to tell apart, in the order they occur:
//
//   plugin_missing   the project has no Locus Unity package (or an incomplete one)
//   not_connected    the package is installed, but nothing is listening on the
//                    broker endpoint this project derives
//   connected        the endpoint exists and answers
//
// Deliberately *not* "is the editor open": `not_connected` covers both "no editor"
// and "editor running without the native bridge", and those need different
// advice. `editorRunning` is reported beside the state for exactly that reason.
//
// ## Why the candidate list is what it is
//
// There is no reliable way to enumerate *running* Unity editors on Windows:
// process command lines need elevation we do not have, and `Editor.log` only
// remembers the last project opened. So the list is derived from what can be
// observed — Unity projects found under the given roots, each probed for
// `Temp/UnityLockfile` — plus any project the caller adds explicitly. Every row
// is a fact about a real directory, never a guess.

import { readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { isUnityProject } from './args.js'
import { inspectSetup } from './setup.js'
import { normalizePipeName, resolvePipeName } from './pipe-name.js'
import { probeEndpoint } from './endpoint.js'

/** How deep below a root the candidate scan looks. Matches `args.js`. */
const SEARCH_DEPTH = 3

/** Rows are cheap filesystem probes, but a huge workspace must not stall a page. */
const MAX_CANDIDATES = 24

/**
 * The state one project is in, as a small closed set.
 *
 * The order of the checks is the story: an install problem makes the endpoint
 * question moot, and a reachable endpoint is proof the install worked whether or
 * not every assembly could be found on disk.
 */
export const PROJECT_STATES = Object.freeze(['connected', 'not_connected', 'plugin_missing'])

/**
 * One project's bridge state.
 *
 * `blockers` carries the setup codes so the page can explain *why* a project is
 * `plugin_missing` (absent vs. incomplete vs. legacy path) instead of showing one
 * undifferentiated badge.
 */
export async function describeProject(projectRoot, { env = process.env, timeoutMs = 1500, open } = {}) {
  const root = resolve(String(projectRoot))
  if (!isUnityProject(root)) {
    throw new Error(`${root} is not a Unity project (expected Assets/ and ProjectSettings/).`)
  }
  // `open` is injected only by tests: the editor's exclusive lock cannot be
  // reproduced in-process on POSIX, so a fixture needs a stand-in syscall.
  const setup = inspectSetup(root, { env, open })
  const endpoint = setup.endpoint ? normalizePipeName(setup.endpoint) : null
  // The probe answers "is something listening", which is the only honest test of
  // "connected": a package on disk proves an install, not a running broker.
  const listening = endpoint ? await probeEndpoint(endpoint, { timeoutMs }) : false

  const packageReady = setup.package !== null && setup.package.missingAssemblies.length === 0
  let state
  if (listening) {
    // A reachable broker outranks a filesystem complaint: the package is
    // demonstrably working, whatever the assembly scan could not find.
    state = 'connected'
  } else if (!packageReady) {
    state = 'plugin_missing'
  } else {
    state = 'not_connected'
  }

  return {
    projectRoot: root,
    name: basename(root),
    state,
    endpoint,
    // Both matter for the "not_connected" explanation, and they are different
    // facts: the editor may be closed, or open with the bridge switched off.
    editorRunning: setup.editorRunning === true,
    markerPresent: setup.marker.present === true,
    markerFromEnv: setup.marker.envOverride === true,
    package: setup.package
      ? {
          installed: true,
          version: setup.package.version ?? null,
          relativeRoot: setup.package.relativeRoot ?? null,
          missingAssemblies: setup.package.missingAssemblies ?? [],
        }
      : { installed: false },
    blockers: setup.problems.map((problem) => problem.code),
    // Only a missing package is installable by this plugin. An incomplete one
    // needs a reinstall, which the same button performs.
    canInstall: setup.payload.available === true && (!packageReady || setup.problems.some((p) => p.code === 'package_incomplete')),
    payloadAvailable: setup.payload.available === true,
    payloadVersion: setup.payload.version ?? null,
  }
}

/**
 * Every Unity project worth listing under `roots`.
 *
 * Bounded on purpose: a monorepo with dozens of checkouts must not turn a
 * settings page into a disk walk. Deduplicated by real path so a project found
 * from two roots appears once.
 */
export function listProjectCandidates(roots, { maxDepth = SEARCH_DEPTH, limit = MAX_CANDIDATES } = {}) {
  const seen = new Map()
  for (const raw of roots ?? []) {
    if (!raw) continue
    let start
    try {
      start = resolve(String(raw))
      if (!statSync(start).isDirectory()) continue
    } catch {
      continue
    }
    for (const found of scan(start, maxDepth)) {
      if (seen.has(found.path)) continue
      seen.set(found.path, found)
      if (seen.size >= limit) return [...seen.keys()].sort()
    }
  }
  return [...seen.keys()].sort()
}

/** Breadth-first scan, recording shallow hits before deep ones. */
function scan(dir, maxDepth) {
  const found = []
  let frontier = [{ path: dir, depth: 0 }]
  while (frontier.length > 0) {
    const next = []
    for (const node of frontier) {
      if (isUnityProject(node.path)) {
        found.push({ path: node.path, depth: node.depth })
        continue
      }
      if (node.depth >= maxDepth) continue
      let entries
      try {
        entries = readdirSync(node.path, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        // The same exclusions `args.js` uses: a Unity `Library/` is tens of
        // thousands of files, and none of them is a project.
        if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP.has(entry.name)) continue
        next.push({ path: join(node.path, entry.name), depth: node.depth + 1 })
      }
    }
    frontier = next
  }
  return found
}

const SKIP = new Set([
  'node_modules',
  'Library',
  'Temp',
  'obj',
  'Obj',
  'Build',
  'Builds',
  'Logs',
  'UserSettings',
  'MemoryCaptures',
  'Recordings',
  'target',
  'dist',
])

export { resolvePipeName }