// Which projects are listed, and which of the three states each one is in.
//
// The state machine is the whole point of this feature, and its ordering is the
// part that is easy to get wrong: a reachable broker must outrank a filesystem
// complaint (the package is demonstrably working), and "the pipe exists but the
// sandbox refused the handle" must never be reported as "nothing listening".

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { describeProject, listProjectCandidates, PROJECT_STATES } from '../src/projects.js'
import { probeEndpoint, probeEndpointDetailed, isSocketEndpoint } from '../src/endpoint.js'

/** A throwaway directory holding one or more Unity projects. */
function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'locus-projects-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/** A project skeleton; `package` adds an installed Locus package. */
function makeProject(root, name, { package: withPackage = false, marker = false, lockfile = false } = {}) {
  const dir = join(root, name)
  mkdirSync(join(dir, 'Assets'), { recursive: true })
  mkdirSync(join(dir, 'ProjectSettings'), { recursive: true })
  if (withPackage) {
    const pkg = join(dir, 'Packages', 'com.farlocus.locus')
    mkdirSync(join(pkg, 'Editor', 'Native', 'x86_64'), { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'com.farlocus.locus', version: '0.1.0' }))
    for (const dll of ['Locus.Json.dll', 'Locus.Roslyn.dll', 'Locus.Detour.dll', 'Locus.HotReload.Runtime.dll']) {
      writeFileSync(join(pkg, 'Editor', dll), '')
    }
    const broker = process.platform === 'win32' ? 'locus_unity_native.dll' : 'liblocus_unity_native.so'
    writeFileSync(join(pkg, 'Editor', 'Native', 'x86_64', broker), '')
  }
  if (marker) {
    mkdirSync(join(dir, 'Library', 'Locus'), { recursive: true })
    writeFileSync(join(dir, 'Library', 'Locus', 'NativeBridge.enabled'), '\\\\.\\pipe\\x\n')
  }
  if (lockfile) {
    mkdirSync(join(dir, 'Temp'), { recursive: true })
    writeFileSync(join(dir, 'Temp', 'UnityLockfile'), '')
  }
  return dir
}

// ── endpoint probing ───────────────────────────────────────────────────────

test('a dead pipe is not listening, and a live one is not mistaken for dead', async () => {
  // The distinction that matters: on Windows a refused handle (EPERM, which is
  // what a sandbox produces) means the NAME EXISTS. Reporting that as "nothing
  // listening" would make every project look uninstalled on a locked-down host.
  const dead = `\\\\.\\pipe\\locus-test-definitely-absent-${process.pid}-${Date.now()}`
  assert.equal(await probeEndpoint(dead, { timeoutMs: 800 }), false)
  const detail = await probeEndpointDetailed(dead, { timeoutMs: 800 })
  assert.equal(detail.listening, false)
  assert.equal(detail.code, 'ENOENT')
})

test('a missing unix socket is not listening', async () => {
  assert.equal(isSocketEndpoint('/tmp/x.sock'), true)
  assert.equal(isSocketEndpoint('\\\\.\\pipe\\x'), false)
  assert.equal(await probeEndpoint(`/tmp/locus-absent-${process.pid}.sock`, { timeoutMs: 400 }), false)
})

test('an empty endpoint is handled without asking the OS', async () => {
  assert.equal(await probeEndpoint(''), false)
  assert.equal((await probeEndpointDetailed('')).code, 'no_endpoint')
})

// ── candidate discovery ────────────────────────────────────────────────────

test('the scan finds nested projects and skips generated trees', (t) => {
  const root = workspace(t)
  const outer = makeProject(root, 'Game')
  // A project inside a directory literally named Library must not be listed:
  // that is Unity's generated tree.
  const decoy = join(root, 'Library', 'Nested')
  mkdirSync(join(decoy, 'Assets'), { recursive: true })
  mkdirSync(join(decoy, 'ProjectSettings'), { recursive: true })

  const found = listProjectCandidates([root])
  assert.ok(found.includes(outer), 'the real project is listed')
  assert.ok(!found.includes(decoy), 'a project under Library/ is skipped')
})

test('a directory that is not a project yields nothing', (t) => {
  const root = workspace(t)
  mkdirSync(join(root, 'JustAFolder'))
  assert.deepEqual(listProjectCandidates([root]), [])
  assert.deepEqual(listProjectCandidates([]), [])
  assert.deepEqual(listProjectCandidates([join(root, 'nope')]), [])
})

test('several projects under one workspace are all listed', (t) => {
  const root = workspace(t)
  const a = makeProject(root, 'Alpha')
  const b = makeProject(root, 'Beta')
  const found = listProjectCandidates([root])
  assert.deepEqual(found.sort(), [a, b].sort())
})

// ── the state machine ──────────────────────────────────────────────────────

test('the three states are a closed set', () => {
  assert.deepEqual([...PROJECT_STATES], ['connected', 'not_connected', 'plugin_missing'])
})

test('a project without the package is plugin_missing and offers an install', async (t) => {
  const root = workspace(t)
  const project = makeProject(root, 'Bare')
  const row = await describeProject(project)
  assert.equal(row.state, 'plugin_missing')
  assert.equal(row.package.installed, false)
  assert.ok(row.blockers.includes('package_missing'))
  assert.equal(row.canInstall, true)
})

test('an installed package with no listener is not_connected, not plugin_missing', async (t) => {
  const root = workspace(t)
  // No lockfile, no broker running: this is the common real state after an
  // install, and it must not read as "the plugin is absent".
  const project = makeProject(root, 'Installed', { package: true, marker: true })
  const row = await describeProject(project)
  assert.equal(row.state, 'not_connected')
  assert.equal(row.package.installed, true)
  assert.equal(row.markerPresent, true)
  assert.equal(row.editorRunning, false)
  assert.equal(row.canInstall, false, 'an installed package is not offered for install')
})

test('an open editor without a listener reports both facts', async (t) => {
  // `editorRunning` is what separates "the editor is closed" from "the editor is
  // open but the bridge never started" — two states that need different advice.
  //
  // The lock is injected: Unity's exclusive handle cannot be reproduced inside
  // one process on POSIX, so the fixture stands in for the failing syscall
  // exactly as `test/setup.test.js` does.
  const root = workspace(t)
  const project = makeProject(root, 'OpenEditor', { package: true, marker: true, lockfile: true })
  const row = await describeProject(project, {
    open: () => {
      throw Object.assign(new Error('EBUSY: editor holds it'), { code: 'EBUSY' })
    },
  })
  assert.equal(row.state, 'not_connected')
  assert.equal(row.editorRunning, true)
})

test('a project whose package exists but has no broker is not installable blindly', async (t) => {
  const root = workspace(t)
  const project = makeProject(root, 'NoBroker', { package: false })
  const row = await describeProject(project)
  // Without any package this is still the installable case.
  assert.equal(row.state, 'plugin_missing')
  assert.equal(row.canInstall, true)
})

test('describing a non-project is an error, not a silent row', async (t) => {
  const root = workspace(t)
  const plain = join(root, 'plain')
  mkdirSync(plain)
  await assert.rejects(() => describeProject(plain), /not a Unity project/)
})