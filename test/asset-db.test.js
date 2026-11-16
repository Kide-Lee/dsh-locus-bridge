// Tests for the on-disk asset index (src/asset-db.js).

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'

import {
  ASSET_DB_MAX_FILES,
  __resetAssetDbForTest,
  findScriptAttachments,
  formatAssetSearch,
  normalizeGuid,
  scanAssets,
  searchAssets,
} from '../src/asset-db.js'

/** A Unity-shaped project with a handful of assets and one of each defect. */
function buildProject(t) {
  const root = mkdtempSync(join(tmpdir(), 'locus-asset-db-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'ProjectSettings'), { recursive: true })
  writeFileSync(join(root, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.5.0f1\n')

  const write = (path, text) => {
    const absolute = join(root, path)
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, text)
  }
  // Unity writes a `.meta` next to every asset; the GUID lives in it.
  const withMeta = (path, guid) => write(`${path}.meta`, `fileFormatVersion: 2\nguid: ${guid}\n`)

  write('Assets/Scripts/Player.cs', 'public class Player : MonoBehaviour { public float speed = 3f; }\n')
  withMeta('Assets/Scripts/Player.cs', '1111111111111111111111111111aaaa')

  write('Assets/Scripts/Enemy.cs', 'public class Enemy : MonoBehaviour { }\n')
  withMeta('Assets/Scripts/Enemy.cs', '1111111111111111111111111111bbbb')

  write('Assets/Materials/Red.mat', '%YAML 1.1\n--- !u!21 &2100000\nMaterial:\n  m_Name: Red\n')
  withMeta('Assets/Materials/Red.mat', '2222222222222222222222222222cccc')

  write('Assets/Textures/Noise.png', 'not really a png')
  withMeta('Assets/Textures/Noise.png', '3333333333333333333333333333dddd')

  // A prefab carrying a MonoBehaviour for Player plus a UnityEvent call on the
  // player's `speed` field.
  write(
    'Assets/Prefabs/Player.prefab',
    [
      '%YAML 1.1',
      '%TAG !u! tag:unity3d.com,2011:',
      '--- !u!1 &100',
      'GameObject:',
      '  m_ObjectHideFlags: 0',
      '  m_Name: Player',
      '--- !u!114 &400',
      'MonoBehaviour:',
      '  m_ObjectHideFlags: 0',
      '  m_GameObject: {fileID: 100}',
      '  m_Script: {fileID: 11500000, guid: 1111111111111111111111111111aaaa, type: 3}',
      '  speed: 3',
      '  m_OnChange:',
      '    m_PersistentCalls:',
      '      m_Calls:',
      '      - m_Target: {fileID: 100}',
      '        m_MethodName: SetSpeed',
      '        m_Mode: 1',
      '',
    ].join('\n'),
  )
  withMeta('Assets/Prefabs/Player.prefab', '4444444444444444444444444444eeee')

  // A scene with a second object using the same script.
  write(
    'Assets/Scenes/Main.unity',
    [
      '%YAML 1.1',
      '--- !u!1 &200',
      'GameObject:',
      '  m_Name: PlayerTwo',
      '--- !u!114 &300',
      'MonoBehaviour:',
      '  m_Script: {fileID: 11500000, guid: 1111111111111111111111111111aaaa, type: 3}',
      '',
    ].join('\n'),
  )
  withMeta('Assets/Scenes/Main.unity', '5555555555555555555555555555ffff')

  // Defects the index reports rather than hides.
  write('Assets/Orphan.cs', 'public class Orphan { }\n') // no .meta at all
  write('Assets/Dup.cs', 'public class Dup { }\n')
  withMeta('Assets/Dup.cs', '6666666666666666666666666666gggg'.replaceAll('g', '0')) // duplicate GUID
  write('Assets/Other.cs', 'public class Other { }\n')
  withMeta('Assets/Other.cs', '6666666666666666666666666666gggg'.replaceAll('g', '0'))

  // Noise the index must not enter or report.
  write('Assets/Scripts/Sub/Build/Generated.cs', '// generated\n')
  write('Assets/Scripts/Sub/Foo~backup.cs', '// ignored\n')
  write('Assets/Scripts/Sub/.hidden.cs', '// ignored\n')
  write('Library/PackageCache/Tracked.cs', '// in Library, not an asset\n')
  write('Assets/Hidden.meta', 'fileFormatVersion: 2\nguid: 7777777777777777777777777777abcz\n')

  return root
}

describe('scanAssets', () => {
  let root
  before(() => {
    __resetAssetDbForTest()
  })
  after(() => __resetAssetDbForTest())

  test('indexes every asset with its guid, type and project-relative path', (t) => {
    root = buildProject(t)
    return scanAssets(root).then((index) => {
      const paths = index.assets.map((asset) => asset.path)
      assert.ok(paths.includes('Assets/Scripts/Player.cs'), `missing Player.cs in ${paths.join(', ')}`)
      assert.ok(paths.includes('Assets/Prefabs/Player.prefab'))
      assert.ok(paths.includes('Assets/Scenes/Main.unity'))
      assert.ok(!paths.some((path) => path.endsWith('.meta')), '.meta files are not assets')
      // Forward slashes only, even on Windows.
      assert.ok(paths.every((path) => !path.includes('\\')))

      const player = index.assets.find((asset) => asset.path === 'Assets/Scripts/Player.cs')
      assert.deepEqual(player, { guid: '1111111111111111111111111111aaaa', path: 'Assets/Scripts/Player.cs', ext: '.cs', type: 'script' })
      assert.equal(index.assets.find((asset) => asset.path === 'Assets/Prefabs/Player.prefab').type, 'prefab')
      assert.equal(index.assets.find((asset) => asset.path === 'Assets/Scenes/Main.unity').type, 'scene')
      assert.equal(index.assets.find((asset) => asset.path === 'Assets/Materials/Red.mat').type, 'material')
      assert.equal(index.assets.find((asset) => asset.path === 'Assets/Textures/Noise.png').type, 'texture')
      assert.equal(index.partial, false)
      assert.ok(index.scannedFiles >= 6)
      assert.ok(Number.isFinite(index.elapsedMs))
    })
  })

  test('skips Unity-generated directories and the dotfile/~ rules Unity applies', (t) => {
    const project = buildProject(t)
    return scanAssets(project, { rescan: true }).then((index) => {
      const paths = index.assets.map((asset) => asset.path)
      assert.ok(!paths.some((path) => path.startsWith('Library/')))
      assert.ok(!paths.some((path) => path.includes('/Build/')))
      assert.ok(!paths.some((path) => path.includes('Foo~')))
      assert.ok(!paths.some((path) => path.includes('.hidden.cs')))
    })
  })

  test('reports a missing .meta and duplicate GUIDs instead of hiding them', (t) => {
    const project = buildProject(t)
    return scanAssets(project, { rescan: true }).then((index) => {
      assert.deepEqual(index.broken.missingMeta, ['Assets/Orphan.cs'])
      const orphan = index.assets.find((asset) => asset.path === 'Assets/Orphan.cs')
      assert.equal(orphan.guid, null, 'an asset without a .meta has no guid')
      assert.equal(index.broken.duplicateGuids.length, 1)
      const [duplicate] = index.broken.duplicateGuids
      assert.equal(duplicate.guid, '66666666666666666666666666660000')
      assert.deepEqual(duplicate.paths.sort(), ['Assets/Dup.cs', 'Assets/Other.cs'])
      // A malformed guid in a .meta is "missing", not a bogus index entry.
      assert.ok(!index.assets.some((asset) => asset.guid === '7777777777777777777777777777abcz'))
    })
  })

  test('indexes MonoBehaviour script bindings so member questions are answerable offline', (t) => {
    const project = buildProject(t)
    return scanAssets(project, { rescan: true }).then((index) => {
      const playerGuid = '1111111111111111111111111111aaaa'
      const attachments = index.memberBindings.filter((binding) => binding.scriptGuid === playerGuid && binding.kind === 'script')
      const assetPaths = attachments.map((binding) => binding.assetPath).sort()
      assert.deepEqual(assetPaths, ['Assets/Prefabs/Player.prefab', 'Assets/Scenes/Main.unity'])
      // fileId is the document's own &id; className is the owning object's
      // m_Name when the document points at one, else the document's type name.
      const inPrefab = attachments.find((binding) => binding.assetPath === 'Assets/Prefabs/Player.prefab')
      assert.equal(inPrefab.fileId, 400)
      assert.equal(inPrefab.className, 'Player')
      const inScene = attachments.find((binding) => binding.assetPath === 'Assets/Scenes/Main.unity')
      assert.equal(inScene.className, 'MonoBehaviour', "no m_GameObject resolution for this doc, so the type name stands in")
      const method = index.memberBindings.find((binding) => binding.kind === 'method')
      assert.equal(method.className, 'SetSpeed')
    })
  })

  test('caches the index and rebuilds it with rescan', async (t) => {
    const project = buildProject(t)
    const first = await scanAssets(project, { rescan: true })
    const second = await scanAssets(project)
    assert.equal(second, first, 'a cached scan is returned by reference')

    writeFileSync(join(project, 'Assets', 'Late.cs'), 'public class Late { }\n')
    writeFileSync(join(project, 'Assets', 'Late.cs.meta'), 'fileFormatVersion: 2\nguid: 8888888888888888888888888888abcd\n')
    const refreshed = await scanAssets(project, { rescan: true })
    assert.ok(refreshed.assets.some((asset) => asset.path === 'Assets/Late.cs'))
  })

  test('marks the index partial when the budget is exhausted', async (t) => {
    const project = buildProject(t)
    await scanAssets(project, { rescan: true })
    // A budget already spent: the walker should stop at its first deadline check
    // rather than claim a complete index.
    // Asset work happens after the walk, so a budget spent before the walk even
    // begins is exhausted by the same clock.
    const budgeted = await scanAssets(project, { rescan: true, budgetMs: -1 })
    assert.equal(budgeted.partial, true)
    const complete = await scanAssets(project, { rescan: true })
    assert.equal(complete.partial, false)
    assert.ok(budgeted.scannedFiles < complete.scannedFiles, `${budgeted.scannedFiles} vs ${complete.scannedFiles}`)
  })

  test('does not loop on a symlinked directory cycle', async (t) => {
    const project = buildProject(t)
    // `Assets/Scripts/loop -> Assets` would be an infinite descent without a guard.
    symlinkSync(join(project, 'Assets'), join(project, 'Assets', 'Scripts', 'loop'), 'dir')
    const index = await scanAssets(project, { rescan: true, budgetMs: 5_000 })
    const playerEntries = index.assets.filter((asset) => asset.path.endsWith('Scripts/Player.cs'))
    assert.equal(playerEntries.length, 1, `Player.cs indexed ${playerEntries.length} times`)
    assert.equal(index.partial, false)
  })

  test('the file ceiling is a real number', () => {
    assert.equal(ASSET_DB_MAX_FILES, 200_000)
  })
})

describe('searchAssets', () => {
  test('filters by type, name, under and guid', async (t) => {
    const project = buildProject(t)
    __resetAssetDbForTest()

    const byType = await searchAssets(project, { type: 'material' })
    assert.deepEqual(byType.assets.map((asset) => asset.path), ['Assets/Materials/Red.mat'])

    const byName = await searchAssets(project, { name: 'player' })
    assert.deepEqual(byName.assets.map((asset) => asset.path).sort(), ['Assets/Prefabs/Player.prefab', 'Assets/Scripts/Player.cs'])

    const under = await searchAssets(project, { under: 'Assets/Scripts' })
    assert.deepEqual(under.assets.map((asset) => asset.path).sort(), ['Assets/Scripts/Enemy.cs', 'Assets/Scripts/Player.cs'])
    assert.ok(under.assets.every((asset) => asset.path.startsWith('Assets/Scripts/')))

    const byGuid = await searchAssets(project, { guid: '1111111111111111111111111111AAAA' })
    assert.deepEqual(byGuid.assets.map((asset) => asset.path), ['Assets/Scripts/Player.cs'])

    const combined = await searchAssets(project, { under: 'Assets', type: 'script', name: 'enemy' })
    assert.deepEqual(combined.assets.map((asset) => asset.path), ['Assets/Scripts/Enemy.cs'])
  })

  test('reports totals, truncation and the broken counters', async (t) => {
    const project = buildProject(t)
    __resetAssetDbForTest()
    const result = await searchAssets(project, { limit: 2 })
    assert.equal(result.assets.length, 2)
    assert.equal(result.truncated, true)
    assert.ok(result.total > 2)
    assert.equal(result.broken.missingMeta, 1)
    assert.equal(result.broken.duplicateGuids, 1)
    assert.equal(result.partial, false)
  })

  test('an unknown guid is an empty result, not an error', async (t) => {
    const project = buildProject(t)
    __resetAssetDbForTest()
    const result = await searchAssets(project, { guid: '99999999999999999999999999999999' })
    assert.deepEqual(result.assets, [])
    assert.equal(result.total, 0)
  })

  test('renders a compact, readable answer', async (t) => {
    const project = buildProject(t)
    __resetAssetDbForTest()
    const text = formatAssetSearch(await searchAssets(project, { type: 'script' }))
    assert.match(text, /^Unity assets: \d+ entries? in \d+ file\(s\)/)
    assert.match(text, /^- Assets\/Scripts\/Player\.cs \[script\] 1111111111111111111111111111aaaa$/m)
    assert.match(text, /^- Assets\/Orphan\.cs \[script\] \(no \.meta\)$/m)
    assert.match(text, /broken: 1 missing \.meta, 1 duplicate GUID\(s\)/)
  })
})

describe('findScriptAttachments', () => {
  test('lists the assets carrying a script', async (t) => {
    const project = buildProject(t)
    __resetAssetDbForTest()
    const result = await findScriptAttachments(project, { scriptGuid: '1111111111111111111111111111aaaa' })
    assert.equal(result.path, 'Assets/Scripts/Player.cs')
    assert.deepEqual(result.attachments.map((row) => row.assetPath).sort(), ['Assets/Prefabs/Player.prefab', 'Assets/Scenes/Main.unity'])
    assert.match(result.text, /Assets\/Prefabs\/Player\.prefab/)
    assert.equal(result.truncated, false)
  })

  test('finds the call site of one member', async (t) => {
    const project = buildProject(t)
    __resetAssetDbForTest()
    const result = await findScriptAttachments(project, { scriptGuid: '1111111111111111111111111111aaaa', member: 'SetSpeed' })
    assert.equal(result.bindingCount, 1)
    assert.equal(result.bindings[0].assetPath, 'Assets/Prefabs/Player.prefab')
    assert.match(result.text, /SetSpeed: 1 attachment\(s\), 1 call site\(s\)\./)
  })

  test('an unknown guid says so instead of returning nothing', async (t) => {
    const project = buildProject(t)
    __resetAssetDbForTest()
    const result = await findScriptAttachments(project, { scriptGuid: '99999999999999999999999999999999' })
    assert.equal(result.total, 0)
    assert.match(result.text, /No asset in the project has GUID 9999/)
  })

  test('a malformed guid is rejected', async (t) => {
    const project = buildProject(t)
    __resetAssetDbForTest()
    await assert.rejects(() => findScriptAttachments(project, { scriptGuid: 'not-a-guid' }), /scriptGuid must be the 32-hex GUID/)
  })
})

describe('normalizeGuid', () => {
  test('accepts 32 hex characters in either case, with braces and dashes', () => {
    assert.equal(normalizeGuid('1111111111111111111111111111AAAA'), '1111111111111111111111111111aaaa')
    assert.equal(normalizeGuid('{11111111-1111-1111-1111-111111111111}'), '11111111111111111111111111111111'.replace(/1/g, '1').slice(0, 32), 'braced/dashed form normalises')
    assert.equal(normalizeGuid('xyz'), null)
    assert.equal(normalizeGuid(undefined), null)
    assert.equal(normalizeGuid(123), null)
  })
})