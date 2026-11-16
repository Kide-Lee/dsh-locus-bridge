import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LIVE_READ_MESSAGE,
  LIVE_UNSUPPORTED,
  assetPathOf,
  hasObjectSelector,
  liveSource,
  readLiveObject,
} from '../src/live-source.js'
import { readYamlText, searchYamlFiles } from '../src/yaml-lite.js'

const PROJECT = mkdtempSync(join(tmpdir(), 'locus-live-source-'))
process.on('exit', () => rmSync(PROJECT, { recursive: true, force: true }))

mkdirSync(join(PROJECT, 'Assets', 'Scenes'), { recursive: true })
writeFileSync(
  join(PROJECT, 'Assets', 'Scenes', 'Main.unity'),
  [
    '%YAML 1.1',
    '%TAG !u! tag:unity3d.com,2011:',
    '--- !u!1 &100',
    'GameObject:',
    '  m_ObjectHideFlags: 0',
    '  m_Name: Player',
    '  m_IsActive: 1',
    '',
  ].join('\n'),
)

/** A client double that answers `read_yaml` with the given reply. */
function fakeClient(reply, { throwError = null } = {}) {
  const calls = []
  return {
    calls,
    async request(type, body, options) {
      calls.push({ type, body, options })
      if (throwError) throw throwError
      return reply
    },
  }
}

test('a live read asks the payload for exactly one object of one file', async () => {
  const client = fakeClient({ ok: true, message: '[source: live Unity Editor (unsaved changes)]\nGameObject &100\n  m_Name: Player (live)' })
  const result = await readLiveObject(client, PROJECT, join(PROJECT, 'Assets', 'Scenes', 'Main.unity'), '100', { depth: 3 })
  assert.equal(result.ok, true)
  assert.equal(client.calls[0].type, 'read_yaml')
  assert.deepEqual(JSON.parse(client.calls[0].body), {
    file_path: 'Assets/Scenes/Main.unity',
    object_path: '100',
    max_depth: 3,
  })
  assert.match(result.text, /m_Name: Player \(live\)/)
})

test('the payload\'s own error text becomes the reason, without its prefix', async () => {
  const client = fakeClient({ ok: true, message: '__ERROR__: object 999 not found in the open scene' })
  const result = await readLiveObject(client, PROJECT, 'Assets/Scenes/Main.unity', '999')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'object 999 not found in the open scene')
})

test('a payload without read_yaml is reported as needing a newer package', async () => {
  const client = fakeClient({ ok: false, error: 'unknown message type: read_yaml' })
  const result = await readLiveObject(client, PROJECT, 'Assets/Scenes/Main.unity', '100')
  assert.equal(result.ok, false)
  assert.equal(result.reason, LIVE_UNSUPPORTED)
})

test('a transport error degrades to a reason instead of throwing', async () => {
  const error = new Error('editor not connected')
  error.code = 'managed_not_ready'
  const client = fakeClient(null, { throwError: error })
  const result = await readLiveObject(client, PROJECT, 'Assets/Scenes/Main.unity', '100')
  assert.equal(result.ok, false)
  assert.match(result.reason, /did not answer \(managed_not_ready\)/)
})

test('only scenes and prefabs can be read live, and only with an object selector', async () => {
  const client = fakeClient({ ok: true, message: 'x' })
  const asset = await readLiveObject(client, PROJECT, 'Assets/Materials/Red.mat', '1')
  assert.equal(asset.ok, false)
  assert.match(asset.reason, /only available for \.unity and \.prefab files/)
  const noObject = await readLiveObject(client, PROJECT, 'Assets/Scenes/Main.unity', '  ')
  assert.equal(noObject.ok, false)
  assert.match(noObject.reason, /needs an object selector/)
  assert.deepEqual(client.calls, [])
})

test('assetPathOf accepts absolute paths and normalises separators', () => {
  assert.equal(assetPathOf(PROJECT, join(PROJECT, 'Assets', 'Scenes', 'Main.unity')), 'Assets/Scenes/Main.unity')
  assert.equal(assetPathOf(PROJECT, './Assets/Scenes/Main.unity'), 'Assets/Scenes/Main.unity')
  assert.equal(hasObjectSelector('100'), true)
  assert.equal(hasObjectSelector(''), false)
  assert.equal(hasObjectSelector(null), false)
})

test('liveSource returns a bundle keyed by the project-relative path', async () => {
  const client = fakeClient({ ok: true, message: 'GameObject &100' })
  const { live, reason } = await liveSource(client, PROJECT, 'Assets/Scenes/Main.unity', { object: '100' })
  assert.equal(reason, null)
  assert.equal(live.path, 'Assets/Scenes/Main.unity')
  assert.equal(live.object, '100')
  assert.equal(live.texts['Assets/Scenes/Main.unity'], 'GameObject &100')
  const missing = await liveSource(client, PROJECT, 'Assets/Scenes/Main.unity', {})
  assert.equal(missing.live, null)
  assert.match(missing.reason, /need an object selector/)
})

test('unity_yaml_read hands the Editor text through with disk context', async () => {
  const text = 'GameObject &100\n  m_Name: Player (live)'
  const client = fakeClient({ ok: true, message: text })
  const { live } = await liveSource(client, PROJECT, 'Assets/Scenes/Main.unity', { object: '100' })
  assert.ok(live !== null, 'the live bundle must be produced')
  assert.equal(live.texts['Assets/Scenes/Main.unity'], text)
  const result = readYamlText(PROJECT, { path: 'Assets/Scenes/Main.unity', object: '100', live })
  assert.equal(result.source, 'live')
  assert.match(result.text, /^Unity YAML: Assets\/Scenes\/Main\.unity \(live Unity Editor, object 100;/)
  assert.match(result.text, /# values come from the Editor, not from Assets\/Scenes\/Main\.unity on disk/)
  assert.match(result.text, /m_Name: Player \(live\)$/)
})

test('a search over the live file sees the live text too', () => {
  const live = { path: 'Assets/Scenes/Main.unity', object: '100', texts: { 'Assets/Scenes/Main.unity': '--- !u!1 &100\nGameObject:\n  m_Name: LiveName\n' } }
  const result = searchYamlFiles(PROJECT, { query: 'LiveName', scope: 'Assets/Scenes', live })
  assert.equal(result.source, 'live')
  assert.equal(result.total, 1)
  assert.equal(result.liveFiles, 1)
})
