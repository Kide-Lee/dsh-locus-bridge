// Tests for the project-index fallback of the asset graph (src/asset-graph.js).
//
// `unity_asset_graph` used to refuse any question that did not name an open
// scene. These tests pin the new behaviour: with no `file_path`, the answer comes
// from the YAML on disk, needs no broker, and says which source it used.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { __resetAssetDbForTest } from '../src/asset-db.js'
import { findCodeUsages, findReferences } from '../src/asset-graph.js'

/** `findReferences`/`findCodeUsages` only touch the client in the open-scene path. */
const NO_EDITOR = {
  toString() {
    return 'no-editor'
  },
}

const PLAYER_GUID = 'fedcba9876543210fedcba9876543210'
const MATERIAL_GUID = '0123456789abcdef0123456789abcdef'

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'locus-asset-graph-'))
  mkdirSync(join(root, 'Assets', 'Scripts'), { recursive: true })
  mkdirSync(join(root, 'Assets', 'Materials'), { recursive: true })
  mkdirSync(join(root, 'Assets', 'Prefabs'), { recursive: true })
  mkdirSync(join(root, 'Assets', 'Scenes'), { recursive: true })
  mkdirSync(join(root, 'ProjectSettings'), { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const write = (path, text) => {
    const absolute = join(root, path)
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, text)
  }
  const asset = (path, guid, text) => {
    write(path, text)
    write(`${path}.meta`, `fileFormatVersion: 2\nguid: ${guid}\n`)
  }

  asset('Assets/Scripts/Player.cs', PLAYER_GUID, 'public class Player : MonoBehaviour { public float speed = 1f; }\n')
  asset('Assets/Materials/Red.mat', MATERIAL_GUID, '%YAML 1.1\n--- !u!21 &2100000\nMaterial:\n  m_Name: Red\n')
  // A prefab that references the material and carries the Player script.
  asset(
    'Assets/Prefabs/Player.prefab',
    '44444444444444444444444444444444',
    [
      '%YAML 1.1',
      '--- !u!1 &100',
      'GameObject:',
      '  m_Name: Player',
      '--- !u!114 &400',
      'MonoBehaviour:',
      '  m_GameObject: {fileID: 100}',
      `  m_Script: {fileID: 11500000, guid: ${PLAYER_GUID}, type: 3}`,
      '  speed: 2.5',
      '--- !u!23 &500',
      'MeshRenderer:',
      '  m_Materials:',
      `  - {fileID: 2100000, guid: ${MATERIAL_GUID}, type: 2}`,
      '',
    ].join('\n'),
  )
  // A scene that also references the material.
  asset(
    'Assets/Scenes/Main.unity',
    '55555555555555555555555555555555',
    [
      '%YAML 1.1',
      '--- !u!23 &600',
      'MeshRenderer:',
      '  m_Materials:',
      `  - {fileID: 2100000, guid: ${MATERIAL_GUID}, type: 2}`,
      '',
    ].join('\n'),
  )
  // Unrelated asset, to prove the scan does not claim everything references everything.
  asset('Assets/Materials/Blue.mat', '33333333333333333333333333333333', '%YAML 1.1\n--- !u!21 &2100001\nMaterial:\n  m_Name: Blue\n')
  return root
}

describe('findReferences without a scene', () => {
  test('answers from the project YAML and labels its source', async (t) => {
    const root = project(t)
    __resetAssetDbForTest()
    const result = await findReferences(NO_EDITOR, root, { assetPath: 'Assets/Materials/Red.mat' })
    assert.equal(result.source, 'project')
    assert.equal(result.guid, MATERIAL_GUID)
    assert.deepEqual(result.paths.sort(), ['Assets/Prefabs/Player.prefab', 'Assets/Scenes/Main.unity'])
    assert.match(result.results, /read from the project YAML on disk/)
    assert.match(result.results, /^- Assets\/Prefabs\/Player\.prefab$/m)
    assert.match(result.results, /source: project index/)
  })

  test('an asset nothing references says so, with the scanned file count', async (t) => {
    const root = project(t)
    __resetAssetDbForTest()
    const result = await findReferences(NO_EDITOR, root, { assetPath: 'Assets/Materials/Blue.mat' })
    assert.deepEqual(result.paths, [])
    assert.match(result.results, /- none\. \d+ file\(s\) were indexed/)
  })

  test('still rejects a path outside the project', async (t) => {
    const root = project(t)
    await assert.rejects(
      () => findReferences(NO_EDITOR, root, { assetPath: '../outside.mat' }),
      /is outside the Unity project/,
    )
  })
})

describe('findCodeUsages without a scene', () => {
  test('lists the assets carrying the script, from the index', async (t) => {
    const root = project(t)
    __resetAssetDbForTest()
    const result = await findCodeUsages(NO_EDITOR, root, { filePath: 'Assets/Scripts/Player.cs' })
    assert.equal(result.source, 'project')
    assert.equal(result.guid, PLAYER_GUID)
    assert.deepEqual(result.paths, ['Assets/Prefabs/Player.prefab'])
    assert.match(result.results, /read from the project YAML on disk/)
    assert.match(result.results, /source: project index/)
  })

  test('a member name reports the objects that serialize that field', async (t) => {
    const root = project(t)
    __resetAssetDbForTest()
    const result = await findCodeUsages(NO_EDITOR, root, { filePath: 'Assets/Scripts/Player.cs', member: 'speed' })
    assert.match(result.results, /Objects that serialize a "speed" field while carrying Assets\/Scripts\/Player\.cs:/)
    assert.match(result.results, /- Assets\/Prefabs\/Player\.prefab :: Player \(fileID 400\)/)
  })

  test('a script nobody attaches says so', async (t) => {
    const root = project(t)
    __resetAssetDbForTest()
    const result = await findCodeUsages(NO_EDITOR, root, { filePath: 'Assets/Materials/Red.mat' })
    assert.match(result.results, /- none\./)
  })
})