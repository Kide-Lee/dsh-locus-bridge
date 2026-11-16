// Unity / 团结引擎发行版识别的测试。
//
// 移植自上游 `flavor.rs` 的单元测试（同一组用例，同样期望值），加上本插件额外的
// 文件读取部分：版本文件解析、Hub 安装扫描。所有测试都在临时目录里搭假工程/假
// Hub 配置，不碰真实安装。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FLAVORS,
  detectFlavor,
  detectFlavorFromEditorTitle,
  editorExecutableCandidates,
  flavorProfile,
  hasProjectVersionFile,
  isEditorWindowTitle,
  isTuanjieVersion,
  parseProjectVersion,
  pathEndsWithEditorExe,
  scanInstalledEditors,
} from '../src/unity-flavor.js'

function sandbox() {
  return mkdtempSync(join(tmpdir(), 'locus-flavor-test-'))
}

function makeProject(root, versionText) {
  mkdirSync(join(root, 'ProjectSettings'), { recursive: true })
  writeFileSync(join(root, 'ProjectSettings', 'ProjectVersion.txt'), versionText)
  return root
}

test('FLAVORS lists unity before tuanjie and is frozen', () => {
  assert.deepEqual([...FLAVORS], ['unity', 'tuanjie'])
  assert.ok(Object.isFrozen(FLAVORS))
})

test('isTuanjieVersion matches the upstream table', () => {
  // 逐条对应上游 `flavor.rs` 的 `is_tuanjie_version` 用例。
  assert.equal(isTuanjieVersion('2022.3.62t10'), true)
  assert.equal(isTuanjieVersion('2022.3.2t3'), true)
  assert.equal(isTuanjieVersion('2022.3.47f1'), false)
  assert.equal(isTuanjieVersion('6000.3.14f1'), false)
  assert.equal(isTuanjieVersion(''), false)
  // 边界：`t` 必须在两个数字之间——版本号的开头、结尾、或相邻非数字都不算。
  assert.equal(isTuanjieVersion('t10'), false)
  assert.equal(isTuanjieVersion('2022.3.62t'), false)
  assert.equal(isTuanjieVersion('2022.3.62tX'), false)
  assert.equal(isTuanjieVersion(null), false)
  assert.equal(isTuanjieVersion(undefined), false)
})

test('flavorProfile exposes each flavor\'s outer marks', () => {
  assert.equal(flavorProfile('unity').editorExeFileName, 'Unity.exe')
  assert.equal(flavorProfile('tuanjie').editorExeFileName, 'Tuanjie.exe')
  assert.equal(flavorProfile('tuanjie').engineModuleDll, 'Tuanjie.dll')
  assert.equal(flavorProfile('tuanjie').windowTitleToken, 'Tuanjie')
  assert.equal(flavorProfile('unity').processImageName, 'unity.exe')
  assert.equal(flavorProfile('tuanjie').processImageName, 'tuanjie.exe')
  // 未知发行版回落到 unity，而不是抛异常：调用方拿到的永远是一张能用的表。
  assert.equal(flavorProfile('godot').flavor, 'unity')
  assert.equal(flavorProfile(null).flavor, 'unity')
})

test('parseProjectVersion reads m_EditorVersion only', () => {
  const text = [
    'm_EditorVersion: 2022.3.62f3',
    'm_EditorVersionWithRevision: 2022.3.62f3 (96770f904ca7)',
  ].join('\n')
  assert.equal(parseProjectVersion(text), '2022.3.62f3')
  assert.equal(parseProjectVersion('m_EditorVersion: 2022.3.62t10\r\n'), '2022.3.62t10')
  assert.equal(parseProjectVersion('nothing here'), null)
  assert.equal(parseProjectVersion(''), null)
})

test('detectFlavor distinguishes unity from tuanjie version files', () => {
  const root = sandbox()
  try {
    const unity = makeProject(join(root, 'unity'), 'm_EditorVersion: 2022.3.62f3\n')
    assert.deepEqual(
      { flavor: detectFlavor(unity).flavor, version: detectFlavor(unity).version },
      { flavor: 'unity', version: '2022.3.62f3' },
    )
    assert.match(detectFlavor(unity).versionFile, /ProjectSettings\/ProjectVersion\.txt$/)

    const tuanjie = makeProject(join(root, 'tuanjie'), 'm_EditorVersion: 2022.3.62t10\n')
    assert.equal(detectFlavor(tuanjie).flavor, 'tuanjie')
    assert.equal(detectFlavor(tuanjie).version, '2022.3.62t10')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('detectFlavor reports null rather than guessing when the file is missing', () => {
  const root = sandbox()
  try {
    // 空目录：不是 Unity 工程，但也不能断言"不是"。
    assert.deepEqual(
      { flavor: detectFlavor(root).flavor, version: detectFlavor(root).version },
      { flavor: null, version: null },
    )
    assert.throws(() => detectFlavor(''), /needs a project root/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('editorExecutableCandidates follows the Hub layout per platform', () => {
  const windows = editorExecutableCandidates('unity', { platform: 'win32' })
  assert.ok(windows.includes('Editor\\Unity.exe') || windows.includes(join('Editor', 'Unity.exe')))
  const windowsTuanjie = editorExecutableCandidates('tuanjie', { platform: 'win32' })
  assert.ok(windowsTuanjie.some((path) => path.endsWith('Tuanjie.exe')))

  const mac = editorExecutableCandidates('unity', { platform: 'darwin' })
  assert.ok(mac[0].endsWith(join('Unity.app', 'Contents', 'MacOS', 'Unity')))

  // Linux 没有固定的 Hub 布局：返回空列表而不是编一个不存在的路径。
  assert.deepEqual(editorExecutableCandidates('unity', { platform: 'linux' }), [])
})

test('pathEndsWithEditorExe normalizes separators and case', () => {
  // 上游用 `\\` 后缀匹配，这里把 `/` 也归一化成 `\\` 再比。
  assert.equal(pathEndsWithEditorExe('c:\\program files\\unity\\editor\\unity.exe', 'unity'), true)
  assert.equal(pathEndsWithEditorExe('/opt/tuanjie/editor/TUANJIE.EXE', 'tuanjie'), true)
  assert.equal(pathEndsWithEditorExe('/opt/tuanjie/editor/unity.exe', 'tuanjie'), false)
  assert.equal(pathEndsWithEditorExe('unity.exe', 'unity'), false)
  assert.equal(pathEndsWithEditorExe('', 'unity'), false)
})

test('detectFlavorFromEditorTitle keeps upstream window-title rules on Windows', () => {
  // 上游的判定是"含 Editor 且含发行版词"，两个条件都满足才算编辑器主窗口。
  const unityTitle = 'Game - SampleScene - Windows, Mac, Linux - Unity 2022.3.47f1 - Editor'
  assert.deepEqual(detectFlavorFromEditorTitle(unityTitle, { platform: 'win32' }), {
    supported: true,
    flavor: 'unity',
    reason: null,
  })
  assert.equal(isEditorWindowTitle(unityTitle), true)

  const tuanjieTitle = 'My project (1) tuanjie - SampleScene - Windows, Mac, Linux - Tuanjie Editor 1.9.2 <DX11>'
  assert.equal(detectFlavorFromEditorTitle(tuanjieTitle, { platform: 'win32' }).flavor, 'tuanjie')
  assert.equal(isEditorWindowTitle(tuanjieTitle), true)

  // 上游用例：没有 "Editor" 的窗口不是编辑器窗口。
  assert.equal(isEditorWindowTitle('Some Other Window'), false)
  assert.equal(detectFlavorFromEditorTitle('Some Other Window', { platform: 'win32' }).flavor, null)
  // 有 "Editor" 但没有发行版词：上游同样判 false，所以这里也认不出。
  assert.equal(isEditorWindowTitle('Foo - Editor'), false)
  assert.equal(detectFlavorFromEditorTitle('Foo - Editor', { platform: 'win32' }).flavor, null)
})

test('detectFlavorFromEditorTitle reports unsupported off Windows', () => {
  // 标题匹配是 Win32 概念；在 Unix 上返回 supported:false，而不是一个假的 false。
  const result = detectFlavorFromEditorTitle('Game - Unity 2022.3.47f1', { platform: 'linux' })
  assert.equal(result.supported, false)
  assert.equal(result.flavor, null)
  assert.match(result.reason, /Windows/)
})

test('scanInstalledEditors reads Hub editors.json entries', () => {
  const home = sandbox()
  try {
    const hubDir = join(home, '.config', 'UnityHub')
    mkdirSync(hubDir, { recursive: true })
    const unityInstall = join(home, 'Unity', 'Hub', 'Editor', '2022.3.62f3')
    const tuanjieInstall = join(home, 'Tuanjie', 'Hub', 'Editor', '2022.3.62t10')
    mkdirSync(unityInstall, { recursive: true })
    mkdirSync(tuanjieInstall, { recursive: true })
    writeFileSync(
      join(hubDir, 'editors.json'),
      JSON.stringify({
        schemaVersion: 1,
        list: [
          { version: '2022.3.62f3', location: unityInstall },
          { version: '2022.3.62t10', location: tuanjieInstall },
          { version: '2021.3.1f1', location: join(home, 'gone') },
        ],
      }),
    )

    const editors = scanInstalledEditors({ platform: 'linux', homeDir: home })
    assert.equal(editors.length, 2)
    assert.deepEqual(
      editors.map((editor) => editor.flavor),
      ['unity', 'tuanjie'],
    )
    assert.equal(editors[0].version, '2022.3.62f3')
    assert.equal(editors[1].version, '2022.3.62t10')
    // Linux 没有固定可执行文件布局，报安装根目录。
    assert.equal(editors[0].path, unityInstall)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('scanInstalledEditors is empty without a Hub config, and infers version from the path', () => {
  const home = sandbox()
  try {
    assert.deepEqual(scanInstalledEditors({ platform: 'linux', homeDir: home }), [])

    const hubDir = join(home, '.config', 'unityhub')
    mkdirSync(hubDir, { recursive: true })
    const install = join(home, 'editors', '2022.3.62t10')
    mkdirSync(install, { recursive: true })
    writeFileSync(join(hubDir, 'editors.json'), JSON.stringify([install]))
    const editors = scanInstalledEditors({ platform: 'linux', homeDir: home })
    assert.equal(editors.length, 1)
    assert.equal(editors[0].version, '2022.3.62t10')
    assert.equal(editors[0].flavor, 'tuanjie')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('hasProjectVersionFile checks the editor-owned file', () => {
  const root = sandbox()
  try {
    assert.equal(hasProjectVersionFile(root), false)
    makeProject(root, 'm_EditorVersion: 2022.3.62f3\n')
    assert.equal(hasProjectVersionFile(root), true)
    assert.equal(hasProjectVersionFile(''), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})