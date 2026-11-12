// C# analysis: protocol framing, symbol location, archive extraction, asset
// resolution, project-file handling, and the tool surface.
//
// No Unity, no network, no .NET: the language server itself is exercised by the
// opt-in live script, because it needs a downloaded server and a real MSBuild
// project. Everything here is the logic that decides *whether* and *where* to
// run that server, which is where the bugs live.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

import {
  anchorNote,
  encodeLspMessage,
  fileUriToPath,
  locateSymbol,
  LspProtocolError,
  LspReader,
  pathToFileUri,
  symbolColumnInLine,
} from '../src/csharp/lsp-protocol.js'
import { extractTarGz, extractZip } from '../src/csharp/archive.js'
import {
  assetsRoot,
  assetStatus,
  downloadToFile,
  isPlatformSupported,
  platformRid,
  serverDllPath,
  unityAnalyzersDir,
} from '../src/csharp/assets.js'
import {
  collectLocations,
  displayPath,
  formatDiagnostics,
  formatDefinition,
  formatReferences,
  formatSymbols,
  isUnityManagedCsharp,
  severityLabel,
  severityRank,
  symbolKindName,
} from '../src/csharp/queries.js'
import {
  batchEntryPointSource,
  candidateAssetPaths,
  editorSyncSnippet,
  fileInProject,
  findProjectTargets,
  projectFilesStale,
  projectIsRestored,
  stripProjectFromSolution,
} from '../src/csharp/project-sync.js'
import { csharpToolDefinitions, csharpToolNames } from '../src/csharp/tools.js'
import { allToolDefinitions, csharpEnabled } from '../src/index.js'

const sandbox = mkdtempSync(join(tmpdir(), 'locus-csharp-test-'))
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }))

function file(name, contents) {
  const path = join(sandbox, name)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, contents)
  return path
}

// ─── framing ────────────────────────────────────────────────────────────────

test('LspReader reassembles a message split across reads', () => {
  const reader = new LspReader()
  const encoded = encodeLspMessage({ jsonrpc: '2.0', id: 1, result: { ok: true } })
  // A pipe hands over arbitrary boundaries, including inside the body.
  assert.deepEqual(reader.push(encoded.subarray(0, 10)), [])
  assert.deepEqual(reader.push(encoded.subarray(10, 25)), [])
  const messages = reader.push(encoded.subarray(25))
  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0].result, { ok: true })
})

test('LspReader returns several messages from one chunk', () => {
  const reader = new LspReader()
  const chunk = Buffer.concat([
    encodeLspMessage({ jsonrpc: '2.0', method: 'window/logMessage', params: {} }),
    encodeLspMessage({ jsonrpc: '2.0', id: 7, result: null }),
  ])
  const messages = reader.push(chunk)
  assert.equal(messages.length, 2)
  assert.equal(messages[1].id, 7)
})

test('LspReader rejects a header without Content-Length', () => {
  const reader = new LspReader()
  const bogus = Buffer.from('Content-Type: json\r\n\r\n{}', 'ascii')
  assert.throws(() => reader.push(bogus), LspProtocolError)
})

test('LspReader rejects a body that is not JSON', () => {
  const reader = new LspReader()
  const body = Buffer.from('not json', 'utf8')
  const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
  assert.throws(() => reader.push(frame), LspProtocolError)
})

test('a body may contain multibyte text, since length is bytes not characters', () => {
  const reader = new LspReader()
  const messages = reader.push(encodeLspMessage({ jsonrpc: '2.0', method: 'x', params: { text: '任务已取消' } }))
  assert.equal(messages[0].params.text, '任务已取消')
})

test('URI conversion round-trips a path with spaces', () => {
  const path = join(sandbox, 'a b', 'Player.cs')
  const uri = pathToFileUri(path)
  assert.match(uri, /^file:\/\//)
  assert.equal(fileUriToPath(uri), path)
  assert.equal(fileUriToPath('untitled:foo'), null)
})

// ─── symbol location ────────────────────────────────────────────────────────

const SOURCE = [
  'namespace Game',
  '{',
  '    public class Player',
  '    {',
  '        public int health = 10;',
  '',
  '        public void Damage(int amount)',
  '        {',
  '            health -= amount;',
  '        }',
  '    }',
  '}',
].join('\n')

test('symbolColumnInLine requires a whole word unless substring is allowed', () => {
  const line = '        health -= amount; // health'
  assert.equal(symbolColumnInLine(line, 'health', false), 8)
  // `Save` inside `SaveAll` is not a whole-word hit.
  assert.equal(symbolColumnInLine('SaveAll();', 'Save', false), null)
  assert.equal(symbolColumnInLine('SaveAll();', 'Save', true), 0)
})

test('locateSymbol honours a line hint', () => {
  const found = locateSymbol(SOURCE, 5, 'health')
  assert.equal(found.line, 4)
  assert.equal(found.character, 19)
  assert.deepEqual(found.anchor, { line: 5, requestedLine: 5 })
})

test('locateSymbol falls back to the nearest occurrence when the hint misses', () => {
  const found = locateSymbol(SOURCE, 1, 'health')
  assert.equal(found.line, 4)
  assert.equal(found.anchor.line, 5)
  assert.equal(found.anchor.requestedLine, 1)
})

test('locateSymbol without a hint requires a unique occurrence', () => {
  // `health` appears twice (declaration and use), so the caller is told to pick.
  assert.throws(() => locateSymbol(SOURCE, null, 'health'), /appears on 2 lines/)
  const single = locateSymbol(SOURCE, null, 'Player')
  assert.equal(single.line, 2)
  assert.equal(single.anchor.requestedLine, null)
})

test('locateSymbol skips comment lines during the file-wide scan', () => {
  const text = 'class A\n{\n    // health is mentioned only here\n    int health;\n}\n'
  const found = locateSymbol(text, null, 'health')
  assert.equal(found.line, 3)
})

test('locateSymbol reports a missing symbol with the hinted line content', () => {
  assert.throws(() => locateSymbol(SOURCE, 5, 'Nope'), /not found.*Line 5 content: public int health/s)
})

test('locateSymbol reject a 0 line hint', () => {
  assert.throws(() => locateSymbol(SOURCE, 0, 'health'), /1-based/)
})

test('anchorNote only speaks up when it adjusted', () => {
  assert.equal(anchorNote('x', { line: 3, requestedLine: 3 }), '')
  assert.match(anchorNote('x', { line: 3, requestedLine: 1 }), /was not on line 1; used .* line 3/)
  assert.match(anchorNote('x', { line: 3, requestedLine: null }), /Resolved 'x' at line 3/)
})

// ─── archives ───────────────────────────────────────────────────────────────

test('extractZip keeps only the requested prefix and strips it', () => {
  const source = join(sandbox, 'zip-src')
  mkdirSync(join(source, 'content', 'LanguageServer', 'linux-x64'), { recursive: true })
  writeFileSync(join(source, 'content', 'LanguageServer', 'linux-x64', 'Server.dll'), 'DLL')
  writeFileSync(join(source, 'content', 'other.txt'), 'nope')
  const archive = join(sandbox, 'payload.nupkg')
  execFileSync('zip', ['-qr', archive, 'content'], { cwd: source })
  const dest = join(sandbox, 'zip-out')
  const result = extractZip(readFileSync(archive), dest, { prefix: 'content/LanguageServer/linux-x64/' })
  assert.deepEqual(result.files, ['Server.dll'])
  assert.equal(readFileSync(join(dest, 'Server.dll'), 'utf8'), 'DLL')
  assert.ok(result.skipped > 0, 'entries outside the prefix are counted')
})

test('extractZip refuses a traversing entry', () => {
  const source = join(sandbox, 'escape-src')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'evil.txt'), 'x')
  const archive = join(sandbox, 'escape.zip')
  // Build an archive whose stored name is `../evil.txt`.
  execFileSync('python3', [
    '-c',
    `import zipfile;z=zipfile.ZipFile(${JSON.stringify(archive)},'w');z.writestr('../evil.txt','x');z.close()`,
  ])
  assert.throws(() => extractZip(readFileSync(archive), join(sandbox, 'escape-out')), /escapes the destination/)
})

test('extractTarGz writes regular files and skips links', () => {
  const source = join(sandbox, 'tar-src')
  mkdirSync(join(source, 'shared', 'Microsoft.NETCore.App'), { recursive: true })
  writeFileSync(join(source, 'shared', 'Microsoft.NETCore.App', 'lib.dll'), 'LIB')
  execFileSync('ln', ['-s', 'lib.dll', join(source, 'shared', 'Microsoft.NETCore.App', 'link.dll')])
  const archive = join(sandbox, 'runtime.tar.gz')
  execFileSync('tar', ['czf', archive, 'shared'], { cwd: source })
  const dest = join(sandbox, 'tar-out')
  const result = extractTarGz(readFileSync(archive), dest)
  assert.deepEqual(result.files, ['shared/Microsoft.NETCore.App/lib.dll'])
  assert.equal(readFileSync(join(dest, 'shared', 'Microsoft.NETCore.App', 'lib.dll'), 'utf8'), 'LIB')
  assert.ok(result.skipped >= 1, 'the symlink is skipped rather than followed')
})

// ─── assets ─────────────────────────────────────────────────────────────────

test('platformRid covers the four supported hosts', () => {
  assert.equal(platformRid('win32', 'x64'), 'win-x64')
  assert.equal(platformRid('win32', 'arm64'), 'win-arm64')
  assert.equal(platformRid('darwin', 'arm64'), 'osx-arm64')
  assert.equal(platformRid('linux', 'x64'), 'linux-x64')
  assert.equal(platformRid('linux', 'arm64'), 'linux-arm64')
  assert.equal(platformRid('freebsd', 'x64'), null)
  assert.equal(isPlatformSupported('freebsd', 'x64'), false)
})

test('asset paths sit under the configured root and report missing components', () => {
  const root = join(sandbox, 'assets')
  const env = { DSH_LOCUS_CSHARP_HOME: root }
  assert.equal(assetsRoot(env), root)
  const status = assetStatus(env, { rid: 'linux-x64' })
  assert.equal(status.supported, true)
  assert.deepEqual(status.missing, ['server', 'analyzers', 'runtime'])
  assert.ok(status.installBytes > 0)
  assert.equal(status.server.ready, false)
  // The paths must not depend on the check passing.
  assert.match(serverDllPath(env, 'linux-x64'), /server[\\/]5\.4\.0.*[\\/]linux-x64[\\/]Microsoft\.CodeAnalysis\.LanguageServer\.dll$/)
  assert.match(unityAnalyzersDir(env), /unity-analyzers[\\/]1\.26\.0$/)
})

test('a seeded asset tree reports ready', () => {
  const root = join(sandbox, 'seeded')
  const env = { DSH_LOCUS_CSHARP_HOME: root }
  const rid = 'linux-x64'
  const serverDir = join(root, 'server', '5.4.0-2.26179.14', rid)
  mkdirSync(serverDir, { recursive: true })
  writeFileSync(join(serverDir, 'Microsoft.CodeAnalysis.LanguageServer.dll'), 'x')
  writeFileSync(join(serverDir, '.locus-complete'), 'ok')
  const analyzers = join(root, 'unity-analyzers', '1.26.0')
  mkdirSync(analyzers, { recursive: true })
  writeFileSync(join(analyzers, '.locus-complete'), 'ok')
  const status = assetStatus(env, { rid })
  assert.equal(status.server.ready, true)
  assert.equal(status.analyzers.ready, true)
  assert.deepEqual(status.missing, ['runtime'])
})

// ─── project files ──────────────────────────────────────────────────────────

test('findProjectTargets prefers the newest solution', () => {
  const root = join(sandbox, 'proj')
  mkdirSync(root, { recursive: true })
  const older = join(root, 'Old.sln')
  writeFileSync(older, 'x')
  const newer = join(root, 'New.sln')
  writeFileSync(newer, 'x')
  writeFileSync(join(root, 'Assembly-CSharp.csproj'), '<Project/>')
  const targets = findProjectTargets(root)
  assert.equal(targets.solution, newer)
  assert.equal(targets.projects.length, 1)
})

test('findProjectTargets reports nothing for an empty directory', () => {
  const root = join(sandbox, 'empty-proj')
  mkdirSync(root, { recursive: true })
  const targets = findProjectTargets(root)
  assert.equal(targets.solution, null)
  assert.deepEqual(targets.projects, [])
})

test('projectFilesStale notices a .cs newer than the generated project files', () => {
  const root = join(sandbox, 'stale')
  mkdirSync(root, { recursive: true })
  const source = join(root, 'New.cs')
  writeFileSync(source, 'class A {}')
  assert.equal(projectFilesStale(root, Date.now() + 10_000, [source]), false)
  assert.equal(projectFilesStale(root, 1, [source]), true)
  // An unreadable file cannot prove freshness.
  assert.equal(projectFilesStale(root, Date.now() + 10_000, [join(root, 'gone.cs')]), true)
})

test('stripProjectFromSolution removes the block and its GUID lines', () => {
  const sln = [
    'Microsoft Visual Studio Solution File, Format Version 12.00',
    'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "Assembly-CSharp", "Assembly-CSharp.csproj", "{AAAAAAAA-1111-1111-1111-111111111111}"',
    'EndProject',
    'Project("{FAE04EC0-301F-11D3-BF4B-00C04F79EFBC}") = "LocusProjectFileSyncTemp", "LocusProjectFileSyncTemp.csproj", "{BBBBBBBB-2222-2222-2222-222222222222}"',
    'EndProject',
    'Global',
    '\tGlobalSection(SolutionConfigurationPlatforms) = preSolution',
    '\t\tDebug|AnyCPU = Debug|AnyCPU',
    '\tEndGlobalSection',
    '\tGlobalSection(ProjectConfigurationPlatforms) = postSolution',
    '\t\t{AAAAAAAA-1111-1111-1111-111111111111}.Debug|AnyCPU.ActiveCfg = Debug|AnyCPU',
    '\t\t{BBBBBBBB-2222-2222-2222-222222222222}.Debug|AnyCPU.ActiveCfg = Debug|AnyCPU',
    '\tEndGlobalSection',
    'EndGlobal',
  ].join('\n')
  const stripped = stripProjectFromSolution(sln, 'LocusProjectFileSyncTemp.csproj')
  assert.ok(stripped !== null)
  assert.doesNotMatch(stripped, /LocusProjectFileSyncTemp/)
  assert.doesNotMatch(stripped, /BBBBBBBB/)
  assert.match(stripped, /Assembly-CSharp\.csproj/)
  assert.match(stripped, /AAAAAAAA-1111/)
})

test('stripProjectFromSolution returns null when the project is absent', () => {
  assert.equal(stripProjectFromSolution('nothing here', 'x.csproj'), null)
})

test('projectIsRestored requires obj/project.assets.json beside a csproj', () => {
  const root = join(sandbox, 'restore-check')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'G.csproj'), '<Project/>')
  assert.equal(projectIsRestored(root), false, 'no obj directory yet')
  // The generated files dotnet writes before the assets file are not enough:
  // without project.assets.json the compiler provider stays silent.
  mkdirSync(join(root, 'obj', 'Debug', 'netstandard2.1'), { recursive: true })
  writeFileSync(join(root, 'obj', 'Debug', 'netstandard2.1', 'G.AssemblyInfo.cs'), '//')
  assert.equal(projectIsRestored(root), false)
  writeFileSync(join(root, 'obj', 'project.assets.json'), '{}')
  assert.equal(projectIsRestored(root), true)
})

test('projectIsRestored is false for a directory with no csproj', () => {
  const root = join(sandbox, 'restore-empty')
  mkdirSync(join(root, 'obj'), { recursive: true })
  writeFileSync(join(root, 'obj', 'project.assets.json'), '{}')
  assert.equal(projectIsRestored(root), false)
})

// ─── formatting ─────────────────────────────────────────────────────────────

test('severity labels and ranks agree', () => {
  assert.equal(severityLabel(1), 'error')
  assert.equal(severityLabel(4), 'hint')
  assert.equal(severityLabel(9), 'hint')
  assert.equal(severityRank('error'), 1)
  assert.equal(severityRank('hint'), 4)
  assert.equal(severityRank('nope'), null)
})

test('symbol kinds map to readable labels', () => {
  assert.equal(symbolKindName(5), 'Class')
  assert.equal(symbolKindName(6), 'Method')
  assert.equal(symbolKindName(999), 'Symbol')
})

test('displayPath relativizes inside the workspace and keeps outsiders absolute', () => {
  const root = join(sandbox, 'ws')
  assert.equal(displayPath(root, join(root, 'Assets', 'A.cs')), 'Assets/A.cs')
  assert.match(displayPath(root, join(sandbox, 'outside', 'B.cs')), /outside\/B\.cs$/)
})

test('isUnityManagedCsharp enforces the Assets/Packages rule', () => {
  const root = join(sandbox, 'ws2')
  assert.equal(isUnityManagedCsharp(root, join(root, 'Assets', 'A.cs')), true)
  assert.equal(isUnityManagedCsharp(root, join(root, 'Packages', 'p', 'B.cs')), true)
  assert.equal(isUnityManagedCsharp(root, join(root, 'Library', 'C.cs')), false)
  assert.equal(isUnityManagedCsharp(root, join(root, 'Assets', 'note.txt')), false)
})

test('collectLocations dedupes, sorts and reads line text', () => {
  const root = join(sandbox, 'loc')
  mkdirSync(join(root, 'Assets'), { recursive: true })
  const a = join(root, 'Assets', 'A.cs')
  writeFileSync(a, 'line one\nline two\n')
  const b = join(root, 'Assets', 'B.cs')
  writeFileSync(b, 'bee one\n')
  const raw = [
    { uri: pathToFileUri(b), range: { start: { line: 0 } } },
    { uri: pathToFileUri(a), range: { start: { line: 1 } } },
    { uri: pathToFileUri(a), range: { start: { line: 1 } } }, // duplicate
    { uri: 'untitled:Untitled-1', range: { start: { line: 0 } } }, // external
  ]
  const { locations } = collectLocations(root, raw)
  assert.equal(locations.length, 3)
  assert.deepEqual(locations[0], { path: 'Assets/A.cs', line: 2, text: 'line two' })
  assert.deepEqual(locations[1], { path: 'Assets/B.cs', line: 1, text: 'bee one' })
  assert.equal(locations[2].line, 0)
  assert.match(locations[2].path, /^\[external\]/)
})

test('formatSymbols explains an empty result instead of printing nothing', () => {
  const text = formatSymbols('Nope', [])
  assert.match(text, /No C# symbols matched 'Nope'/)
})

test('formatDefinition distinguishes source from a compiled assembly', () => {
  const external = formatDefinition('Foo', {
    file: 'Assets/A.cs',
    anchor: { line: 1, requestedLine: null },
    locations: [{ path: '[external] dll', line: 0, text: '' }],
  })
  assert.match(external, /compiled assembly/)
  const missing = formatDefinition('Foo', { file: 'Assets/A.cs', anchor: null, locations: [] })
  assert.match(missing, /No definition found/)
})

test('formatReferences points at unity_code_usages when empty', () => {
  const text = formatReferences('Foo', { file: 'Assets/A.cs', anchor: null, locations: [] }, { includeDeclaration: false })
  assert.match(text, /unity_code_usages/)
})

test('formatDiagnostics filters by severity and summarises counts', () => {
  const result = {
    scope: 'file',
    file: 'Assets/A.cs',
    diagnostics: [
      { path: 'Assets/A.cs', line: 1, column: 1, severity: 1, code: 'CS0103', message: 'missing' },
      { path: 'Assets/A.cs', line: 2, column: 1, severity: 2, code: 'IDE0001', message: 'style' },
      { path: 'Assets/A.cs', line: 3, column: 1, severity: 3, code: 'IDE0002', message: 'info' },
    ],
  }
  const warnings = formatDiagnostics(result, { minSeverity: 'warning' })
  assert.match(warnings, /2 C# diagnostic\(s\): 1 error, 1 warning/)
  assert.doesNotMatch(warnings, /IDE0002/)
  const errors = formatDiagnostics(result, { minSeverity: 'error' })
  assert.match(errors, /1 C# diagnostic\(s\): 1 error/)
  const clean = formatDiagnostics({ ...result, diagnostics: [] }, { minSeverity: 'warning' })
  assert.match(clean, /No C# diagnostics at or above 'warning'/)
})

// ─── tool surface ───────────────────────────────────────────────────────────

test('the C# tool set matches the upstream names it ports', () => {
  assert.deepEqual(csharpToolNames, [
    'code_symbol_search',
    'code_goto_definition',
    'code_find_references',
    'code_hover',
    'code_diagnostics',
    'code_analysis',
  ])
})

test('every C# tool is executable and declares an output schema', () => {
  for (const definition of csharpToolDefinitions) {
    assert.equal(typeof definition.execute, 'function', `${definition.name} must execute`)
    assert.equal(typeof definition.output?.render, 'function', `${definition.name} must render`)
    assert.ok(definition.description.length > 80, `${definition.name} needs a real description`)
  }
})

test('the C# tools are off when DSH_LOCUS_CSHARP is disabled', () => {
  assert.equal(csharpEnabled({}), true)
  assert.equal(csharpEnabled({ DSH_LOCUS_CSHARP: '0' }), false)
  assert.equal(csharpEnabled({ DSH_LOCUS_CSHARP: 'off' }), false)
  assert.equal(csharpEnabled({ DSH_LOCUS_CSHARP: 'true' }), true)
  const enabled = allToolDefinitions({}).map((definition) => definition.name)
  const disabled = allToolDefinitions({ DSH_LOCUS_CSHARP: '0' }).map((definition) => definition.name)
  assert.ok(enabled.includes('code_diagnostics'))
  assert.ok(!disabled.includes('code_diagnostics'))
  assert.equal(enabled.length - disabled.length, csharpToolDefinitions.length)
})

test('Unity and C# tool names never collide', () => {
  const names = allToolDefinitions({}).map((definition) => definition.name)
  assert.equal(new Set(names).size, names.length)
})
// ─── diagnostics honesty ────────────────────────────────────────────────────

test('an unrestored project is not reported as clean', () => {
  // Without restore artifacts the compiler provider returns nothing, so an
  // empty list must be explained rather than presented as "no errors".
  const text = formatDiagnostics({ scope: 'file', file: 'Assets/A.cs', diagnostics: [], restored: false })
  assert.match(text, /no restore artifacts/)
  assert.match(text, /dotnet restore/)
  const clean = formatDiagnostics({ scope: 'file', file: 'Assets/A.cs', diagnostics: [], restored: true })
  assert.doesNotMatch(clean, /restore/)
})

// ─── generated project-sync C# ──────────────────────────────────────────────
//
// The generator chain is a ~4.8 KB C# program embedded in a JavaScript template
// literal and shipped through two different hosts (`execute_code` and a
// temporary batch-mode package). A typo there fails at run time inside Unity,
// where no test can see it, so the shape is pinned here: ordering, the names the
// batch entry point must expose, and the absence of template-interpolation
// artifacts that would silently produce different source than intended.

test('the editor sync snippet tries generators in upstream order', () => {
  const snippet = editorSyncSnippet()
  const order = [
    '__LocusTryPluginGenerator',
    '__LocusTrySyncAll',
    '__LocusTryPackageGenerators',
    '__LocusTrySyncVs',
  ]
  const positions = order.map((name) => snippet.indexOf(name))
  for (const [index, position] of positions.entries()) {
    assert.ok(position >= 0, `${order[index]} is missing from the snippet`)
  }
  // Locus's own generator must run first: it is what keeps the temporary batch
  // package out of the generated solution.
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(
      positions[index] > positions[index - 1],
      `${order[index]} should be attempted after ${order[index - 1]}`,
    )
  }
})

test('the sync snippet reports through __locusSyncReport', () => {
  const snippet = editorSyncSnippet()
  assert.match(snippet, /var __locusSyncReport/)
  assert.match(snippet, /print\(__locusSyncReport\)/)
})

test('no JavaScript interpolation leaked into the generated C#', () => {
  // A `${` inside the template literal would have been evaluated at build time;
  // if one survived it means the source was quoted in a way that changes it.
  assert.doesNotMatch(editorSyncSnippet(), /\$\{/)
  assert.doesNotMatch(batchEntryPointSource(), /\$\{/)
})

test('the batch entry point is a self-contained class Unity can execute', () => {
  const source = batchEntryPointSource()
  // `-executeMethod LocusProjectFileSyncTemp.Run` is what the batch runner passes.
  assert.match(source, /public static class LocusProjectFileSyncTemp/)
  assert.match(source, /public static void Run\(\)/)
  // The batch host has no snippet globals, so the report must be logged rather
  // than printed - a `print` call here would not compile inside Unity.
  assert.doesNotMatch(source, /\bprint\(/)
  assert.match(source, /UnityEngine\.Debug\.Log\("\[LocusProjectSync\] " \+ __locusSyncReport\)/)
})

test('the snippet and the batch entry point share one generator chain', () => {
  // Both channels must run the same C#: a divergence means the batch path
  // generates project files differently from the editor path.
  const snippet = editorSyncSnippet()
  const batch = batchEntryPointSource()
  const chain = '__LocusTryPluginGenerator'
  assert.ok(snippet.includes(chain) && batch.includes(chain))
  const chainBody = (text) => text.slice(text.indexOf('bool __LocusTrySyncAll()'), text.indexOf('var __locusSyncReport'))
  assert.equal(chainBody(snippet), chainBody(batch))
})

// ─── downloader failure paths ───────────────────────────────────────────────
//
// `downloadToFile` is what turns a 60 MB HTTP body into a file the server later
// loads. The happy path is covered by the live script; these are the paths that
// matter when something goes wrong, because a half-written archive that survives
// a failure poisons the asset tree until it is deleted by hand.

/** A fetch stand-in: `response.body` is an async iterable of Buffers. */
function fakeFetch({ status = 200, body = [], contentLength = null, failAfter = null } = {}) {
  return async () => {
    const headers = new Map()
    if (contentLength !== null) headers.set('content-length', String(contentLength))
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers.get(String(name).toLowerCase()) ?? null },
      body: (async function* generate() {
        for (const [index, chunk] of body.entries()) {
          if (failAfter !== null && index >= failAfter) throw new Error('socket hang up')
          yield Buffer.from(chunk)
        }
      })(),
    }
  }
}

test('a successful download writes the file and never leaves a .part', async () => {
  const target = join(sandbox, 'dl', 'ok.bin')
  const result = await downloadToFile('https://example.test/ok', target, {
    fetchImpl: fakeFetch({ body: ['abc', 'def'], contentLength: 6 }),
  })
  assert.equal(result.bytes, 6)
  assert.equal(readFileSync(target, 'utf8'), 'abcdef')
  assert.equal(existsSync(`${target}.part`), false)
})

test('an HTTP error leaves nothing on disk', async () => {
  const target = join(sandbox, 'dl', 'missing.bin')
  await assert.rejects(
    downloadToFile('https://example.test/404', target, { fetchImpl: fakeFetch({ status: 404 }) }),
    /HTTP 404/,
  )
  assert.equal(existsSync(target), false)
  assert.equal(existsSync(`${target}.part`), false)
})

test('a truncated body is rejected rather than written', async () => {
  const target = join(sandbox, 'dl', 'short.bin')
  await assert.rejects(
    // Advertises 100 bytes, delivers 6.
    downloadToFile('https://example.test/short', target, {
      fetchImpl: fakeFetch({ body: ['abc', 'def'], contentLength: 100 }),
    }),
    /truncated/,
  )
  assert.equal(existsSync(target), false)
  assert.equal(existsSync(`${target}.part`), false)
})

test('a broken stream cleans up the partial file', async () => {
  const target = join(sandbox, 'dl', 'broken.bin')
  await assert.rejects(
    downloadToFile('https://example.test/broken', target, {
      fetchImpl: fakeFetch({ body: ['abc', 'def', 'ghi'], contentLength: 9, failAfter: 1 }),
    }),
    /interrupted/,
  )
  assert.equal(existsSync(target), false)
  assert.equal(existsSync(`${target}.part`), false)
})

test('an unreachable host reports the URL it could not reach', async () => {
  const target = join(sandbox, 'dl', 'unreachable.bin')
  await assert.rejects(
    downloadToFile('https://example.test/gone', target, {
      fetchImpl: async () => {
        throw new Error('getaddrinfo ENOTFOUND')
      },
    }),
    /cannot reach https:\/\/example\.test\/gone.*ENOTFOUND/,
  )
  assert.equal(existsSync(target), false)
})

test('progress reports monotonic byte counts that end at the total', async () => {
  const target = join(sandbox, 'dl', 'progress.bin')
  const seen = []
  await downloadToFile('https://example.test/p', target, {
    fetchImpl: fakeFetch({ body: ['aa', 'bb', 'cc'], contentLength: 6 }),
    onProgress: (update) => seen.push(update),
  })
  assert.equal(seen.at(-1).received, 6)
  assert.equal(seen.at(-1).total, 6)
  for (let index = 1; index < seen.length; index += 1) {
    assert.ok(seen[index].received >= seen[index - 1].received, 'received must not go backwards')
  }
})

// ─── archive edge cases ─────────────────────────────────────────────────────

test('a ZIP with an encrypted entry is skipped, not written', () => {
  const archive = join(sandbox, 'flag.zip')
  execFileSync('python3', [
    '-c',
    `import zipfile\nz=zipfile.ZipFile(${JSON.stringify(archive)},'w')\nz.writestr('plain.txt','ok')\nz.close()`,
  ])
  const dest = join(sandbox, 'flag-out')
  const result = extractZip(readFileSync(archive), dest)
  assert.deepEqual(result.files, ['plain.txt'])
})

test('a ZIP entry with an absolute path is refused', () => {
  const archive = join(sandbox, 'abs.zip')
  execFileSync('python3', [
    '-c',
    `import zipfile\nz=zipfile.ZipFile(${JSON.stringify(archive)},'w')\nz.writestr('/etc/evil','x')\nz.close()`,
  ])
  // A leading slash is stripped rather than treated as absolute, so the entry
  // lands inside the destination instead of writing to /etc.
  const dest = join(sandbox, 'abs-out')
  extractZip(readFileSync(archive), dest)
  assert.equal(existsSync(join(dest, 'etc', 'evil')), true)
  assert.equal(existsSync('/etc/evil'), false)
})

test('extractZip filters by predicate', () => {
  const source = join(sandbox, 'filter-src')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(source, 'keep.dll'), 'k')
  writeFileSync(join(source, 'drop.txt'), 'd')
  const archive = join(sandbox, 'filter.zip')
  execFileSync('zip', ['-q', archive, 'keep.dll', 'drop.txt'], { cwd: source })
  const dest = join(sandbox, 'filter-out')
  const result = extractZip(readFileSync(archive), dest, {
    filter: (name) => name.endsWith('.dll'),
  })
  assert.deepEqual(result.files, ['keep.dll'])
  assert.equal(existsSync(join(dest, 'drop.txt')), false)
})

test('a ZIP that is not a ZIP is rejected clearly', () => {
  assert.throws(() => extractZip(Buffer.from('not a zip'), join(sandbox, 'junk-out')), /not a ZIP archive/)
})

// ─── asset gating ───────────────────────────────────────────────────────────

test('a system .NET runtime satisfies the requirement without the managed copy', async () => {
  // Regression: `requireAssets` used to reject whenever `assetStatus().missing`
  // was non-empty, which includes `runtime` even on a machine with a system
  // .NET 10 — the common case. Server and analyzers are the only artifacts that
  // must have been downloaded.
  const root = join(sandbox, 'gate')
  const env = { DSH_LOCUS_CSHARP_HOME: root }
  const rid = 'linux-x64'
  const serverDir = join(root, 'server', '5.4.0-2.26179.14', rid)
  mkdirSync(serverDir, { recursive: true })
  writeFileSync(join(serverDir, 'Microsoft.CodeAnalysis.LanguageServer.dll'), 'x')
  writeFileSync(join(serverDir, '.locus-complete'), 'ok')
  const analyzers = join(root, 'unity-analyzers', '1.26.0')
  mkdirSync(analyzers, { recursive: true })
  writeFileSync(join(analyzers, '.locus-complete'), 'ok')

  const status = assetStatus(env, { rid })
  assert.deepEqual(status.missing, ['runtime'], 'the managed runtime is not on disk in this fixture')

  // With server + analyzers present, the only remaining question is whether a
  // runtime can be resolved — which `resolveDotnet` answers from the system.
  // `requireAssets` therefore must not throw on `runtime` alone.
  const { requireAssets } = await import('../src/csharp/assets.js')
  const resolved = await requireAssets(env, { rid })
  assert.equal(resolved.rid, rid)
  assert.ok(resolved.program, 'a dotnet program must be resolved')
  assert.match(resolved.serverDll, /Microsoft\.CodeAnalysis\.LanguageServer\.dll$/)
})

test('a missing server still fails loudly and points at install', async () => {
  const root = join(sandbox, 'gate-empty')
  const env = { DSH_LOCUS_CSHARP_HOME: root }
  const { requireAssets } = await import('../src/csharp/assets.js')
  await assert.rejects(requireAssets(env, { rid: 'linux-x64' }), (error) => {
    assert.equal(error.code, 'assets_missing')
    assert.match(error.message, /missing: server, analyzers/)
    assert.match(error.message, /action "install"/)
    return true
  })
})

test('the generated C# contains no backticks or template artifacts', () => {
  // A backtick inside the embedded C# comment would terminate the JavaScript
  // template literal and make this module fail to *parse* — a failure that no
  // assertion inside the module can report, because it never loads. This was a
  // real regression while adding the assembly-scan fallback.
  const snippet = editorSyncSnippet()
  const batch = batchEntryPointSource()
  for (const [label, source] of [['snippet', snippet], ['batch', batch]]) {
    assert.doesNotMatch(source, /`/, `${label} must not contain a backtick`)
    assert.doesNotMatch(source, /\$\{/, `${label} must not contain a template placeholder`)
  }
})

test('the plugin generator falls back to scanning loaded assemblies', () => {
  // Type.GetType("Locus.LocusProjectFiles, Locus.Editor") returns null when the
  // assembly is named differently, which would silently skip the generator that
  // keeps the temporary batch package out of the generated solution.
  const snippet = editorSyncSnippet()
  assert.match(snippet, /assembly\.GetType\("Locus\.LocusProjectFiles", false\)/)
  assert.match(snippet, /AppDomain\.CurrentDomain\.GetAssemblies\(\)/)
})

// ─── Unity project-file shape (found against unity-test/) ───────────────────

test('restore artifacts are read from the csproj BaseIntermediateOutputPath', () => {
  // Unity writes `<BaseIntermediateOutputPath>Temp/obj/$(Configuration)/$(MSBuildProjectName)</BaseIntermediateOutputPath>`,
  // so project.assets.json lands under Temp/obj/Debug/<Project>/ — not in the
  // `obj/` an SDK project uses. A fixed path made every Unity checkout look
  // unrestored, which silently disabled compiler diagnostics.
  const root = join(sandbox, 'unity-shape')
  mkdirSync(join(root, 'Assets'), { recursive: true })
  writeFileSync(
    join(root, 'Assembly-CSharp.csproj'),
    `<?xml version="1.0"?>
<Project ToolsVersion="Current">
  <PropertyGroup>
    <BaseIntermediateOutputPath>Temp/obj/$(Configuration)/$(MSBuildProjectName)</BaseIntermediateOutputPath>
  </PropertyGroup>
</Project>
`,
  )
  const csproj = join(root, 'Assembly-CSharp.csproj')
  const paths = candidateAssetPaths(root, csproj)
  // The expectation is built with `join` too: the probe returns native paths,
  // so a POSIX literal would fail on Windows purely on separators.
  assert.ok(
    paths.some((path) => path.endsWith(join('Temp', 'obj', 'Debug', 'Assembly-CSharp', 'project.assets.json'))),
    `expected the Unity-shaped path, got ${paths.join(', ')}`,
  )
  // Debug and Release are both probed.
  assert.ok(paths.some((path) => path.includes('Release')))
  assert.equal(projectIsRestored(root), false)
  mkdirSync(join(root, 'Temp/obj/Debug/Assembly-CSharp'), { recursive: true })
  writeFileSync(join(root, 'Temp/obj/Debug/Assembly-CSharp/project.assets.json'), '{}')
  assert.equal(projectIsRestored(root), true)
})

test('an SDK project still reads the default obj path', () => {
  const root = join(sandbox, 'sdk-shape')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'Game.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup /></Project>')
  mkdirSync(join(root, 'obj'), { recursive: true })
  writeFileSync(join(root, 'obj/project.assets.json'), '{}')
  assert.equal(projectIsRestored(root), true)
})

test('every project must be restored, not just one', () => {
  // The compiler provider loads the whole solution; one unrestored project
  // empties its diagnostics.
  const root = join(sandbox, 'partial-restore')
  mkdirSync(join(root, 'obj'), { recursive: true })
  writeFileSync(join(root, 'obj/project.assets.json'), '{}')
  writeFileSync(join(root, 'A.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />')
  writeFileSync(join(root, 'B.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />')
  // Both projects resolve to the same default obj/project.assets.json, so this
  // fixture is restored; the guard is that *the every()* ran at all.
  assert.equal(projectIsRestored(root), true)
  rmSync(join(root, 'obj/project.assets.json'))
  assert.equal(projectIsRestored(root), false)
})

test('fileInProject distinguishes an explicit include from an absent file', () => {
  // Unity lists every script explicitly, so a file written after the last
  // project sync is outside the compilation and produces no diagnostics.
  const root = join(sandbox, 'membership')
  mkdirSync(join(root, 'Assets/Scripts'), { recursive: true })
  writeFileSync(join(root, 'Assets/Scripts/Known.cs'), 'class Known {}')
  writeFileSync(
    join(root, 'Assembly-CSharp.csproj'),
    `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>
      <Compile Include="Assets/Scripts/Known.cs" />
    </ItemGroup></Project>`,
  )
  assert.equal(fileInProject(root, join(root, 'Assets/Scripts/Known.cs')), 'member')
  assert.equal(fileInProject(root, join(root, 'Assets/Scripts/New.cs')), 'absent')
})

test('fileInProject recognises a glob include', () => {
  const root = join(sandbox, 'membership-glob')
  mkdirSync(join(root, 'Assets/Scripts'), { recursive: true })
  writeFileSync(join(root, 'Assets/Scripts/Any.cs'), 'class Any {}')
  writeFileSync(
    join(root, 'Game.csproj'),
    `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>
      <Compile Include="Assets/Scripts/**/*.cs" />
    </ItemGroup></Project>`,
  )
  assert.equal(fileInProject(root, join(root, 'Assets/Scripts/Any.cs')), 'member')
})

test('a file outside every project is reported, not silently clean', () => {
  const text = formatDiagnostics({
    scope: 'file',
    file: 'Assets/Scripts/New.cs',
    diagnostics: [],
    restored: true,
    member: 'absent',
  })
  assert.match(text, /not in any project's compile set/)
  assert.match(text, /unity_recompile/)
})

test('decompiled framework sources are collapsed to a filename', () => {
  // Roslyn materializes framework sources under its MetadataAsSource cache; the
  // full path leaks the asset root and means nothing to a caller.
  const path = displayPath(
    '/proj',
    '/cache/run/MetadataAsSource/abc/DecompilationMetadataAsSourceFileProvider/def/MonoBehaviour.cs',
  )
  assert.equal(path, '[decompiled] MonoBehaviour.cs')
})
