// Project resolution: the behaviour the Locus desktop client has, adapted to a
// DSH Session whose cwd is usually the repository rather than the Unity project.
//
// Desktop reference points:
//   * `unity_bridge::is_unity_project` — `Assets/` + `ProjectSettings/`
//   * `cli_driver::resolve_project_path` — an explicit error when nothing is named

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { isUnityProject, resolveProjectRoot, unityProjectChildren } from '../src/args.js'

/** Create a throwaway directory tree; `unity` names become Unity projects. */
function sandbox(unity = [], plain = []) {
  const root = mkdtempSync(join(tmpdir(), 'locus-args-test-'))
  for (const name of unity) {
    const dir = join(root, name)
    mkdirSync(join(dir, 'Assets'), { recursive: true })
    mkdirSync(join(dir, 'ProjectSettings'), { recursive: true })
  }
  for (const name of plain) mkdirSync(join(root, name), { recursive: true })
  return root
}

/** A host context whose Session cwd is `cwd`. */
function ctx(cwd) {
  return { agent: { session: { header: { cwd } } } }
}

test('isUnityProject requires both Assets/ and ProjectSettings/', () => {
  const root = sandbox(['Game'], ['JustAssets', 'Docs'])
  mkdirSync(join(root, 'JustAssets', 'Assets'), { recursive: true })
  try {
    assert.equal(isUnityProject(join(root, 'Game')), true)
    assert.equal(isUnityProject(join(root, 'JustAssets')), false, 'Assets/ alone is not a project')
    assert.equal(isUnityProject(join(root, 'Docs')), false, 'ProjectSettings/ alone is not a project')
    assert.equal(isUnityProject(join(root, 'missing')), false)
    assert.equal(isUnityProject(''), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a cwd that is already a Unity project resolves to itself', () => {
  const root = sandbox(['Game'])
  try {
    const project = join(root, 'Game')
    assert.equal(resolveProjectRoot(undefined, ctx(project)), resolve(project))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a repository cwd resolves the single Unity project directly inside it', () => {
  // This is the shape that matters in practice: the Session runs in a repo whose
  // Unity project is a subdirectory (e.g. `unity-test/`).
  const root = sandbox(['unity-test'], ['src', 'docs'])
  try {
    assert.deepEqual(
      unityProjectChildren(root).map((p) => p.slice(root.length + 1)),
      ['unity-test'],
    )
    assert.equal(resolveProjectRoot(undefined, ctx(root)), resolve(join(root, 'unity-test')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('several candidate projects are reported instead of guessed', () => {
  const root = sandbox(['GameA', 'GameB'])
  try {
    assert.throws(
      () => resolveProjectRoot(undefined, ctx(root)),
      (error) => /several Unity projects/.test(error.message) && /GameA/.test(error.message) && /GameB/.test(error.message),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('no project anywhere is an explicit error naming project_path', () => {
  const root = sandbox([], ['src', 'docs'])
  try {
    assert.throws(() => resolveProjectRoot(undefined, ctx(root)), /pass project_path/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an explicit project_path is validated, not taken on faith', () => {
  const root = sandbox(['Game'], ['NotAProject'])
  try {
    const project = join(root, 'Game')
    // Absolute.
    assert.equal(resolveProjectRoot(project, ctx(root)), resolve(project))
    // Relative to the Session cwd.
    assert.equal(resolveProjectRoot('Game', ctx(root)), resolve(project))
    // `.` means "the cwd" (and must still be a project).
    assert.equal(resolveProjectRoot('.', ctx(project)), resolve(project))

    assert.throws(
      () => resolveProjectRoot(join(root, 'NotAProject'), ctx(root)),
      /is not a Unity project/,
    )
    assert.throws(() => resolveProjectRoot('Nope', ctx(root)), /is not a Unity project/)
    assert.throws(() => resolveProjectRoot('.', ctx(root)), /is not a Unity project/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('`..` segments collapse without resolving symlinks', () => {
  // Unity derives the broker key from the path it opened, so resolution must not
  // rewrite a path the user supplied beyond collapsing `.`/`..`.
  const root = sandbox(['Game'])
  try {
    const viaParent = join(root, 'Game', '..', 'Game')
    assert.equal(resolveProjectRoot(viaParent, ctx(root)), resolve(join(root, 'Game')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a Windows-style path is treated as absolute, not joined to the cwd', () => {
  // `F:/Projects/Game` cannot exist on this host, so it must fail as "not a
  // project" rather than being silently joined onto the Session cwd.
  assert.throws(
    () => resolveProjectRoot('F:/Projects/Game', ctx('/home/someone/repo')),
    /is not a Unity project/,
  )
})
