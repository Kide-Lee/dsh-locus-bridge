import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  checkManagedReferenceTypes,
  formatManagedTypeSection,
  managedClassKey,
  managedClassSegments,
  managedTypeSection,
  movedFromOf,
  scanDeclarations,
  stripComments,
} from '../src/csharp/managed-types.js'

function makeProject(files) {
  const root = mkdtempSync(join(tmpdir(), 'locus-managed-'))
  for (const [path, text] of Object.entries(files)) {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, text)
  }
  return root
}

const IDENTITY = (overrides = {}) => ({
  className: 'MeleeAttack',
  namespace: 'Game.Combat',
  assembly: 'Game.Runtime',
  instanceCount: 3,
  assetCount: 2,
  ...overrides,
})

test('stripComments keeps strings, drops comments, preserves line count', () => {
  const source = ['class A {', '  // note', '  string u = "https://x";', '  /* block', '     still */', '  string q = \'"\' ;', '}'].join('\n')
  const stripped = stripComments(source)
  assert.equal(stripped.split('\n').length, source.split('\n').length)
  assert.match(stripped, /https:\/\/x/)
  assert.doesNotMatch(stripped, /note/)
  assert.doesNotMatch(stripped, /block/)
  assert.match(stripped, /'"/)
})

test('scanDeclarations finds block and file-scoped namespaces with nested types', () => {
  const block = scanDeclarations('namespace Game.Combat {\n  public class MeleeAttack : Attack {\n  }\n}\n')
  assert.equal(block.length, 1)
  assert.equal(block[0].name, 'MeleeAttack')
  assert.deepEqual(block[0].path, ['MeleeAttack'])
  assert.equal(block[0].namespace, 'Game.Combat')
  assert.deepEqual(block[0].bases, ['Attack'])

  const fileScoped = scanDeclarations('namespace Game.Combat;\npublic sealed class Bow : Attack {\n}\npublic class Outer {\n  public class Inner {\n  }\n}\n')
  const names = fileScoped.map((declaration) => `${declaration.namespace}:${declaration.path.join('/')}`)
  assert.deepEqual(names, ['Game.Combat:Bow', 'Game.Combat:Outer', 'Game.Combat:Outer/Inner'])
})

test('scanDeclarations keeps [MovedFrom] with the declaration it decorates', () => {
  const [declaration] = scanDeclarations(
    'namespace New.Space {\n  [MovedFrom(true, "Old.Space", "Old.Asm", null)]\n  public class Sword : Weapon {\n  }\n}\n',
  )
  assert.equal(declaration.attributes.length, 1)
  const moved = movedFromOf(declaration)
  assert.deepEqual(moved, { autoUpdate: true, namespace: 'Old.Space', assembly: 'Old.Asm', className: null })
})

test('movedFromOf understands the named-argument form and the legacy single string', () => {
  assert.deepEqual(movedFromOf({ attributes: [{ text: 'MovedFrom(sourceAssembly: "Old.Asm")' }] }), {
    autoUpdate: null,
    namespace: null,
    assembly: 'Old.Asm',
    className: null,
  })
  assert.deepEqual(movedFromOf({ attributes: [{ text: 'UnityEngine.MovedFrom("Old.Asm")' }] }), {
    autoUpdate: null,
    namespace: null,
    assembly: 'Old.Asm',
    className: null,
  })
  assert.equal(movedFromOf({ attributes: [{ text: 'Serializable' }] }), null)
})

test('managed class keys and segments follow Unity naming', () => {
  assert.deepEqual(managedClassSegments('Game.Foo/Inner'), ['Game.Foo', 'Inner'])
  assert.deepEqual(managedClassSegments('Outer+Inner'), ['Outer', 'Inner'])
  assert.deepEqual(managedClassSegments('Box`1'), ['Box'])
  assert.equal(managedClassKey('Ns.Outer/Inner'), 'inner')
  assert.equal(managedClassKey('MeleeAttack'), 'meleeattack')
})

test('a resolving identity produces the all-clear line', () => {
  const root = makeProject({
    'Assets/Game/Scripts/MeleeAttack.cs': 'namespace Game.Combat {\n  public class MeleeAttack {\n  }\n}\n',
    'Assets/Game/Game.Runtime.asmdef': JSON.stringify({ name: 'Game.Runtime' }),
  })
  try {
    const report = checkManagedReferenceTypes([IDENTITY()], root)
    assert.equal(report.issues.length, 0)
    assert.equal(report.checkedTypes, 1)
    assert.equal(report.checkedInstances, 3)
    assert.equal(
      formatManagedTypeSection(report),
      '\n\nSerializeReference types: all 1 serialized project type resolves (3 instances).',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a renamed type without [MovedFrom] is reported as missing', () => {
  const root = makeProject({
    'Assets/Game/Scripts/MaulAttack.cs': 'namespace Game.Combat {\n  public class MaulAttack {\n  }\n}\n',
    'Assets/Game/Game.Runtime.asmdef': JSON.stringify({ name: 'Game.Runtime' }),
  })
  try {
    const report = checkManagedReferenceTypes([IDENTITY()], root)
    assert.equal(report.issues.length, 1)
    assert.equal(report.issues[0].movedTo, null)
    const text = formatManagedTypeSection(report)
    assert.match(text, /1 unresolved of 1 checked/)
    assert.match(text, /Game\.Combat\.MeleeAttack \[asm Game\.Runtime\]: no such type in code/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('[MovedFrom] keeps a renamed type resolvable', () => {
  const root = makeProject({
    'Assets/Game/Scripts/MaulAttack.cs':
      'namespace Game.Combat {\n  [MovedFrom(false, null, null, "MeleeAttack")]\n  public class MaulAttack {\n  }\n}\n',
    'Assets/Game/Game.Runtime.asmdef': JSON.stringify({ name: 'Game.Runtime' }),
  })
  try {
    const report = checkManagedReferenceTypes([IDENTITY()], root)
    assert.equal(report.issues.length, 0)
    assert.equal(report.checkedTypes, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a type that moved to another assembly is reported with both assemblies', () => {
  const root = makeProject({
    'Assets/Core/Scripts/MeleeAttack.cs': 'namespace Game.Combat {\n  public class MeleeAttack {\n  }\n}\n',
    'Assets/Core/Game.Core.asmdef': JSON.stringify({ name: 'Game.Core' }),
    'Assets/Game/Game.Runtime.asmdef': JSON.stringify({ name: 'Game.Runtime' }),
  })
  try {
    const report = checkManagedReferenceTypes([IDENTITY()], root)
    assert.equal(report.issues.length, 1)
    assert.deepEqual(report.issues[0].movedTo, { displayName: 'Game.Combat.MeleeAttack', assembly: 'Game.Core' })
    assert.match(
      formatManagedTypeSection(report),
      /now compiles into 'Game\.Core', not 'Game\.Runtime' — add \[MovedFrom\(sourceAssembly: "Game\.Runtime"\)\]/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('identities in assemblies the project cannot see are skipped, not failed', () => {
  const root = makeProject({
    'Assets/Game/Scripts/MeleeAttack.cs': 'namespace Game.Combat {\n  public class MeleeAttack {\n  }\n}\n',
    'Assets/Game/Game.Runtime.asmdef': JSON.stringify({ name: 'Game.Runtime' }),
  })
  try {
    const report = checkManagedReferenceTypes([IDENTITY({ assembly: 'Unity.RenderPipelines.Core.Runtime' })], root)
    assert.equal(report.skippedExternalTypes, 1)
    assert.equal(report.issues.length, 0)
    assert.equal(report.checkedTypes, 0)
    assert.match(formatManagedTypeSection(report), /from assemblies outside the project were not checked/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('file scope ignores identities owned by other assemblies', () => {
  const root = makeProject({
    'Assets/Game/Scripts/MeleeAttack.cs': 'namespace Game.Combat {\n  public class MeleeAttack {\n  }\n}\n',
    'Assets/Other/Game.Other.asmdef': JSON.stringify({ name: 'Game.Other' }),
    'Assets/Other/Unrelated.cs': 'namespace Game.Other {\n  public class Unrelated {\n  }\n}\n',
  })
  try {
    const scoped = checkManagedReferenceTypes([IDENTITY({ className: 'Unrelated', namespace: 'Game.Other' })], root, {
      scopeFile: join(root, 'Assets/Game/Scripts/MeleeAttack.cs'),
    })
    assert.equal(scoped.checkedTypes, 0)
    const whole = checkManagedReferenceTypes([IDENTITY({ className: 'Unrelated', namespace: 'Game.Other' })], root)
    assert.equal(whole.issues.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a file with no identity of its own still passes the global check', () => {
  const root = makeProject({
    'Assets/Game/Scripts/MeleeAttack.cs': 'namespace Game.Combat {\n  public class MeleeAttack {\n  }\n}\n',
  })
  try {
    // No .asmdef: the predefined `Assembly-CSharp` is the file's assembly.
    const report = checkManagedReferenceTypes([IDENTITY({ assembly: 'Assembly-CSharp' })], root, {
      scopeFile: join(root, 'Assets/Game/Scripts/MeleeAttack.cs'),
    })
    assert.equal(report.issues.length, 0)
    assert.equal(report.checkedTypes, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the section is silent without an index, and quotes index failures', () => {
  assert.equal(managedTypeSection('/projects/x', {}), '')
  assert.equal(managedTypeSection('/projects/x', { lookup: () => ({ available: false, types: [] }) }), '')
  assert.match(
    managedTypeSection('/projects/x', {
      lookup: () => {
        throw new Error('database is locked')
      },
    }),
    /\(SerializeReference type check skipped: database is locked\)/,
  )
})

test('the section renders samples from the index for failing identities', () => {
  const root = makeProject({
    'Assets/Scripts/Other.cs': 'namespace Game.Combat {\n  public class Other {\n  }\n}\n',
    'Assets/Game/Game.Runtime.asmdef': JSON.stringify({ name: 'Game.Runtime' }),
  })
  try {
    const lookup = (_projectRoot, { classKeys }) => ({
      available: true,
      types: [IDENTITY()],
      entries:
        classKeys === undefined || classKeys === null
          ? []
          : [{ path: 'Assets/Arena.prefab', hostFileId: 200, rid: 1, className: 'MeleeAttack', namespace: 'Game.Combat', assembly: 'Game.Runtime', line: 15 }],
      guidToPath: new Map(),
    })
    const text = managedTypeSection(root, { lookup })
    assert.match(text, /Game\.Combat\.MeleeAttack/)
    assert.match(text, /Assets\/Arena\.prefab:15/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
