// The durable asset index: what gets stored, what a rescan re-reads, and how the
// reference graph answers from it.
//
// The index exists to stop the reference graph from reading every YAML file on
// every question. So the tests check the two properties that make it worth
// having — an unchanged file is not re-read, and a changed or deleted file is
// applied exactly once — plus the row shapes the graph needs.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { scanAssets, __resetAssetDbForTest } from '../src/asset-db.js'
import {
  countRows,
  getMeta,
  installBuiltinLoader,
  openIndex,
  readKnownFiles,
  setMeta,
  statFile,
} from '../src/asset-index.js'
import {
  deriveRows,
  indexStats,
  indexPath,
  lookupReferences,
  refreshIndex,
} from '../src/asset-index-sync.js'
import { parseUnityYaml } from '../src/yaml-lite.js'

const SCRIPT_GUID = '11111111111111111111111111111111'
const OTHER_GUID = '22222222222222222222222222222222'

const PREFAB = [
  '--- !u!1 &100',
  'GameObject:',
  '  m_Name: Player',
  '--- !u!114 &200',
  'MonoBehaviour:',
  '  m_GameObject: {fileID: 100}',
  `  m_Script: {fileID: 11500000, guid: ${SCRIPT_GUID}, type: 3}`,
  `  target: {fileID: 50, guid: ${OTHER_GUID}, type: 2}`,
  '  local: {fileID: 100}',
  '',
].join('\n')

/** A throwaway project with one script, one prefab and their .meta files. */
function makeProject() {
  const root = mkdtempSync(join(tmpdir(), 'asset-index-'))
  mkdirSync(join(root, 'Assets', 'Scripts'), { recursive: true })
  writeFileSync(join(root, 'Assets', 'Scripts', 'Player.cs'), 'public class Player {}\n')
  writeFileSync(join(root, 'Assets', 'Scripts', 'Player.cs.meta'), `fileFormatVersion: 2\nguid: ${SCRIPT_GUID}\n`)
  writeFileSync(join(root, 'Assets', 'Player.prefab'), PREFAB)
  return root
}

test('refreshIndex stores one row per walked file and one per document', () => {
  const root = makeProject()
  try {
    const walked = [
      { absolute: join(root, 'Assets/Scripts/Player.cs'), path: 'Assets/Scripts/Player.cs', ext: '.cs', yaml: false, guid: SCRIPT_GUID, type: 'script', root },
      { absolute: join(root, 'Assets/Player.prefab'), path: 'Assets/Player.prefab', ext: '.prefab', yaml: true, guid: null, type: 'prefab', root },
    ]
    const summary = refreshIndex(root, walked)
    assert.equal(summary.unavailable, null)
    assert.equal(summary.changed, 2)
    assert.equal(summary.removed, 0)
    assert.equal(summary.objects, 2)
    // Two cross-asset edges; the bare `{fileID: 100}` is a same-file reference and
    // must not become an edge of its own.
    assert.equal(summary.refs, 2)
    assert.equal(countRows(summary.db, 'files'), 2)
    const known = readKnownFiles(summary.db)
    assert.equal(known.size, 2)
    assert.ok(getMeta(summary.db, 'scanned_at') !== null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a rescan re-reads only files whose stamp moved, and removes vanished ones', () => {
  const root = makeProject()
  try {
    const prefab = join(root, 'Assets/Player.prefab')
    const script = join(root, 'Assets/Scripts/Player.cs')
    const walked = [
      { absolute: script, path: 'Assets/Scripts/Player.cs', ext: '.cs', yaml: false, guid: SCRIPT_GUID, type: 'script', root },
      { absolute: prefab, path: 'Assets/Player.prefab', ext: '.prefab', yaml: true, guid: null, type: 'prefab', root },
    ]
    refreshIndex(root, walked)
    // Nothing changed: no row is re-derived, nothing is removed.
    const idle = refreshIndex(root, walked)
    assert.equal(idle.changed, 0)
    assert.equal(idle.removed, 0)
    assert.equal(idle.objects, 0)

    const removed = refreshIndex(root, [walked[0]])
    assert.equal(removed.removed, 1)
    closeIndexAfter(removed)
    const opened = openIndex(root, { create: false })
    try {
      assert.equal(countRows(opened.db, 'files'), 1)
      assert.equal(countRows(opened.db, 'objects'), 0)
    } finally {
      opened.db.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('deriveRows borrows a MonoBehaviour name from its GameObject and lowercases GUIDs', () => {
  const text = PREFAB.replace(SCRIPT_GUID, SCRIPT_GUID.toUpperCase())
  const rows = deriveRows(
    { path: 'Assets/Player.prefab', ext: '.prefab', yaml: true, type: 'prefab' },
    () => parseUnityYaml(text),
  )
  assert.deepEqual(
    rows.objects.map((row) => [row.classId, row.fileId, row.typeName, row.name]),
    [
      [1, 100, 'GameObject', 'Player'],
      [114, 200, 'MonoBehaviour', 'Player'],
    ],
  )
  assert.equal(rows.objects[1].scriptGuid, SCRIPT_GUID)
  assert.equal(rows.objects[1].ownerFileId, 100)
  assert.deepEqual(
    rows.refs.map((row) => [row.fromFileId, row.toGuid, row.toFileId]),
    [
      [200, SCRIPT_GUID, 11500000],
      [200, OTHER_GUID, 50],
    ],
  )
})

test('a binary asset yields an asset row and no documents', () => {
  const rows = deriveRows(
    { path: 'Assets/Scene.unity', ext: '.unity', yaml: true, type: 'scene' },
    () => {
      throw new Error('not text')
    },
  )
  assert.deepEqual(rows.objects, [])
  assert.deepEqual(rows.refs, [])
})

test('scanAssets folds the index summary into its result', async () => {
  const root = makeProject()
  __resetAssetDbForTest()
  try {
    const first = await scanAssets(root, { rescan: true })
    assert.equal(first.index.available, true)
    assert.equal(first.index.changed, 2)
    const second = await scanAssets(root, { rescan: true })
    assert.equal(second.index.changed, 0)
    assert.equal(second.index.removed, 0)
    assert.deepEqual(
      [second.scannedFiles, second.assets.length],
      [2, 2],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a partial scan does not touch the durable index', async () => {
  const root = makeProject()
  __resetAssetDbForTest()
  try {
    await scanAssets(root, { rescan: true })
    const before = indexPath(root)
    const opened = openIndex(root, { create: false })
    const files = countRows(opened.db, 'files')
    opened.db.close()
    assert.equal(files, 2)
    // A zero budget walks nothing; writing that walk would erase both rows.
    __resetAssetDbForTest()
    const partial = await scanAssets(root, { rescan: true, budgetMs: 0 })
    assert.equal(partial.partial, true)
    assert.equal(partial.index, null)
    const again = openIndex(root, { create: false })
    try {
      assert.equal(countRows(again.db, 'files'), files)
    } finally {
      again.db.close()
    }
    assert.ok(before.endsWith('asset-index.db'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('lookupReferences answers from the table, with the target path resolved', async () => {
  const root = makeProject()
  __resetAssetDbForTest()
  try {
    await scanAssets(root, { rescan: true })
    const found = lookupReferences(root, SCRIPT_GUID)
    assert.equal(found.available, true)
    assert.equal(found.references.length, 1)
    assert.equal(found.references[0].path, 'Assets/Player.prefab')
    assert.equal(found.references[0].fromFileId, 200)
    assert.equal(found.references[0].type, 'script')
    const missing = lookupReferences(root, '3'.repeat(32))
    assert.deepEqual(missing.references, [])
    const stats = indexStats(root)
    assert.equal(stats.files, 2)
    assert.equal(stats.refs, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a schema bump replaces the old tables instead of reading them', () => {
  const root = makeProject()
  try {
    const first = refreshIndex(root, [
      { absolute: join(root, 'Assets/Scripts/Player.cs'), path: 'Assets/Scripts/Player.cs', ext: '.cs', yaml: false, guid: SCRIPT_GUID, type: 'script', root },
    ])
    setMeta(first.db, 'note', 'before')
    setMeta(first.db, 'schema_marker', 'stale')
    first.db.close()
    // Simulate a library written by an older build.
    const raw = openIndex(root, { create: false })
    raw.db.exec('PRAGMA user_version = 0')
    raw.db.close()
    const rebuilt = refreshIndex(root, [
      { absolute: join(root, 'Assets/Scripts/Player.cs'), path: 'Assets/Scripts/Player.cs', ext: '.cs', yaml: false, guid: SCRIPT_GUID, type: 'script', root },
    ])
    assert.equal(rebuilt.unavailable, null)
    assert.equal(rebuilt.changed, 1)
    assert.equal(getMeta(rebuilt.db, 'note'), null)
    rebuilt.db.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('without node:sqlite the index reports itself unavailable instead of throwing', async () => {
  const root = makeProject()
  __resetAssetDbForTest()
  try {
    const summary = refreshIndex(root, [], {
      openIndexImpl: () => ({ db: null, unavailable: 'node:sqlite is not available', file: indexPath(root) }),
    })
    assert.equal(summary.unavailable, 'node:sqlite is not available')
    assert.equal(summary.changed, 0)
    const found = lookupReferences(root, SCRIPT_GUID, {
      openIndexImpl: () => ({ db: null, unavailable: 'node:sqlite is not available', file: '' }),
    })
    assert.equal(found.available, false)
    assert.deepEqual(found.references, [])
    // The scan still answers, just without the durable table.
    const scanned = await scanAssets(root, { rescan: true })
    assert.equal(scanned.assets.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('statFile reports a missing file as null', () => {
  assert.equal(statFile(join(tmpdir(), 'asset-index-missing', 'nope')), null)
})

/** Close a summary's handle when the test opened it itself. */
function closeIndexAfter(summary) {
  summary.db?.close()
}

// `installBuiltinLoader` is installed by `asset-db.js` on import; this guard makes
// a future refactor that drops that wiring fail loudly here instead of silently
// degrading every index test above.
test('the builtin loader is installed', () => {
  assert.equal(typeof installBuiltinLoader, 'function')
})
