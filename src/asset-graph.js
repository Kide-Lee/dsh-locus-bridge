// Asset reference graph over the Locus bridge.
//
// Upstream Locus answers `unity_ref_search` / `unity_code_usages` from its Rust
// `asset_db` index (`src-tauri/src/asset_db/`), which this plugin does not have.
// Two broker commands were considered as substitutes and both fall short:
//
//   * `search_yaml` matches GameObject *names and hierarchy paths* only. Passing
//     a GUID as `query` always yields "Total matches: 0", which is why earlier
//     versions reported zero references for assets that plainly exist.
//   * `property_tree_discover` (what upstream's `unity_yaml_search` drives) does
//     walk scene properties and can match field values, but it compares
//     `displayValue` as a case-insensitive SUBSTRING. For an object reference
//     that display value is the asset path, not the GUID, so a script's attach
//     points can only be found by path — and only as a substring, where
//     `Probe.cs` also matches `MyProbe.cs`. Exact GUID identity is unavailable.
//
// These actions therefore run a compiled snippet over the open scenes instead:
// the GUID from the asset's `.meta` is compared against the `m_Script` /
// reference slots Unity actually serialized, which is what the desktop index
// answers without needing the index.
//
// That still only covers scenes that are OPEN, and the common question — "which
// assets reference this material" — is usually about a prefab nobody has open.
// So there is a second path: `src/asset-db.js` indexes the whole project from the
// `.meta` files on disk, and answers from the YAML itself when the target the
// caller named is not an open scene. Every result says which source it came from
// in `source`, because "no references" means something different when only the
// open scenes were searched.

import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { findScriptAttachments, scanAssets, searchAssets } from './asset-db.js'
import { lookupReferences } from './asset-index-sync.js'
import { withClient } from './client-pool.js'
import { csString } from './scene-set.js'
import { readYamlFile, queryDocument } from './yaml-lite.js'

const EXECUTE_TIMEOUT_MS = 120_000
const SEARCH_LIMIT_MAX = 500
const DEFAULT_LIMIT = 100

/** Where the snippet-based scan can look: Unity serializes references there. */
const YAML_EXTENSIONS = new Set(['.unity', '.prefab'])

/**
 * Unity YAML serializes a file reference as `m_Script: {fileID: 11500000, guid: <32 hex>, type: 3}`.
 * The GUID is what every lookup matches on, so it has to look like one.
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

/** Refuse a target the scene/prefab scan cannot read. */
export function assertSearchableAsset(projectRoot, assetPath) {
  const rel = projectRelative(projectRoot, assetPath)
  const extension = rel.slice(rel.lastIndexOf('.')).toLowerCase()
  if (!YAML_EXTENSIONS.has(extension)) {
    throw new Error(
      `${rel} is not a scene or prefab (${extension || 'no extension'}). ` +
        'Unity serializes references inside .unity and .prefab files.',
    )
  }
  return rel
}

/** Run one compiled snippet and return its printed text. */
async function runSnippet(target, code) {
  const envelope = await withClient(target, (client) =>
    client.call('execute_code', code, { timeoutMs: EXECUTE_TIMEOUT_MS }),
  )
  return envelope.message ?? ''
}

/**
 * Snippet that walks the loaded scenes and reports every object whose
 * `m_Script` (or, with `member`, whose named serialized field) points at `guid`.
 */
function attachPointBody({ guid, member, limit, scenePath }) {
  const sceneFilter = scenePath ? csString(scenePath) : 'null'
  const memberCheck = member
    ? `var field = serialized.FindProperty(${csString(member)});
      if (field == null) continue;
      if (field.propertyType == SerializedPropertyType.ObjectReference) {
        if (field.objectReferenceValue == null) continue;
        if (AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(field.objectReferenceValue)).ToLowerInvariant() != targetGuid) continue;
      } else {
        totalMemberUses++;
      }`
    : ''
  // No `wantedMember` variable: the member name only ever entered through
  // `memberCheck`, so carrying a separate binding served nothing — and its
  // `var wantedMember = null` form was CS0815 whenever `member` was absent,
  // which made every `usages` call without a member fail to compile.
  return `var targetGuid = ${csString(guid)};
string sceneFilter = ${sceneFilter};
var limit = ${limit};
var results = new List<Dictionary<string, object>>();
var totalAttach = 0;
var totalMemberUses = 0;
for (var s = 0; s < SceneManager.sceneCount; s++) {
  var scene = SceneManager.GetSceneAt(s);
  if (!scene.IsValid() || !scene.isLoaded) continue;
  if (sceneFilter != null && scene.path != sceneFilter) continue;
  foreach (var root in scene.GetRootGameObjects()) {
    foreach (var mono in root.GetComponentsInChildren<MonoBehaviour>(true)) {
      if (mono == null) continue;
      var script = MonoScript.FromMonoBehaviour(mono);
      if (script == null) continue;
      var scriptGuid = AssetDatabase.AssetPathToGUID(AssetDatabase.GetAssetPath(script));
      if (string.IsNullOrEmpty(scriptGuid) || scriptGuid.ToLowerInvariant() != targetGuid) continue;
      totalAttach++;
      var serialized = new SerializedObject(mono);
      ${memberCheck}
      if (results.Count < limit) {
        results.Add(new Dictionary<string, object> {
          { "scenePath", scene.path },
          { "objectPath", mono.gameObject.name },
          { "component", mono.GetType().Name },
          { "componentIndex", Array.IndexOf(mono.gameObject.GetComponents<Component>(), mono) }
        });
      }
    }
  }
}
printJson(new Dictionary<string, object> {
  { "attachPoints", totalAttach },
  ${member ? '{ "memberUses", totalMemberUses },' : ''}
  { "returned", results.Count },
  { "truncated", totalAttach > results.Count },
  { "results", results }
});`
}

/** Snippet that reports what one scene/prefab stores, by GUID. */
function outgoingBody({ filePath, limit }) {
  return `var path = ${csString(filePath)};
var limit = ${limit};
var found = new List<Dictionary<string, object>>();
var seen = new HashSet<string>();
for (var s = 0; s < SceneManager.sceneCount; s++) {
  var scene = SceneManager.GetSceneAt(s);
  if (!scene.IsValid() || !scene.isLoaded) continue;
  if (scene.path != path) continue;
  foreach (var root in scene.GetRootGameObjects()) {
    foreach (var component in root.GetComponentsInChildren<Component>(true)) {
      if (component == null) continue;
      if (found.Count >= limit) break;
      var serialized = new SerializedObject(component);
      var iterator = serialized.GetIterator();
      while (iterator.NextVisible(true)) {
        if (iterator.propertyType != SerializedPropertyType.ObjectReference) continue;
        var value = iterator.objectReferenceValue;
        if (value == null) continue;
        var assetPath = AssetDatabase.GetAssetPath(value);
        if (string.IsNullOrEmpty(assetPath)) continue;
        if (!seen.Add(assetPath)) continue;
        if (found.Count >= limit) break;
        found.Add(new Dictionary<string, object> {
          { "objectPath", root.name }, { "component", component.GetType().Name },
          { "property", iterator.propertyPath }, { "assetPath", assetPath }
        });
      }
    }
  }
}
printJson(new Dictionary<string, object> { { "searched", path }, { "count", found.Count }, { "dependencies", found } });`
}

function formatAttachPoints(text, { guid, member, searched, script }) {
  let parsed
  try {
    parsed = JSON.parse(text.trim())
  } catch {
    return text
  }
  const heading = member
    ? `Serialized uses of "${member}" from ${script} inside ${searched} (guid ${guid}):`
    : `Attach points of ${script} inside ${searched} (guid ${guid}):`
  const lines = [heading]
  lines.push(
    member
      ? `${parsed.attachPoints ?? 0} attach point(s); ${parsed.memberUses ?? 0} object reference(s) pointing at this script.`
      : `${parsed.attachPoints ?? 0} attach point(s).`,
  )
  for (const entry of parsed.results ?? []) {
    lines.push(`- ${entry.scenePath} :: ${entry.objectPath} (${entry.component}, component ${entry.componentIndex})`)
  }
  if (parsed.truncated) lines.push(`… more attach points hidden by limit ${DEFAULT_LIMIT}.`)
  if ((parsed.attachPoints ?? 0) === 0) lines.push('No object in the searched scope carries this script.')
  return lines.join('\n')
}

/**
 * Find the assets that reference `assetPath`, or the assets it depends on.
 *
 * Incoming edges come from the asset's GUID appearing in another scene or
 * prefab. `filePath` names the scene/prefab to search inside; a project-wide
 * scan is not available through the broker.
 */
export async function findReferences(target, projectRoot, { assetPath, direction = 'references', filePath, limit }) {
  const guid = readAssetGuid(projectRoot, assetPath)
  const size = clampLimit(limit)
  if (direction === 'dependencies') {
    const searched = assertSearchableAsset(projectRoot, filePath ?? assetPath)
    const text = await runSnippet(target, outgoingBody({ filePath: searched, limit: size }))
    let parsed
    try {
      parsed = JSON.parse(text.trim())
    } catch {
      return { guid: null, direction, source: 'open-scene', searched, guids: [], results: text }
    }
    const lines = [`Assets ${searched} depends on (${parsed.count ?? 0}):`]
    for (const entry of parsed.dependencies ?? []) {
      lines.push(`- ${entry.assetPath} ← ${entry.objectPath}.${entry.component}.${entry.property}`)
    }
    if ((parsed.count ?? 0) === 0) lines.push('No outgoing asset references were found in the open scene.')
    return { guid: null, direction, source: 'open-scene', searched, guids: [], results: lines.join('\n') }
  }
  if (!filePath) {
    // No scene named: answer from the on-disk index instead of refusing. This is
    // the common case ("what uses this material?") and does not need the Editor.
    return { guid, direction, source: 'project', ...(await projectReferences(projectRoot, assetPath, guid, size)) }
  }
  const searched = assertSearchableAsset(projectRoot, filePath)
  const text = await runSnippet(target, attachPointBody({ guid, member: null, limit: size, scenePath: searched }))
  return {
    guid,
    direction,
    source: 'open-scene',
    searched,
    results: formatAttachPoints(text, { guid, member: null, searched, script: projectRelative(projectRoot, assetPath) }),
  }
}

/**
 * Find serialized uses of a C# script: its attach points (`m_Script` GUID
 * matches) and, with `member`, the serialized fields inside them.
 */
export async function findCodeUsages(target, projectRoot, { filePath, member, limit, scenePath }) {
  const guid = readAssetGuid(projectRoot, filePath)
  const size = clampLimit(limit)
  if (!scenePath) {
    return {
      guid,
      source: 'project',
      script: projectRelative(projectRoot, filePath),
      member: member ?? null,
      ...(await projectScriptUsages(projectRoot, filePath, guid, member, size)),
    }
  }
  const searched = assertSearchableAsset(projectRoot, scenePath)
  const text = await runSnippet(target, attachPointBody({ guid, member, limit: size, scenePath: searched }))
  return {
    guid,
    source: 'open-scene',
    searched,
    script: projectRelative(projectRoot, filePath),
    member: member ?? null,
    results: formatAttachPoints(text, { guid, member: member ?? null, searched, script: projectRelative(projectRoot, filePath) }),
  }
}

// ─── project-wide answers (no Editor needed) ────────────────────────────────

/**
 * Which assets reference `assetPath`'s GUID, read from the YAML on disk.
 *
 * A reference inside a scene or prefab is a `{fileID: …, guid: <32 hex>}` map in
 * the file, so the answer is "which YAML files mention this GUID". That covers
 * every file in `Assets/` and `Packages/`, not just the open scenes, and it works
 * with the Editor closed.
 */
async function projectReferences(projectRoot, assetPath, guid, limit) {
  const wanted = guid.toLowerCase()
  const index = await scanAssets(projectRoot)
  const matches = []
  let truncated = false
  // The durable index records one row per `{fileID, guid}` mapping while the
  // project is walked, so this is a table lookup rather than "read every YAML
  // file and search for the GUID". It falls back to the scan's bindings when
  // `node:sqlite` is unavailable, which keeps the answer correct either way.
  const looked = lookupReferences(projectRoot, wanted, { limit })
  let rows = looked.references
  if (!looked.available) {
    rows = []
    for (const entry of index.assets) {
      if (!YAML_EXTENSIONS.has(entry.ext) && entry.ext !== '.asset' && entry.ext !== '.mat') continue
      if (!mentionsGuid(projectRoot, entry, wanted)) continue
      rows.push({ path: entry.path })
    }
  }
  const seen = new Set()
  for (const row of rows) {
    if (seen.has(row.path)) continue
    seen.add(row.path)
    if (matches.length >= limit) {
      truncated = true
      break
    }
    matches.push(row.path)
  }
  const target = projectRelative(projectRoot, assetPath)
  const lines = [`Assets that reference ${target} (guid ${wanted}), read from the project YAML on disk:`]
  if (matches.length === 0) {
    lines.push(`- none. ${index.scannedFiles} file(s) were indexed${index.partial ? ' (partial scan: budget exceeded)' : ''}.`)
  } else {
    for (const path of matches) lines.push(`- ${path}`)
  }
  if (truncated) lines.push(`… more than ${limit} referencing assets; raise limit to see them.`)
  lines.push(
    looked.available
      ? 'source: project index (durable reference table; works with the Editor closed).'
      : `source: project index (file scan; durable index unavailable: ${looked.unavailable ?? 'unknown'}).`,
  )
  return { paths: matches, total: matches.length, truncated, results: lines.join('\n') }
}

/** Whether one indexed YAML asset mentions a GUID token. */
function mentionsGuid(projectRoot, entry, guid) {
  let file
  try {
    file = readYamlFile(projectRoot, entry.path)
  } catch {
    return false
  }
  const needle = `guid: ${guid}`
  return file.text.toLowerCase().includes(needle)
}

/**
 * The objects carrying a script, from the project index, plus its call sites.
 *
 * `src/asset-db.js` already indexes `m_Script` GUIDs while scanning; this only
 * renders them the way the open-scene path does, so a caller gets the same shape
 * whether or not the Editor is running.
 */
async function projectScriptUsages(projectRoot, filePath, guid, member, limit) {
  const attachments = await findScriptAttachments(projectRoot, { scriptGuid: guid, limit })
  const script = projectRelative(projectRoot, filePath)
  const heading = member
    ? `Serialized uses of "${member}" from ${script} (guid ${guid}), read from the project YAML on disk:`
    : `Attach points of ${script} (guid ${guid}), read from the project YAML on disk:`
  let lines = [heading]
  if (attachments.attachments.length === 0) {
    lines.push(`- none. ${script} is not attached in any scene or prefab on disk.`)
  } else {
    for (const row of attachments.attachments) lines.push(`- ${row.assetPath}`)
    if (attachments.truncated) lines.push(`… more than ${limit} asset(s); raise limit to see them.`)
  }
  if (member) {
    const fields = await projectFields(projectRoot, guid, member, limit)
    if (fields.length > 0) {
      lines.push(`Objects that serialize a "${member}" field while carrying ${script}:`)
      for (const field of fields) lines.push(`- ${field.assetPath} :: ${field.objectName} (fileID ${field.fileId})`)
    }
  }
  lines.push('source: project index (works with the Editor closed; open scenes were not consulted).')
  lines = lines.filter((line) => line !== undefined)
  return { searched: null, paths: attachments.attachments.map((row) => row.assetPath), member, results: lines.join('\n') }
}

/**
 * Documents carrying the script that also serialize a field named `member`.
 *
 * The field is found in the YAML itself, which answers "is this serialized value
 * actually used anywhere" without loading the scene.
 */
async function projectFields(projectRoot, guid, member, limit) {
  const index = await scanAssets(projectRoot)
  const found = []
  for (const binding of index.memberBindings) {
    if (binding.scriptGuid !== guid || binding.kind !== 'script') continue
    if (found.length >= limit) break
    let file
    try {
      file = readYamlFile(projectRoot, binding.assetPath)
    } catch {
      continue
    }
    const document = file.documents.find((candidate) => candidate.fileId === binding.fileId)
    if (document === undefined) continue
    const node = queryDocument(document, `/${member}`)
    if (node == null) continue
    found.push({ assetPath: binding.assetPath, objectName: binding.className, fileId: binding.fileId })
  }
  return found
}

function clampLimit(limit) {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMIT_MAX) {
    throw new Error(`limit must be an integer in 1..${SEARCH_LIMIT_MAX}.`)
  }
  return limit
}

export { SEARCH_LIMIT_MAX, DEFAULT_LIMIT, YAML_EXTENSIONS }
