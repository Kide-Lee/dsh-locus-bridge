# AGENTS.md

Instructions for AI agents working in this repository.

## Choosing the Unity project

**Decide for yourself which Unity project a call targets; do not ask the human.**

This repository ships the plugin and the Linux/macOS broker, not a Unity
project. A working session usually has one checked out next to the code — the
local development fixture is `unity-test/` (it holds `Assets/` and
`ProjectSettings/`, which is what makes a directory a Unity project) — and the
`unity_*` tools find it unaided: they search the working directory and up to
three levels below it, then beside each ancestor up to the nearest `.git`.

So `unity_status` with no `project_path` normally resolves the project on its
own, whether the session starts at the repository root or inside a subdirectory.

Pass `project_path` when there is more than one candidate, or when you mean a
different checkout. When a call reports several candidates, pick the one the
request is about and pass it — the ambiguity is information, not a reason to
ask. Only ask a human when nothing in the request or the repository indicates
which project is meant.

## What the Unity tools need

- A running Unity Editor with the Locus package and the native broker
  (`locus_unity_native.dll` on Windows, `liblocus_unity_native.so` on Linux),
  plus `<project>/Library/Locus/NativeBridge.enabled` (or
  `LOCUS_UNITY_NATIVE_BRIDGE=1`).
- On Linux the broker speaks a Unix domain socket. Under this sandbox it must
  live inside the workspace (`.locus/`), because `/tmp` is not shared between
  commands; the editor therefore has to run in a long-lived background job, not
  a one-shot command.
- Without a GPU: start the editor as
  `Unity -batchmode -nographics -projectPath <project>` and do **not** pass
  `-quit` when you need the broker to stay reachable.

## Editing this plugin

- `npm test` runs the JS suite. `npm run typecheck` checks module wiring;
  `node scripts/dump-tools.mjs` validates every tool schema.
- `src/tools.js` holds the seven tool definitions; `src/args.js` owns project
  resolution and is covered by `test/args.test.js`.
- `native/locus_unix_native/` is the Linux/macOS broker port, derived from the
  upstream Locus `locus-native-broker` and therefore GPL-3.0-or-later. Its
  protocol dependency `native/locus-native-protocol/` is an unmodified upstream
  copy. Both build standalone: `npm run build:native` / `npm run test:native`.
  See `NOTICE` before changing either; modifications must be documented there.
- `unity-test/` is a disposable local fixture: git-ignored, never committed. It
  is not required to build or test this repository.
