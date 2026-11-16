---
name: view
description: >-
  Use when the user wants to build, extend or debug an in-Editor window — an inspector, table, graph, board or settings panel — or to read and change serialized properties of scene objects and assets. Both are done with plain Unity Editor C# through unity_execute (SerializedObject, SerializedProperty, EditorWindow, AssetDatabase). Ignore Unity project View classes, folders, assets, and camera/runtime views unless they are being edited as UI.
metadata:
  portedFrom: locus
  upstream: Locus/skills/view/SKILL.md
  rewrote: dsh-locus-bridge (the upstream document drives Locus's TypeScript frontend, which this plugin does not ship; this version is the same task through the tools this plugin actually provides)
---

# Editor windows and serialized properties

This skill is the DSH version of Locus's "View" document. Upstream, a View is a Vue panel compiled into the Locus frontend and driven from TypeScript (`execute_typescript`, `locus.views.*`, `@locus/view-runtime`). **None of that exists in this plugin**: there is no TypeScript runtime, no `@locus/components` package, and no View registry. Do not write TypeScript and do not look for those packages — the calls cannot resolve.

What is left is Unity's own Editor API, reached through `unity_execute`. That is enough for the same job: a dockable window, an inspector that edits real serialized data, a table or graph view. Every example below is ordinary Unity code that a `unity_execute` snippet compiles as-is (`UnityEngine`, `UnityEditor`, `UnityEditor.SceneManagement` and `System.Linq` are already imported).

## 1. Pick the right tool before writing code

| The user wants | Use | Not |
| --- | --- | --- |
| Read one object's serialized fields | `unity_execute` + `SerializedObject` (below) | text parsing of a scene file |
| Change a serialized field | `unity_execute` + `SerializedProperty` + `ApplyModifiedProperties` | hand-written YAML edit |
| A new dockable window / panel | `unity_execute` + `EditorWindow` (section 3) | a WebView |
| A drawer for a custom type | `PropertyDrawer`, then `unity_recompile` | a bespoke Inspector UI |
| Read an asset or scene file while the Editor is closed | `unity_yaml_read` / `unity_asset_search` | a script that loads a scene |
| Change many fields in one step | one snippet that batches, then a single `ApplyModifiedProperties` | one tool call per field |

Names such as `property_tree_read` and `property_tree_apply` are the **bridge-level equivalent the plugin's own tools use internally** (they are broker pipe commands, not managed APIs); they are **not callable from a snippet**, and there is no `unity_save_assets` tool. In code, write `SerializedObject`.

## 2. Edit serialized properties correctly

- **Resolve the target, then keep it resolved.** A target is a scene object (`Selection.activeGameObject`, a component found by type) or an asset (`AssetDatabase.LoadAssetAtPath<GameObject>`). Prefer `selection` from `unity_status` over searching by name.
- **Read before writing.** Property paths differ per component (`m_Script`, `speed`, `m_Rigidbody.m_Mass`). Read the object, pick the exact path from it, then write. A guessed path silently edits nothing.
- **Always go through the pair.** `new SerializedObject(target)` → edit `prop.*Value` → `serialized.ApplyModifiedProperties()` (or `ApplyModifiedPropertiesWithoutUndo` inside an existing Undo group). Skipping the apply call is the single most common reason "the value did not change".
- **Record Undo explicitly.** The bridge does not wrap your snippet in an Undo step: call `Undo.RecordObject(target, "…")` (and `Undo.RecordObjects` for a batch) before mutating.
- **One logical change, one apply.** Batch the fields of a change into one `ApplyModifiedProperties` so the Inspector sees one Undo entry, not ten.
- **Save is separate.** Property edits are in-memory and only dirty the object, exactly like the Inspector. Report that, and persist only when the user asked: `EditorSceneManager.MarkSceneDirty(scene)` then `EditorSceneManager.SaveScene(scene)` for a scene, `AssetDatabase.SaveAssets()` for an asset.
- **Prefab instances.** Editing an instance writes an override; `PrefabUtility.GetPropertyModifications(target)` lists them and `PrefabUtility.RevertPropertyOverride` removes one. Say which one you did — "changed the instance, not the prefab asset" is information the user needs.
- **Never edit a `.prefab` or `.unity` file by hand** for a property the Editor can express. A YAML writer cannot record Undo, cannot repaint, and can produce a document Unity refuses.

```csharp
// Read, edit, apply, and report the before/after — one component.
var go = Selection.activeGameObject;
if (go == null) return "nothing selected";
var body = go.GetComponent<Rigidbody>();
if (body == null) return go.name + " has no Rigidbody";

var serialized = new SerializedObject(body);
var mass = serialized.FindProperty("m_Mass");
var before = mass.floatValue;

Undo.RecordObject(body, "Set mass");
mass.floatValue = 5.5f;
serialized.ApplyModifiedProperties();

return $"{go.name} Rigidbody.m_Mass: {before} -> {mass.floatValue}";
```

## 3. A tool window, from scratch

An `EditorWindow` is the DSH replacement for "View": a dockable panel that lives in the Editor and reads the same serialized data.

```csharp
// Assets/Editor/PlayerInspectorWindow.cs — then unity_recompile, then open it.
using UnityEditor;
using UnityEngine;

public class PlayerInspectorWindow : EditorWindow
{
    [MenuItem("Tools/Player Inspector")]
    static void Open() => GetWindow<PlayerInspectorWindow>("Player Inspector");

    SerializedObject serialized;
    Vector2 scroll;

    void OnEnable() => Selection.selectionChanged += OnSelectionChanged;
    void OnDisable() => Selection.selectionChanged -= OnSelectionChanged;

    void OnSelectionChanged()
    {
        serialized = Selection.activeGameObject != null
            ? new SerializedObject(Selection.activeGameObject)
            : null;
        Repaint();
    }

    void OnGUI()
    {
        if (Selection.activeGameObject == null)
        {
            EditorGUILayout.HelpBox("Select a GameObject.", MessageType.Info);
            return;
        }

        serialized ??= new SerializedObject(Selection.activeGameObject);
        serialized.Update(); // pick up changes made outside this window

        scroll = EditorGUILayout.BeginScrollView(scroll);
        EditorGUILayout.LabelField(Selection.activeGameObject.name, EditorStyles.boldLabel);

        using (new EditorGUI.DisabledScope(Application.isPlaying))
        {
            var iterator = serialized.GetIterator();
            var enterChildren = true;
            while (iterator.NextVisible(enterChildren))
            {
                enterChildren = false;
                EditorGUILayout.PropertyField(iterator, true); // custom drawers still apply
            }
        }

        if (serialized.ApplyModifiedProperties())
            Repaint();
        EditorGUILayout.EndScrollView();
    }
}
```

Rules that keep a window from being a nuisance:

- **Redraw on the event you care about**: `Selection.selectionChanged`, `EditorApplication.update` for Play Mode, `Undo.undoRedoPerformed`. Do not `Repaint()` every frame for static data.
- **Respect the edit boundaries**: disable fields in Play Mode unless the edit is meant to be live, and use `EditorGUI.DisabledScope` rather than omitting the field (the layout must stay stable).
- **Cache the `SerializedObject`** in `OnEnable`/`OnSelectionChanged` and call `Update()` once per `OnGUI`; constructing it inside every row re-walks the whole object at ~100 Hz.
- **Saving state**: `EditorPrefs` for a preference, `ScriptableSingleton` for window state that must survive a domain reload — a plain field is reset by every `unity_recompile`.
- **New or changed `.cs` file** → `unity_recompile` before the window exists, then open it. A failed compile means no menu item, not a broken window.

For tables and graphs the same shell works: rows with `GUILayout.BeginHorizontal`, custom drawing with `Handles` / `GUI.matrix` inside rectangles obtained from `GUILayoutUtility.GetRect` so the window resizes correctly.

## 4. Validate and report

- Open what you built (`GetWindow<PlayerInspectorWindow>()` then `Repaint()`), and read `unity_console_log` afterwards: a window that throws in `OnGUI` logs an exception on every repaint and merely looks "empty".
- Report the file you created, the menu path, whether the Editor compiled it (`unity_recompile` result), what changed (before → after values), whether it is dirty or saved, and anything the user must do by hand (dock the window, select an object).
- If the request was really "show me this data" rather than "give me a window", do not build a window: read it with a `SerializedObject` snippet and answer directly. A window nobody asked for is permanent maintenance.

## 5. What this skill deliberately does not cover

These came from the upstream document and cannot work here; say so plainly instead of inventing a substitute:

- `execute_typescript`, `locus.ui`, `locus.workbench`, `locus.views.*`, `frontend-sdk.md`, `components.md`, `runtime-api.md`, `debug.md` — the Locus frontend runtime is not shipped by this plugin.
- `@locus/view-runtime`, `@locus/components`, `UnityPropertyScope`, `UnitySerializedPropertyTree`, `useUnityPropertyBinding`, `propertyDrawer.register*` — Vue-side APIs of that runtime.
- `view:<view-id>` reference lines, Workbench tabs, `locus.views.reload()` — there is no View registry to reference.
- `property_tree_read` / `property_tree_apply` / `unity_save_assets` as callable names — the first two are internal broker commands the plugin's tools use; the third does not exist.

If the user explicitly asks for a Locus View (a Vue panel in the Locus app), tell them this plugin does not ship the Locus frontend and that the equivalent here is a Unity `EditorWindow`. Section 3 is that equivalent.