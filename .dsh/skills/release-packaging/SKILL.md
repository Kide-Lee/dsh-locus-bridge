---
name: release-packaging
description: >-
  Build the dsh-locus-bridge release ZIP from the npm files whitelist, after version and
  CHANGELOG checks. Use for cutting a release, bumping the package version, refreshing the
  changelog, or replacing a .tgz artifact with the canonical .zip.
whenToUse: >-
  The user asks to package a release, bump the version, write or refresh the changelog, or
  produce a distributable archive for dsh-locus-bridge.
---

# Release packaging

This skill covers the **dsh-locus-bridge release archive**, not the Unity Locus payload and not
the npm tarball. The canonical artifact is a ZIP whose contents are exactly the npm `files`
whitelist, with one top-level directory.

## Non-goals

- Do not zip the repository root. That pulls in `.git`, `node_modules`, `Locus/`, `unity-test/`,
  `.tmp/`, `.npm-cache/` and local build output. Add only the reviewed payload tree and installer.
- Do not edit or regenerate `payload/locus_unity/` or `lib/client.js` during packaging. Use
  `npm run sync:payload` or the client build scripts when those inputs actually changed.
- Do not commit anything under `dist/`. It is ignored build output.
- Do not publish a `.tgz` as the release artifact. `npm pack` is only a file-list oracle here.

## Preflight

Run from the repository root.

1. Read the version from `package.json`. For this release it must be `1.0.0`; never guess from a
   changelog heading.
2. Confirm all three version fields agree:
   - `package.json` → `version`
   - `package-lock.json` → `version`
   - `package-lock.json` → `packages[""].version`
3. Confirm `CHANGELOG.md` starts with a matching `## [<version>] - YYYY-MM-DD` section, and that
   `CHANGELOG.md` is listed in `package.json` → `files`.
4. Confirm the installable payload exists and is complete:
   - `payload/locus_unity/package.json` reports the Unity package version (`0.1.0`; this is not
     the upstream Locus release version);
   - `payload/locus_unity/Editor/Native/x86_64/locus_unity_native.dll` exists;
   - `payload/locus_unity/Editor/Native/linux-x86_64/liblocus_unity_native.so` exists;
   - `scripts/install-unity-package.mjs` exists and imports `../src/setup.js`.
5. Confirm `package.json` → `locus.version` records the vendored upstream Locus release (currently
   `0.9.3`). This is the version the packager compares with GitHub; do not confuse it with the
   Unity package version in `payload/locus_unity/package.json`.
6. Confirm `git status --short` contains only the intended release changes. Packaging must not
   silently include unrelated work.
7. Run the release checks:

   ```bash
   npm test
   DSH_TOOLS_PATH=/absolute/path/to/@deepseek-ai/dsh-tools/lib/index.js npm run validate
   ```

   `validate-dsh-tools` needs the installed DSH tools; without `DSH_TOOLS_PATH` it exits 2.
   If `npm` is not on `PATH`, use the absolute npm from the active Node installation.

## Build the ZIP

There is exactly one artifact mode: every release ZIP is installable. There is no `--full`/`--slim`
switch and no second archive.

```bash
npm run pack:release
```

`scripts/pack-release.mjs` performs the whole single-mode build:

1. Version/CHANGELOG/payload preflight;
2. **Latest-Locus hard gate** — reads `package.json` → `locus.version`, queries the latest GitHub
   release (falling back to the highest semver tag), and stops with a warning if the vendored
   version is not the latest. Update `payload/locus_unity/` with `npm run sync:payload`, then bump
   `locus.version` and `NOTICE`;
3. **Latest-DSH soft gate** — queries the npm `latest` tag for `@deepseek-ai/dsh`, checks it against
   `engines.dsh`, and continues with a warning if it is incompatible or cannot be checked;
4. `npm pack` file list, extraction into a versioned top-level directory, payload + installer copy,
   stable timestamps, deterministic `zip -X`, and `unzip -t` verification.

If GitHub or the npm registry is unreachable, the Locus gate stops the release; the DSH gate warns
and continues. Set `GITHUB_TOKEN` when unauthenticated GitHub API calls are rate-limited. The
packager never emits a `.tgz` as the artifact.

The resulting layout is:

```text
dsh-locus-bridge-1.0.0.zip
└── dsh-locus-bridge-1.0.0/
    ├── package.json
    ├── CHANGELOG.md
    ├── README.md
    ├── README.en.md
    ├── LICENSE
    ├── NOTICE
    ├── cordis.patch.yml
    ├── icon.svg
    ├── lib/
    ├── src/
    ├── native/...
    ├── payload/
    │   └── locus_unity/          # complete Unity package + both native brokers
    └── scripts/
        └── install-unity-package.mjs
```

The ZIP is the installable artifact. The npm tarball still excludes `payload/`; that split is
deliberate, because npm users may already keep the payload outside the plugin directory via
`DSH_LOCUS_PAYLOAD_DIR`.

## Verify before reporting

```bash
unzip -l "dist/dsh-locus-bridge-$VERSION.zip" | tail -5
unzip -p "dist/dsh-locus-bridge-$VERSION.zip" "$NAME/package.json" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))'
unzip -p "dist/dsh-locus-bridge-$VERSION.zip" "$NAME/CHANGELOG.md" | head -5
sha256sum "dist/dsh-locus-bridge-$VERSION.zip"
```

Check all of these:

- version printed by the packaged `package.json` equals `$VERSION`;
- `CHANGELOG.md` is present and its first version heading matches;
- `src/background.js`, `src/index.js`, `src/tools.js` and `cordis.patch.yml` are present;
- `payload/locus_unity/package.json`, both native broker files and
  `scripts/install-unity-package.mjs` are present;
- the archive has one top-level directory and no `.git`, `node_modules`, `Locus`, `unity-test`,
  `.tmp`, `dist`, or `native/**/target` entries;
- no stale `dist/dsh-locus-bridge-*.tgz` remains after switching to ZIP.

Report the version, ZIP path, size, file count and SHA-256. Do not claim tests passed unless they
were run in this turn.

## Changelog rules

- Add a new `## [<version>] - YYYY-MM-DD` section at the top; keep older sections intact.
- Summarize user-visible capabilities and fixes, not a raw commit log. Group by Unity tools,
  background execution, C# analysis, sidebar, settings/skills, distribution and fixes.
- State compatibility constraints explicitly (Node, DSH, Unity, test framework, optional C#
  download).
- State that the release ZIP includes the Unity payload and installer, while the npm tarball excludes the payload.
- Update the test count only after the full suite has actually run.

## Optional marketplace alias

If the artifact is uploaded to a GitHub Release consumed through `releases/latest/download/`, also
copy the ZIP to the fixed name the listing expects:

```bash
cp "dist/dsh-locus-bridge-$VERSION.zip" dist/dsh-locus-bridge.zip
```

Keep the versioned ZIP as the canonical artifact; the alias exists only for a stable download URL.
