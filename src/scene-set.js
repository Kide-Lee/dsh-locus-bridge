// Source for the atomic scene setter (`unity_scene` action=set).
//
// Locus' property-tree API is read/discover only; writes are C# snippets. The
// snippet below is compiled and run by Unity as one method body:
//   1. resolves the GameObject by scene + hierarchy path (same segment rules as
//      `LocusSceneObjectUtility`: "Name" or "Name[1]" for same-named siblings),
//   2. records Undo, finds the component by type name (or index) and writes the
//      SerializedProperty with a type-checked value,
//   3. applies, marks the scene dirty, saves it, and prints one JSON line with
//      the applied value.
// User-supplied text is embedded only as C# string/int literals; JSON values
// travel as one JSON string and are parsed by the snippet.

import { randomUUID } from 'node:crypto'

/** Operations the atomic setter understands. */
export const SET_OPERATIONS = new Set(['set', 'array_insert', 'array_remove', 'array_move', 'array_resize'])

/** Validate `unity_scene` action=set arguments into a normalized request. */
export function validateSetArgs({ scene_path, object_path, component_type, component_index, property_path, operation }) {
  const request = {
    scenePath: String(scene_path ?? '').trim(),
    objectPath: String(object_path ?? '').trim(),
    componentType: String(component_type ?? '').trim(),
    componentIndex: component_index,
    propertyPath: String(property_path ?? '').trim(),
    op: String(operation?.op ?? 'set'),
    value: operation?.value,
    index: operation?.index,
    toIndex: operation?.to_index,
    size: operation?.size,
  }
  if (!request.scenePath) throw new Error('scene_path is required (for example Assets/Scenes/Main.unity).')
  if (!request.objectPath) throw new Error('object_path is required (for example "Canvas/Button").')
  if (!request.componentType) throw new Error('component_type is required (for example Transform, RectTransform).')
  if (!request.propertyPath) throw new Error('property_path is required (for example m_LocalPosition).')
  if (component_index !== undefined && (!Number.isInteger(component_index) || component_index < 0)) {
    throw new Error('component_index must be a non-negative integer.')
  }
  if (!SET_OPERATIONS.has(request.op)) {
    throw new Error(`operation.op '${request.op}' is not supported (set, array_insert, array_remove, array_move, array_resize).`)
  }
  if (request.op === 'set' && request.value === undefined) throw new Error('operation.value is required for set.')
  if (['array_insert', 'array_remove', 'array_move'].includes(request.op) && !Number.isInteger(request.index)) {
    throw new Error(`${request.op} requires an integer index.`)
  }
  if (request.op === 'array_move' && !Number.isInteger(request.to_index)) {
    throw new Error('array_move requires an integer to_index.')
  }
  if (request.op === 'array_resize' && (!Number.isInteger(request.size) || request.size < 0)) {
    throw new Error('array_resize requires a non-negative size.')
  }
  if ((request.op === 'array_insert' || request.op === 'array_resize') && request.value === undefined) {
    throw new Error(`${request.op} requires a value.`)
  }
  return request
}

const CS_ESCAPE = { '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' }

/** C# string literal for arbitrary text. */
export function csString(value) {
  return `"${String(value).replace(/[\\"\n\r\t]/g, (ch) => CS_ESCAPE[ch])}"`
}

function csInt(value, fallback = -1) {
  return Number.isInteger(value) ? String(value) : String(fallback)
}

// `SerializedProperty.displayValue` is internal to UnityEditor, so the snippet
// reads every printable scalar through the public typed accessors instead; a
// property type without one reports its type name (never a compile error, which
// would block the write itself).
const PRELUDE = `Func<SerializedProperty, object> CurrentValue = p => {
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
    case SerializedPropertyType.Bounds: { var b = p.boundsValue; return b.center.x + "," + b.center.y + "," + b.center.z + ";" + b.size.x + "," + b.size.y + "," + b.size.z; }
    case SerializedPropertyType.ObjectReference: return p.objectReferenceValue != null ? AssetDatabase.GetAssetPath(p.objectReferenceValue) + "|" + p.objectReferenceValue.name : "(null)";
    default: return "(" + p.propertyType + ")";
  }
};`

/**
 * Build the C# method body. `quote("x")` is used across string concatenations
 * so Unity still reports errors at valid line numbers.
 */
export function buildSceneSetBody(request) {
  const literal = (text) => csString(text)
  const valueJson = request.value === undefined ? null : JSON.stringify(request.value)
  const raw = valueJson === null ? 'null' : literal(valueJson)
  const op = literal(request.op)
  return `var scene = default(Scene);
for (var i = 0; i < SceneManager.sceneCount; i++) { var s = SceneManager.GetSceneAt(i); if (s.path == ${literal(request.scenePath)}) { scene = s; break; } }
if (!scene.IsValid() || !scene.isLoaded) throw new Exception("scene_not_loaded: " + ${literal(request.scenePath)});
GameObject FindIn(GameObject root, string[] parts) { var go = root; for (var k = 1; k < parts.Length && go != null; k++) { var b = parts[k].LastIndexOf('['); var wantIndex = 0; var name = parts[k]; if (b > 0 && parts[k].EndsWith("]")) { int parsed; if (int.TryParse(parts[k].Substring(b + 1, parts[k].Length - b - 2), out parsed) && parsed >= 0) wantIndex = parsed; name = parts[k].Substring(0, b); } Transform next = null; var seen = 0; foreach (Transform child in go.transform) if (child.name == name) { if (seen++ == wantIndex) { next = child; break; } } go = next != null ? next.gameObject : null; } return go; }
var parts = ${literal(request.objectPath)}.Split(new[] { '/' }, StringSplitOptions.RemoveEmptyEntries);
GameObject target = null;
if (parts.Length > 0) { var b0 = parts[0].LastIndexOf('['); var wantRoot = 0; var rootName = parts[0]; if (b0 > 0 && parts[0].EndsWith("]")) { int parsed; if (int.TryParse(parts[0].Substring(b0 + 1, parts[0].Length - b0 - 2), out parsed) && parsed >= 0) wantRoot = parsed; rootName = parts[0].Substring(0, b0); } var rootSeen = 0; foreach (var root in scene.GetRootGameObjects()) if (root.name == rootName) { if (rootSeen++ == wantRoot) { target = FindIn(root, parts); break; } } }
if (target == null) throw new Exception("object_not_found: " + ${literal(request.objectPath)});
Component component = null;
if (${Number.isInteger(request.componentIndex) ? 'true' : 'false'}) { var all = target.GetComponents<Component>(); if (${csInt(request.componentIndex)} < all.Length) component = all[${csInt(request.componentIndex)}]; }
else { foreach (var candidate in target.GetComponents<Component>()) if (candidate != null && (candidate.GetType().Name == ${literal(request.componentType)} || candidate.GetType().FullName == ${literal(request.componentType)})) { component = candidate; break; } }
if (component == null) throw new Exception("component_not_found: " + ${literal(request.componentType)} + " on " + ${literal(request.objectPath)});
Undo.IncrementCurrentGroup();
Undo.SetCurrentGroupName("Locus scene set");
Undo.RecordObject(component, "Locus scene set");
var serialized = new SerializedObject(component);
serialized.Update();
var property = serialized.FindProperty(${literal(request.propertyPath)});
if (property == null) throw new Exception("property_not_found: " + ${literal(request.propertyPath)});
if (!property.editable) throw new Exception("unsupported_capability: property is read only " + ${literal(request.propertyPath)});
var raw = ${raw};
if (property.isArray && property.propertyType != SerializedPropertyType.String) {
  if (${op} == "array_insert" || ${op} == "array_resize") {
    var element = property.GetArrayElementAtIndex(Math.Max(0, property.arraySize - 1));
    if (raw != null && !element.isArray && element.propertyType != SerializedPropertyType.Generic) {
      switch (element.propertyType) {
        case SerializedPropertyType.Integer: case SerializedPropertyType.Enum: case SerializedPropertyType.LayerMask: element.longValue = Convert.ToInt64(raw); break;
        case SerializedPropertyType.Boolean: element.boolValue = Convert.ToBoolean(raw); break;
        case SerializedPropertyType.Float: element.floatValue = Convert.ToSingle(raw, System.Globalization.CultureInfo.InvariantCulture); break;
        case SerializedPropertyType.String: element.stringValue = Convert.ToString(raw); break;
        default: throw new Exception("type_mismatch: array element " + element.propertyType + " needs a supported scalar value"); }
    }
    else if (raw == null) throw new Exception("invalid_operation: " + ${op} + " requires a value");
  }
  if (${op} == "array_insert") property.InsertArrayElementAtIndex(${csInt(request.index)});
  else if (${op} == "array_remove") { var before = property.arraySize; property.DeleteArrayElementAtIndex(${csInt(request.index)}); if (property.arraySize == before) property.DeleteArrayElementAtIndex(${csInt(request.index)}); }
  else if (${op} == "array_move") property.MoveArrayElement(${csInt(request.index)}, ${csInt(request.toIndex)});
  else if (${op} == "array_resize") property.arraySize = ${csInt(request.size)};
}
else if (raw != null) {
  switch (property.propertyType) {
    case SerializedPropertyType.Integer: case SerializedPropertyType.Enum: case SerializedPropertyType.LayerMask: property.longValue = Convert.ToInt64(raw); break;
    case SerializedPropertyType.Boolean: property.boolValue = Convert.ToBoolean(raw); break;
    case SerializedPropertyType.Float: property.floatValue = Convert.ToSingle(raw, System.Globalization.CultureInfo.InvariantCulture); break;
    case SerializedPropertyType.String: property.stringValue = Convert.ToString(raw); break;
    case SerializedPropertyType.Color: property.colorValue = ColorUtility.TryParseHtmlString(Convert.ToString(raw), out var color) ? color : JsonUtility.FromJson<Color>(Convert.ToString(raw)); break;
    case SerializedPropertyType.Vector2: { var c = Convert.ToString(raw).Split(','); property.vector2Value = new Vector2(Convert.ToSingle(c[0], System.Globalization.CultureInfo.InvariantCulture), Convert.ToSingle(c[1], System.Globalization.CultureInfo.InvariantCulture)); break; }
    case SerializedPropertyType.Vector3: { var c = Convert.ToString(raw).Split(','); property.vector3Value = new Vector3(Convert.ToSingle(c[0], System.Globalization.CultureInfo.InvariantCulture), Convert.ToSingle(c[1], System.Globalization.CultureInfo.InvariantCulture), Convert.ToSingle(c[2], System.Globalization.CultureInfo.InvariantCulture)); break; }
    default: throw new Exception("type_mismatch: cannot set " + property.propertyType + " from JSON; use unity_execute for this field"); }
}
else if (${op} == "set") throw new Exception("invalid_operation: set requires a value");
serialized.ApplyModifiedProperties();
EditorSceneManager.MarkSceneDirty(scene);
if (!EditorSceneManager.SaveScene(scene)) throw new Exception("scene_save_failed: " + ${literal(request.scenePath)});
printJson(new Dictionary<string, object> { { "ok", true }, { "scene", ${literal(request.scenePath)} }, { "objectPath", ${literal(request.objectPath)} }, { "component", component.GetType().Name }, { "propertyPath", ${literal(request.propertyPath)} }, { "operation", ${op} }, { "value", CurrentValue(property) } });
return null;`
}

/** Full snippet body for one scene set (prelude + body). */
export function sceneSetCode(request) {
  return `${PRELUDE}\n${buildSceneSetBody(request)}`
}

/** Snippet + execution id for the execute_code transport. */
export function sceneSetExecution(request, { executionId } = {}) {
  return { code: sceneSetCode(request), executionId: executionId ?? randomUUID() }
}
