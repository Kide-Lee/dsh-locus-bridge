# AGENTS.md

Instructions for AI agents working in this repository.

## Unity project selection

This repository drives one Unity project, already recorded in `.locus.json`:

```json
{ "project": "unity-test" }
```

**Do not ask the human which Unity project to use.** Call the `unity_*` tools
without `project_path`; resolution reads `.locus.json` and targets
`unity-test/`. If a call fails with "not a Unity project", fix the resolved path
the error names — do not fall back to asking.

Resolution order (highest first), implemented in `src/args.js`:

1. an explicit `project_path` argument;
2. the nearest `.locus.json` / `locus.json` at or above the working directory;
3. the working directory itself, when it is a Unity project;
4. the shallowest Unity project within three levels below the working directory;
5. otherwise an error listing the candidates.

Only pass `project_path` to override the recorded choice (for example to point at
a different checkout). When several Unity projects exist and none is recorded,
add `{"project": "<dir>"}` to `.locus.json` rather than asking a human per call.

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

- `npm test` runs the suite (68+ tests). `npm run typecheck` checks module
  wiring; `node scripts/dump-tools.mjs` validates every tool schema.
- `src/tools.js` holds the seven tool definitions; `src/args.js` owns project
  resolution and is covered by `test/args.test.js`.
- `Locus/` is a separate upstream checkout (its own git repository). The Linux
  broker port lives in `Locus/locus_unix_native/` and is **not** committed here.
- `unity-test/` is a disposable local fixture: git-ignored, never committed.
