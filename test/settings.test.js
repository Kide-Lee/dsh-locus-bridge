// The feature switches: storage, merge semantics, and the deployment override.
//
// These are the rules the settings page depends on, and the ones a hand-edited
// `settings.json` must not be able to break: a malformed document degrades to
// the defaults instead of unregistering every tool, and `DSH_LOCUS_CSHARP=0`
// keeps winning over a stored `csharp: true`.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  DEFAULT_FEATURES,
  DEFAULT_PREFERENCES,
  FEATURE_KEYS,
  HOME_ENV,
  bridgeHome,
  defaultSettings,
  normalizeSettings,
  onSettingsChanged,
  readSettings,
  resolveFeatures,
  saveSettings,
  settingsPath,
} from '../src/settings.js'
import { allToolDefinitions, effectiveFeatures } from '../src/index.js'

/** One throwaway bridge home, removed after the test. */
function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'locus-settings-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { [HOME_ENV]: dir }
}

test('every plane is on by default, and the frame cache with it', () => {
  assert.deepEqual({ ...DEFAULT_FEATURES }, { unity: true, csharp: true, preview: true })
  assert.equal(DEFAULT_PREFERENCES.frameCache, true)
  assert.deepEqual(FEATURE_KEYS, ['unity', 'csharp', 'preview'])
  assert.deepEqual(
    { ...defaultSettings().features },
    { unity: true, csharp: true, preview: true },
  )
})

test('a missing document is the first-run state, not an error', (t) => {
  const env = home(t)
  assert.equal(readSettings(env).features.csharp, true)
  // Reading it must not create the file: only a write does that.
  assert.throws(() => readFileSync(settingsPath(env), 'utf8'))
})

test('a write round-trips and is observable', (t) => {
  const env = home(t)
  const seen = []
  const stop = onSettingsChanged((value) => seen.push(value))
  t.after(stop)
  const saved = saveSettings({ features: { csharp: false } }, env)
  assert.equal(saved.features.csharp, false)
  assert.equal(saved.features.unity, true, 'a merge must not reset the siblings')
  assert.equal(readSettings(env).features.csharp, false, 'the write is on disk')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].features.csharp, false)
  // The document is a plain JSON object a human can edit.
  const onDisk = JSON.parse(readFileSync(settingsPath(env), 'utf8'))
  assert.equal(onDisk.version, 1)
  assert.equal(onDisk.features.csharp, false)
})

test('a hand-edited file is picked up without a restart', (t) => {
  const env = home(t)
  saveSettings({ features: { unity: false } }, env)
  const path = settingsPath(env)
  const document = JSON.parse(readFileSync(path, 'utf8'))
  document.features.unity = true
  document.features.preview = false
  // Bump the size as well as the content so the (mtime, size) cache key cannot
  // collide on a filesystem with coarse timestamps.
  document.note = 'edited by hand'
  writeFileSync(path, JSON.stringify(document, null, 2), 'utf8')
  const settings = readSettings(env)
  assert.equal(settings.features.unity, true)
  assert.equal(settings.features.preview, false)
})

test('a malformed document falls back to the defaults and says so', (t) => {
  const env = home(t)
  saveSettings({ features: { csharp: false } }, env)
  writeFileSync(settingsPath(env), '{ not json', 'utf8')
  const warnings = []
  const settings = readSettings(env, { onWarning: (message) => warnings.push(message) })
  assert.equal(settings.features.csharp, true)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /malformed/)
})

test('non-boolean and unknown switches are not coerced', () => {
  // `"off"` and `0` are the mistakes a hand-written file makes; treating them as
  // truthy would silently keep a plane on, and treating them as false would
  // silently switch one off. The default is the only honest answer.
  const settings = normalizeSettings({
    features: { unity: 'off', csharp: 0, preview: false, nonsense: true },
    preferences: { frameCache: 'no', other: 1 },
  })
  assert.equal(settings.features.unity, true)
  assert.equal(settings.features.csharp, true)
  assert.equal(settings.features.preview, false)
  assert.equal('nonsense' in settings.features, false)
  assert.equal(settings.preferences.frameCache, true)
  assert.deepEqual(Object.keys(settings.preferences), ['frameCache'])
})

test('a patch cannot invent a switch key', (t) => {
  const env = home(t)
  saveSettings({ features: { nonsense: false } }, env)
  assert.equal('nonsense' in readSettings(env).features, false)
})

test('DSH_LOCUS_CSHARP=0 pins the C# plane off regardless of the stored value', (t) => {
  const env = home(t)
  saveSettings({ features: { csharp: true } }, env)
  const stored = readSettings(env)
  assert.equal(resolveFeatures(stored, { ...env, DSH_LOCUS_CSHARP: '0' }).csharp, false)
  assert.equal(resolveFeatures(stored, env).csharp, true)
  // The other planes are untouched by that switch.
  assert.equal(resolveFeatures(stored, { ...env, DSH_LOCUS_CSHARP: '0' }).unity, true)
})

test('the bridge home honours the relocation variable', (t) => {
  const env = { [HOME_ENV]: join(tmpdir(), 'locus-bridge-home-test') }
  assert.equal(bridgeHome(env), env[HOME_ENV])
  assert.equal(settingsPath(env), join(env[HOME_ENV], 'settings.json'))
})

test('the tool catalog follows the stored switches', (t) => {
  const env = home(t)
  const unityNames = (names) => names.filter((name) => name.startsWith('unity_'))
  const csharpNames = (names) => names.filter((name) => name.startsWith('code_'))

  const all = allToolDefinitions(env).map((definition) => definition.name)
  assert.ok(unityNames(all).length > 0)
  assert.ok(csharpNames(all).length > 0)

  saveSettings({ features: { csharp: false } }, env)
  const withoutCsharp = allToolDefinitions(env).map((definition) => definition.name)
  assert.deepEqual(csharpNames(withoutCsharp), [])
  assert.deepEqual(unityNames(withoutCsharp), unityNames(all))

  saveSettings({ features: { unity: false } }, env)
  const neither = allToolDefinitions(env).map((definition) => definition.name)
  assert.deepEqual(unityNames(neither), [])
  assert.deepEqual(neither, [])

  // The preview plane is not a tool plane: it must not change this list.
  saveSettings({ features: { unity: true, csharp: true, preview: false } }, env)
  assert.deepEqual(
    allToolDefinitions(env).map((definition) => definition.name).sort(),
    [...all].sort(),
  )
  assert.equal(effectiveFeatures(env).preview, false)
})