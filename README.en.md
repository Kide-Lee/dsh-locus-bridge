# dsh-locus-bridge

[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.12-339933?style=flat-square&logo=node.js&logoColor=white)](package.json)
[![Unity](https://img.shields.io/badge/unity-2022.3-000000?style=flat-square&logo=unity&logoColor=white)](https://github.com/Kide-Lee/dsh-locus-bridge)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-4b5563?style=flat-square)](https://github.com/Kide-Lee/dsh-locus-bridge)
[![Upstream: Locus](https://img.shields.io/badge/upstream-r1n7aro%2FLocus-2d6cdf?style=flat-square&logo=github)](https://github.com/r1n7aro/Locus)

English | [简体中文](README.md)

A **DeepSeek Harness plugin** that lets DSH act as a [Locus](https://github.com/r1n7aro/Locus)
client. It does not go through MCP: it speaks the Locus native broker protocol
directly, so the agent can drive a running Unity editor.

- No MCP server in the middle — DSH connects to the broker that the Locus Unity
  package already runs inside the editor process.
- 7 tools, all prefixed `unity_`: status, C# evaluation, play mode, console,
  recompile, asset edits, scene edits.
- Windows named pipe and Unix domain socket transports. The Linux/macOS broker
  port lives in `native/locus_unix_native/` and is built by `npm run build:native`.

## How it works

Locus is not a normal client/server pair. **The Unity side is the server**: the
`locus_unity_native` Rust dll is loaded in-process by the editor and serves a
named pipe (Windows) or a Unix domain socket (Linux/macOS), surviving domain
reloads because the dll itself stays resident. The Locus desktop app is a client
of that socket, and so is this plugin — it implements the same line-delimited
JSON protocol, which means **nothing on the Unity side has to change**.

Requests look like `{"id": "...", "type": "<command>", "message": "<string>"}`
and replies carry `reply_to`, so a single connection can pipeline calls. Error
codes such as `managed_reloading` or `native_request_timed_out` mean the request
was **not** executed and can be retried safely; the client uses that distinction
to reconnect across a domain reload instead of failing the call.

## Install

From a local checkout:

```bash
dsh plugin --profile <profile> add /path/to/dsh-locus-bridge
```

Or straight from GitHub. The package declares `dsh.bundle`, so installing it as a
profile bundle is enough — you do not edit your own `cordis.patch.yml`:

```bash
dsh plugin --profile <profile> add github:Kide-Lee/dsh-locus-bridge
```

Or just ask the agent to do it:

```
Install the plugin https://github.com/Kide-Lee/dsh-locus-bridge for me, and set up
the Locus Unity package in my Unity project if it is missing.
```

Restart DSH afterwards. The model then sees 7 tools prefixed with `unity_`.

### Editor prerequisites

1. The `locus_unity` Unity package is installed in the project (from Locus
   upstream).
2. The native broker library is present for the platform — `locus_unity_native.dll`
   on Windows, `liblocus_unity_native.so` (built with `npm run build:native`) on
   Linux/macOS.
3. `<project>/Library/Locus/NativeBridge.enabled` exists, or the editor was
   started with `LOCUS_UNITY_NATIVE_BRIDGE=1`. On Linux the marker's first line is
   read as an absolute socket path, because the socket cannot live in `/tmp`
   under a sandbox.

A tool reporting a disconnected editor is the normal failure mode: it returns a
structured result rather than throwing, so the agent can explain what is missing.

## Tools

| Tool | What it does | Broker commands |
|---|---|---|
| `unity_status` | Connection check, editor state (editing/playing/playing_paused), open scenes, capabilities, domain-reload state | `status` / `bridge_capabilities` / `get_reload_state` |
| `unity_execute` | Compile and run a C# method body on the Unity main thread (`print`/`printJson`/`ctx.Progress`/`ctx.WaitFrame`); the escape hatch | `status` → `begin_edit_session` → `execute_code` + 250 ms `execute_code_progress` → (cancel) `cancel_execute_code` → `end_edit_session` |
| `unity_play_mode` | Switch to Play or Edit mode and wait until it takes effect | `status` → `set_editor_status` → poll `status` |
| `unity_console_log` | Read the Unity Console, merged and deduplicated by level | `unity_get_console_log` |
| `unity_recompile` | Compile + domain reload, waiting across the disconnect for convergence; `sync: none/targeted/full` controls asset import | `request_recompile` → disconnect → reconnect → poll `get_compile_result` |
| `unity_asset` | Read a serialized asset; revision-guarded atomic edits (`set` and array ops); undo; reload | `asset_api` (read / apply_batch / disk_reload) |
| `unity_scene` | Scene object search, property-tree read, atomic set (Undo, saves the scene) | `search_scene_objects` / `property_tree_read` / generated `execute_code` |

## Differences from the Locus desktop client

- **The session working directory does not have to be the Unity project.** The
  plugin searches up to three levels downward, breadth-first, then looks beside
  each ancestor directory; an explicit `project_path` always wins.
- **No Locus UI, knowledge base or skill system.** The plugin takes only the
  "call into Unity from another process" capability; the desktop app's panels and
  agent loop are not involved.
- **The broker accepts multiple clients.** When the broker advertises the
  `broker_multi_client_v1` capability, DSH and the Locus desktop app can be
  connected to the same editor at the same time, and replies go back to the
  connection that asked.
- **Recompile survives the disconnect.** A domain reload tears the connection
  down mid-call, so the client reconnects and resumes polling the operation id
  rather than reporting a transport error.

## Development

```bash
npm test               # 71 tests, no Unity required
npm run typecheck      # static import/export checks
npm run validate       # tool schemas against the DSH JSON Schema subset
npm run build:native   # Linux/macOS broker (Rust)
npm run test:live      # end-to-end against a real editor; see scripts/live-smoke.mjs
```

`unity-test/` is a disposable local fixture and is git-ignored.

## License

GPL-3.0-or-later. `native/` contains work derived from upstream Locus — see
[NOTICE](NOTICE) for the exact files and the upstream commit it was aligned with.
Nothing here is an official Locus release, and the Locus authors are not
affiliated with this project.
