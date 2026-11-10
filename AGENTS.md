# AGENTS.md

Instructions for AI agents working in this repository.

## Choosing the Unity project

**Decide for yourself which Unity project a call targets; do not ask the human.**

There is exactly one Unity project here — `unity-test/` (it holds `Assets/` and
`ProjectSettings/`, which is what makes a directory a Unity project). Because of
that, the `unity_*` tools find it unaided: they search the working directory and
up to three levels below it, so `unity_status` with no `project_path` resolves
`unity-test/` from the repository root or any subdirectory.

If this repository grows a second Unity project, or you need to target a
different checkout, pass `project_path` explicitly. When a call reports several
candidates, pick the one the request is about and pass it — the ambiguity is
information, not a reason to ask. Only ask a human when nothing in the request
or the repository indicates which project is meant.

## What the Unity tools need

- A running Unity Editor with the Locus package and the native broker
  (`locus_unity_native.dll` on Windows, `liblocus_unity_native.so` on Linux),
  plus `unity-test/Library/Locus/NativeBridge.enabled` (or
  `LOCUS_UNITY_NATIVE_BRIDGE=1`).
- On this Linux host the broker speaks a Unix domain socket inside the workspace
  (`.locus/`), because `/tmp` is not shared between sandboxed commands. The
  editor must run in a long-lived background job, not a one-shot command.
- No GPU here: start the editor as
  `Unity -batchmode -nographics -projectPath <unity-test>` and do **not** pass
  `-quit` when you need the broker to stay reachable.

## Editing this plugin

- `npm test` runs the suite. `npm run typecheck` checks module wiring;
  `node scripts/dump-tools.mjs` validates every tool schema.
- `src/tools.js` holds the seven tool definitions; `src/args.js` owns project
  resolution and is covered by `test/args.test.js`.
- `Locus/` is a separate upstream checkout (its own git repository). The Linux
  broker port lives in `Locus/locus_unix_native/` and is **not** committed here.
- `unity-test/` is a disposable local fixture: git-ignored, never committed.
