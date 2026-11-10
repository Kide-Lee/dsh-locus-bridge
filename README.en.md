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

After restarting DSH, the model sees 7 tools whose names start with `unity_`.

### Editor prerequisites

1. The `locus_unity` Unity package is installed in the project (obtained from Locus upstream).
2. The native broker library for the platform is in place — on Windows it is `locus_unity_native.dll`, on
   Linux/macOS it is `liblocus_unity_native.so` (built with `npm run build:native`).
3. `<project>/Library/Locus/NativeBridge.enabled` exists, or the editor was started with
   `LOCUS_UNITY_NATIVE_BRIDGE=1`. On Linux the first line of that marker is read as an absolute socket path,
   because inside a sandbox the socket cannot live in `/tmp`.

A tool reporting "editor not connected" is the normal failure shape: they return a structured result rather than
throwing, so the agent can tell the user directly what is missing.

## Tools

| Tool | What it does | Underlying commands |
|---|---|---|
| `unity_status` | Connection check, editor state (editing/playing/playing_paused), open scenes, capabilities, domain reload state | `status` / `bridge_capabilities` / `get_reload_state` |
| `unity_execute` | Compile and execute a C# method body on the Unity main thread (`print`/`printJson`/`ctx.Progress`/`ctx.WaitFrame`), the escape hatch | `status` → `begin_edit_session` → `execute_code` + 250ms `execute_code_progress` → (cancel) `cancel_execute_code` → `end_edit_session` |
| `unity_play_mode` | Switch to Play/Edit mode and wait for it to take effect | `status` → `set_editor_status` → poll `status` |
| `unity_console_log` | Read the Unity Console (merged and deduplicated by level) | `unity_get_console_log` |
| `unity_recompile` | Compile + domain reload + wait across the disconnect for convergence; `sync: none/targeted/full` controls asset import | `request_recompile` → disconnect → reconnect → poll `get_compile_result` |
| `unity_asset` | Read serialized assets; revision-guarded atomic edits (`set` and array operations); undo; reload | `asset_api` (read / apply_batch / disk_reload) |
| `unity_scene` | Scene object search, property tree read, atomic set (Undo, saves the scene) | `search_scene_objects` / `property_tree_read` / generated `execute_code` |

## Differences from the Locus desktop client

- **The session working directory does not have to be the Unity project.** The plugin searches up to three
  levels downward, breadth-first, and when that fails it searches beside each ancestor directory; an explicit
  `project_path` always takes precedence.
- **No Locus UI, knowledge base or skill system.** This plugin takes only the "call into Unity from another
  process" capability; the desktop app's panels and agent loop take no part.
- **The broker supports multiple clients.** When the broker has the `broker_multi_client_v1` capability, DSH and
  the Locus desktop app can be connected to the same editor at the same time, and responses go back to the
  connection that issued the request.
- **Recompilation continues across the disconnect.** A domain reload breaks the connection mid-call; the client
  reconnects and keeps polling the operation id instead of reporting a transport error.

## Development

```bash
npm test               # 71 tests, Unity not required
npm run typecheck      # static check of import / export
npm run validate       # validate tool definitions against the DSH JSON Schema subset
npm run build:native   # the Linux/macOS broker (Rust)
npm run test:live      # end-to-end against a real editor, see scripts/live-smoke.mjs
```

`unity-test/` is a local disposable verification project, ignored by git.

## License

GPL-3.0-or-later. The code under `native/` is derived from upstream Locus; see
[NOTICE](NOTICE) for the exact files and the upstream commit it is aligned with. This project is not an official
Locus release and has no affiliation with the Locus authors.
