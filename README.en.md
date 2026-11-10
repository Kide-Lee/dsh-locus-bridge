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

1. The `locus_unity` Unity package (`com.farlocus.locus`) is installed in the project.
2. The native broker library for the platform is in place — on Windows it is `locus_unity_native.dll`, on
   Linux/macOS it is `liblocus_unity_native.so`. The bundled payload carries both platforms, so neither needs
   to be built locally.
3. `<project>/Library/Locus/NativeBridge.enabled` exists, or the editor was started with
   `LOCUS_UNITY_NATIVE_BRIDGE=1`. On Linux the first line of that marker is read as an absolute socket path,
   because inside a sandbox the socket cannot live in `/tmp`.

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
