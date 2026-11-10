// Asset reference graph over the Locus bridge.
//
// Upstream Locus answers `unity_ref_search` / `unity_code_usages` from its Rust
// `asset_db` index (`src-tauri/src/asset_db/`), which this plugin does not have.
// The broker's `search_yaml` is NOT a substitute for that index: it matches
// GameObject *names and hierarchy paths* only. Passing a GUID as `query` always
// yields "Total matches: 0", which is why earlier versions of this module
// reported zero references for assets that plainly exist.
//
// These actions therefore run a compiled snippet over the open scenes instead:
// the GUID from the asset's `.meta` is compared against the `m_Script` /
// reference slots Unity actually serialized, which is what the desktop index
// answers without needing the index.

import { readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { withClient } from './client-pool.js'
import { csString } from './scene-set.js'

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
  return `var targetGuid = ${csString(guid)};
var wantedMember = ${member ? csString(member) : 'null'};
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
      return { guid: null, direction, searched, guids: [], results: text }
    }
    const lines = [`Assets ${searched} depends on (${parsed.count ?? 0}):`]
    for (const entry of parsed.dependencies ?? []) {
      lines.push(`- ${entry.assetPath} ← ${entry.objectPath}.${entry.component}.${entry.property}`)
    }
    if ((parsed.count ?? 0) === 0) lines.push('No outgoing asset references were found in the open scene.')
    return { guid: null, direction, searched, guids: [], results: lines.join('\n') }
  }
  if (!filePath) {
    throw new Error(
      `references needs the scene or prefab to search inside, because the scan covers open scenes one at a time and ` +
        `has no project-wide mode. Pass file_path for example Assets/Scenes/Main.unity; ` +
        `${projectRelative(projectRoot, assetPath)} contributes its GUID (${guid}).`,
    )
  }
  const searched = assertSearchableAsset(projectRoot, filePath)
  const text = await runSnippet(target, attachPointBody({ guid, member: null, limit: size, scenePath: searched }))
  return { guid, direction, searched, results: formatAttachPoints(text, { guid, member: null, searched, script: projectRelative(projectRoot, assetPath) }) }
}

/**
 * Find serialized uses of a C# script: its attach points (`m_Script` GUID
 * matches) and, with `member`, the serialized fields inside them.
 */
export async function findCodeUsages(target, projectRoot, { filePath, member, limit, scenePath }) {
  const guid = readAssetGuid(projectRoot, filePath)
  if (!scenePath) {
    throw new Error(
      `usages needs the scene or prefab to search inside, since the scan covers open scenes one at a time. ` +
        `Pass file_path (the scene/prefab) for example Assets/Scenes/Main.unity; ${projectRelative(projectRoot, filePath)} ` +
        `itself only contributes its GUID (${guid}).`,
    )
  }
  const searched = assertSearchableAsset(projectRoot, scenePath)
  const size = clampLimit(limit)
  const text = await runSnippet(target, attachPointBody({ guid, member, limit: size, scenePath: searched }))
  return {
    guid,
    searched,
    script: projectRelative(projectRoot, filePath),
    member: member ?? null,
    results: formatAttachPoints(text, { guid, member: member ?? null, searched, script: projectRelative(projectRoot, filePath) }),
  }
}

function clampLimit(limit) {
  if (limit === undefined || limit === null) return DEFAULT_LIMIT
  if (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMIT_MAX) {
    throw new Error(`limit must be an integer in 1..${SEARCH_LIMIT_MAX}.`)
  }
  return limit
}

export { SEARCH_LIMIT_MAX, DEFAULT_LIMIT, YAML_EXTENSIONS }
