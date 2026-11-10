using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;

namespace Locus
{
    public static partial class LocusBridge
    {
        // View-only value protocol. The legacy tree remains the authority for
        // compound roots, runtime objects, managed graphs and structural writes.
        [Serializable] private sealed class PropertyObjectsRequest
        {
            public string action;
            public PropertyObjectRead[] reads;
            public PropertyTreeWriteRequest write;
            public string[] knownSchemas;
        }
        [Serializable] private sealed class PropertyObjectRead
        {
            public PropertyTreeTarget target;
            public string revision;
            public int maxDepth = 6;
            public int maxArrayItems = 8;
        }
        private sealed class PropertyObjectSchema
        {
            public string Id;
            public Dictionary<string, object> Data;
            public FieldInfo Field;
            public bool Dynamic;
        }
        private sealed class PropertyObjectState
        {
            public int OwnerId;
            public string Revision;
            public Dictionary<string, Dictionary<string, object>> Nodes;
        }
        private sealed class PropertyObjectUnsupported : Exception { }
        private const int PropertyObjectNodeLimit = 2048;
        private static long _propertyObjectSequence;
        private static readonly Dictionary<string, PropertyObjectSchema> PropertyObjectSchemas = new Dictionary<string, PropertyObjectSchema>();
        private static readonly Dictionary<string, PropertyObjectState> PropertyObjectStates = new Dictionary<string, PropertyObjectState>();
        private static readonly Dictionary<Type, bool> PropertyObjectSimpleTypes = new Dictionary<Type, bool>();

        private static async Task<PipeEnvelope> HandlePropertyObjects(string requestId, string message)
        {
            PropertyObjectsRequest request;
            try { request = JsonUtility.FromJson<PropertyObjectsRequest>(message ?? "{}"); }
            catch (Exception error) { return ErrorResponse(requestId, error.Message); }
            var completion = LocusAsync.CreateTcs<object>();
            PostToMainThread(() => {
                try { completion.TrySetResult(ExecutePropertyObjects(request)); }
                catch (Exception error) { completion.TrySetException(error); }
            });
            if (await Task.WhenAny(completion.Task, Task.Delay(ExecuteTimeoutMs)) != completion.Task)
                return ErrorResponse(requestId, "property_objects timed out; read before retrying a write");
            try {
                object captured = await completion.Task;
                // Only immutable managed DTOs cross this boundary. No Unity API,
                // SerializedObject, field getter or deferred iterator runs here.
                return await Task.Run(() => OkResponse(requestId, Locus.Json.LocusJson.SerializeData(captured)));
            } catch (Exception error) { return ErrorResponse(requestId, error.Message); }
        }

        private static object ExecutePropertyObjects(PropertyObjectsRequest request)
        {
            if (request == null) throw new ArgumentException("Missing property object request.");
            if ((request.knownSchemas?.Length ?? 0) > 8192) throw new ArgumentException("Too many known schemas.");
            var known = new HashSet<string>(request.knownSchemas ?? new string[0], StringComparer.Ordinal);
            var schemas = new Dictionary<string, object>();
            if (request.action == "write") {
                var result = WritePropertyObject(request.write, known, schemas);
                return new Dictionary<string, object> { { "protocol", 1 }, { "schemas", schemas }, { "result", result } };
            }
            if (request.action != "read" || request.reads == null || request.reads.Length == 0 || request.reads.Length > 32)
                throw new ArgumentException("Property object read requires 1 to 32 targets.");
            var results = new List<object>();
            foreach (var read in request.reads) {
                try { results.Add(ReadPropertyObject(read, known, schemas)); }
                catch (PropertyObjectUnsupported) { results.Add(new { unsupported = true }); }
                catch (Exception error) { results.Add(new { error = error.Message }); }
            }
            return new Dictionary<string, object> { { "protocol", 1 }, { "schemas", schemas }, { "results", results } };
        }

        private static string PropertyObjectKey(UnityEngine.Object owner)
        {
            return GlobalObjectId.GetGlobalObjectIdSlow(owner).ToString();
        }

        private static bool PropertyObjectSupported(UnityEngine.Object owner)
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode || !owner ||
                !(owner is ScriptableObject || owner is Component) || !IsPropertyAuthoringTarget(owner) ||
                GlobalObjectId.GetGlobalObjectIdSlow(owner).targetObjectId == 0) return false;
            Type type = owner.GetType();
            if (!PropertyObjectSimpleTypes.TryGetValue(type, out var supported)) {
                supported = !PropertyObjectHasManagedGraph(type, new HashSet<Type>(), true);
                if (PropertyObjectSimpleTypes.Count >= 2048) PropertyObjectSimpleTypes.Clear();
                PropertyObjectSimpleTypes[type] = supported;
            }
            return supported;
        }

        private static bool PropertyObjectHasManagedGraph(Type type, HashSet<Type> visited, bool root = false)
        {
            if (type == null || type.IsPrimitive || type.IsEnum || type.IsPointer || type.IsByRef || type == typeof(string)) return false;
            if (!root && typeof(UnityEngine.Object).IsAssignableFrom(type)) return false;
            if (type.IsArray) return PropertyObjectHasManagedGraph(type.GetElementType(), visited);
            if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(List<>)) return PropertyObjectHasManagedGraph(type.GetGenericArguments()[0], visited);
            if (!visited.Add(type)) return false;
            if (visited.Count > 128) return true;
            for (var current = type; current != null && current != typeof(UnityEngine.Object); current = current.BaseType)
                foreach (var field in current.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly)) {
                    if (field.IsStatic || field.IsInitOnly || field.IsNotSerialized) continue;
                    if (field.IsDefined(typeof(SerializeReference), true)) return true;
                    if ((field.IsPublic || field.IsDefined(typeof(SerializeField), true)) && PropertyObjectHasManagedGraph(field.FieldType, visited)) return true;
                }
            return false;
        }

        private static void CheckPropertyObjectBudget(SerializedProperty property, int depth, int maxDepth, int maxItems, ref int count)
        {
            if (++count > PropertyObjectNodeLimit || property.propertyType == SerializedPropertyType.ManagedReference) throw new PropertyObjectUnsupported();
            if (depth >= maxDepth || IsSerializedPropertyCompactValue(property.propertyType)) return;
            if (property.isArray && property.propertyType == SerializedPropertyType.Generic) {
                for (int i = 0; i < Math.Min(property.arraySize, maxItems); i++) CheckPropertyObjectBudget(property.GetArrayElementAtIndex(i), depth + 1, maxDepth, maxItems, ref count);
            } else if (property.hasVisibleChildren) {
                var cursor = property.Copy(); var end = property.GetEndProperty(); bool enter = true;
                while (cursor.NextVisible(enter) && !SerializedProperty.EqualContents(cursor, end)) {
                    CheckPropertyObjectBudget(cursor, depth + 1, maxDepth, maxItems, ref count); enter = false;
                }
            }
        }

        private static object ReadPropertyObject(PropertyObjectRead request, HashSet<string> known, Dictionary<string, object> schemas)
        {
            ValidatePropertyTreeObjectTarget(request?.target);
            if (!string.IsNullOrEmpty(request.target.propertyPath)) throw new ArgumentException("Object reads require an object target.");
            var owner = ResolvePropertyTreeObject(request.target);
            if (!PropertyObjectSupported(owner)) throw new PropertyObjectUnsupported();
            var target = PropertyTreeTargetWithLocalFileIds(request.target, owner);
            string key = PropertyObjectKey(owner);
            // A path-only main asset with subassets has compound-root semantics.
            // Never silently replace that legacy hierarchy with one SO's fields.
            if (owner is ScriptableObject &&
                AssetDatabase.LoadAllAssetsAtPath(AssetDatabase.GetAssetPath(owner)).Length > 1)
                throw new PropertyObjectUnsupported();
            int maxDepth = Math.Max(1, Math.Min(16, request.maxDepth));
            int maxItems = Math.Max(1, Math.Min(1024, request.maxArrayItems));
            var nodes = new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
            Type ownerType = owner.GetType();
            var rootSchema = PropertyObjectRootSchema(ownerType);
            IncludePropertyObjectSchema(rootSchema, known, schemas);
            nodes[""] = new Dictionary<string, object> {
                { "p", "" }, { "s", rootSchema.Id }, { "parent", null },
                { "v", owner.name }, { "d", owner.name }, { "e", false }, { "h", true }
            };
            using (var serialized = new SerializedObject(owner)) {
                serialized.Update();
                var cursor = serialized.GetIterator();
                bool enter = true; int count = 1;
                while (cursor.NextVisible(enter)) { CheckPropertyObjectBudget(cursor, 1, maxDepth, maxItems, ref count); enter = false; }
                cursor = serialized.GetIterator(); enter = true;
                while (cursor.NextVisible(enter)) {
                    CapturePropertyObjectNode(cursor, "", ownerType, 1, maxDepth, maxItems, nodes, known, schemas);
                    enter = false;
                }
            }
            PropertyObjectState previous;
            PropertyObjectStates.TryGetValue(key, out previous);
            int ownerId = LocusObjectIdentity.InstanceId(owner);
            if (previous != null && previous.OwnerId != ownerId) previous = null;
            bool identical = previous != null && previous.Nodes.Count == nodes.Count &&
                nodes.All(pair => previous.Nodes.TryGetValue(pair.Key, out var value) && PropertyObjectValueEquals(value, pair.Value));
            string revision = identical ? previous.Revision : PropertyDataDomain + ":o" + (++_propertyObjectSequence).ToString(CultureInfo.InvariantCulture);
            bool delta = previous != null && request.revision == previous.Revision;
            var changed = nodes.Where(pair => !delta || !previous.Nodes.TryGetValue(pair.Key, out var value) || !PropertyObjectValueEquals(value, pair.Value)).Select(pair => pair.Value).ToArray();
            var removed = delta ? previous.Nodes.Keys.Where(path => !nodes.ContainsKey(path)).ToArray() : new string[0];
            if (PropertyObjectStates.Count >= 128 && !PropertyObjectStates.ContainsKey(key)) PropertyObjectStates.Clear();
            PropertyObjectStates[key] = new PropertyObjectState { OwnerId = ownerId, Revision = revision, Nodes = nodes };
            return new Dictionary<string, object> {
                { "objectKey", key }, { "target", PropertyObjectTarget(target) }, { "revision", revision },
                { "dataVersion", PropertyDataVersion }, { "baseRevision", delta ? previous.Revision : null },
                { "complete", !delta }, { "nodes", changed }, { "removed", removed },
                { "maxDepth", maxDepth }, { "maxArrayItems", maxItems }, { "rootProjection", owner is ScriptableObject },
                { "conservativeInvalidation", PropertyTreeDynamicPresentationTypes.Contains(owner.GetType()) },
                { "applied", true }, { "persisted", !EditorUtility.IsDirty(owner) }
            };
        }

        // Compare captured values, not per-node JSON. Unknown DTO types are
        // conservatively changed; this never invokes a Unity property getter.
        private static bool PropertyObjectValueEquals(object left, object right)
        {
            if (ReferenceEquals(left, right)) return true;
            if (left == null || right == null) return false;
            if (left is Dictionary<string, object> a && right is Dictionary<string, object> b) {
                if (a.Count != b.Count) return false;
                foreach (var pair in a) if (!b.TryGetValue(pair.Key, out var value) || !PropertyObjectValueEquals(pair.Value, value)) return false;
                return true;
            }
            if (left is System.Collections.IList x && right is System.Collections.IList y) {
                if (x.Count != y.Count) return false;
                for (int i = 0; i < x.Count; i++) if (!PropertyObjectValueEquals(x[i], y[i])) return false;
                return true;
            }
            if (left is SerializedPropertyAttributeInfo p && right is SerializedPropertyAttributeInfo q)
                return p.type == q.type && p.displayName == q.displayName && p.value == q.value;
            return (left is string || left.GetType().IsPrimitive || left is decimal) && left.Equals(right);
        }

        private static Dictionary<string, object> PropertyObjectTarget(PropertyTreeTarget target)
        {
            return new Dictionary<string, object> {
                { "kind", target.kind }, { "guid", target.guid }, { "path", target.path },
                { "scenePath", target.scenePath }, { "objectPath", target.objectPath },
                { "globalObjectId", target.globalObjectId }, { "componentType", target.componentType },
                { "componentIndex", target.componentIndex }, { "propertyPath", target.propertyPath },
                { "objectFileId", target.objectFileId == 0 ? null : target.objectFileId.ToString(CultureInfo.InvariantCulture) },
                { "targetFileId", target.targetFileId == 0 ? null : target.targetFileId.ToString(CultureInfo.InvariantCulture) },
                { "targetTypeFullName", target.targetTypeFullName }, { "targetTypeAssembly", target.targetTypeAssembly },
                { "targetTypeName", target.targetTypeName }
            };
        }

        private static object PropertyObjectReferenceTarget(SerializedProperty property)
        {
            var reference = property.propertyType == SerializedPropertyType.ExposedReference ? property.exposedReferenceValue : property.objectReferenceValue;
            return reference ? PropertyObjectTarget(PropertyTreeTargetForObject(reference)) : null;
        }

        private static void CapturePropertyObjectNode(SerializedProperty property, string parent, Type ownerType, int depth, int maxDepth, int maxItems,
            Dictionary<string, Dictionary<string, object>> nodes, HashSet<string> known, Dictionary<string, object> schemas)
        {
            if (nodes.Count >= PropertyObjectNodeLimit || property.propertyType == SerializedPropertyType.ManagedReference)
                throw new PropertyObjectUnsupported();
            var schema = PropertyObjectFieldSchema(property, ownerType);
            IncludePropertyObjectSchema(schema, known, schemas);
            bool array = property.isArray && property.propertyType == SerializedPropertyType.Generic;
            bool compact = IsSerializedPropertyCompactValue(property.propertyType);
            bool reference = property.propertyType == SerializedPropertyType.ObjectReference || property.propertyType == SerializedPropertyType.ExposedReference;
            string path = property.propertyPath;
            object referenceTarget = reference ? PropertyObjectReferenceTarget(property) : null;
            var node = new Dictionary<string, object> {
                { "p", path }, { "parent", parent }, { "s", schema.Id },
                { "v", SerializedPropertyValue(property) }, { "d", SerializedPropertyDisplayValue(property) },
                { "e", IsSerializedPropertyWritable(property) }, { "o", property.prefabOverride },
                { "h", !compact && (property.hasVisibleChildren || referenceTarget != null) }
            };
            nodes[path] = node;
            if (path.EndsWith("]", StringComparison.Ordinal)) { node["name"] = property.name; node["displayName"] = property.displayName; }
            if (reference) node["r"] = referenceTarget;
            if (property.propertyType == SerializedPropertyType.Enum) {
                node["i"] = property.enumValueIndex; node["f"] = SerializedEnumNumericValue(property);
            }
            if (schema.Dynamic) {
                var attributes = (SerializedPropertyAttributeInfo[])schema.Data["attributes"];
                var snapshot = new SerializedPropertySnapshot { isArray = array,
                    attributes = array ? attributes.Where(a => a.type != "Locus.ListElementType").ToArray() : attributes };
                ApplyPropertyListPresentation(property, snapshot, schema.Field);
                node["attributes"] = snapshot.attributes;
            }
            int childCount = 0;
            if (array) {
                int size = property.arraySize; node["a"] = size;
                if (depth < maxDepth) for (int i = 0; i < Math.Min(size, maxItems); i++) {
                    CapturePropertyObjectNode(property.GetArrayElementAtIndex(i), path, ownerType, depth + 1, maxDepth, maxItems, nodes, known, schemas); childCount++;
                }
                node["t"] = size > childCount;
            } else if (!compact && property.hasVisibleChildren) {
                if (depth < maxDepth) {
                    var cursor = property.Copy(); var end = property.GetEndProperty();
                    bool enter = true;
                    while (cursor.NextVisible(enter) && !SerializedProperty.EqualContents(cursor, end)) {
                        CapturePropertyObjectNode(cursor, path, ownerType, depth + 1, maxDepth, maxItems, nodes, known, schemas); childCount++; enter = false;
                    }
                }
                node["t"] = depth >= maxDepth;
            }
            node["count"] = childCount;
        }

        private static void IncludePropertyObjectSchema(PropertyObjectSchema schema, HashSet<string> known, Dictionary<string, object> schemas)
        {
            if (!known.Contains(schema.Id)) schemas[schema.Id] = schema.Data;
        }
        private static PropertyObjectSchema PropertyObjectRootSchema(Type type)
        {
            string key = type.AssemblyQualifiedName + "|root";
            if (PropertyObjectSchemas.TryGetValue(key, out var schema)) return schema;
            return CachePropertyObjectSchema(key, new Dictionary<string, object> {
                { "nodeKind", "object" }, { "type", type.Name }, { "valueType", "Object" },
                { "name", type.Name }, { "displayName", type.Name }, { "fieldTypeFullName", FieldTypeFullName(type) },
                { "fieldTypeAssembly", FieldTypeAssembly(type) }, { "isArray", false }, { "isManagedReference", false }
            }, null, false);
        }
        private static PropertyObjectSchema PropertyObjectFieldSchema(SerializedProperty property, Type ownerType)
        {
            string normalized = System.Text.RegularExpressions.Regex.Replace(property.propertyPath, @"\.Array\.data\[\d+\]", ".Array.data[*]");
            string key = ownerType.AssemblyQualifiedName + "|" + normalized + "|" + property.type;
            if (PropertyObjectSchemas.TryGetValue(key, out var schema)) return schema;
            var snapshot = SnapshotSerializedProperty(property, 0, 0, false, false);
            FieldInfo field = ResolveSerializedPropertyFieldInfo(property);
            bool dynamic = field != null && SerializedFieldMetadataFor(field).HasDynamicListPresentation;
            var attributes = (snapshot.attributes ?? new SerializedPropertyAttributeInfo[0]).Where(a => a.type != "Locus.PropertyVisibility" && a.type != "Locus.ListElementLabel").ToArray();
            return CachePropertyObjectSchema(key, new Dictionary<string, object> {
                { "nodeKind", snapshot.nodeKind }, { "name", snapshot.name }, { "displayName", snapshot.displayName },
                { "type", snapshot.type }, { "valueType", snapshot.valueType }, { "fieldTypeFullName", snapshot.fieldTypeFullName },
                { "fieldTypeAssembly", snapshot.fieldTypeAssembly }, { "isArray", snapshot.isArray }, { "isManagedReference", false },
                { "isFlagsEnum", snapshot.isFlagsEnum }, { "enumOptions", snapshot.enumOptions },
                { "tooltip", snapshot.tooltip }, { "header", snapshot.header }, { "hasRange", snapshot.hasRange },
                { "rangeMin", snapshot.rangeMin }, { "rangeMax", snapshot.rangeMax }, { "numberStep", snapshot.numberStep },
                { "multiline", snapshot.multiline }, { "minLines", snapshot.minLines }, { "maxLines", snapshot.maxLines },
                { "referenceTypeFullName", snapshot.referenceTypeFullName }, { "referenceTypeAssembly", snapshot.referenceTypeAssembly },
                { "attributes", attributes }
            }, field, dynamic);
        }
        private static PropertyObjectSchema CachePropertyObjectSchema(string key, Dictionary<string, object> data, FieldInfo field, bool dynamic)
        {
            if (PropertyObjectSchemas.Count >= 4096) PropertyObjectSchemas.Clear();
            var schema = new PropertyObjectSchema { Id = PropertyDataDomain + ":s" + (++_propertyObjectSequence).ToString(CultureInfo.InvariantCulture), Data = data, Field = field, Dynamic = dynamic };
            PropertyObjectSchemas[key] = schema; return schema;
        }

        private static object WritePropertyObject(PropertyTreeWriteRequest request, HashSet<string> known, Dictionary<string, object> schemas)
        {
            ValidatePropertyTreeTarget(request?.target);
            var owner = ResolvePropertyTreeObject(request.target);
            // Unsupported is returned ONLY before any mutation. Never retry a
            // failed/timeout mutation through the legacy transport.
            if (!PropertyObjectSupported(owner) || request.target.propertyPath == "m_Name" || IsPropertyTreeSyntheticHeaderProperty(owner, request.target) || IsPropertyTreePreviewMode(request.mode) ||
                PropertyTreeHasValidation(owner.GetType()) || PropertyTreeDynamicPresentationTypes.Contains(owner.GetType()) ||
                request.valueJson == null || request.valueJson.Contains("\"action\"")) return new { unsupported = true };
            using (var serialized = new SerializedObject(owner)) {
                serialized.Update(); var property = serialized.FindProperty(request.target.propertyPath);
                if (property == null) throw new ArgumentException("SerializedProperty not found: " + request.target.propertyPath);
                if (property.isArray && property.propertyType == SerializedPropertyType.Generic ||
                    property.propertyType == SerializedPropertyType.Generic || property.propertyType == SerializedPropertyType.ManagedReference)
                    return new { unsupported = true };
                if (!PropertyPreviewStarts.ContainsKey(PropertyPreviewKey(owner, request.target.propertyPath))) Undo.IncrementCurrentGroup();
                var before = TakePropertyBeforeSnapshot(owner, property);
                SetSerializedPropertyValue(property, request.valueJson);
                ApplyPropertyTreeSerializedChanges(serialized, owner);
                CompletePropertySnapshotRestore(serialized, request.target.propertyPath, request.valueJson);
                var updated = serialized.FindProperty(request.target.propertyPath);
                var schema = PropertyObjectFieldSchema(updated, owner.GetType()); IncludePropertyObjectSchema(schema, known, schemas);
                var nodes = new Dictionary<string, Dictionary<string, object>>();
                CapturePropertyObjectNode(updated, null, owner.GetType(), 0, 0, 1, nodes, known, schemas);
                // Cached full-object state is no longer a delta base until captured
                // again. Other fields may have changed concurrently in the Editor.
                PropertyObjectStates.Remove(PropertyObjectKey(owner));
                return new Dictionary<string, object> {
                    { "ok", true }, { "target", PropertyObjectTarget(PropertyTreeTargetWithLocalFileIds(request.target, owner)) },
                    { "node", nodes[request.target.propertyPath] }, { "beforeSnapshot", before },
                    { "restoreState", Locus.Json.LocusJson.SerializeData(CapturePropertyRestoreState(updated)) },
                    { "dataVersion", PropertyDataVersion }, { "applied", true }, { "persisted", false },
                    { "saved", true }, { "refreshObject", false }
                };
            }
        }
    }
}
