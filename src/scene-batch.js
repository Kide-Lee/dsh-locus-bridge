// C# snippet sources for the scene capabilities the broker has no command for.
//
// Same contract as `scene-set.js`: the text below is compiled and run as one
// method body by `execute_code`, and user text only ever enters as a C# string
// literal. Three operations live here:
//
//   find-components  list the objects that carry a component type (the broker's
//                    `search_scene_objects` only matches names and paths, so a
//                    type filter has to walk the hierarchy itself).
//   batch            apply many field writes in one undo group, then save the
//                    touched scenes once — one transaction instead of N round trips.
//   undo-batch       revert those writes from a token the batch returned, so a
//                    half-applied edit is recoverable without the user's Ctrl+Z.

import { csString } from './scene-set.js'

/** Writes accepted in one batch; each is one SerializedProperty operation. */
const BATCH_LIMIT = 200

/** The scalar readers/writers shared with the scene setter. */
const VALUE_HELPERS = `object ReadValue(SerializedProperty p) {
  if (p.isArray && p.propertyType != SerializedPropertyType.String) return "array[" + p.arraySize + "]";
  switch (p.propertyType) {
    case SerializedPropertyType.Integer: case SerializedPropertyType.LayerMask: case SerializedPropertyType.Character: return p.longValue;
    case SerializedPropertyType.Enum: return p.enumValueIndex;
    case SerializedPropertyType.Boolean: return p.boolValue;
    case SerializedPropertyType.Float: return p.doubleValue;
    case SerializedPropertyType.String: return p.stringValue;
    case SerializedPropertyType.Color: { var c = p.colorValue; return "#" + ColorUtility.ToHtmlStringRGBA(c); }
    case SerializedPropertyType.Vector2: { var v = p.vector2Value; return v.x + "," + v.y; }
    case SerializedPropertyType.Vector3: { var v = p.vector3Value; return v.x + "," + v.y + "," + v.z; }
    case SerializedPropertyType.Vector4: { var v = p.vector4Value; return v.x + "," + v.y + "," + v.z + "," + v.w; }
    case SerializedPropertyType.Quaternion: { var q = p.quaternionValue; return q.x + "," + q.y + "," + q.z + "," + q.w; }
    case SerializedPropertyType.Rect: { var r = p.rectValue; return r.x + "," + r.y + "," + r.width + "," + r.height; }
    case SerializedPropertyType.ObjectReference: return p.objectReferenceValue != null ? AssetDatabase.GetAssetPath(p.objectReferenceValue) + "|" + p.objectReferenceValue.name : "(null)";
    default: return "(" + p.propertyType + ")";
  }
}
bool WriteValue(SerializedProperty p, string raw) {
  if (raw == null) return false;
  if (p.isArray && p.propertyType != SerializedPropertyType.String) {
    var element = p.GetArrayElementAtIndex(Math.Max(0, p.arraySize - 1));
    if (element == null || element.isArray || element.propertyType == SerializedPropertyType.Generic) return false;
    return WriteValue(element, raw);
  }
  switch (p.propertyType) {
    case SerializedPropertyType.Integer: case SerializedPropertyType.Enum: case SerializedPropertyType.LayerMask: p.longValue = Convert.ToInt64(raw, System.Globalization.CultureInfo.InvariantCulture); return true;
    case SerializedPropertyType.Boolean: p.boolValue = Convert.ToBoolean(raw, System.Globalization.CultureInfo.InvariantCulture); return true;
    case SerializedPropertyType.Float: p.floatValue = Convert.ToSingle(raw, System.Globalization.CultureInfo.InvariantCulture); return true;
    case SerializedPropertyType.String: p.stringValue = Convert.ToString(raw); return true;
    case SerializedPropertyType.Color: if (!ColorUtility.TryParseHtmlString(Convert.ToString(raw), out var c)) return false; p.colorValue = c; return true;
    case SerializedPropertyType.Vector2: { var v = Convert.ToString(raw).Split(','); p.vector2Value = new Vector2(Convert.ToSingle(v[0], System.Globalization.CultureInfo.InvariantCulture), Convert.ToSingle(v[1], System.Globalization.CultureInfo.InvariantCulture)); return true; }
    case SerializedPropertyType.Vector3: { var v = Convert.ToString(raw).Split(','); p.vector3Value = new Vector3(Convert.ToSingle(v[0], System.Globalization.CultureInfo.InvariantCulture), Convert.ToSingle(v[1], System.Globalization.CultureInfo.InvariantCulture), Convert.ToSingle(v[2], System.Globalization.CultureInfo.InvariantCulture)); return true; }
    case SerializedPropertyType.Vector4: { var v = Convert.ToString(raw).Split(','); p.vector4Value = new Vector4(Convert.ToSingle(v[0], System.Globalization.CultureInfo.InvariantCulture), Convert.ToSingle(v[1], System.Globalization.CultureInfo.InvariantCulture), Convert.ToSingle(v[2], System.Globalization.CultureInfo.InvariantCulture), Convert.ToSingle(v[3], System.Globalization.CultureInfo.InvariantCulture)); return true; }
    default: return false;
  }
}
bool TypeMatches(Component candidate, string wanted) {
  if (candidate == null) return false;
  var type = candidate.GetType();
  return type.Name == wanted || type.FullName == wanted;
}`

/**
 * The hierarchy path form `LocusSceneObjectUtility.ResolveSceneObject` accepts:
 * "Name" with "Name[i]" for same-named siblings, joined by "/" from the root.
 */
const PATH_OF = `string PathOf(GameObject target) {
  var segments = new List<string>();
  var current = target.transform;
  while (current != null) {
    var parent = current.parent;
    var sameName = 0;
    var index = 0;
    if (parent != null) {
      foreach (Transform sibling in parent) {
        if (sibling.name != current.name) continue;
        if (sibling == current) index = sameName;
        sameName++;
      }
    } else {
      foreach (var sibling in current.gameObject.scene.GetRootGameObjects()) {
        if (sibling.name != current.name) continue;
        if (sibling.transform == current) index = sameName;
        sameName++;
      }
    }
    segments.Insert(0, sameName > 1 ? current.name + "[" + index + "]" : current.name);
    current = parent;
  }
  return string.Join("/", segments);
}`

/** Validate the `find_components` request. */
export function validateComponentSearch({ component_type, include_inactive, limit, scene_path }) {
  const type = String(component_type ?? '').trim()
  if (!type) throw new Error('component_type is required (for example Rigidbody or UnityEngine.Light).')
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 1000)) {
    throw new Error('limit must be an integer in 1..1000.')
  }
  return {
    componentType: type,
    includeInactive: include_inactive === true,
    limit: limit ?? 200,
    scenePath: scene_path ? String(scene_path).trim() : null,
  }
}

/** Build the snippet that lists every object carrying one component type. */
export function componentSearchBody(request) {
  const sceneFilter = request.scenePath ? csString(request.scenePath) : 'null'
  return `${VALUE_HELPERS}
${PATH_OF}
var wanted = ${csString(request.componentType)};
var sceneFilter = ${sceneFilter};
var limit = ${request.limit};
var includeInactive = ${request.includeInactive ? 'true' : 'false'};
var found = new List<Dictionary<string, object>>();
for (var i = 0; i < SceneManager.sceneCount && found.Count < limit; i++) {
  var scene = SceneManager.GetSceneAt(i);
  if (!scene.IsValid() || !scene.isLoaded || EditorSceneManager.IsPreviewScene(scene)) continue;
  if (sceneFilter != null && scene.path != sceneFilter) continue;
  foreach (var root in scene.GetRootGameObjects()) {
    foreach (var component in root.GetComponentsInChildren<Component>(includeInactive)) {
      if (component == null || !TypeMatches(component, wanted)) continue;
      if (found.Count >= limit) break;
      found.Add(new Dictionary<string, object> {
        { "scenePath", scene.path },
        { "objectPath", PathOf(component.gameObject) },
        { "name", component.gameObject.name },
        { "component", component.GetType().Name },
        { "componentType", component.GetType().FullName },
        { "componentIndex", Array.IndexOf(component.gameObject.GetComponents<Component>(), component) },
        { "active", component.gameObject.activeInHierarchy }
      });
    }
  }
}
printJson(new Dictionary<string, object> { { "component", wanted }, { "count", found.Count }, { "truncated", found.Count >= limit }, { "objects", found } });`
}

/** Validate one batch write. */
function validateWrite(write, index) {
  const at = `edits[${index}]`
  const scenePath = String(write.scene_path ?? '').trim()
  const objectPath = String(write.object_path ?? '').trim()
  const componentType = String(write.component_type ?? '').trim()
  const propertyPath = String(write.property_path ?? '').trim()
  if (!scenePath) throw new Error(`${at}.scene_path is required.`)
  if (!objectPath) throw new Error(`${at}.object_path is required.`)
  if (!componentType) throw new Error(`${at}.component_type is required.`)
  if (!propertyPath) throw new Error(`${at}.property_path is required.`)
  if (write.value === undefined) throw new Error(`${at}.value is required.`)
  return {
    scenePath,
    objectPath,
    componentType,
    componentIndex: Number.isInteger(write.component_index) ? write.component_index : null,
    propertyPath,
    value: JSON.stringify(write.value),
  }
}

/** Validate a whole batch and return the normalized request. */
export function validateBatch({ edits, save = true }) {
  if (!Array.isArray(edits) || edits.length === 0) throw new Error('edits must be a non-empty array of writes.')
  if (edits.length > BATCH_LIMIT) throw new Error(`edits is limited to ${BATCH_LIMIT} writes per batch.`)
  return { writes: edits.map(validateWrite), save: save !== false }
}

/**
 * Build one transaction: every write is applied inside a single undo group, the
 * previous values are captured for the undo token, and each touched scene is
 * saved once after the last write.
 */
export function batchBody(request) {
  const writes = request.writes.map((write) => `new Dictionary<string, object> {
    { "scenePath", ${csString(write.scenePath)} },
    { "objectPath", ${csString(write.objectPath)} },
    { "componentType", ${csString(write.componentType)} },
    { "componentIndex", ${write.componentIndex === null ? '-1' : String(write.componentIndex)} },
    { "propertyPath", ${csString(write.propertyPath)} },
    { "raw", ${csString(write.value)} }
  }`)
  return `${VALUE_HELPERS}
var writes = new List<Dictionary<string, object>> { ${writes.join(',\n')} };
Undo.IncrementCurrentGroup();
Undo.SetCurrentGroupName("Locus batch edit");
var undoGroup = Undo.GetCurrentGroup();
var applied = new List<Dictionary<string, object>>();
var failed = new List<Dictionary<string, object>>();
var touched = new List<Scene>();
foreach (var write in writes) {
  var scenePath = (string)write["scenePath"];
  var objectPath = (string)write["objectPath"];
  var componentType = (string)write["componentType"];
  var componentIndex = (int)write["componentIndex"];
  var propertyPath = (string)write["propertyPath"];
  var raw = (string)write["raw"];
  try {
    var target = Locus.LocusSceneObjectUtility.ResolveSceneObject(scenePath, objectPath);
    var scene = target.scene;
    Component component = null;
    if (componentIndex >= 0) { var all = target.GetComponents<Component>(); if (componentIndex < all.Length) component = all[componentIndex]; }
    else { foreach (var candidate in target.GetComponents<Component>()) if (TypeMatches(candidate, componentType)) { component = candidate; break; } }
    if (component == null) throw new Exception("component_not_found: " + componentType + " on " + objectPath);
    Undo.RecordObject(component, "Locus batch edit");
    var serialized = new SerializedObject(component);
    serialized.Update();
    var property = serialized.FindProperty(propertyPath);
    if (property == null) throw new Exception("property_not_found: " + propertyPath);
    if (!property.editable) throw new Exception("unsupported_capability: read only " + propertyPath);
    var before = ReadValue(property);
    if (!WriteValue(property, raw)) throw new Exception("type_mismatch: " + property.propertyType + " at " + propertyPath);
    serialized.ApplyModifiedProperties();
    EditorUtility.SetDirty(component);
    if (!touched.Contains(scene)) touched.Add(scene);
    applied.Add(new Dictionary<string, object> {
      { "scenePath", scenePath }, { "objectPath", objectPath }, { "component", component.GetType().Name },
      { "componentIndex", Array.IndexOf(target.GetComponents<Component>(), component) },
      { "propertyPath", propertyPath }, { "before", before }, { "after", ReadValue(property) }
    });
  } catch (Exception error) {
    failed.Add(new Dictionary<string, object> { { "scenePath", scenePath }, { "objectPath", objectPath }, { "propertyPath", propertyPath }, { "error", error.Message } });
  }
}
Undo.CollapseUndoOperations(undoGroup);
var savedScenes = new List<string>();
${
    request.save
      ? `foreach (var scene in touched) { if (scene.isDirty) { EditorSceneManager.MarkSceneDirty(scene); EditorSceneManager.SaveScene(scene); savedScenes.Add(scene.path); } }`
      : ''
  }
printJson(new Dictionary<string, object> {
  { "applied", applied.Count }, { "failed", failed.Count },
  { "undoGroup", undoGroup }, { "savedScenes", savedScenes },
  { "results", applied }, { "errors", failed }
});`
}

/**
 * Build the revert snippet. `undo` carries the applied writes with the value
 * each replaced, so the same batch machinery can put them back — the scene
 * equivalent of what `unity_asset action "undo"` does for asset files.
 */
export function batchUndoBody({ writes }) {
  return `${VALUE_HELPERS}
var writes = new List<Dictionary<string, object>> { ${writes
    .map(
      (write) => `new Dictionary<string, object> {
    { "scenePath", ${csString(write.scenePath)} },
    { "objectPath", ${csString(write.objectPath)} },
    { "componentType", ${csString(write.componentType)} },
    { "componentIndex", ${write.componentIndex === null ? '-1' : String(write.componentIndex)} },
    { "propertyPath", ${csString(write.propertyPath)} },
    { "raw", ${csString(write.before)} }
  }`,
    )
    .join(',\n')} };
Undo.IncrementCurrentGroup();
Undo.SetCurrentGroupName("Locus batch undo");
var undoGroup = Undo.GetCurrentGroup();
var restored = 0;
var failed = new List<string>();
var touched = new List<Scene>();
foreach (var write in writes) {
  var scenePath = (string)write["scenePath"];
  var objectPath = (string)write["objectPath"];
  var componentType = (string)write["componentType"];
  var componentIndex = (int)write["componentIndex"];
  var propertyPath = (string)write["propertyPath"];
  var raw = (string)write["raw"];
  try {
    var target = Locus.LocusSceneObjectUtility.ResolveSceneObject(scenePath, objectPath);
    var scene = target.scene;
    Component component = null;
    if (componentIndex >= 0) { var all = target.GetComponents<Component>(); if (componentIndex < all.Length) component = all[componentIndex]; }
    else { foreach (var candidate in target.GetComponents<Component>()) if (TypeMatches(candidate, componentType)) { component = candidate; break; } }
    if (component == null) throw new Exception("component_not_found: " + componentType);
    Undo.RecordObject(component, "Locus batch undo");
    var serialized = new SerializedObject(component);
    serialized.Update();
    var property = serialized.FindProperty(propertyPath);
    if (property == null) throw new Exception("property_not_found: " + propertyPath);
    if (!WriteValue(property, raw)) throw new Exception("type_mismatch: " + property.propertyType);
    serialized.ApplyModifiedProperties();
    EditorUtility.SetDirty(component);
    if (!touched.Contains(scene)) touched.Add(scene);
    restored++;
  } catch (Exception error) {
    failed.Add(objectPath + " " + propertyPath + ": " + error.Message);
  }
}
Undo.CollapseUndoOperations(undoGroup);
foreach (var scene in touched) { if (scene.isDirty) { EditorSceneManager.MarkSceneDirty(scene); EditorSceneManager.SaveScene(scene); } }
printJson(new Dictionary<string, object> { { "restored", restored }, { "failed", failed.Count }, { "errors", failed } });`
}

/** Turn a batch result into the undo token `unity_scene action=undo` consumes. */
export function batchUndoToken(result) {
  return {
    kind: 'scene-batch',
    undoGroup: result.undoGroup ?? null,
    writes: (result.results ?? []).map((entry) => ({
      scenePath: entry.scenePath,
      objectPath: entry.objectPath,
      componentType: entry.component,
      componentIndex: entry.componentIndex ?? null,
      propertyPath: entry.propertyPath,
      // `WriteValue` takes the raw scalar text, so the recorded previous value
      // is re-serialized to the same shape the write used.
      before: Array.isArray(entry.before) ? entry.before.join(',') : String(entry.before ?? ''),
    })),
  }
}

export { BATCH_LIMIT }
