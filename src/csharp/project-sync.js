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

import { withClient, openEditSession, connectedClient } from '../client-pool.js'
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

bool __LocusRunChain()
{
    bool synced = false;
    try { synced = __LocusTryPluginGenerator(); }
    catch (System.Exception e) { __locusSyncLog.AppendLine("Locus generator: " + e.Message); }
    if (!synced)
    {
        try { synced = __LocusTrySyncAll(); }
        catch (System.Exception e) { __locusSyncLog.AppendLine("CodeEditor.SyncAll: " + e.Message); }
    }
    if (!synced)
    {
        try { synced = __LocusTryPackageGenerators(); }
        catch (System.Exception e) { __locusSyncLog.AppendLine("package generators: " + e.Message); }
    }
    if (!synced)
    {
        try { synced = __LocusTrySyncVs(); }
        catch (System.Exception e) { __locusSyncLog.AppendLine("SyncVS: " + e.Message); }
    }
    return synced;
}

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

__locusSynced = __LocusRunChain();
// A script that Unity has not imported yet is invisible to every generator
// (they enumerate the AssetDatabase, not the disk). Asking for the import
// first, then syncing once it finishes, is what makes a refresh after a new
// file actually add that file.
if (__locusAfterImport)
{
    UnityEditor.AssetDatabase.Refresh();
    // Do not wait for the import or the compile: a snippet has to print every
    // 30 s or it is killed, and a compile here would block the editor's main
    // thread (which the generators below need anyway). The next reload usually
    // lands after the import finished on its own.
    __locusSyncLog.AppendLine("AssetDatabase.Refresh: requested");
    __locusSynced = __LocusRunChain();
}
var __locusSyncReport =
    (__locusSynced ? "synced" : "no project generator succeeded") + "\\n" + __locusSyncLog;
`

/** Snippet that runs the generator chain inside a connected editor. */
export function editorSyncSnippet() {
  return `bool __locusAfterImport = false;\n${SYNC_CHAIN_STATEMENTS}\nprint(__locusSyncReport);\n`
}

/** Snippet that imports new scripts, then runs the generator chain again. */
export function refreshSnippet() {
  return `bool __locusAfterImport = true;\n${SYNC_CHAIN_STATEMENTS}\nprint(__locusSyncReport);\n`
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
    if (lower.endsWith('.sln')) solutions.push({ path, name, mtimeMs: stats.mtimeMs })
    else if (lower.endsWith('.csproj')) projects.push({ path, mtimeMs: stats.mtimeMs })
  }
  // A generated solution is rewritten on every sync; its mtime is the freshest
  // single timestamp to compare project inputs against.
  //
  // Which one is loaded matters: Unity leaves its own `<folder>.sln`
  // (`unity-test.sln`) next to an older IDE-generated one (`Tower of Babel.sln`),
  // and the two disagree about project membership. A solution named after the
  // directory wins, then the newest — upstream's `scan_project_target` order,
  // with mtime standing in for its alphabetical tie-break.
  const directoryName = basename(root)
  solutions.sort((a, b) => {
    const aOwn = solutionStem(a.name) === directoryName
    const bOwn = solutionStem(b.name) === directoryName
    if (aOwn !== bOwn) return aOwn ? -1 : 1
    return b.mtimeMs - a.mtimeMs
  })
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

/** `MyProj.sln` → `MyProj`, for comparing a solution against its directory. */
function solutionStem(name) {
  return name.replace(/\.sln$/i, '')
}

/** Extensions whose edits invalidate the generated project files. */
const PROJECT_INPUT_EXTENSIONS = ['.cs', '.asmdef', '.asmref', '.rsp', '.additionalfile']

/**
 * Newest project input under Unity's source folders.
 *
 * Only the folders Unity compiles are walked (`Assets/`, `Packages/`, plus
 * assembly definitions and response files at the root), dot directories are
 * skipped (`Packages/.git` is not project input), and `.cs` is the only
 * extension followed into directories — the others Unity only honors where it
 * finds them directly.
 *
 * @returns {Array<{ path: string, mtimeMs: number }>} inputs given to `projectFilesStale`
 */
export function newestSourceFile(root) {
  const inputs = []
  const walk = (dir, depth) => {
    if (depth > 8) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      const lower = entry.name.toLowerCase()
      if (entry.isDirectory()) {
        walk(path, depth + 1)
        continue
      }
      if (!entry.isFile() || !lower.endsWith('.cs')) continue
      try {
        inputs.push({ path, mtimeMs: statSync(path).mtimeMs })
      } catch {
        // Raced with a delete; not project input.
      }
    }
  }
  for (const folder of ['Assets', 'Packages']) walk(join(root, folder), 0)
  try {
    for (const name of readdirSync(root)) {
      const lower = name.toLowerCase()
      if (!PROJECT_INPUT_EXTENSIONS.some((extension) => lower.endsWith(extension))) continue
      const path = join(root, name)
      try {
        const stats = statSync(path)
        if (stats.isFile()) inputs.push({ path, mtimeMs: stats.mtimeMs })
      } catch {
        // Not a readable file.
      }
    }
  } catch {
    // Root unreadable: nothing to add.
  }
  return inputs
}

/**
 * Whether a source file changed after the project files were generated.
 *
 * The server caches its MSBuild evaluation, so a stale `.sln` means a new file
 * is invisible until a re-sync. A path may be a project input itself (its mtime
 * is compared) or carry one as `{ path, mtimeMs }` when the caller already
 * statted it (a tree walk, where a per-file `statSync` would be wasted work).
 */
export function projectFilesStale(scannedAt, inputs) {
  if (!scannedAt) return true
  for (const input of inputs) {
    const path = typeof input === 'string' ? input : input?.path
    if (!path) continue
    if (!PROJECT_INPUT_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension))) continue
    const known = typeof input === 'string' ? null : input.mtimeMs
    if (typeof known === 'number') {
      if (known > scannedAt) return true
      continue
    }
    try {
      if (statSync(path).mtimeMs > scannedAt) return true
    } catch {
      // A file we cannot stat cannot prove the project files are current.
      return true
    }
  }
  return false
}

/**
 * A broker target for `root` if an editor is already connected, else `null`.
 *
 * Never connects: the check runs on every load, including load-only paths in
 * tests and offline checkouts, and an editor that is not running must not turn
 * into a socket attempt (and its error message) here.
 */
export function connectedEditor(root) {
  try {
    const target = { projectRoot: root }
    return connectedClient(target) ? target : null
  } catch {
    return null
  }
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
export async function syncFromEditorSnippet(target, { signal = null, afterSync = false } = {}) {
  return withClient(target, async (client) => {
    const owner = `dsh-csharp-sync-${process.pid}`
    const session = await openEditSession(target, owner)
    try {
      const { output } = await executeSnippet(client, {
        code: afterSync ? refreshSnippet() : editorSyncSnippet(),
        executionId: `dsh-csharp-sync-${process.pid}-${Date.now()}`,
        // A generator over a large solution holds the main thread for minutes;
        // Unity's own idle watchdog refuses to run a snippet that prints
        // nothing for 30 s, so the wait for the outgoing compile is bounded to
        // that window and the total budget stays generous.
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
export async function syncFromBatchMode(
  root,
  { unityExecutable = null, timeoutMs = BATCH_SYNC_TIMEOUT_MS, reason = 'missing' } = {},
) {
  if (!unityExecutable) {
    // The two situations need different advice: a checkout that never had
    // project files cannot be repaired from here, while project files that
    // merely predate a script can (and the editor does it automatically).
    throw new ProjectSyncError(
      reason === 'stale'
        ? 'the project files predate a script, and no Unity editor is connected to regenerate them. ' +
            'Call unity_recompile (which regenerates them through the editor), or open the project in Unity.'
        : 'no .sln/.csproj in the project and no connected editor to generate them. ' +
            'Open the project in Unity once (which writes them), or start the editor and retry.',
      { code: reason === 'stale' ? 'project_files_stale' : 'project_files_missing' },
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
  return ensureProjectFilesWith(root, { target, unityExecutable, force, signal })
}

/**
 * Regenerate project files that no longer cover the sources on disk.
 *
 * Upstream regenerates before every cold load and whenever it sees `.cs` files
 * it has no project for; the plugin instead only generated them when *none*
 * existed, so in an editor session a newly added script stayed invisible to the
 * server (empty symbol search, a file "not in any project") until Unity itself
 * next rewrote the csproj. This is the same decision made cheaply: if the
 * newest source file under `Assets/`/`Packages/` is newer than the newest
 * project file, the generated set is stale and is rebuilt through the editor.
 *
 * Failures are reported, never thrown: the existing (stale) project files still
 * analyze everything they know about, which beats refusing to answer.
 *
 * @returns {Promise<{ refreshed: boolean, channel: string|null, report: string|null }>}
 */
export async function refreshProjectFiles(
  root,
  { target = null, unityExecutable = null, signal = null, sources = null, force = false } = {},
) {
  const existing = findProjectTargets(root)
  if (!existing.solution && existing.projects.length === 0) {
    return { refreshed: false, channel: null, report: null, stale: false }
  }
  // Two independent reasons to regenerate:
  //  * project files older than a source — Unity writes them on save, so a
  //    script added after the last sync is missing from them;
  //  * a source an earlier answer already named that no project compiles —
  //    the case the mtime check cannot see, because Unity skips a script it has
  //    not imported and the `.csproj` can therefore be newer than every source
  //    and still omit one.
  const sourcesMissing = sourcesMissingFromProjects(root, sources)
  const stale = force || sourcesMissing || projectFilesStale(existing.scannedAt, newestSourceFile(root))
  if (!stale) return { refreshed: false, channel: null, report: null, stale: false }
  try {
    const synced = await ensureProjectFilesWith(root, { target, unityExecutable, force: true, signal })
    const now = findProjectTargets(root)
    // A generator that ran but did not write anything is not a refresh; saying
    // otherwise would make the caller believe the missing script is analyzed.
    const refreshed = now.scannedAt !== existing.scannedAt
    return { refreshed, channel: synced.channel, report: synced.report, stale: true }
  } catch (error) {
    return { refreshed: false, channel: null, report: error.message, stale: true }
  }
}

/**
 * Whether any of `sources` (absolute paths an answer already named) is absent
 * from the generated project files.
 *
 * A file written with `File.WriteAllText` and then referenced by a tool call is
 * the case `projectFilesStale` cannot see: its mtime may be older than the
 * `.csproj`, and Unity's own generator skips a script it has not imported yet.
 * Upstream sees the same situation from the editor's file list and reloads.
 */
export function sourcesMissingFromProjects(root, sources) {
  if (!Array.isArray(sources) || sources.length === 0) return false
  const includes = readProjectIncludes(root)
  if (!includes) return false
  return sources.some((path) => fileInProject(root, path, includes) === 'absent')
}

async function ensureProjectFilesWith(root, { target, unityExecutable, force, signal }) {
  const existing = findProjectTargets(root)
  if (!force && (existing.solution || existing.projects.length > 0)) {
    // The editor is a fallback target when the caller has none: reloads after a
    // file change regenerate through it, and a reload that forgot the target
    // could only fail as "no editor to generate them".
    return {
      ...existing,
      channel: 'existing',
      report: 'project files already present',
      target: target ?? connectedEditor(root),
    }
  }
  let sync = null
  // A *refresh* has one extra requirement the plain generation path lacks: a
  // script Unity has not imported yet is invisible to every generator (they
  // enumerate the AssetDatabase, not the disk), so the project could be synced
  // and still lack the new file. Only the snippet can run that sequence (ask
  // for the import, then sync again), so a refresh uses it; a plugin that
  // answers `sync_skipped` falls back to the command, which also waits out a
  // sync already in flight.
  const hasProjectFiles = Boolean(existing.solution || existing.projects.length > 0)
  if (target) {
    try {
      sync = hasProjectFiles ? await syncFromEditorSnippet(target, { signal, afterSync: true }) : await syncFromEditor(target)
      if (!sync?.ok) sync = await syncFromEditor(target)
    } catch (error) {
      sync = { ok: false, report: `editor sync failed: ${error.message}`, channel: 'editor' }
    }
  }
  if (!sync?.ok) {
    const batch = await syncFromBatchMode(root, { unityExecutable, reason: hasProjectFiles ? 'stale' : 'missing' })
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
export async function ensureRestored(
  root,
  { dotnetProgram = 'dotnet', stateDir = null, timeoutMs = 300_000, force = false } = {},
) {
  if (!force && projectIsRestored(root)) return { restored: true, ran: false, output: '' }
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
/**
 * Compile items of every generated project, or `null` when there are none.
 *
 * Parsing the whole set once and answering many membership questions from it
 * keeps the per-query "is this file actually analyzed?" check cheap; the
 * previous implementation re-read every csproj for every single path.
 */
export function readProjectIncludes(root) {
  let projects
  try {
    projects = findProjectTargets(root).projects
  } catch {
    return null
  }
  if (projects.length === 0) return null
  const includes = []
  for (const csproj of projects) {
    let text
    try {
      text = readFileSync(csproj, 'utf8')
    } catch {
      continue
    }
    for (const match of text.matchAll(/<Compile\s+Include="([^"]+)"/g)) {
      const include = match[1].replaceAll('\\', '/')
      // A glob covers everything it matches; `*` and `**` both count.
      // MSBuild glob semantics: `**/` matches zero or more directories, so
      // `Assets/Scripts/**/*.cs` must accept `Assets/Scripts/Any.cs`.
      includes.push(
        /[*?]/.test(include)
          ? {
              pattern: new RegExp(
                `^${include
                  .replace(/[.+^${}()|[\]\\]/g, '\\$&')
                  .replace(/\*\*\//g, '\u0001')
                  .replace(/\*\*/g, '\u0000')
                  .replace(/\*/g, '[^/]*')
                  .replace(/\?/g, '.')
                  .replace(/\u0001/g, '(?:.*/)?')
                  .replace(/\u0000/g, '.*')}$`,
              ),
            }
          : { literal: include },
      )
    }
  }
  return includes.length > 0 ? includes : null
}

/**
 * Whether `absolutePath` is a compile item of the workspace: `'member'`,
 * `'absent'`, or `'unknown'` when no project lists compile items at all (a
 * generated project set that relies on the SDK default glob, for instance).
 */
export function fileInProject(root, absolutePath, includes = null) {
  const items = includes ?? readProjectIncludes(root)
  if (!items) return 'unknown'
  const relativePath = relative(root, absolutePath).replaceAll('\\', '/')
  if (!relativePath || relativePath.startsWith('..')) return 'unknown'
  for (const item of items) {
    if (item.literal !== undefined ? item.literal === relativePath : item.pattern.test(relativePath)) return 'member'
  }
  return 'absent'
}
