---
name: view
description: >-
  Use when the user asks to control or debug the Locus frontend through TypeScript, or build or edit a Locus View (视图/面板): a Vue UI panel, inspector, table, board, or graph editor. Ignore Unity project View classes, folders, assets, and camera/runtime views.
metadata:
  portedFrom: locus
  upstream: Locus/skills/view/SKILL.md
---

# View

## Instructions

All operations use the skill-loaded `execute_typescript` tool, which executes TypeScript in the live Locus frontend. For frontend control without creating a View, read `frontend-sdk.md` and use `locus.ui` / `locus.workbench` directly. For View authoring, follow this workflow.

1. Resolve the target View.
   - Use `locus.views.list()` first when a matching View may already exist. To change an existing View, reuse its `packageRoot` and continue from step 3.
   - For a new View, prefer a single Vue file: pass `fileName` and complete `component` source to `locus.views.create()`. Put logic, template and scoped styles in that file. No metadata is required; the file name without `.vue` becomes the id and display name.
   - Read `components.md` to choose existing controls and editors. `locus.views.components()` lists the native component names. Compose these components in the Vue file; View creation does not select or copy a template.

2. Create the package with `locus.views.create()`.
   - Use lowercase kebab-case file names, for example `asset-panel.vue`. `id` can be omitted when `fileName` is supplied. Alternatively, supply `id` and Locus names the file `<id>.vue`.
   - A component View contains one root `.vue` file in its own `packageRoot`, with no `view.json`, `main.ts`, independent CSS or workspace scaffold. Optional metadata goes in a leading `<view>` JSON block (see `frontend-sdk.md`); omit the whole block when defaults suffice. `name`, `icon`, `displayPath` and `unity` creation options are written into that block only when supplied.
   - `icon` accepts any bundled Lucide name (for example `Swords` or `alarm-clock`) or an inline SVG string. Use `viewBox` and `currentColor` for custom SVG icons; see `frontend-sdk.md` for the supported static SVG subset and size limit.
   - Omit `component` to initialize a minimal empty Vue file and write the implementation afterwards. Optional `directories`, for example `["src/components", "unity"]`, create only those directories inside `packageRoot`. There is no template parameter or template catalog.
   - Set `temporary: true` for one-off display Views. They are written under the app temp directory, stay out of `Locus/View` and `locus.views.list()`, and the requested id gains a unique suffix — use the returned id everywhere afterwards.
   - `displayPath` only changes the user-visible View tree path. `packageName` picks the workspace folder under `Locus/View` and defaults to the Unity project name.
   - Set `unity: true` only when a connected Unity editor is required. Component selection never implicitly adds a Unity dependency or a C# script.

3. Edit only inside the returned `packageRoot`.
   - Read `detail.manifest.entry` to locate the actual Vue entry for a component View; do not assume `src/App.vue`. The returned manifest is derived by Locus from the file name and optional `<view>` block. Do not write it back as `view.json` or add schema, version, entry or style metadata to the component.
   - Existing multi-file packages with `view.json` remain readable; inspect their actual entry and dependencies before editing. All paths remain package-relative with forward slashes.
   - Additional modules may be created under `src/` when needed. Optional Unity scripts live under `unity/`; declare them in the component's `<view>` `scripts` array or the legacy `view.json`.
   - Code shared across Views in the same workspace lives in the workspace `src/` and is imported as `@locus/project-view`.

4. Resolve API details through the stable View contract, in this order:
   - `components.md`: reusable component choices and small composition examples. Prefer native component props, slots and events over recreating controls or copying whole pages.
   - `runtime-api.md` in this skill package: the quick reference for `@locus/view-runtime` services (Unity property editing, drawers, drag/drop, graph/canvas, session, LLM, storage, fs, logs) and `@locus/components` components. Locate it with `knowledge_query`, then `read` the returned physical path.
   - Exported runtime sources under this skill package's `app/view-runtime/src/`: exact component props, graph/canvas data shapes, and release behavior.
   - Locus application sources: only present in a development checkout. Installed releases do not ship them, so never depend on them from package code or instructions.

   For Markdown-backed tables, boards and editors, use `documents` from `@locus/view-runtime` (also `locus.documents`). Use workspace/Knowledge references, read properties and body, and save with the returned revision. Keep business data in the original documents. See `frontend-sdk.md` → Markdown documents for discovery, typed edits and lifecycle-managed change notifications; do not implement frontmatter writes using raw `fs.writeFile` or persist a second editable copy in View storage.

   Typical starting imports:

```ts
import { view, unity, property, onEditorUpdate } from "@locus/view-runtime";
import { UnitySerializedPropertyTree, GraphView } from "@locus/components";
```

5. Use the right runtime path for Unity data.
   - Default for configuration pages: `UnityPropertyScope :target="resolvedTarget"` containing `UnityPropertyField path="serialized.path"`. Display bindings are the demand declaration; do not maintain a second field list, fetch in each component, or implement a private cache/queue. Custom controls use the field slot or `useUnityPropertyBinding`. Locus owns object-level value caching, static Schema, compact Live snapshots, incremental receipts, invalidation and local drafts. Pass project read-only/Play Mode constraints through the scope. See `components.md` → Component-driven Unity data.
   - Custom setters must invalidate the affected target with `property.invalidate(target)`; use `tree.refresh()` when an authoritative reread is required. Do not replace the default writer with raw YAML, discard Undo, or save/import after every keystroke. A Live `applied` receipt is not disk `persisted` completion.
   - Keep TypeScript/C# for domain queries and semantic guards that cannot be inferred from serialized fields; do not bypass those checks when migrating to default fields.
   - `SerializedProperty` editing from package code: `property.fromPath("asset/<assetPath>/property/<propertyPath>")` — also `selection/…`, `guid/<assetGuid>/…`, `scene/…`, and `prefab/…` path forms — then `tree.drawDefaultEditor()`, `tree.require(path).draw()`, `property.write(target, value)`, or batched `property.apply([...])`.
   - For existing bound-tree forms, use `tree.require(path).drawDefaultEditor()` / `.write(value)`. Bound scalar edits keep local drafts, merge authoritative receipts and preserve the mounted controls; `tree.pending` and `tree.error` are status, not reasons to disable the form. Do not add a `saving` guard that drops edits, change component keys per commit, or reread a whole page after each scalar change. See `runtime-api.md` → Continuous property editing for conflict/Undo behavior.
   - Unknown property paths: `locus.unity.property.discover()` before hardcoding any path. Agent-side spot checks and one-off fixes: `locus.unity.property.read()`, `.write()`, `.apply()`.
   - Custom property rendering: `propertyDrawer.registerValue/registerField/registerAttribute/registerPropertyPath/register`, passed as `propertyDrawers` into `UnitySerializedPropertyTree`, `UnityPropertyDraw`, or `UnityObjectPreview`. Whole-object rendering: `unityObjectDrawer.register(...)`, passed as `objectDrawers` into `UnityObjectPreview`. App-wide drawers (affecting chat fences and the Locus Inspector, not just this View) ship as plugin drawer packages instead — see `runtime-api.md` "Plugin Drawer Packages".
   - Custom Unity logic: declare the C# file in `<view>` `scripts[]` (or legacy `view.json`), then call it with `view.callScript` from package code or `locus.views.compileScript()` + `locus.views.callScript()` from the agent.
   - Selection-driven panels: `onEditorUpdate(handler)`. Unity selection and inspectors: `unity.select(...)`, `unity.inspect(...)`, `unity.selectAsset(...)`, `unity.selectSceneObject(...)`.
   - Locus <-> Unity drag and drop: `useUnityReferenceDrag`, `useUnityAssetDropTarget`, `UnityReferenceChip`, `UnityDropZone`.
   - LLM-assisted semantic editors: `view.session` and `view.llm`.

6. Keep the UI aligned with Locus / Unity Editor tool style.
   - Prefer panels, split panes, inspectors, tables, trees, toolbars, and workspaces.
   - Keep controls compact, neutral, and useful for long editing sessions. Use existing tokens for surfaces, borders, text, hover states, and accent color.
   - Use state badges only for strong statuses such as running, error, modified, enabled, or disabled.
   - Avoid marketing-style hero areas, decorative gradients, heavy shadows, oversized cards, colorful chip clusters, and continuous animation.

7. Validate, debug, and report.
   - Run `locus.views.reload()` after edits: it validates the manifest and refreshes an open host. `locus.views.open()` creates and activates a permanent Workbench tab, or activates the existing tab for that View in the current window and checkout. It preserves other tabs and returns a handle bound to the selected instance.
   - If the View fails to load or misbehaves, locate `debug.md` with `knowledge_query`, then `read` the returned physical path. Reading a registered Skill document activates its debugging tools through the single `execute_typescript` TypeScript tool. Check `panel.logs()` first for frontend runtime errors.
   - When the user-facing reply should reference the finished View, put a standalone line in this exact format: `view:<view-id>`, using the id returned by `locus.views.create()`, `locus.views.list()`, or `locus.views.reload()`. The Locus frontend renders that line as a View reference block with an Open View button.
   - Report the View id, `packageRoot`, actual source file, reload or run result, and the standalone `view:<view-id>` reference line.

All View authoring and debugging calls run as TypeScript through `execute_typescript`. Read `frontend-sdk.md` for the shared native frontend SDK. Views are ordinary Workbench Vue subtrees; do not create another WebView or app-wide window globals.
