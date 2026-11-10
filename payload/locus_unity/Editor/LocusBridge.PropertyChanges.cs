using System;
using System.Collections.Generic;
using UnityEditor;

namespace Locus
{
    public static partial class LocusBridge
    {
        private static readonly string PropertyDataDomain = Guid.NewGuid().ToString("N");
        private static long _propertyDataRevision;
        private static long _lastPropertyDataPublished = -1;
        private static string PropertyDataVersion => PropertyDataDomain + ":" + _propertyDataRevision;
        [Serializable] private sealed class PropertyDataChangeSet {
            public string fromVersion;
            public bool full;
            public string[] objects;
        }
        private static bool _propertyDataFullChange;
        private static readonly HashSet<string> PropertyDataChangedObjects = new HashSet<string>(StringComparer.Ordinal);
        private static void AdvancePropertyDataVersion() { ++_propertyDataRevision; _propertyDataFullChange = true; PropertyDataChangedObjects.Clear(); }
        private static void AdvancePropertyDataObject(UnityEngine.Object target) {
            ++_propertyDataRevision;
            if (_propertyDataFullChange) return;
            AddPropertyDataObjectKey(target);
            // A GameObject rename also changes the names/locators exposed by
            // references to its components, without changing those references.
            if (target is UnityEngine.GameObject go)
                foreach (var component in go.GetComponents<UnityEngine.Component>())
                    if (IsPropertyAuthoringTarget(component)) AddPropertyDataObjectKey(component);
        }
        private static void AddPropertyDataObjectKey(UnityEngine.Object target) {
            if (_propertyDataFullChange) return;
            if (PropertyDataChangedObjects.Count >= 256) { _propertyDataFullChange = true; PropertyDataChangedObjects.Clear(); return; }
            PropertyDataChangedObjects.Add(GlobalObjectId.GetGlobalObjectIdSlow(target).ToString());
        }
        private static PropertyDataChangeSet TakePropertyDataChanges() {
            var result = new PropertyDataChangeSet {
                fromVersion = _lastPropertyDataPublished < 0 ? null : PropertyDataDomain + ":" + _lastPropertyDataPublished,
                full = _propertyDataFullChange || _lastPropertyDataPublished < 0,
                objects = new List<string>(PropertyDataChangedObjects).ToArray()
            };
            _propertyDataFullChange = false; PropertyDataChangedObjects.Clear(); return result;
        }
        private static void TrackPropertyDataChanges()
        {
            Undo.undoRedoPerformed += AdvancePropertyDataVersion;
            EditorApplication.projectChanged += AdvancePropertyDataVersion;
            EditorApplication.hierarchyChanged += AdvancePropertyDataVersion;
            ObjectChangeEvents.changesPublished += OnPropertyDataChanges;
            EditorApplication.playModeStateChanged += _ => AdvancePropertyDataVersion();
        }
        private static void OnPropertyDataChanges(ref ObjectChangeEventStream changes)
        {
            // Playing transforms are not an authoring-cache invalidation every
            // frame. Live runtime reads remain available through explicit refresh.
            if (EditorApplication.isPlaying) return;
            for (int i = 0; i < changes.length; i++)
            {
                UnityEngine.Object target = null;
                switch (changes.GetEventType(i))
                {
                    case ObjectChangeKind.ChangeAssetObjectProperties:
                        changes.GetChangeAssetObjectPropertiesEvent(i, out var asset);
#if UNITY_6000_5_OR_NEWER
                        target = EditorUtility.EntityIdToObject(asset.entityId);
#else
                        target = EditorUtility.InstanceIDToObject(asset.instanceId);
#endif
                        break;
                    case ObjectChangeKind.ChangeGameObjectOrComponentProperties:
                        changes.GetChangeGameObjectOrComponentPropertiesEvent(i, out var component);
#if UNITY_6000_5_OR_NEWER
                        target = EditorUtility.EntityIdToObject(component.entityId);
#else
                        target = EditorUtility.InstanceIDToObject(component.instanceId);
#endif
                        break;
                    default: continue; // Structural/project events have dedicated hooks above.
                }
                if (IsPropertyAuthoringTarget(target)) AdvancePropertyDataObject(target);
            }
        }
        private static bool IsPropertyAuthoringTarget(UnityEngine.Object target)
        {
            if (!target || (target.hideFlags & UnityEngine.HideFlags.DontSave) != 0) return false;
            if (EditorUtility.IsPersistent(target)) return true;
            var go = target as UnityEngine.GameObject ?? (target as UnityEngine.Component)?.gameObject;
            return go && go.scene.IsValid() && go.scene.isLoaded &&
                !UnityEditor.SceneManagement.EditorSceneManager.IsPreviewScene(go.scene) &&
                (go.hideFlags & UnityEngine.HideFlags.DontSave) == 0;
        }
    }
}
