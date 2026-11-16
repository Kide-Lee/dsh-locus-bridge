import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

import { installBuiltinLoader, openIndex } from '../src/asset-index.js'
import { refreshIndex } from '../src/asset-index-sync.js'
import {
  LIVE_OVERRIDES_MESSAGE,
  LIVE_READ_MESSAGE,
  formatOverrides,
  liveSource,
  readLiveAsset,
  readLiveOverrides,
  renderSnapshotAsYaml,
} from '../src/live-source.js'
import { parseUnityYaml, queryDocument } from '../src/yaml-lite.js'

const requireBuiltin = createRequire(import.meta.url)
installBuiltinLoader((specifier) => {
  if (specifier !== 'node:sqlite') throw new Error(`unexpected builtin ${specifier}`)
  return requireBuiltin(specifier)
})

const PROJECT = mkdtempSync(join(tmpdir(), 'locus-live-source-'))
process.on('exit', () => rmSync(PROJECT, { recursive: true, force: true }))

/** A client double: records requests and answers from a table of replies. */
function fakeClient(replies) {
  const calls = []
  return {
    calls,
    async request(type, body, options) {
      calls.push({ type, body: JSON.parse(body), options })
      const reply = replies[type]
      if (reply === undefined) return { ok: false, error: `unknown message type: ${type}` }
      if (typeof reply === 'function') return reply(JSON.parse(body))
      return reply
    },
  }
}

test('readLiveAsset sends the project-relative path and indexes objects by FileID', async () => {
  const client = fakeClient({
    [LIVE_READ_MESSAGE]: {
      ok: true,
      message: JSON.stringify({
        path: 'Assets/Scenes/Main.unity',
        count: 2,
        objects: [
          { name: 'Player', type: 'GameObject', file_id: 100, fields: [{ name: 'm_Name', type: 'string', value: 'Player' }] },
          { name: 'Cube', type: 'GameObject', fields: [] },
        ],
      }),
    },
  })
  const result = await readLiveAsset(client, '/project', '/project/Assets/Scenes/Main.unity')
  assert.equal(result.ok, true)
  assert.equal(client.calls[0].body.path, 'Assets/Scenes/Main.unity')
  assert.equal(result.objects[0].fileId, '100')
  // An object without a FileID still survives, under a stable synthetic key.
  assert.equal(result.objects[1].fileId, '')
  assert.match(result.objects[1].liveKey, /^anon:/)
})

test('an editor without the companion package is reported as "not installed", not as a failure', async () => {
  const client = fakeClient({})
  const result = await readLiveAsset(client, '/project', 'Assets/Scenes/Main.unity')
  assert.equal(result.ok, false)
  assert.match(result.reason, /com\.locus\.dsh-bridge is not installed/)
})

test('a transport error degrades to a reason instead of throwing', async () => {
  const client = {
    async request() {
      const error = new Error('editor not connected')
      error.code = 'managed_not_ready'
      throw error
    },
  }
  const result = await readLiveAsset(client, '/project', 'Assets/x.prefab')
  assert.equal(result.ok, false)
  assert.match(result.reason, /did not answer \(managed_not_ready\)/)
})

test('a handler that writes its own error object is surfaced verbatim', async () => {
  const client = fakeClient({ [LIVE_READ_MESSAGE]: { ok: true, message: '{"error":"Assets/missing.prefab does not exist"}' } })
  const result = await readLiveAsset(client, '/project', 'Assets/missing.prefab')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'Assets/missing.prefab does not exist')
})

test('liveSource returns null without a client so callers fall back to disk', async () => {
  const { live, reason } = await liveSource(null, '/project', 'Assets/x.prefab')
  assert.equal(live, null)
  assert.equal(reason, 'no Editor connection')
})

test('readLiveOverrides parses the override table', async () => {
  const client = fakeClient({
    [LIVE_OVERRIDES_MESSAGE]: {
      ok: true,
      message: JSON.stringify({
        path: 'Assets/Prefabs/Enemy.prefab',
        count: 1,
        overrides: [{ target: 'Body', property_path: 'm_Mass', value: '12', original_value: '1' }],
      }),
    },
  })
  const result = await readLiveOverrides(client, '/project', 'Assets/Prefabs/Enemy.prefab')
  assert.equal(result.ok, true)
  assert.equal(result.overrides.length, 1)
})

test('formatOverrides names the original value so an override reads as a change', () => {
  const text = formatOverrides({
    path: 'Assets/Prefabs/Enemy.prefab',
    overrides: [{ target: 'Body', property_path: 'm_Mass', value: '12', original_value: '1' }],
  })
  assert.match(text, /Prefab overrides: Assets\/Prefabs\/Enemy\.prefab \(live, 1 override\(s\)\)/)
  assert.match(text, /Body m_Mass = 12\s+\(prefab: 1\)/)
})

test('formatOverrides says "no overrides" for an untouched instance', () => {
  const text = formatOverrides({ path: 'Assets/Prefabs/Plain.prefab', overrides: [] })
  assert.match(text, /<no overrides/)
})

test('the index opens read-only when asked and refuses to create a database', () => {
  const opened = openIndex(PROJECT, { readonly: true })
  assert.equal(opened.db, null)
  assert.match(opened.unavailable, /does not exist yet; run an asset scan first/)
})

test('a read-only open can read rows written by a read-write session', () => {
  const writer = openIndex(PROJECT)
  assert.equal(writer.unavailable, null)
  // refreshIndex stats every path, so the file has to exist on disk.
  mkdirSync(join(PROJECT, 'Assets', 'Materials'), { recursive: true })
  writeFileSync(join(PROJECT, 'Assets', 'Materials', 'Red.mat'), 'binary mat')
  refreshIndex(PROJECT, [
    {
      path: 'Assets/Materials/Red.mat',
      absolute: join(PROJECT, 'Assets/Materials/Red.mat'),
      ext: '.mat',
      guid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      type: 'material',
      yaml: false,
      size: 10,
      mtimeMs: 1000,
    },
  ])
  writer.db.close()
  const reader = openIndex(PROJECT, { readonly: true })
  assert.equal(reader.unavailable, null)
  const row = reader.db.prepare('SELECT count(*) AS n FROM assets').get()
  assert.equal(Number(row.n), 1)
  // The type survives a round trip: a read-only reader sees what the writer wrote.
  assert.equal(reader.db.prepare('SELECT type FROM assets').get().type, 'material')
  reader.db.close()
})

test('renderSnapshotAsYaml round-trips through the disk parser', () => {
  // The live search depends on this: the Editor sends a property tree, the
  // search reads Unity YAML, so the tree has to become YAML that parseUnityYaml
  // reads back into the same field names and values.
  const yaml = renderSnapshotAsYaml([
    {
      type: 'GameObject',
      file_id: '123',
      fields: [
        { name: 'm_Name', value: 'Main Camera' },
        { name: 'm_Transform', children: [{ name: 'm_LocalPosition', children: [{ name: 'x', value: '1.5' }] }] },
      ],
    },
  ])
  const parsed = parseUnityYaml(yaml)
  assert.equal(parsed.documents.length, 1)
  assert.equal(parsed.documents[0].typeName, 'GameObject')
  // queryDocument answers with the node, not its scalar; compare the raw text.
  assert.equal(queryDocument(parsed.documents[0], '/m_Name').raw, 'Main Camera')
  assert.equal(queryDocument(parsed.documents[0], '/m_Transform/m_LocalPosition/x').raw, '1.5')
})

test('renderSnapshotAsYaml quotes values that would change YAML meaning', () => {
  const yaml = renderSnapshotAsYaml([{ type: 'Note', fields: [{ name: 'm_Text', value: 'a: b # not a comment' }] }])
  const parsed = parseUnityYaml(yaml)
  assert.equal(queryDocument(parsed.documents[0], '/m_Text').value, 'a: b # not a comment')
})

test('renderSnapshotAsYaml returns null for an empty snapshot', () => {
  assert.equal(renderSnapshotAsYaml([]), null)
  assert.equal(renderSnapshotAsYaml([{ type: 'Empty', fields: [] }]), null)
})

test('liveSource hands the rendered text to the search path', async () => {
  const client = fakeClient({
    [LIVE_READ_MESSAGE]: {
      ok: true,
      message: JSON.stringify({
        path: 'Assets/Scenes/Main.unity',
        objects: [{ type: 'GameObject', file_id: '7', fields: [{ name: 'm_Name', value: 'Player' }] }],
      }),
    },
  })
  const { live, reason } = await liveSource(client, PROJECT, 'Assets/Scenes/Main.unity')
  assert.equal(reason, null)
  assert.match(live.texts['Assets/Scenes/Main.unity'], /m_Name: Player/)
})
