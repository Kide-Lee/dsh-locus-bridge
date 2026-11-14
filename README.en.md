# dsh-locus-bridge

[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.12-339933?style=flat-square&logo=node.js&logoColor=white)](package.json)
[![Unity](https://img.shields.io/badge/unity-2022.3-000000?style=flat-square&logo=unity&logoColor=white)](https://github.com/Kide-Lee/dsh-locus-bridge)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-4b5563?style=flat-square)](https://github.com/Kide-Lee/dsh-locus-bridge)
[![Upstream: Locus](https://img.shields.io/badge/upstream-r1n7aro%2FLocus-2d6cdf?style=flat-square&logo=github)](https://github.com/r1n7aro/Locus)

English | [简体中文](README.md)

dsh-locus-bridge is a **DeepSeek harness plugin**. It lets DSH act directly as a Locus client and operate the Unity editor through the Locus native broker.

This project's `native/` directory contains two Rust crates: `locus_unix_native` (the Linux/macOS native broker built by this project) and `locus-native-protocol` (the upstream protocol crate). They build `liblocus_unity_native.so`, which the C# plugin inside Unity calls.

For more information about Locus, see:

- Upstream project: https://github.com/r1n7aro/Locus
- Documentation: https://unity.farlocus.com

## How it works

Locus is not an ordinary "client / server" structure. **The Unity side is the server**: the `locus_unity_native`
Rust dll is loaded in-process by the editor, exposing a named pipe (Windows) or a Unix domain socket
(Linux/macOS), and because the dll itself stays resident, it survives domain reloads. The Locus desktop app is a
client of that socket, and so is this plugin — it implements the same "one JSON per line" protocol, so the Unity
side needs no code changes.

A request looks like `{"id": "...", "type": "<command>", "message": "<string>"}`, and responses carry `reply_to`,
so one connection can multiplex concurrent calls. Error codes such as `managed_reloading` or
`native_request_timed_out` mean the request was **not executed** and can be retried safely; the client relies on
exactly this distinction to reconnect across a domain reload instead of declaring the call dead.

## Install

You can enter the following prompt in DSH and let the AI install this plugin:

```
Please install the plugin https://github.com/Kide-Lee/dsh-locus-bridge for me. If my Unity project does not have the Locus plugin, please install that for me too.
```

Or you can install it manually after cloning this project:

```bash
dsh plugin --profile <profile> add /path/to/dsh-locus-bridge
```

You can also install straight from GitHub:

```bash
dsh plugin --profile <profile> add github:Kide-Lee/dsh-locus-bridge
```

After restarting DSH, the model sees 11 tools whose names start with `unity_`, plus 6 `code_*` C# analysis tools (disable the latter with
`DSH_LOCUS_CSHARP=0`).

### Editor prerequisites

1. The `locus_unity` Unity package (`com.farlocus.locus`) is installed in the project.
2. The native broker library for the platform is in place — on Windows it is `locus_unity_native.dll`, on
   Linux/macOS it is `liblocus_unity_native.so`. The bundled payload carries both platforms, so neither needs
   to be built locally.
3. `<project>/Library/Locus/NativeBridge.enabled` exists, or the editor was started with
   `LOCUS_UNITY_NATIVE_BRIDGE=1`. On Linux the first line of that marker is read as an absolute socket path,
   because inside a sandbox the socket cannot live in `/tmp`.

**Two prerequisites that are easy to blame elsewhere, so confirm them first:**

- **Another `Newtonsoft.Json` in the project breaks the whole build.** The bundled `Locus.Json.dll` is an
  ILRepack merge; even though the Newtonsoft types are internalized, a second `Newtonsoft.Json.dll` in the
  project (some GitHub-installed packages ship one) produces a wall of `error CS0433` type-ambiguity errors and
  `Assembly-CSharp` never loads — that takes down every game script, not just this plugin. Remove one of the
  two and retry; a `unity_status` that never gets capabilities is usually this.
- **`unity_test` needs `com.unity.test-framework >= 1.4.0`.** The bundled
  `Editor/Testing/Locus.UnityTesting.Editor.asmdef` uses `versionDefines` with the
  `LOCUS_HAS_UNITY_TEST_FRAMEWORK` constraint, so on an older version the whole assembly is excluded and the
  four `unity_test_*` commands are never registered — calls fail with `unknown message type: unity_test_list`.
  The tool says so when it fails; the test framework itself still works, this plugin just cannot drive it.

**`unity_asset` only supports text serialization.** It goes through Unity's `SerializedObject` text-YAML
channel, so the project needs `Editor Settings → Asset Serialization` set to `Force Text` (the Unity 2022
default). On a binary-serialized project `read` / `apply` answer
`unsupported_capability: asset is not Unity text YAML`; use `unity_scene` or `unity_execute` there.

A failed `unity_status` **automatically** reports what the project is missing, so a diagnosis costs no extra
call. Only when it finds **no Unity package** does it also print the install command:

```bash
node scripts/install-unity-package.mjs <project> --install
```

That copies the bundled package into `Packages/com.farlocus.locus`, writes
`Library/Locus/NativeBridge.enabled`, and verifies the result. It requires the editor to be closed.

**A running editor is refused.** The test is `<project>/Temp/UnityLockfile`: Unity creates it on
launch and holds an exclusive lock, while a file left by a crash does not count (taking the lock
proves nobody owns it). When it is held the install never starts, exits 2, and asks for a restart:

```
The Unity Editor has <project> open. Close the editor and run this again: ...
```

Failing halfway instead is worse than useless: on Windows removing the old package fails with
`EPERM`, and even where the delete succeeds the editor keeps the assemblies it already loaded, so
the next reload misbehaves for reasons nothing local explains.

When the project is fine and only the editor is shut, the diagnosis prints **nothing**: "the package is in
place" is the absence of a finding, and no finding costs no context. The tool definitions therefore match the
official client's exactly: installing is rare enough that it must not occupy context permanently.

### Install source

`payload/locus_unity` is the compiled Unity package (233 files, about 15 MB, of which
`Editor/Roslyn/Locus.Roslyn.dll` is 9 MB). It is deliberately not fetched from upstream git: upstream's
`.gitignore` drops `Locus.Json.dll`, `Locus.Detour.dll`, `Locus.HotReload.Runtime.dll`, `Locus.Roslyn.dll`
and the native broker, so `"com.farlocus.locus": "https://github.com/...?path=locus_unity"` installs a
package that **does not compile**. Vendoring a complete copy is the only source that works on every platform.

The package carries the native broker for **both platforms**, so the same payload connects directly on
Windows and on Linux/macOS:

| Platform | Path | Built from |
|---|---|---|
| Windows x86_64 | `Editor/Native/x86_64/locus_unity_native.dll` | the upstream `locus_unity_native` crate (`cargo build --release`) |
| Linux x86_64 | `Editor/Native/linux-x86_64/liblocus_unity_native.so` | this repository's `native/locus_unix_native/` (`npm run build:native`) |

The Windows file is the upstream crate itself, unmodified, and its 44 exported symbols match upstream's
`locus_unity_native/exports.txt` name for name (Unity binds by those names across versions).

Regenerate it with `npm run sync:payload` from a local Locus checkout (`--check` verifies without writing).
The 15 MB tree stays out of the npm tarball but ships inside the release ZIP at `payload/locus_unity`; point
`DSH_LOCUS_PAYLOAD_DIR` at an unpacked copy to keep it outside the plugin directory.

## Tools

| Tool | What it does | Underlying commands |
|---|---|---|
| `unity_status` | Connection check, editor state (editing/playing/playing_paused), open scenes, capabilities, domain reload state; diagnoses a missing package/broker/marker automatically, and prints the install command when the package is absent | `status` / `bridge_capabilities` / `get_reload_state` |
| `unity_execute` | Compile and execute a C# method body on the Unity main thread (`print`/`printJson`/`ctx.Progress`/`ctx.WaitFrame`), the escape hatch | `status` → `begin_edit_session` → `execute_code` + 250ms `execute_code_progress` → (cancel) `cancel_execute_code` → `end_edit_session` |
| `unity_run_states` | Drive Unity across frames with a C# state machine (`start`/`update`/`end`) and no 30-second idle watchdog for long observations; output up to 100k tokens is inline, 100k–1M is saved under `Library/Locus/RunStates`, and larger output is refused | `status` → `run_states` |
| `unity_play_mode` | Switch to Play/Edit mode and wait for it to take effect | `status` → `set_editor_status` → poll `status` |
| `unity_console_log` | Read the Unity Console (merged and deduplicated by level) | `unity_get_console_log` |
| `unity_recompile` | Compile + domain reload + wait across the disconnect for convergence; `editor_status` is required and must match the live state; `sync: none/targeted/full` controls asset import | `request_recompile` → disconnect → reconnect → poll `get_compile_result` |
| `unity_test` | Discover and run Unity Test Framework tests, waiting for structured results (`list` / `run`) | `unity_test_list` / `unity_test_start` → 250ms `unity_test_status` → (cancel) `unity_test_cancel` |
| `unity_asset` | Read serialized assets; revision-guarded atomic edits (`set` and array operations); undo; reload | `asset_api` (read / apply_batch / disk_reload) |
| `unity_asset_graph` | Asset reference graph and script usages: `references` / `dependencies` / `usages` | generated `execute_code` (GUID comparison against serialized fields) |
| `unity_capture` | Capture the Game / Scene view or an Editor window, with the image attached to the result (`ImageBlock`) — visible in one call | `capture_viewport` + `attachments.saveImage` |
| `unity_scene` | Scene object search (by name, and `find` by component type), property tree read, atomic `set`, single-transaction `batch` and `undo` | `search_scene_objects` / `property_tree_read` / generated `execute_code` |

`unity_execute` and `unity_test action:"run"` also accept a host-injected `async` argument with Locus's semantics: `sync` (the default) waits for the result; `async` returns a job id immediately, sends no completion notice, and leaves the result for `job_output`; `notify` returns immediately and has the completion delivered automatically. Jobs are owned by the DSH jobs service, can be cancelled with `job_kill`, and live only in this Session. Running in the background only frees the agent: the work still runs on Unity's main thread and keeps the 30-second no-output limit and the tool's own `timeout`. `unity_run_states` stays synchronous, matching upstream.

### C# semantic analysis (optional, independent of the Unity connection)

These six tools do not touch the broker: they start a local Roslyn language server (`dotnet` child
process) and speak LSP over stdio, so they work with Unity closed as long as the `.sln`/`.csproj`
exist.

| Tool | Purpose |
|---|---|
| `code_symbol_search` | Find C# symbols by name or camel hump |
| `code_goto_definition` | Jump to a definition across files, asmdefs and packages |
| `code_find_references` | Semantic references (overloads, generics, partials, using aliases; comments and strings excluded) |
| `code_hover` | Signature, type and XML documentation |
| `code_diagnostics` | Roslyn compiler errors plus Roslyn and Unity analyzers, without a Unity compile |
| `code_analysis` | Inspect, install, warm, restart or reset the backend (`status` / `install` / `warm` / `restart` / `reset`) |

The first use needs `code_analysis action:"install"`, which fetches about 90 MB (a ~60 MB Roslyn
server; the ~30 MB runtime is skipped when the machine already has .NET 10). It can be switched off in
Settings, or forced off deployment-wide with `DSH_LOCUS_CSHARP=0` (a deployment switch the settings page
cannot override).

All three copy upstream's approach, but they are constrained by "this plugin is only a broker client", so the
limits are worth stating.

- **`unity_test`**: served by `Editor/Testing/LocusUnityTestService.cs` shipped in the payload: it already
  registers `unity_test_list` / `unity_test_start` / `unity_test_status` / `unity_test_cancel`, so nothing on the
  Unity side changed and the plugin only drives them. The 250 ms cadence and the "cancellation must be observed
  reaching a terminal state" rule mirror upstream's `unity_bridge/mod.rs::unity_test_run_controlled`. A timeout
  also cancels, so a lost caller never leaves a run holding the editor. The asmdef is conditionally compiled on
  `LOCUS_HAS_UNITY_TEST_FRAMEWORK`; without `com.unity.test-framework >= 1.4.0` those commands do not exist and
  the call surfaces Unity's own error.
- **`unity_asset_graph`**: upstream answers from its Rust `asset_db` index, which this plugin does not have. The
  broker's `search_yaml` **cannot** stand in for it: it matches GameObject names and hierarchy paths only and
  **never searches field values**, so passing a GUID as `query` always yields `Total matches: 0` (a scene with
  400 `Localizer` instances still returns 0). These actions therefore run a generated `execute_code` snippet over
  the scenes: the GUID from the asset's `.meta` is compared against the `m_Script` / reference slots Unity
  actually serialized. The cost is **no project-wide scan** — the snippet only walks the currently open scenes,
  so `references` and `usages` need `file_path` from the caller, and a `.prefab` must be open in the editor to be
  scanned. Results cover Unity's serialized data; binary assets, custom serialization, presets and references
  assembled from strings at runtime are not included.
- **`unity_capture`**: takes the same route as `read_image`: it captures a PNG, hands it to the Host's
  `attachments.saveImage`, and attaches an `ImageBlock` to the tool result, so **one call returns both the text
  summary and the image itself** with no second read. The image-capability check (`llm.resolveModelInfo`'s
  `inputModalities`) runs before the attachment is committed, so a text-only model is refused rather than
  storing an image it can never see. Without an attachment service the call degrades to a path-only text
  result.

## Right-Sidebar asset preview and editing

In the Web GUI (`dsh web`) the right Sidebar can open and edit Unity assets the way the Inspector does. Click a
`.prefab` / `.asset` / `.mat` / `.anim` / `.controller` file in the file tree (or hand its
`dsh-resource://file/...` address to the Sidebar) and it opens in this plugin's `locus-asset` tab.

It **is** Locus' own call path — nothing re-implements Unity's serialization in the browser:

| Panel action | Broker command | Locus counterpart |
|---|---|---|
| read the property tree | `property_tree_read` | `UnitySerializedPropertyTree` / `LocusPropertyTree` |
| edit one field | `property_tree_apply` (one write) | `unityPropertyApi.write` (also an in-memory edit that dirties the object) |
| save to disk | `execute_code` following `SaveAssetApiScopeAllowed`'s branches | the desktop app leaves saving to the editor; the browser gets an explicit button |
| thumbnail | `asset_thumbnail` | `AssetPreview.GetAssetPreview` |
| orbitable prefab preview | `asset_preview_render` | `PreviewRenderUtility` |
| `.fbx` / `.glb` model | `GET /locus/api/model` + browser three.js | `ModelViewer` (WebGL parses the model bytes) |
| reveal in the editor | `select_asset` | Project-window ping |

Formats: `.prefab` (hierarchy + components + fields, with an orbitable preview), `.asset` / `.mat`
(ScriptableObject and material fields), `.anim` (clip fields), `.controller` (a sub-asset summary table).
Models take two paths: `.fbx` / `.glb` are parsed directly by the browser three.js viewer, with animation,
wireframe, clay, grid and statistics; other model formats (`.obj` / `.dae` / `.gltf`, …) still go through
Unity's `PreviewRenderUtility` when the project has the matching importer. `.unity` scenes are **read-only**:
reading one requires the scene to be loaded in the editor, and "opening it rewrites what the editor has open"
is not a decision a file viewer should make. A write is refused with the reason.

Prefab orbit frames are requested continuously while dragging (90 ms floor, one Unity render in flight at a
time) and once more on pointer-up. The last frame and its camera are written to
`Library/Locus/asset-preview-cache/` (Locus' directory layout; this plugin hashes with SHA-256 while Locus
uses BLAKE3, so the two keep independent entries); reopening restores that angle, and the sidecar is
invalidated by the source file's mtime. The three.js viewer is a lazy, separate bundle
(`lib/model-viewer.js`) and never enters the main client bundle; rebuild it with `npm run build:viewer`.

Behaviour worth knowing, all of it Unity's own semantics:

- Edits are **in-memory**: the field takes effect and the object turns dirty, while the file on disk does not
  change. **Save** writes it; **Revert** writes every field this tab changed back to the value it had when the
  tab opened. Unity's own Ctrl+Z is not involved — that undo stack lives in the editor process, not in a
  browser session.
- Fields inherited from a prefab are not writable (Unity answers `unsupported_capability`, and the panel shows
  why). A derived array such as `Renderer.m_Materials` may have its element insert silently ignored by Unity,
  so after a structural write the panel **re-reads the node** and shows what the editor actually holds.
- Every write goes through the same revision/undo semantics as the tools; while a domain reload runs the panel
  says "Unity is busy" and offers a retry.
- The browser can only name project-relative `Assets/…` paths. The Host resolves the project root and refuses
  anything that escapes it.

The routes live under `/locus/api/*`, register only on a Host that has a `webServer` (so CLI/TUI sessions are
unaffected), and pass DSH's browser-trust fence (`ctx.connection.requestRejection`).

Two address rules are worth stating, because both cost real debugging time:

* A file address is **relative to the session's working directory**, and the Unity
  project may live below it (a `Project/` folder inside the workspace). The Host
  resolves the address against that directory and then re-expresses it as a
  project-relative `Assets/…` path, so both spellings work; anything escaping the
  project is still refused.
* The Sidebar picks a tab type by `(priority band, pattern length, registration
  order)`, and generic file editors — `dsh-better-sidebar` is the common one —
  register `dsh-resource://file/**` (22 characters). This plugin therefore claims
  whole, scheme-qualified patterns such as `dsh-resource://file/**/*.prefab`
  (≥28 characters); with a short `*.prefab` every prefab would open in the text
  editor instead.

### UI language

The panel's copy follows the DSH i18n system, the same way the official UI
plugins do: the client `apply` attaches `ctx.locale` and registers two
dictionaries (`zh` / `en`) under the `locusBridge` namespace. `t()` resolves the
active language from the locale service's `getSnapshot().active`, so **switching
the language in Settings re-renders the panel immediately** — no need to reopen
the tab.

The `locale` service is deliberately **optional** (it is not in `inject`): with
no locale plugin mounted (or in a bare test composition) `t()` falls back to
`navigator.language`, then to English, and never renders raw keys. Diagnostic
bodies coming from Unity are arbitrary technical text, so only their severity is
localised (warning / error / info); the message itself stays verbatim —
translating it would mean inventing Unity's wording.

## Settings

DSH's Settings has a **Unity bridge** page (`settings.section`, id `dsh-locus-bridge`) with three groups:

- **Workspace**: pick a workspace, pick a Unity project, see or install the Locus plugin;
- **Features**: three feature switches. A change takes effect immediately with no restart: the page `POST`s
  to `/locus/api/settings`, the Host re-registers its tool set, and the `preview` plane makes the client
  re-read the switch (on window focus) and register or dispose the tab type accordingly.
- **Domain skills**: five skills, one switch each (see [Domain skills](#domain-skills)).

| Switch | What turning it off does |
|---|---|
| **Unity control** | The eleven `unity_*` tools leave the model's tool list (the Host unregisters them; they are not merely hidden) |
| **C# analysis** | The six `code_*` tools leave, and any Roslyn language-server processes already started are closed |
| **File preview** | The right-Sidebar Unity asset tab is no longer registered, and every Unity-backed `/locus/api` route answers `feature_disabled` |

`preferences.frameCache` (cache preview frames inside the project) stays in `settings.json`, but the page no
longer offers a switch for it: writing rendered frames into a project is a storage choice that belongs to asset
browsing, not beside the feature planes.

Design notes:

- **Stored in the plugin's own file, not in `cordis.patch.yml`.** The path is
  `<user data dir>/locus/locus-bridge/settings.json` (Windows: `%APPDATA%\locus\locus-bridge\settings.json`);
  `DSH_LOCUS_BRIDGE_HOME` relocates it. The patch layer is configuration a human edits by hand, and a settings
  page rewriting it would fight every manual edit and every `plugin_manager` write.
- **`DSH_LOCUS_CSHARP=0` still wins.** That is a deployment statement ("this profile must not carry the
  surface"), so the page renders it as locked instead of as a usable switch; the user preference lives inside
  that envelope.
- **A malformed file falls back to the defaults.** A broken JSON document costs a preference, never the whole
  tool set.
- **Non-boolean values are not coerced.** `"off"` or `0` falls back to that key's default; guessing either way
  would silently keep a plane on or silently switch one off.

### Workspace

The **Workspace** picker lists the workspaces DSH has already registered (the Host's `workspaceRegistry`);
choosing one stores its path in `preferences.workspacePath` and decides where the project scan looks and which
project the domain skills' C# capabilities are activated in. With nothing selected the page falls back to the
Session's own workspace.

The search direction is only downward: **the workspace itself and its subdirectories**. The plugin no longer
looks in ancestor directories or in siblings beside a workspace — with several checkouts in one repository, that
search used to attach a Session to the wrong project.

The **Unity project** picker lists the projects that scan found; the choice is stored in
`preferences.unityProject` and reused next time, falling back to the first scanned project when it disappears.
Below it, the **Locus plugin** row reports the selected project in a capsule with four states:

| Capsule | Meaning |
|---|---|
| **Connected** | The package is installed and something answers on the broker endpoint |
| **Unity not open** | The package is installed but the editor has not opened this project |
| **Connection failed** | The editor is open but the native bridge never started (check `Library/Locus/NativeBridge.enabled`) |
| **Not installed** | The project has no Locus package, or an incomplete one; the row offers **Install** |

The Workspace, Features and Domain skills groups each sit in their own bordered card, and the row geometry
matches the host Settings page.

The install button is deliberately narrow:

- **It installs; it never launches Unity.** It writes the marker the editor's native bridge starts on, then
  tells you to reopen the editor.
- **It refuses while the editor has the project open** (409 `editor_running`) — the editor holds the package
  assemblies. The page turns that refusal into a sentence rather than printing the status code.
- **It only handles projects this scan would show**, so the button never becomes an arbitrary directory copier.

`Temp/UnityLockfile` (is the editor open) and an endpoint probe (is anything listening) decide the connection
state; "No plugin" is a filesystem fact, not a connection problem.

### Domain skills

Five skills, one switch each. Turning a row on puts that skill into the model's catalog, loadable with the
`skill` tool; turning it off removes it again. There is no master switch and nothing is written into the
workspace: the skills follow the plugin version, so an upgrade cannot leave a stale copy behind in a project.

They appear only in a workspace that holds a Unity project: the provider gates its catalog on the session's
working directory, so a non-Unity conversation does not pay for these entries. The documents with no DSH
equivalent are kept:

| Skill | Covers | Executable C# |
|---|---|---|
| `debugger` | PlayerLoop/Tick positioning, cross-frame conditions, paused inspection, native thread stacks | — |
| `profiler` | CPU/GPU/memory/GC samples, baseline comparison, marker call paths | — |
| `graphics-debugger` | Frame Debugger events and render targets, RenderDoc capture/replay | `FrameDebuggerApi`, `RenderDocCaptureApi` |
| `ui-toolkit` | Unity 6.3+ UI Toolkit layout, style and interaction debugging | `UIToolkitApi` |
| `view` | Locus View panels (Vue UI, inspector, table, graph editors) | — |

The two skills that carry C# activate **implicitly**: once a switch is on, the first `unity_execute` in that
project hands the shipped sources to the editor's own `compile_skill_package`, which compiles them into an
assembly and keeps it active, so a later snippet can call them with `using Locus.Skills;`. There is no button
and no separate activation step; the target is the project in the **Unity project** dropdown above, and several
projects in one workspace need no extra choice. A failed compile is retried at most once a minute.

Injection does not depend on the project count: a switch decides whether that skill reaches the prompt, and the
C# compile is an addition on top.

After that, neither a domain reload nor a plugin upgrade needs a manual click: the next `unity_execute` reads the
editor's `domain_generation`, recompiles silently when it moved (a cache hit makes it near-free), and a changed
source hash triggers the same recompile. A failed compile is retried at most once a minute, so a package that
cannot build never holds up every snippet.

`RenderDocCaptureApi` only gets compiled and activated: an actual RenderDoc capture still needs the Python
helpers and the `renderdoc` module that only the Locus desktop app carries, so only the Frame Debugger half of
the graphics skill is complete here. Repeating the activation is idempotent — an assembly that is already
current is reused from the editor's cache.

## Differences from the Locus desktop client

- **The session working directory does not have to be the Unity project.** The plugin searches up to three
  levels downward, breadth-first, and never upward or into a directory beside the workspace; an explicit
  `project_path` always takes precedence.
- **No Locus desktop UI, knowledge base or skill system.** This plugin takes the "call into Unity from another
  process" capability, plus one right-Sidebar asset panel and five switchable Unity domain skills; the desktop
  app's main window, knowledge index, skill runtime and agent loop take no part.
- **The broker supports multiple clients.** When the broker has the `broker_multi_client_v1` capability, DSH and
  the Locus desktop app can be connected to the same editor at the same time, and responses go back to the
  connection that issued the request.
- **Recompilation continues across the disconnect.** A domain reload breaks the connection mid-call; the client
  reconnects and keeps polling the operation id instead of reporting a transport error.

## Development

```bash
npm install                # dev dependencies (three / esbuild, needed to build the model viewer)
npm test                   # no Unity or network needed
npm run typecheck          # static check of import / export
npm run validate           # tool definitions + static checks + both bundle freshness checks
npm run pack:release       # release ZIP; checks latest Locus and latest DSH first
npm run build:client       # generate lib/client.js from src/client/plugin.js (the Sidebar panel)
npm run build:viewer       # generate lib/model-viewer.js from src/model-viewer/viewer.js (three.js viewer)
npm run build:native       # the Linux/macOS broker (Rust)
npm run test:live          # tools: end-to-end against a real editor, see scripts/live-smoke.mjs
npm run test:live:sidebar  # sidebar routes: real HTTP + real Unity, see scripts/live-sidebar.mjs
npm run test:live:render   # sidebar panel: every format through a render harness, see scripts/live-render.mjs
npm run test:csharp        # C# analysis end-to-end against a real Roslyn server
```

`npm run pack:release` produces exactly one artifact: an installable ZIP containing the Unity
payload and installer. Before building it queries the latest Locus GitHub release and **stops** if it
does not match `package.json` → `locus.version`; it also checks the latest published DSH version
against `engines.dsh`, warning but continuing when it is incompatible or cannot be checked.

The Sidebar client lives in `src/client/plugin.js` (plain ESM, so tests import it directly);
`npm run build:client` wraps it into the `__ModuleLoader__` factory a DSH client bundle needs and writes
`lib/client.js`. Edit the source and regenerate — `npm run check:client` fails when the artifact is stale.
The three.js model viewer lives separately in `src/model-viewer/`; `npm run build:viewer` bundles it with
esbuild into `lib/model-viewer.js`. The Sidebar loads it lazily — do **not** fold it into the main client
bundle. `npm run check:viewer` verifies the artifact.

`unity-test/` is a local disposable verification project, ignored by git.

## License

GPL-3.0-or-later. The code under `native/` is derived from upstream Locus; see
[NOTICE](NOTICE) for the exact files and the upstream commit it is aligned with. This project is not an official
Locus release and has no affiliation with the Locus authors.
