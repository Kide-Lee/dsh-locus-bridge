// Asset reference graph over the Locus bridge.
//
// Upstream Locus answers `unity_ref_search` / `unity_code_usages` from its Rust
// `asset_db` index (`src-tauri/src/asset_db/`), which this plugin does not have.
// The broker still ships the same query surface underneath: `search_yaml` reads
// scenes and prefabs through Unity's own serialization and matches on component
// type, field name, or field value. Both tools are built on it:
//
//   unity_ref_search   An asset file is referenced by other assets through a
//                      GUID literal. Reading the file's own .meta gives that
//                      GUID, then matching it as a field value finds every
//                      prefab/scene that stores it — the same incoming-edge
//                      answer the index gives, without an index.
//   unity_code_usages  A .cs file's .meta GUID is what every MonoBehaviour
//                      attach point stores in `m_Script`. Matching that GUID as
//                      a component filter finds the attach points; matching a
//                      field name inside them finds serialized member uses.

import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { withClient } from './client-pool.js'

const YAML_TIMEOUT_MS = 180_000
const SEARCH_LIMIT_MAX = 500
const DEFAULT_LIMIT = 100

/** Where the broker's YAML tools look; anything else is refused before a round trip. */
const YAML_EXTENSIONS = new Set(['.unity', '.prefab'])

/**
 * Unity YAML serializes a file reference as `m_Script: {fileID: 11500000, guid: <32 hex>, type: 3}`.
 * The GUID is what both tools match on, so it has to look like one before a search.
 */
const GUID_PATTERN = /^[0-9a-f]{32}$/i

/** Read the GUID a Unity `.meta` file assigns to its asset. */
export function readAssetGuid(projectRoot, assetPath) {
  const absolute = resolveAssetPath(projectRoot, assetPath)
  let text
  try {
    text = readFileSync(`${absolute}.meta`, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(
        `${assetPath} has no .meta file, so it has no GUID for other assets to reference. ` +
          'Unity writes .meta files on import; make sure the asset is inside Assets/.',
      )
    }
    throw error
  }
  const match = /^guid:\s*([0-9a-f]{32})\s*$/im.exec(text)
  if (!match || !GUID_PATTERN.test(match[1])) {
    throw new Error(`The .meta file of ${assetPath} does not declare a guid; re-import the asset in Unity.`)
  }
  return match[1].toLowerCase()
}

/**
 * Resolve a project-relative or absolute asset path and refuse anything outside
 * the project, because the GUID lives in a `.meta` beside the asset.
 */
export function resolveAssetPath(projectRoot, assetPath) {
  const text = String(assetPath ?? '').trim()
  if (!text) throw new Error('asset path is required, for example Assets/Prefabs/Player.prefab.')
  const absolute = isAbsolute(text) ? resolve(text) : resolve(projectRoot, text)
  const root = resolve(projectRoot)
  const rel = relative(root, absolute)
  if (rel.startsWith('..') || rel.split(sep).includes('..')) {
    throw new Error(`${assetPath} is outside the Unity project ${root}.`)
  }
  return absolute
}

/** The project-relative form the broker expects (forward slashes). */
export function projectRelative(projectRoot, assetPath) {
  return relative(resolve(projectRoot), resolveAssetPath(projectRoot, assetPath)).split(sep).join('/')
}

/** Refuse a target the broker's YAML tools cannot read. */
export function assertSearchableAsset(projectRoot, assetPath) {
  const rel = projectRelative(projectRoot, assetPath)
  const extension = rel.slice(rel.lastIndexOf('.')).toLowerCase()
  if (!YAML_EXTENSIONS.has(extension)) {
    throw new Error(
      `${rel} is not a scene or prefab (${extension || 'no extension'}). ` +
        'Unity only serializes references inside .unity and .prefab files through the bridge.',
    )
  }
  return rel
}

function buildSearchRequest({ filePath, query, componentFilter, matchFields, limit }) {
  const request = { file_path: filePath }
  if (query) request.query = query
  if (componentFilter) request.component_filter = componentFilter
  if (matchFields) request.match_fields = matchFields
  if (limit !== undefined) request.limit = limit
  return JSON.stringify(request)
}

/** Run one `search_yaml` and return its text answer (the broker already renders it). */
export async function searchYaml(target, request, { signal } = {}) {
  if (signal?.aborted) throw new Error('cancelled')
  return withClient(target, (client) => client.call('search_yaml', request, { timeoutMs: YAML_TIMEOUT_MS }))
    .then((envelope) => envelope.message ?? '')
}

/**
 * Find the assets that reference `assetPath`, or the assets it depends on.
 *
 * Incoming edges come from the asset's GUID appearing as a value in another
 * scene or prefab, so a `filePath` is required: the bridge searches one
 * `.unity` or `.prefab` at a time and has no project-wide scan. Outgoing edges
 * are read from the asset itself when it is a scene or prefab.
 */
export async function findReferences(target, projectRoot, { assetPath, direction = 'references', filePath, limit }) {
  const guid = readAssetGuid(projectRoot, assetPath)
  const size = clampLimit(limit)
  if (direction === 'dependencies') {
    const searched = assertSearchableAsset(projectRoot, filePath ?? assetPath)
    return readOutgoing(target, searched, size)
  }
  if (!filePath) {
    throw new Error(
      `references needs the scene or prefab to search inside, because the bridge searches one .unity or .prefab at ` +
        `a time and has no project-wide scan. Pass file_path for example Assets/Scenes/Main.unity; ` +
        `${projectRelative(projectRoot, assetPath)} contributes its GUID (${guid}).`,
    )
  }
  const searched = assertSearchableAsset(projectRoot, filePath)
  return { guid, direction, searched, results: await searchForGuid(target, searched, guid, size) }
}

/**
 * A GUID literal is matched with `match_fields` left open, because the field
 * that stores it differs per asset type (`m_Script`, `m_Material`, an array slot).
 */
async function searchForGuid(target, filePath, guid, limit) {
  const request = buildSearchRequest({ filePath, query: guid, limit })
  return searchYaml(target, request)
}

/** Outgoing edges: every GUID this asset stores, mapped back to each target's path. */
async function readOutgoing(target, filePath, limit) {
  const request = JSON.stringify({ file_path: filePath, max_depth: 6, max_array_items: 200, limit })
  const text = await searchYaml(target, request)
  const guids = [...new Set((text.match(/\b[0-9a-f]{32}\b/gi) ?? []).map((value) => value.toLowerCase()))]
  return { guid: null, direction: 'dependencies', searched: filePath, guids, results: text }
}

/**
 * Find serialized uses of a C# script: its attach points (`m_Script` GUID
 * matches) and, with `member`, the serialized fields inside them.
 *
 * The script file itself is not searchable — `search_yaml` reads scenes and
 * prefabs — so `file_path` is the scene or prefab to search *within*, and the
 * script contributes only its GUID. Without `file_path` the tool cannot cover
 * the whole project, because the bridge has no command that searches every
 * asset at once; the caller has to name the scene or prefab to look in.
 */
export async function findCodeUsages(target, projectRoot, { filePath, member, limit, scenePath }) {
  const guid = readAssetGuid(projectRoot, filePath)
  if (!scenePath) {
    throw new Error(
      `usages needs the scene or prefab to search inside, since the bridge only searches one .unity or .prefab at ` +
        `a time. Pass scene_path for example Assets/Scenes/Main.unity; ${projectRelative(projectRoot, filePath)} itself ` +
        `only contributes its GUID (${guid}).`,
    )
  }
  const searched = assertSearchableAsset(projectRoot, scenePath)
  const size = clampLimit(limit)
  const request = buildSearchRequest({
    filePath: searched,
    query: member ? undefined : guid,
    matchFields: member,
    limit: size,
  })
  const text = await searchYaml(target, request)
  return { guid, searched, script: projectRelative(projectRoot, filePath), member: member ?? null, results: text }
}

function clampLimit(limit) {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMIT_MAX) {
    throw new Error(`limit must be an integer in 1..${SEARCH_LIMIT_MAX}.`)
  }
  return limit
}

export { SEARCH_LIMIT_MAX, DEFAULT_LIMIT, YAML_EXTENSIONS }
