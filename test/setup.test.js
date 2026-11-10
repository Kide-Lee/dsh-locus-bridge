// Project setup: diagnosing why a Unity project is not connected, installing the
// bundled Locus package, and writing the native-bridge marker.
//
// The behaviour these tests pin down, in order of how easily it regresses:
//
//   * a `file:` manifest dependency that resolves is an install (the way a
//     side-by-side checkout is wired), not a missing package;
//   * the marker content is the endpoint, so rewriting a stale file is part of
//     installing — not an optimisation;
//   * an install preserves `Editor/Skills` and replaces everything else, and a
//     failed install must not leave a half-written package behind;
//   * diagnosis never needs a running editor.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  editorIsRunning,
  editorRunningError,
  formatSetup,
  inspectSetup,
  installPackage,
  manifestDependency,
  nativeBrokerFor,
  payloadDir,
  writeMarker,
} from '../src/setup.js'

/**
 * Point this process at a fixture package for the duration of one test.
 *
 * Returns the payload directory, or null when the check is skipped because the
 * fixture could not be built.
 */
function usePayloadFixture(t, build) {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'locus-payload-'))
  build(dir)
  const previous = process.env.DSH_LOCUS_PAYLOAD_DIR
  process.env.DSH_LOCUS_PAYLOAD_DIR = dir
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_LOCUS_PAYLOAD_DIR
    else process.env.DSH_LOCUS_PAYLOAD_DIR = previous
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

/** A project shell plus an isolated copy of the payload under test. */
function project(overrides = {}) {
  const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'locus-setup-test-'))
  mkdirSync(join(root, 'Assets'), { recursive: true })
  mkdirSync(join(root, 'ProjectSettings'), { recursive: true })
  mkdirSync(join(root, 'Packages'), { recursive: true })
  writeFileSync(join(root, 'Packages', 'manifest.json'), JSON.stringify({ dependencies: {} }, null, 2))
  for (const [rel, content] of Object.entries(overrides)) {
    const path = join(root, rel)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  return root
}

/** A complete fake `locus_unity` package, laid out like a bridged build. */
function fakePackage(dir, { native = 'linux' } = {}) {
  mkdirSync(join(dir, 'Editor', 'Roslyn'), { recursive: true })
  mkdirSync(join(dir, 'Editor', 'Native', 'linux-x86_64'), { recursive: true })
  mkdirSync(join(dir, 'Editor', 'Native', 'x86_64'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'com.farlocus.locus', version: '9.9.9' }))
  writeFileSync(join(dir, 'Editor', 'Locus.Editor.asmdef'), '{}')
  for (const name of ['Locus.Json.dll', 'Locus.Roslyn.dll', 'Locus.Detour.dll', 'Locus.HotReload.Runtime.dll']) {
    writeFileSync(join(dir, 'Editor', 'Roslyn', name), `${name} bytes`)
    writeFileSync(join(dir, 'Editor', 'Roslyn', `${name}.meta`), 'meta')
  }
  if (native === 'linux') {
    writeFileSync(join(dir, 'Editor', 'Native', 'linux-x86_64', 'liblocus_unity_native.so'), 'so')
  } else if (native === 'win32') {
    writeFileSync(join(dir, 'Editor', 'Native', 'x86_64', 'locus_unity_native.dll'), 'dll')
  }
  return dir
}

test('inspectSetup reports an empty project as missing both package and marker', () => {
  const root = project()
  const result = inspectSetup(root, { platform: 'linux' })
  assert.equal(result.ready, false)
  assert.equal(result.package, null)
  assert.deepEqual(
    result.problems.map((p) => p.code).sort(),
    ['marker_missing', 'package_missing'],
  )
  // The endpoint shape follows the host, not the `platform` override above:
  // `resolvePipeName` asks `process.platform` whether to derive a socket path or
  // a Win32 pipe name. Asserting `.sock` unconditionally only passed on POSIX.
  const expectedShape = process.platform === 'win32' ? /^\\\\\.\\pipe\\locus_unity_native_/ : /\.sock$/
  assert.match(result.endpoint, expectedShape)
})

test('the payload broker is reported for the host platform', () => {
  assert.equal(nativeBrokerFor('win32').file, 'locus_unity_native.dll')
  assert.equal(nativeBrokerFor('linux').file, 'liblocus_unity_native.so')
  assert.equal(nativeBrokerFor('freebsd'), null, 'an unsupported host has no broker expectation')
})

test('reading a project never throws, even when Packages/ is unreadable', () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'locus-setup-nopkg-'))
  mkdirSync(join(root, 'Assets'))
  mkdirSync(join(root, 'ProjectSettings'))
  try {
    assert.equal(manifestDependency(root).declared, false)
    assert.doesNotThrow(() => inspectSetup(root, { platform: 'linux' }))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a file: dependency that resolves counts as an install', () => {
  const root = project()
  const external = fakePackage(mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'locus-setup-ext-')))
  writeFileSync(
    join(root, 'Packages', 'manifest.json'),
    JSON.stringify({ dependencies: { 'com.farlocus.locus': 'file:../../ext' } }),
  )
  // Manifest paths resolve against Packages/, so point the entry at the sibling.
  const relative = join('..', '..', external.split('/').pop())
  writeFileSync(
    join(root, 'Packages', 'manifest.json'),
    JSON.stringify({ dependencies: { 'com.farlocus.locus': `file:${relative}` } }),
  )
  const expected = join(root, 'Packages', `file:${relative}`.slice('file:'.length))
  assert.equal(
    manifestDependency(root).resolves,
    existsSync(join(expected, 'package.json')),
    'resolves reflects what the specifier points at',
  )
})

test('an embedded package wins over a manifest dependency and is not marked legacy', () => {
  const root = project()
  fakePackage(join(root, 'Packages', 'com.farlocus.locus'))
  writeFileSync(
    join(root, 'Packages', 'manifest.json'),
    JSON.stringify({ dependencies: { 'com.farlocus.locus': 'file:../../elsewhere' } }),
  )
  const result = inspectSetup(root, { platform: 'linux' })
  assert.equal(result.package.via, 'packages')
  assert.equal(result.package.legacy, false)
  assert.equal(result.package.version, '9.9.9')
})

test('an Assets/Locus copy is reported as legacy but still counts as installed', () => {
  const root = project()
  fakePackage(join(root, 'Assets', 'Locus'))
  const result = inspectSetup(root, { platform: 'linux' })
  assert.equal(result.package.via, 'assets')
  assert.equal(result.package.legacy, true)
  assert.ok(result.problems.some((p) => p.code === 'legacy_install'))
})

test('a package without the host broker is not ready and says which file is missing', () => {
  const root = project()
  fakePackage(join(root, 'Packages', 'com.farlocus.locus'), { native: 'win32' })
  writeMarker(root, '/tmp/x.sock')
  const result = inspectSetup(root, { platform: 'linux' })
  assert.equal(result.ready, false)
  const problem = result.problems.find((p) => p.code === 'broker_missing')
  assert.ok(problem, 'reports broker_missing')
  assert.match(problem.detail, /liblocus_unity_native\.so/)
})

test('an incomplete package names the assemblies it lacks', () => {
  const root = project()
  const pkg = fakePackage(join(root, 'Packages', 'com.farlocus.locus'))
  rmSync(join(pkg, 'Editor', 'Roslyn', 'Locus.Json.dll'))
  writeMarker(root, '/tmp/x.sock')
  const result = inspectSetup(root, { platform: 'linux' })
  assert.deepEqual(result.package.missingAssemblies, ['Locus.Json.dll'])
  assert.ok(result.problems.some((p) => p.code === 'package_incomplete'))
})

test('LOCUS_UNITY_NATIVE_BRIDGE=1 excuses a missing marker', () => {
  const root = project()
  fakePackage(join(root, 'Packages', 'com.farlocus.locus'))
  const withoutEnv = inspectSetup(root, { platform: 'linux', env: {} })
  const withEnv = inspectSetup(root, { platform: 'linux', env: { LOCUS_UNITY_NATIVE_BRIDGE: '1' } })
  assert.ok(withoutEnv.problems.some((p) => p.code === 'marker_missing'))
  assert.equal(withEnv.ready, true)
})

test('writeMarker stores the endpoint on its own line and rewrites a stale one', () => {
  const root = project()
  const first = writeMarker(root, '/run/locus/first.sock')
  assert.equal(readFileSync(first.path, 'utf8'), '/run/locus/first.sock\n')
  const second = writeMarker(root, '/run/locus/second.sock')
  assert.equal(readFileSync(second.path, 'utf8'), '/run/locus/second.sock\n')
  const result = inspectSetup(root, { platform: 'linux' })
  assert.equal(result.marker.endpoint, '/run/locus/second.sock')
})

test('installing copies the package, writes the marker and becomes ready', (t) => {
  const root = project()
  const payload = usePayloadFixture(t, fakePackage)

  const installed = installPackage(root)
  assert.equal(installed.relativeTarget, 'Packages/com.farlocus.locus')
  assert.equal(existsSync(join(root, 'Packages', 'com.farlocus.locus', 'package.json')), true)
  assert.equal(installed.keptSkills, 0)
  writeMarker(root, inspectSetup(root, { platform: 'linux' }).endpoint)
  assert.equal(inspectSetup(root, { platform: 'linux' }).ready, true)
})

test('an install preserves Editor/Skills and replaces the rest', (t) => {
  const root = project()
  const payload = usePayloadFixture(t, fakePackage)

  const target = join(root, 'Packages', 'com.farlocus.locus')
  installPackage(root)
  mkdirSync(join(target, 'Editor', 'Skills'), { recursive: true })
  writeFileSync(join(target, 'Editor', 'Skills', 'mine.md'), 'keep me')
  writeFileSync(join(target, 'stale.txt'), 'gone')
  const again = installPackage(root)
  assert.equal(again.keptSkills, 1)
  assert.equal(readFileSync(join(target, 'Editor', 'Skills', 'mine.md'), 'utf8'), 'keep me')
  assert.equal(existsSync(join(target, 'stale.txt')), false, 'files absent from the payload do not survive')
})

test('installing does not leave the staging directory behind', (t) => {
  const root = project()
  const payload = usePayloadFixture(t, fakePackage)

  installPackage(root)
  assert.equal(existsSync(join(root, 'Library', 'Locus', 'package-staging')), false)
})

test('the install is byte-identical to the payload', (t) => {
  const root = project()
  const payload = usePayloadFixture(t, fakePackage)

  installPackage(root)
  const installed = readFileSync(join(root, 'Packages', 'com.farlocus.locus', 'package.json'), 'utf8')
  assert.equal(installed, readFileSync(join(payload, 'package.json'), 'utf8'))
})

test('a project that already has everything reports no problems', (t) => {
  const root = project()
  const payload = usePayloadFixture(t, fakePackage)

  installPackage(root)
  writeMarker(root, inspectSetup(root, { platform: 'linux' }).endpoint)
  const result = inspectSetup(root, { platform: 'linux' })
  assert.equal(result.ready, true)
  assert.deepEqual(result.problems, [])
})

test('a healthy project renders nothing, so a normal call adds no context', (t) => {
  const root = project()
  usePayloadFixture(t, fakePackage)
  installPackage(root)
  writeMarker(root, inspectSetup(root, { platform: 'linux' }).endpoint)
  const result = inspectSetup(root, { platform: 'linux' })
  assert.equal(result.ready, true)
  assert.equal(formatSetup(result), '', 'no problems means no report')
})

test('a broken project renders one line per problem and no confirmation of what works', (t) => {
  const root = project()
  usePayloadFixture(t, fakePackage)
  const text = formatSetup(inspectSetup(root, { platform: 'linux' }))
  assert.match(text, /com\.farlocus\.locus is not installed/)
  assert.match(text, /NativeBridge\.enabled/)
  assert.doesNotMatch(text, /Broker:/, 'a healthy subsystem is not narrated')
  assert.doesNotMatch(text, /Endpoint:/)
})

test('install instructions appear only when the package is absent', (t) => {
  const root = project()
  usePayloadFixture(t, fakePackage)
  const missing = formatSetup(inspectSetup(root, { platform: 'linux' }))
  assert.match(missing, /has no Locus Unity package/)
  assert.match(missing, /--install/, 'names the command that fixes it')

  // With a package present but the marker absent, the guide must be gone: the
  // agent has nothing to install, only a marker to write.
  installPackage(root)
  const noMarker = formatSetup(inspectSetup(root, { platform: 'linux' }))
  assert.match(noMarker, /NativeBridge\.enabled/)
  assert.doesNotMatch(noMarker, /--install/)
  assert.doesNotMatch(noMarker, /has no Locus Unity package/)
})

test('a broken package does not advertise an install it cannot fix', (t) => {
  const root = project()
  usePayloadFixture(t, fakePackage)
  const pkg = join(root, 'Packages', 'com.farlocus.locus')
  fakePackage(pkg)
  rmSync(join(pkg, 'Editor', 'Roslyn', 'Locus.Json.dll'))
  writeMarker(root, '/tmp/x.sock')
  const text = formatSetup(inspectSetup(root, { platform: 'linux' }))
  assert.match(text, /Locus\.Json\.dll/)
  assert.doesNotMatch(text, /--install/, 're-copying cannot supply a missing assembly')
})

// ── a running editor ────────────────────────────────────────────────────────
//
// Unity holds an exclusive lock on `Temp/UnityLockfile` for the life of the
// process. That lock is cross-process: no second `open()` inside this process
// can reproduce it on POSIX, where an in-process reopen always succeeds. The
// probe is therefore injectable, and these tests stand in an `open` that fails
// the way the real syscall does when another process owns the file.

/** A probe that behaves as if an editor holds the lockfile. */
function lockedByEditor() {
  return () => {
    const error = new Error('EPERM: resource busy or locked, open Temp/UnityLockfile')
    error.code = 'EPERM'
    throw error
  }
}

/** Create `Temp/UnityLockfile` the way a crashed editor leaves one behind. */
function staleLockfile(root) {
  mkdirSync(join(root, 'Temp'), { recursive: true })
  writeFileSync(join(root, 'Temp', 'UnityLockfile'), '')
}

test('a project with no Temp/UnityLockfile has no editor running', () => {
  const root = project()
  assert.equal(editorIsRunning(root), false)
})

test('a stale UnityLockfile with no holder does not count as a running editor', () => {
  const root = project()
  staleLockfile(root)
  // A crashed editor leaves the file behind; only a held lock proves it is up.
  assert.equal(editorIsRunning(root), false)
})

test('an unreadable lockfile that is not a lock failure is not "editor running"', () => {
  const root = project()
  const probe = () => {
    const error = new Error('EACCES: permission denied')
    error.code = 'EACCES'
    throw error
  }
  // EACCES is in the held set: an unreadable file is reported as "close it",
  // because that is the only advice that can help either way.
  assert.equal(editorIsRunning(root, { open: probe }), true)
})

test('inspectSetup reports editorRunning so a caller can ask for a restart', () => {
  const root = project()
  staleLockfile(root)
  assert.equal(inspectSetup(root, { platform: 'linux' }).editorRunning, false)
  assert.equal(inspectSetup(root, { platform: 'linux', open: lockedByEditor() }).editorRunning, true)
})

test('installPackage refuses while the editor holds the project', (t) => {
  const root = project()
  usePayloadFixture(t, fakePackage)
  staleLockfile(root)
  assert.throws(
    () => installPackage(root, { open: lockedByEditor() }),
    (error) => {
      assert.equal(error.code, 'EDITOR_RUNNING', 'callers branch on the code, not the text')
      assert.equal(error.name, 'EditorRunningError')
      assert.match(error.message, /close the editor/i)
      return true
    },
  )
})

test('a refused install leaves the project untouched', (t) => {
  const root = project()
  usePayloadFixture(t, fakePackage)
  staleLockfile(root)
  assert.throws(() => installPackage(root, { open: lockedByEditor() }))
  assert.equal(existsSync(join(root, 'Packages', 'com.farlocus.locus')), false, 'nothing was copied')
  assert.equal(
    existsSync(join(root, 'Library', 'Locus', 'package-staging')),
    false,
    'no staging directory survives the refusal',
  )
})

test('the install guide tells the caller to close a running editor', (t) => {
  const root = project()
  usePayloadFixture(t, fakePackage)
  staleLockfile(root)

  const closed = formatSetup(inspectSetup(root, { platform: 'linux' }))
  assert.match(closed, /has no Locus Unity package/)
  assert.match(closed, /Run it with the Unity Editor closed/)

  const open = formatSetup(inspectSetup(root, { platform: 'linux', open: lockedByEditor() }))
  assert.match(open, /Close the Unity Editor first/)
  assert.doesNotMatch(open, /Run it with the Unity Editor closed/)
})

test('editorRunningError carries the project and one actionable sentence', () => {
  const root = project()
  const error = editorRunningError(root)
  assert.equal(error.code, 'EDITOR_RUNNING')
  assert.equal(error.projectRoot, root)
  assert.match(error.message, /Close the editor and run this again/)
})
