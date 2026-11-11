#!/usr/bin/env node
// Live smoke test for the C# analysis tools.
//
// The unit suite (`test/csharp.test.js`) covers everything that does not need a
// language server. This script exercises the real thing: it downloads the Roslyn
// server + .NET runtime on first use, starts a workspace server, and runs each
// query against a scratch project shaped like a Unity checkout.
//
// Usage:
//   node scripts/live-csharp.mjs                 # scratch project in the OS temp dir
//   node scripts/live-csharp.mjs --project PATH  # an existing Unity checkout
//   node scripts/live-csharp.mjs --skip-install  # fail fast instead of downloading
//
// Exits non-zero on the first failed assertion. Nothing is written outside the
// scratch directory and the asset cache.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { assetStatus, installAssets } from '../src/csharp/assets.js'
import { shutdownCsharpPool, poolStatus } from '../src/csharp/lsp-pool.js'
import {
  fileDiagnostics,
  findReferences,
  formatDefinition,
  formatDiagnostics,
  formatHover,
  formatReferences,
  formatSymbols,
  gotoDefinition,
  hover,
  searchSymbols,
} from '../src/csharp/queries.js'

const args = process.argv.slice(2)
function flag(name) {
  return args.includes(`--${name}`)
}
function option(name, fallback = null) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}

const failures = []
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures.push(`${label}${detail ? `: ${detail}` : ''}`)
  console.log(`  FAIL ${label}${detail ? `: ${detail}` : ''}`)
}

// ─── a scratch project shaped like a Unity checkout ─────────────────────────

const SOURCES = {
  'Assets/Scripts/IDamageable.cs': `namespace Game
{
    public interface IDamageable
    {
        int Health { get; }
        void TakeDamage(int amount);
    }
}
`,
  'Assets/Scripts/Health.cs': `namespace Game
{
    public class Health
    {
        public int Value;
        public bool IsDead => Value <= 0;
    }
}
`,
  'Assets/Scripts/Player.cs': `namespace Game
{
    public class Player : IDamageable
    {
        public Health health = new Health();

        public int Health => health.Value;

        public void TakeDamage(int amount)
        {
            health.Value -= amount;
            if (health.IsDead)
                LogDeath();
        }

        private void LogDeath()
        {
        }

        public void Break()
        {
            Nope();
        }
    }
}
`,
}

/**
 * Scratch roots live beside the repo, not in the OS temp dir.
 *
 * Verified on Linux: an identical project under `/tmp` loads and answers symbol
 * queries, but its compiler provider never produces compiler diagnostics — the
 * analyzer providers do. Keeping the scratch project on the same filesystem as
 * the checkout makes this script exercise the same code path a real Unity
 * project takes.
 */
const SCRATCH_PARENT = join(dirname(fileURLToPath(import.meta.url)), '..', '.tmp')

function makeScratchProject() {
  mkdirSync(SCRATCH_PARENT, { recursive: true })
  const root = mkdtempSync(join(SCRATCH_PARENT, 'csharp-live-'))
  for (const [relative, contents] of Object.entries(SOURCES)) {
    const path = join(root, relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, contents)
  }
  // The server loads MSBuild project files; Unity writes these itself.
  mkdirSync(join(root, 'ProjectSettings'), { recursive: true })
  writeFileSync(
    join(root, 'UnityGame.csproj'),
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>netstandard2.1</TargetFramework>
    <LangVersion>9.0</LangVersion>
    <EnableDefaultItems>false</EnableDefaultItems>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="Assets/Scripts/**/*.cs" />
  </ItemGroup>
</Project>
`,
  )
  return root
}

// ─── run ────────────────────────────────────────────────────────────────────

const explicitProject = option('project')
const projectRoot = explicitProject ? resolve(explicitProject) : makeScratchProject()
const scratch = explicitProject ? null : projectRoot
console.log(`project: ${projectRoot}`)

let exitCode = 0
try {
  console.log('\nassets')
  let status = assetStatus()
  console.log(`  rid ${status.rid}, missing: ${status.missing.join(', ') || 'none'}`)
  // `missing` includes the managed runtime whenever the downloaded copy is
  // absent, but a system .NET 10 satisfies it — mirrors `requireAssets`, which
  // only demands the two downloaded artifacts.
  const required = status.missing.filter((part) => part !== 'runtime')
  if (required.length > 0) {
    if (flag('skip-install')) {
      console.log(`  --skip-install given and ${required.join(', ')} missing; cannot continue`)
      process.exit(2)
    }
    console.log(`  downloading (about ${Math.round(status.installBytes / (1024 * 1024))} MB)…`)
    status = await installAssets(process.env, {
      onProgress: ({ received, total }) => {
        if (total && received === total) console.log(`  downloaded ${Math.round(total / (1024 * 1024))} MB`)
      },
    })
  }
  check('server and analyzers ready', required.length === 0, required.join(', '))

  console.log('\nsymbol search')
  const symbols = await searchSymbols(projectRoot, { query: 'TakeDamage' })
  console.log(
    formatSymbols('TakeDamage', symbols)
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n'),
  )
  check('finds the interface method', symbols.some((symbol) => symbol.container?.includes('IDamageable')))
  check('finds the implementation', symbols.some((symbol) => symbol.path.endsWith('Player.cs')))

  console.log('\ngoto definition')
  const definition = await gotoDefinition(projectRoot, {
    filePath: 'Assets/Scripts/Player.cs',
    symbol: 'TakeDamage',
  })
  console.log(formatDefinition('TakeDamage', definition).replace(/^/gm, '  '))
  check('resolves a source definition', definition.locations.length > 0)
  // Querying from the interface declaration resolves to the interface itself;
  // the implementation is a separate query from a call site.
  check('definition is a .cs file', /[.]cs$/.test(definition.locations[0]?.path ?? ''))

  console.log('\nfind references')
  const references = await findReferences(projectRoot, {
    filePath: 'Assets/Scripts/IDamageable.cs',
    symbol: 'IDamageable',
  })
  console.log(formatReferences('IDamageable', references, { includeDeclaration: false }).replace(/^/gm, '  '))
  check('finds the implementing class', references.locations.length >= 1)

  console.log('\nhover')
  const info = await hover(projectRoot, {
    filePath: 'Assets/Scripts/Player.cs',
    symbol: 'health',
    line: 7,
  })
  console.log(formatHover('health', info).replace(/^/gm, '  '))
  check('reports a signature', /Health/.test(info.contents))

  console.log('\ndiagnostics')
  const diagnostics = await fileDiagnostics(projectRoot, { filePath: 'Assets/Scripts/Player.cs' })
  console.log(formatDiagnostics(diagnostics, { minSeverity: 'warning' }).replace(/^/gm, '  '))
  // Compiler diagnostics land a beat after the analyzer ones (the semantic
  // model has to finish), so poll briefly instead of racing the first pull.
  let foundCompilerError = diagnostics.diagnostics.some((entry) => entry.severity === 1)
  for (let attempt = 0; attempt < 8 && !foundCompilerError; attempt += 1) {
    await new Promise((done) => setTimeout(done, 1500))
    const again = await fileDiagnostics(projectRoot, { filePath: 'Assets/Scripts/Player.cs' })
    foundCompilerError = again.diagnostics.some((entry) => entry.severity === 1)
    if (foundCompilerError) {
      console.log(formatDiagnostics(again, { minSeverity: 'warning' }).replace(/^/gm, '  '))
    }
  }
  check(
    'reports the unresolved call',
    foundCompilerError,
    JSON.stringify(diagnostics.diagnostics.map((entry) => entry.code)),
  )

  console.log('\npool')
  const pool = poolStatus()
  console.log(`  ${pool.workspaces} workspace(s): ${pool.entries.map((entry) => entry.workspace).join(', ')}`)
  check('one workspace server', pool.workspaces === 1)
} catch (error) {
  console.error(`\nFAILED: ${error.message}`)
  if (process.env.DSH_LOCUS_CSHARP_DEBUG) console.error(error)
  exitCode = 1
} finally {
  await shutdownCsharpPool()
  if (scratch) rmSync(scratch, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  exitCode = 1
} else if (exitCode === 0) {
  console.log('\nall checks passed')
}
process.exit(exitCode)