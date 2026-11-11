// Locating the `.sln`/`.csproj` files the Roslyn server loads.
//
// The language server loads a workspace through MSBuild project files, but a
// fresh Unity checkout has none until an IDE package inside the editor writes
// them. Two channels, tried in order (mirroring
// `Locus/src-tauri/src/csharp_lsp/unity_sync.rs`):
//
//   1. a connected editor — ask the Locus plugin for `sync_project_files`, and
//      fall back to a generated `execute_code` snippet that walks the same
//      generator chain (plugin generator → `CodeEditor.SyncAll` → Visual
//      Studio / Rider / VS Code project generation → `UnityEditor.SyncVS`);
//   2. no editor — a one-shot `-batchmode` run with a temporary embedded
//      package carrying the entry point, removed afterwards.
//
// Channel 1 is cheap and is what a running editor should use; channel 2 is the
// slow path (a 900 s budget in upstream, dominated by the first asset import of
// a large project) and is only attempted when the editor is not connected.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

import { withClient, openEditSession } from '../client-pool.js'
import { executeSnippet } from '../execute.js'

/** No usable project files could be produced. */
export class ProjectSyncError extends Error {
  constructor(message, { code = null, report = null } = {}) {
    super(message)
    this.name = 'ProjectSyncError'
    this.code = code
    this.report = report
  }
}

const TEMP_PACKAGE_FOLDER = 'com.locus.projectsync.tmp'
const TEMP_ASSEMBLY_NAME = 'LocusProjectFileSyncTemp'
const BATCH_SYNC_TIMEOUT_MS = 900_000

/**
 * C# statements implementing the generator fallback chain.
 *
 * Valid both as an `execute_code` snippet body and inlined into the temporary
 * package's `Run()`. Ends with `__locusSyncReport` in scope describing what was
 * attempted. Ported verbatim from upstream so both clients produce the same
 * project files, including the "Locus generator first" ordering that keeps the
 * embedded package out of the generated solution.
 */
const SYNC_CHAIN_STATEMENTS = `
var __locusSyncLog = new System.Text.StringBuilder();
bool __locusSynced = false;
bool __locusEditorSelected = false;

bool __LocusTryPluginGenerator()
{
    // The assembly-qualified lookup is exact: Type.GetType returns null when the
    // assembly name does not match, which a renamed editor assembly would cause.
    // Fall back to scanning loaded assemblies for the full type name, so a rename
    // degrades to a slower lookup instead of silently skipping the generator that
    // keeps this package out of the solution.
    var projectFilesType = System.Type.GetType("Locus.LocusProjectFiles, Locus.Editor", false);
    if (projectFilesType == null)
    {
        foreach (var assembly in System.AppDomain.CurrentDomain.GetAssemblies())
        {
            if (assembly == null || assembly.IsDynamic)
                continue;
            var candidate = assembly.GetType("Locus.LocusProjectFiles", false);
            if (candidate != null)
            {
                projectFilesType = candidate;
                break;
            }
        }
    }
    if (projectFilesType == null)
        return false;
    var versionField = projectFilesType.GetField(
        "GeneratorVersion",
        System.Reflection.BindingFlags.Static
            | System.Reflection.BindingFlags.Public
            | System.Reflection.BindingFlags.NonPublic);
    if (versionField == null)
    {
        __locusSyncLog.AppendLine("Locus generator: installed plugin is too old");
        return false;
    }
    var syncMethod = projectFilesType.GetMethod(
        "SyncAll",
        System.Reflection.BindingFlags.Static
            | System.Reflection.BindingFlags.Public
            | System.Reflection.BindingFlags.NonPublic);
    if (syncMethod == null)
        return false;
    var result = syncMethod.Invoke(null, null);
    __locusSyncLog.AppendLine("Locus generator: " + (result ?? "ok"));
    return true;
}

bool __LocusTrySyncAll()
{
    var editor = Unity.CodeEditor.CodeEditor.CurrentEditor;
    if (editor == null)
    {
        __locusSyncLog.AppendLine("CodeEditor.SyncAll: no external editor configured");
        return false;
    }
    if (editor.GetType().Name == "LocusExternalCodeEditor")
        __locusEditorSelected = true;
    try
    {
        editor.SyncAll();
        __locusSyncLog.AppendLine("CodeEditor.SyncAll: ok (" + editor.GetType().Name + ")");
        return true;
    }
    catch (System.Exception e)
    {
        __locusSyncLog.AppendLine("CodeEditor.SyncAll: " + e.Message);
        return false;
    }
}

bool __LocusTryPackageGenerators()
{
    string[] typeNames = new string[]
    {
        "Microsoft.Unity.VisualStudio.Editor.ProjectGeneration, Unity.VisualStudio.Editor",
        "Packages.Rider.Editor.ProjectGeneration.ProjectGeneration, Unity.Rider.Editor",
        "VSCodeEditor.ProjectGeneration, Unity.VSCode.Editor",
    };
    foreach (string typeName in typeNames)
    {
        try
        {
            var type = System.Type.GetType(typeName, false);
            if (type == null)
                continue;
            var generator = System.Activator.CreateInstance(type, true);
            var syncMethod = type.GetMethod(
                "Sync",
                System.Reflection.BindingFlags.Public
                    | System.Reflection.BindingFlags.NonPublic
                    | System.Reflection.BindingFlags.Instance,
                null,
                System.Type.EmptyTypes,
                null);
            if (syncMethod == null)
            {
                __locusSyncLog.AppendLine(typeName + ": Sync() not found");
                continue;
            }
            syncMethod.Invoke(generator, null);
            __locusSyncLog.AppendLine(typeName + ": ok");
            return true;
        }
        catch (System.Exception e)
        {
            var inner = e.InnerException != null ? e.InnerException : e;
            __locusSyncLog.AppendLine(typeName + ": " + inner.Message);
        }
    }
    return false;
}

bool __LocusTrySyncVs()
{
    if (__locusEditorSelected)
    {
        __locusSyncLog.AppendLine("UnityEditor.SyncVS: skipped because Locus is selected");
        return false;
    }
    var syncVsType = System.Type.GetType("UnityEditor.SyncVS,UnityEditor", false);
    if (syncVsType == null)
    {
        __locusSyncLog.AppendLine("UnityEditor.SyncVS: not present");
        return false;
    }
    var syncSolution = syncVsType.GetMethod(
        "SyncSolution",
        System.Reflection.BindingFlags.Static
            | System.Reflection.BindingFlags.Public
            | System.Reflection.BindingFlags.NonPublic);
    if (syncSolution == null)
    {
        __locusSyncLog.AppendLine("SyncVS.SyncSolution: not found");
        return false;
    }
    syncSolution.Invoke(null, null);
    __locusSyncLog.AppendLine("SyncVS.SyncSolution: ok");
    return true;
}

try { __locusSynced = __LocusTryPluginGenerator(); }
catch (System.Exception e) { __locusSyncLog.AppendLine("Locus generator: " + e.Message); }
if (!__locusSynced)
{
    try { __locusSynced = __LocusTrySyncAll(); }
    catch (System.Exception e) { __locusSyncLog.AppendLine("CodeEditor.SyncAll: " + e.Message); }
}
if (!__locusSynced)
{
    try { __locusSynced = __LocusTryPackageGenerators(); }
    catch (System.Exception e) { __locusSyncLog.AppendLine("package generators: " + e.Message); }
}
if (!__locusSynced)
{
    try { __locusSynced = __LocusTrySyncVs(); }
    catch (System.Exception e) { __locusSyncLog.AppendLine("SyncVS: " + e.Message); }
}
var __locusSyncReport =
    (__locusSynced ? "synced" : "no project generator succeeded") + "\\n" + __locusSyncLog;
`

/** Snippet that runs the generator chain inside a connected editor. */
export function editorSyncSnippet() {
  return `${SYNC_CHAIN_STATEMENTS}\nprint(__locusSyncReport);\n`
}

/** Source of the temporary package's entry point for a batch run. */
export function batchEntryPointSource() {
  return (
    '// Temporary entry point written to generate .sln/.csproj in batch mode.\n' +
    '// The package is deleted right after the run.\n' +
    `public static class ${TEMP_ASSEMBLY_NAME}\n{\n    public static void Run()\n    {\n` +
    SYNC_CHAIN_STATEMENTS +
    '\n        UnityEngine.Debug.Log("[LocusProjectSync] " + __locusSyncReport);\n' +
    '    }\n}\n'
  )
}

function tempPackageDir(root) {
  return join(root, 'Packages', TEMP_PACKAGE_FOLDER)
}

function writeTempPackage(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    `{\n  "name": "${TEMP_PACKAGE_FOLDER}",\n  "version": "1.0.0",\n` +
      '  "displayName": "Locus Project File Sync (temporary)",\n' +
      '  "description": "Written to generate .sln/.csproj in batch mode. Safe to delete."\n}\n',
  )
  writeFileSync(
    join(dir, `${TEMP_ASSEMBLY_NAME}.asmdef`),
    `{\n  "name": "${TEMP_ASSEMBLY_NAME}",\n  "references": [],\n` +
      '  "includePlatforms": ["Editor"],\n  "excludePlatforms": [],\n  "autoReferenced": false\n}\n',
  )
  writeFileSync(join(dir, `${TEMP_ASSEMBLY_NAME}.cs`), batchEntryPointSource())
}

function removeTempPackage(dir) {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

/** Drop the temporary package's project block from a generated solution. */
export function stripProjectFromSolution(slnText, projectFileName) {
  const needle = `"${projectFileName}"`
  const eol = slnText.includes('\r\n') ? '\r\n' : '\n'
  const hadTrailingNewline = slnText.endsWith('\n')
  let guid = null
  for (const line of slnText.split(/\r?\n/)) {
    if (line.trimStart().startsWith('Project(') && line.includes(needle)) {
      const open = line.lastIndexOf('{')
      const close = line.lastIndexOf('}')
      if (close > open) guid = line.slice(open, close + 1)
      break
    }
  }
  if (!guid) return null
  const kept = []
  let inProject = false
  for (const line of slnText.split(/\r?\n/)) {
    if (inProject) {
      if (line.trim() === 'EndProject') inProject = false
      continue
    }
    if (line.trimStart().startsWith('Project(') && line.includes(needle)) {
      inProject = true
      continue
    }
    if (line.includes(guid)) continue
    kept.push(line)
  }
  let result = kept.join(eol)
  if (hadTrailingNewline) result += eol
  return result
}

/** Remove leftover temporary-project artifacts from the generated output. */
export function stripTempProjectArtifacts(root) {
  const csproj = join(root, `${TEMP_ASSEMBLY_NAME}.csproj`)
  if (existsSync(csproj)) rmSync(csproj, { force: true })
  let names
  try {
    names = readdirSync(root)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.sln')) continue
    const path = join(root, name)
    try {
      const text = readFileSync(path, 'utf8')
      const stripped = stripProjectFromSolution(text, `${TEMP_ASSEMBLY_NAME}.csproj`)
      if (stripped !== null) writeFileSync(path, stripped)
    } catch {
      // Best effort: leftovers only cost a load warning.
    }
  }
}

/**
 * Project files to hand the language server.
 *
 * A solution is preferred (one `solution/open` covers every assembly); a
 * `*.csproj` set is the fallback when a generator produced only project files.
 */
export function findProjectTargets(root) {
  if (!existsSync(root)) return { solution: null, projects: [], scannedAt: null }
  const solutions = []
  const projects = []
  let scannedAt = null
  for (const name of readdirSync(root)) {
    const path = join(root, name)
    let stats
    try {
      stats = statSync(path)
    } catch {
      continue
    }
    if (!stats.isFile()) continue
    const lower = name.toLowerCase()
    if (lower.endsWith('.sln')) solutions.push({ path, mtimeMs: stats.mtimeMs })
    else if (lower.endsWith('.csproj')) projects.push({ path, mtimeMs: stats.mtimeMs })
  }
  // A generated solution is rewritten on every sync; its mtime is the freshest
  // single timestamp to compare project inputs against.
  solutions.sort((a, b) => b.mtimeMs - a.mtimeMs)
  projects.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const newestProject = projects[0]?.mtimeMs ?? 0
  const newestSolution = solutions[0]?.mtimeMs ?? 0
  scannedAt = Math.max(newestProject, newestSolution) || null
  return {
    solution: solutions[0]?.path ?? null,
    projects: projects.map((entry) => entry.path),
    scannedAt,
  }
}

/** Extensions whose edits invalidate the generated project files. */
const PROJECT_INPUT_EXTENSIONS = ['.cs', '.asmdef', '.asmref', '.rsp', '.additionalfile']

/**
 * Whether a source file changed after the project files were generated.
 *
 * The server caches its MSBuild evaluation, so a stale `.sln` means a new file
 * is invisible until a re-sync. Comparing mtimes is cheaper than parsing
 * Unity's own change detection and catches the common case (a file written
 * after the last sync).
 */
export function projectFilesStale(root, scannedAt, paths) {
  if (!scannedAt) return true
  for (const path of paths) {
    if (!PROJECT_INPUT_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension))) continue
    try {
      if (statSync(path).mtimeMs > scannedAt) return true
    } catch {
      // A file we cannot stat cannot prove the project files are current.
      return true
    }
  }
  return false
}

/** Ask a connected editor to regenerate `.sln`/`.csproj`. */
export async function syncFromEditor(target) {
  // Not `exclusive`: the command only rewrites project files, so replaying it
  // after a reload boundary is harmless.
  return withClient(target, async (client) => {
    const envelope = await client.call('sync_project_files', '', { timeoutMs: 180_000 })
    const report = String(envelope?.message ?? '').trim()
    if (/sync_skipped/.test(report)) {
      return { ok: false, report: `the editor refused a concurrent sync: ${report}`, channel: 'plugin' }
    }
    return { ok: true, report, channel: 'plugin' }
  })
}

/**
 * Fallback for an editor whose plugin predates `sync_project_files`: run the
 * generator chain as a compiled snippet.
 */
export async function syncFromEditorSnippet(target, { signal = null } = {}) {
  return withClient(target, async (client) => {
    const owner = `dsh-csharp-sync-${process.pid}`
    const session = await openEditSession(target, owner)
    try {
      const { output } = await executeSnippet(client, {
        code: editorSyncSnippet(),
        executionId: `dsh-csharp-sync-${process.pid}-${Date.now()}`,
        timeoutMs: 180_000,
        signal,
      })
      const report = String(output ?? '').trim()
      return { ok: /^synced/m.test(report), report, channel: 'snippet' }
    } finally {
      await session.release().catch(() => {})
    }
  })
}

/**
 * Generate project files with a one-shot headless editor run.
 *
 * Writes a temporary embedded package (auto-discovered by Unity, so no
 * manifest edit is needed), runs `-batchmode -quit -executeMethod`, then
 * removes the package and strips its artifacts from the generated solution.
 */
export async function syncFromBatchMode(root, { unityExecutable = null, timeoutMs = BATCH_SYNC_TIMEOUT_MS } = {}) {
  if (!unityExecutable) {
    throw new ProjectSyncError(
      'no .sln/.csproj in the project and no connected editor to generate them. ' +
        'Open the project in Unity once (which writes them), or start the editor and retry.',
      { code: 'project_files_missing' },
    )
  }
  const packageDir = tempPackageDir(root)
  writeTempPackage(packageDir)
  try {
    const { spawn } = await import('node:child_process')
    const output = await new Promise((resolve, reject) => {
      const child = spawn(
        unityExecutable,
        ['-batchmode', '-quit', '-nographics', '-projectPath', root, '-executeMethod', `${TEMP_ASSEMBLY_NAME}.Run`, '-logFile', '-'],
        { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
      )
      let text = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new ProjectSyncError(`the headless Unity run exceeded ${Math.round(timeoutMs / 1000)}s`, { code: 'batch_timeout' }))
      }, timeoutMs)
      child.stdout.on('data', (chunk) => {
        text += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        text += String(chunk)
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(new ProjectSyncError(`cannot start ${unityExecutable}: ${error.message}`, { code: 'batch_failed' }))
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        resolve({ code, text })
      })
    })
    const report = /\[LocusProjectSync\][^\n]*\n[\s\S]{0,4000}/.exec(output.text)?.[0]?.trim() ?? ''
    const targets = findProjectTargets(root)
    if (!targets.solution && targets.projects.length === 0) {
      throw new ProjectSyncError(
        `Unity batch generation finished (exit ${output.code}) but no .sln/.csproj appeared in the project root.` +
          (report ? `\nGenerator report:\n${report}` : ''),
        { code: 'project_files_missing', report },
      )
    }
    return { ok: true, report: report || 'batch generation finished', channel: 'batchmode', exitCode: output.code }
  } finally {
    removeTempPackage(packageDir)
    stripTempProjectArtifacts(root)
  }
}

/**
 * Ensure the workspace has project files, generating them when absent.
 *
 * @returns {{ solution: string|null, projects: string[], channel: string, report: string }}
 */
export async function ensureProjectFiles(root, { target = null, unityExecutable = null, force = false, signal = null } = {}) {
  const existing = findProjectTargets(root)
  if (!force && (existing.solution || existing.projects.length > 0)) {
    return { ...existing, channel: 'existing', report: 'project files already present' }
  }
  let sync = null
  if (target) {
    try {
      sync = await syncFromEditor(target)
      if (!sync.ok) sync = await syncFromEditorSnippet(target, { signal })
    } catch (error) {
      sync = { ok: false, report: `editor sync failed: ${error.message}`, channel: 'editor' }
    }
  }
  if (!sync?.ok) {
    const batch = await syncFromBatchMode(root, { unityExecutable })
    sync = batch
  }
  const refreshed = findProjectTargets(root)
  if (!refreshed.solution && refreshed.projects.length === 0) {
    throw new ProjectSyncError(
      'no .sln/.csproj appeared after generation.' + (sync?.report ? `\n${sync.report}` : ''),
      { code: 'project_files_missing', report: sync?.report ?? null },
    )
  }
  return { ...refreshed, channel: sync?.channel ?? 'unknown', report: sync?.report ?? '' }
}

/**
 * Whether the project has been restored (`obj/project.assets.json`).
 *
 * This matters more than it looks. Without restore artifacts the Roslyn
 * compiler provider answers `textDocument/diagnostic` with an empty list
 * forever — no error, no timeout — while the analyzer providers still report
 * style suggestions. A user then sees "no diagnostics" for a file that does not
 * compile. Unity's own project generation runs restore as part of opening the
 * editor, so a real checkout normally has this; a checkout whose `.sln` was
 * generated by a different IDE, or one restored with a different
 * `BaseIntermediateOutputPath`, may not.
 */
/**
 * Where one project's `project.assets.json` may live.
 *
 * Unity's generated csproj set
 * `<BaseIntermediateOutputPath>Temp/obj/$(Configuration)/$(MSBuildProjectName)</BaseIntermediateOutputPath>`,
 * so restore artifacts land in `Temp/obj/Debug/<Project>/` — not in the `obj/`
 * a hand-written SDK project would use. The property has to be read from the
 * project file; a fixed `obj/project.assets.json` path misses every Unity
 * checkout, which is exactly what happened before this was fixed.
 */
export function candidateAssetPaths(root, csprojPath) {
  let configured = null
  try {
    const text = readFileSync(csprojPath, 'utf8')
    const match = /<BaseIntermediateOutputPath>\s*([^<]+?)\s*<\/BaseIntermediateOutputPath>/.exec(text)
    if (match) configured = match[1]
  } catch {
    // Unreadable project file: fall through to the defaults below.
  }
  const projectName = basename(csprojPath, '.csproj')
  const paths = []
  if (configured) {
    for (const configuration of ['Debug', 'Release']) {
      const expanded = configured
        .replaceAll('$(Configuration)', configuration)
        .replaceAll('$(MSBuildProjectName)', projectName)
        .replaceAll('\\', '/')
      paths.push(join(root, expanded, 'project.assets.json'))
    }
  }
  // The SDK default, and the shape a project may carry over from another tool.
  paths.push(join(root, 'obj', 'project.assets.json'))
  paths.push(join(root, 'obj', 'Debug', 'project.assets.json'))
  return [...new Set(paths)]
}

/**
 * Whether every project in the workspace has restore artifacts.
 *
 * "Some project restored" is not enough: the compiler provider loads the whole
 * solution, and a single unrestored project makes its diagnostics empty.
 */
export function projectIsRestored(root) {
  let projects
  try {
    projects = findProjectTargets(root).projects
  } catch {
    return false
  }
  if (projects.length === 0) return false
  return projects.every((csproj) => candidateAssetPaths(root, csproj).some((assets) => existsSync(assets)))
}

/**
 * Run `dotnet restore` for the workspace when no restore artifacts exist.
 *
 * Best effort: a failed restore is reported so the caller can mention it, but it
 * does not stop the server (symbol search, hover and definition work off the
 * MSBuild evaluation alone).
 */
export async function ensureRestored(root, { dotnetProgram = 'dotnet', stateDir = null, timeoutMs = 300_000 } = {}) {
  if (projectIsRestored(root)) return { restored: true, ran: false, output: '' }
  const targets = findProjectTargets(root)
  const projects = targets.projects
  if (projects.length === 0 && !targets.solution) {
    return { restored: false, ran: false, output: 'no .csproj to restore' }
  }
  // `dotnet restore` accepts exactly one project or solution per invocation:
  // passing several csproj fails with MSB1008 ("only one project can be
  // specified"), which a Unity checkout with Assembly-CSharp.csproj plus its
  // package projects triggers every time. Prefer the solution (it restores every
  // project it lists in one pass) and fall back to one call per csproj.
  const restoreArgs = targets.solution ? [targets.solution] : projects
  const { spawn } = await import('node:child_process')
  const runRestore = (args) => new Promise((resolve) => {
    const child = spawn(dotnetProgram, ['restore', ...args], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // `dotnet` writes first-run sentinels into `DOTNET_CLI_HOME` (default
      // `$HOME`); on a host with a read-only home it exits before restoring, so
      // point it at the writable asset state dir when one is available.
      env: {
        ...process.env,
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        DOTNET_NOLOGO: '1',
        DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
        ...(stateDir ? { DOTNET_CLI_HOME: stateDir } : {}),
      },
    })
    let text = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: null, text: `${text}\n(restore exceeded ${Math.round(timeoutMs / 1000)}s)` })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      text += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      text += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: null, text: `cannot start ${dotnetProgram}: ${error.message}` })
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      resolve({ code, text })
    })
  })

  if (targets.solution) {
    const result = await runRestore(restoreArgs)
    return {
      restored: projectIsRestored(root),
      ran: true,
      exitCode: result.code,
      output: result.text.trim().slice(-2000),
    }
  }

  // No solution: restore each project separately, stopping at the first failure
  // so the caller sees the real error instead of a cascade.
  const outputs = []
  for (const project of projects) {
    const result = await runRestore([project])
    outputs.push(result.text.trim())
    if (result.code !== 0) {
      return {
        restored: projectIsRestored(root),
        ran: true,
        exitCode: result.code,
        output: outputs.join('\n').slice(-2000),
      }
    }
  }
  return {
    restored: projectIsRestored(root),
    ran: true,
    exitCode: 0,
    output: outputs.join('\n').slice(-2000),
  }
}

/** Root-relative display path for a project file. */
export function displayProjectPath(root, path) {
  return relative(root, path).replaceAll('\\', '/')
}
/**
 * Whether a source file is part of any project's compile set.
 *
 * Unity's generated csproj list every file explicitly (7 `<Compile Include>`
 * entries for a 7-script project) rather than globbing, so a file written after
 * the last project sync is simply absent from the compilation. Roslyn then
 * reports no diagnostics for it — indistinguishable from "this file is clean"
 * unless the caller checks. An explicit glob entry is treated as membership so a
 * hand-written SDK project does not pay for the scan.
 *
 * @returns {'member'|'absent'|'unknown'} `unknown` when no project file could be read.
 */
export function fileInProject(root, absolutePath) {
  let targets
  try {
    targets = findProjectTargets(root).projects
  } catch {
    return 'unknown'
  }
  if (targets.length === 0) return 'unknown'
  const relativePath = relative(root, absolutePath).replaceAll('\\', '/')
  if (!relativePath || relativePath.startsWith('..')) return 'unknown'
  let sawAnyInclude = false
  for (const csproj of targets) {
    let text
    try {
      text = readFileSync(csproj, 'utf8')
    } catch {
      continue
    }
    for (const match of text.matchAll(/<Compile\s+Include="([^"]+)"/g)) {
      sawAnyInclude = true
      const include = match[1].replaceAll('\\', '/')
      if (include === relativePath) return 'member'
      // A glob covers everything it matches; `*` and `**` both count.
      if (/[*?]/.test(include)) {
        // MSBuild glob semantics: `**/` matches zero or more directories, so
        // `Assets/Scripts/**/*.cs` must accept `Assets/Scripts/Any.cs`.
        const pattern = include
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*\//g, '\u0001')
          .replace(/\*\*/g, '\u0000')
          .replace(/\*/g, '[^/]*')
          .replace(/\?/g, '.')
          .replace(/\u0001/g, '(?:.*/)?')
          .replace(/\u0000/g, '.*')
        if (new RegExp(`^${pattern}$`).test(relativePath)) return 'member'
      }
    }
  }
  return sawAnyInclude ? 'absent' : 'unknown'
}
