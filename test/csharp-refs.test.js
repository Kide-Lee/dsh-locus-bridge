// String-reference validation (tags, layers, scenes, Resources, Input axes).
//
// These references compile and only fail at run time, so they cannot come from
// Roslyn — they are checked by parsing ProjectSettings text, which is what
// upstream `code_unity.rs::scan_project_refs` does and what this module ports.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  closestMatch,
  collectResourcePaths,
  formatProjectRefsSection,
  parseActiveInputHandler,
  parseBuildSettings,
  parseInputManager,
  parseTagManager,
  scanProjectRefs,
} from '../src/csharp/project-refs.js'

const sandbox = mkdtempSync(join(tmpdir(), 'locus-refs-test-'))
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }))

function project(name, options = {}) {
  const { tagManager = null, buildSettings = null, inputManager = null, projectSettings = null, scripts = {}, resources = [] } = options
  const root = join(sandbox, name)
  mkdirSync(join(root, 'ProjectSettings'), { recursive: true })
  mkdirSync(join(root, 'Assets/Scripts'), { recursive: true })
  if (tagManager !== null) writeFileSync(join(root, 'ProjectSettings/TagManager.asset'), tagManager)
  if (buildSettings !== null) writeFileSync(join(root, 'ProjectSettings/EditorBuildSettings.asset'), buildSettings)
  if (inputManager !== null) writeFileSync(join(root, 'ProjectSettings/InputManager.asset'), inputManager)
  if (projectSettings !== null) writeFileSync(join(root, 'ProjectSettings/ProjectSettings.asset'), projectSettings)
  for (const [file, body] of Object.entries(scripts)) writeFileSync(join(root, 'Assets/Scripts', file), body)
  for (const resource of resources) {
    const path = join(root, 'Assets', resource)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, 'x')
  }
  return root
}

const TAG_MANAGER = `%YAML 1.1
--- !u!78 &1
TagManager:
  tags:
  - Coin
  - killzone
  layers:
  - Default
  - TransparentFX
  - Ignore Raycast
  - ground
  - Water
  - UI
  - CameraBounds
  - 
`

const BUILD_SETTINGS = `%YAML 1.1
--- !u!1045 &1
EditorBuildSettings:
  m_ObjectHideFlags: 0
  serializedVersion: 2
  m_Scenes:
  - enabled: 1
    path: Assets/Scenes/Menu.unity
    guid: aaa
  - enabled: 1
    path: Assets/Scenes/Level.unity
    guid: bbb
`

const INPUT_MANAGER = `%YAML 1.1
--- !u!13 &1
InputManager:
  m_Axes:
  - serializedVersion: 3
    m_Name: Horizontal
    positiveButton: right
  - serializedVersion: 3
    m_Name: Vertical
    positiveButton: up
`

test('TagManager parsing keeps built-ins and adds customs in order', () => {
  const root = project('tags', { tagManager: TAG_MANAGER })
  const { tags, layers } = parseTagManager(root)
  assert.ok(tags.includes('Player'), 'built-in tags are always valid')
  assert.ok(tags.includes('Coin'))
  assert.ok(tags.includes('killzone'))
  assert.equal(layers.get(0), 'Default')
  assert.equal(layers.get(3), 'ground')
  assert.equal(layers.get(6), 'CameraBounds')
})

test('a missing TagManager still yields the built-in tags', () => {
  const root = project('no-tags')
  const { tags, layers } = parseTagManager(root)
  assert.ok(layers.size > 0)
  assert.ok(tags.includes('Untagged'))
})

test('Build Settings parsing separates enabled from disabled scenes', () => {
  const disabled = BUILD_SETTINGS.replace(
    'enabled: 1\n    path: Assets/Scenes/Level.unity',
    'enabled: 0\n    path: Assets/Scenes/Level.unity',
  )
  const root = project('scenes', { buildSettings: disabled })
  const result = parseBuildSettings(root)
  assert.equal(result.hasSettings, true)
  assert.deepEqual(result.enabled, ['Assets/Scenes/Menu.unity'])
  assert.deepEqual(result.disabled, ['Assets/Scenes/Level.unity'])
})

test('an empty scene list is not mistaken for entries', () => {
  const root = project('no-scenes', { buildSettings: 'EditorBuildSettings:\n  m_Scenes: []\n' })
  const result = parseBuildSettings(root)
  assert.deepEqual(result.enabled, [])
  assert.deepEqual(result.disabled, [])
})

test('Input Manager axis names are read', () => {
  const root = project('input', { inputManager: INPUT_MANAGER })
  const result = parseInputManager(root)
  assert.equal(result.hasSettings, true)
  assert.deepEqual([...result.axes].sort(), ['Horizontal', 'Vertical'])
})

test('activeInputHandler selects the input backend', () => {
  const root = project('active-input', { projectSettings: 'PlayerSettings:\n  activeInputHandler: 1\n' })
  assert.equal(parseActiveInputHandler(root), 1)
  assert.equal(parseActiveInputHandler(join(sandbox, 'does-not-exist')), null)
})

test('Resources paths are harvested keyed without extension', () => {
  const root = project('resources', {
    resources: ['Resources/Icons/Coin.png', 'Resources/Config/Game.asset', 'Packages/P/Resources/Nested/Thing.prefab'],
  })
  const found = collectResourcePaths(root)
  assert.ok(found.has('Icons/Coin'))
  assert.ok(found.has('Config/Game'))
  assert.ok(found.has('Nested/Thing'), 'Packages Resources folders count too')
})

test('aware tags resolve, unknown ones are reported', () => {
  const root = project('refs-tag', {
    tagManager: TAG_MANAGER,
    scripts: {
      'A.cs': 'class A { void M() {\n  gameObject.CompareTag("Coin");\n  gameObject.CompareTag("NoSuchTag");\n} }',
    },
  })
  const report = scanProjectRefs(root)
  assert.equal(report.counts.tags, 2)
  assert.equal(report.problems.length, 1)
  assert.match(report.problems[0].message, /unknown tag "NoSuchTag"/)
})

test('a near-miss tag gets a did-you-mean hint', () => {
  const root = project('refs-typo', {
    tagManager: TAG_MANAGER,
    scripts: { 'A.cs': 'class A { void M() { gameObject.CompareTag("Coinn"); } }' },
  })
  const report = scanProjectRefs(root)
  assert.match(report.problems[0].message, /did you mean "Coin"/)
})

test('scene references check against Build Settings', () => {
  const root = project('refs-scene', {
    buildSettings: BUILD_SETTINGS,
    scripts: {
      'A.cs': 'class A { void M() {\n  SceneManager.LoadScene("Level");\n  SceneManager.LoadScene("NoSuchScene");\n} }',
    },
  })
  const report = scanProjectRefs(root)
  assert.equal(report.problems.length, 1)
  assert.match(report.problems[0].message, /not in Build Settings/)
})

test('an out-of-range scene index is reported', () => {
  const root = project('refs-index', {
    buildSettings: BUILD_SETTINGS,
    scripts: { 'A.cs': 'class A { void M() { SceneManager.LoadScene(9); } }' },
  })
  const report = scanProjectRefs(root)
  assert.equal(report.problems.length, 1)
  assert.match(report.problems[0].message, /out of range/)
})

test('unknown Input axes are reported, known ones are not', () => {
  const root = project('refs-axis', {
    inputManager: INPUT_MANAGER,
    scripts: {
      'A.cs': 'class A { void M() {\n  Input.GetAxis("Horizontal");\n  Input.GetAxis("NoSuchAxis");\n} }',
    },
  })
  const report = scanProjectRefs(root)
  assert.equal(report.problems.length, 1)
  assert.match(report.problems[0].message, /unknown Input axis/)
})

test('the new Input System suppresses legacy axis checks', () => {
  const root = project('refs-newinput', {
    inputManager: INPUT_MANAGER,
    projectSettings: 'PlayerSettings:\n  activeInputHandler: 1\n',
    scripts: { 'A.cs': 'class A { void M() { Input.GetAxis("Anything"); } }' },
  })
  const report = scanProjectRefs(root)
  assert.equal(report.problems.length, 0)
})

test('missing Resources assets are reported', () => {
  const root = project('refs-resources', {
    resources: ['Resources/Icons/Coin.png'],
    scripts: {
      'A.cs': 'class A { void M() {\n  Resources.Load("Icons/Coin");\n  Resources.Load("Icons/Missing");\n} }',
    },
  })
  const report = scanProjectRefs(root)
  assert.equal(report.problems.length, 1)
  assert.match(report.problems[0].message, /has no asset/)
})

test('commented-out references are not reported', () => {
  const root = project('refs-comment', {
    tagManager: TAG_MANAGER,
    scripts: {
      'A.cs': 'class A { void M() {\n  // gameObject.CompareTag("NoSuchTag");\n  /* CompareTag("AlsoMissing"); */\n  gameObject.CompareTag("Coin");\n} }',
    },
  })
  const report = scanProjectRefs(root)
  assert.equal(report.problems.length, 0, JSON.stringify(report.problems))
  assert.equal(report.counts.tags, 1)
})

test('scanning one file ignores references in the others', () => {
  const root = project('refs-scope', {
    tagManager: TAG_MANAGER,
    scripts: {
      'A.cs': 'class A { void M() { gameObject.CompareTag("Coin"); } }',
      'B.cs': 'class B { void M() { gameObject.CompareTag("Bad"); } }',
    },
  })
  const onlyA = scanProjectRefs(root, join(root, 'Assets/Scripts/A.cs'))
  assert.equal(onlyA.problems.length, 0)
  const all = scanProjectRefs(root)
  assert.equal(all.problems.length, 1)
})

test('closestMatch suggests only near misses', () => {
  assert.equal(closestMatch(['Coin', 'Player'], 'Coinn'), 'Coin')
  assert.equal(closestMatch(['Coin', 'Player'], 'Zzzzzzzz'), null)
})

test('the section is empty when nothing was checked', () => {
  assert.equal(
    formatProjectRefsSection({ counts: { tags: 0, layers: 0, scenes: 0, resources: 0, axes: 0 }, problems: [] }),
    '',
  )
})

test('a clean report states the counts', () => {
  const text = formatProjectRefsSection({
    counts: { tags: 2, layers: 0, scenes: 1, resources: 0, axes: 0 },
    problems: [],
  })
  assert.match(text, /3 checked/)
  assert.match(text, /all resolve/)
})

test('a problem report lists path and line', () => {
  const text = formatProjectRefsSection({
    counts: { tags: 1, layers: 0, scenes: 0, resources: 0, axes: 0 },
    problems: [{ path: 'Assets/A.cs', line: 7, message: 'unknown tag "X"' }],
  })
  assert.match(text, /Assets\/A\.cs:7/)
})
