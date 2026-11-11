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

After restarting DSH, the model sees 10 tools whose names start with `unity_`, plus 6 `code_*` C# analysis tools (disable the latter with
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
The 15 MB tree stays out of the npm tarball and ships as a release asset; point `DSH_LOCUS_PAYLOAD_DIR` at the
unpacked directory to keep it outside the plugin directory.

## Tools

| Tool | What it does | Underlying commands |
|---|---|---|
| `unity_status` | Connection check, editor state (editing/playing/playing_paused), open scenes, capabilities, domain reload state; diagnoses a missing package/broker/marker automatically, and prints the install command when the package is absent | `status` / `bridge_capabilities` / `get_reload_state` |
| `unity_execute` | Compile and execute a C# method body on the Unity main thread (`print`/`printJson`/`ctx.Progress`/`ctx.WaitFrame`), the escape hatch | `status` → `begin_edit_session` → `execute_code` + 250ms `execute_code_progress` → (cancel) `cancel_execute_code` → `end_edit_session` |
| `unity_play_mode` | Switch to Play/Edit mode and wait for it to take effect | `status` → `set_editor_status` → poll `status` |
| `unity_console_log` | Read the Unity Console (merged and deduplicated by level) | `unity_get_console_log` |
| `unity_recompile` | Compile + domain reload + wait across the disconnect for convergence; `editor_status` is required and must match the live state; `sync: none/targeted/full` controls asset import | `request_recompile` → disconnect → reconnect → poll `get_compile_result` |
| `unity_test` | Discover and run Unity Test Framework tests, waiting for structured results (`list` / `run`) | `unity_test_list` / `unity_test_start` → 250ms `unity_test_status` → (cancel) `unity_test_cancel` |
| `unity_asset` | Read serialized assets; revision-guarded atomic edits (`set` and array operations); undo; reload | `asset_api` (read / apply_batch / disk_reload) |
| `unity_asset_graph` | Asset reference graph and script usages: `references` / `dependencies` / `usages` | generated `execute_code` (GUID comparison against serialized fields) |
| `unity_capture` | Capture the Game / Scene view or an Editor window, with the image attached to the result (`ImageBlock`) — visible in one call | `capture_viewport` + `attachments.saveImage` |
| `unity_scene` | Scene object search (by name, and `find` by component type), property tree read, atomic `set`, single-transaction `batch` and `undo` | `search_scene_objects` / `property_tree_read` / generated `execute_code` |

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
server; the ~30 MB runtime is skipped when the machine already has .NET 10).

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
| orbitable 3D preview | `asset_preview_render` | `PreviewRenderUtility` |
| reveal in the editor | `select_asset` | Project-window ping |

Formats: `.prefab` (hierarchy + components + fields, with an orbitable preview), `.asset` / `.mat`
(ScriptableObject and material fields), `.anim` (clip fields), `.controller` (a sub-asset summary table),
textures and models (`AssetPreview` thumbnails). `.unity` scenes are **read-only**: reading one requires the
scene to be loaded in the editor, and "opening it rewrites what the editor has open" is not a decision a file
viewer should make. A write is refused with the reason.

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

## Differences from the Locus desktop client

- **The session working directory does not have to be the Unity project.** The plugin searches up to three
  levels downward, breadth-first, and when that fails it searches beside each ancestor directory; an explicit
  `project_path` always takes precedence.
- **No Locus desktop UI, knowledge base or skill system.** This plugin takes the "call into Unity from another
  process" capability plus one right-Sidebar asset panel; the desktop app's main window, knowledge and skills
  take no part.
- **The broker supports multiple clients.** When the broker has the `broker_multi_client_v1` capability, DSH and
  the Locus desktop app can be connected to the same editor at the same time, and responses go back to the
  connection that issued the request.
- **Recompilation continues across the disconnect.** A domain reload breaks the connection mid-call; the client
  reconnects and keeps polling the operation id instead of reporting a transport error.

## Development

```bash
npm test                   # no Unity or network needed
npm run typecheck          # static check of import / export
npm run validate           # tool definitions + static checks + client bundle freshness
npm run build:client       # generate lib/client.js from src/client/plugin.js (the Sidebar panel)
npm run build:native       # the Linux/macOS broker (Rust)
npm run test:live          # tools: end-to-end against a real editor, see scripts/live-smoke.mjs
npm run test:live:sidebar  # sidebar routes: real HTTP + real Unity, see scripts/live-sidebar.mjs
npm run test:live:render   # sidebar panel: every format through a render harness, see scripts/live-render.mjs
npm run test:csharp        # C# analysis end-to-end against a real Roslyn server
```

The Sidebar client lives in `src/client/plugin.js` (plain ESM, so tests import it directly);
`npm run build:client` wraps it into the `__ModuleLoader__` factory a DSH client bundle needs and writes
`lib/client.js`. Edit the source and regenerate — `npm run check:client` fails when the artifact is stale.

`unity-test/` is a local disposable verification project, ignored by git.

## License

GPL-3.0-or-later. The code under `native/` is derived from upstream Locus; see
[NOTICE](NOTICE) for the exact files and the upstream commit it is aligned with. This project is not an official
Locus release and has no affiliation with the Locus authors.
