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

import { findUnityProjects, isUnityProject, PROJECT_SEARCH_DEPTH, resolveProjectRoot } from '../src/args.js'

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
    assert.equal(resolveProjectRoot(undefined, ctx(root)), resolve(join(root, 'unity-test')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/** Build a Unity project nested `depth` directories below `root`. */
function nestedProject(root, depth, name = 'Game') {
  const segments = Array.from({ length: Math.max(0, depth - 1) }, (_unused, index) => `level${index + 1}`)
  const dir = join(root, ...segments, name)
  mkdirSync(join(dir, 'Assets'), { recursive: true })
  mkdirSync(join(dir, 'ProjectSettings'), { recursive: true })
  return dir
}

test('the implicit search reaches three levels but not four', () => {
  assert.equal(PROJECT_SEARCH_DEPTH, 3)

  for (const depth of [1, 2, 3]) {
    const root = sandbox([], ['src'])
    try {
      const project = nestedProject(root, depth)
      assert.equal(
        resolveProjectRoot(undefined, ctx(root)),
        resolve(project),
        `a project ${depth} level(s) down must be found`,
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  const deep = sandbox([], ['src'])
  try {
    nestedProject(deep, 4)
    assert.throws(() => resolveProjectRoot(undefined, ctx(deep)), /none within 3 levels/)
  } finally {
    rmSync(deep, { recursive: true, force: true })
  }
})

test('the shallowest project wins over a deeper one', () => {
  // Breadth-first: a project one level down is a better answer than one three
  // levels down, so this must not be reported as an ambiguity.
  const root = sandbox([], ['src'])
  try {
    const shallow = nestedProject(root, 1)
    const deeper = nestedProject(root, 3, 'Deep')
    const found = findUnityProjects(root)
    assert.deepEqual(
      found.map((candidate) => ({ depth: candidate.depth, path: candidate.path })),
      [
        { depth: 1, path: shallow },
        { depth: 3, path: deeper },
      ],
    )
    assert.equal(resolveProjectRoot(undefined, ctx(root)), resolve(shallow))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('two projects at the same shallowest depth are an ambiguity, not a guess', () => {
  const root = sandbox([], ['src'])
  try {
    nestedProject(root, 2, 'GameA')
    nestedProject(root, 2, 'GameB')
    // Deeper hits must not rescue an ambiguous shallow tier.
    nestedProject(root, 3, 'Deeper')
    assert.throws(
      () => resolveProjectRoot(undefined, ctx(root)),
      (error) => /several Unity projects 2 level\(s\) down/.test(error.message) && /GameA/.test(error.message) && /GameB/.test(error.message),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the search skips generated trees such as a project Library/', () => {
  // Descending into `Library/` would be both slow and pointless; it must never
  // be reported as a candidate path.
  const root = sandbox([], ['src'])
  try {
    const project = nestedProject(root, 1)
    const inside = join(project, 'Library', 'PackageCache', 'com.example.fake')
    mkdirSync(join(inside, 'Assets'), { recursive: true })
    mkdirSync(join(inside, 'ProjectSettings'), { recursive: true })
    const found = findUnityProjects(root).map((candidate) => candidate.path)
    assert.deepEqual(found, [project])
    assert.equal(resolveProjectRoot(undefined, ctx(root)), resolve(project))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the search does not descend into a project it already found', () => {
  const root = sandbox([], ['src'])
  try {
    const project = nestedProject(root, 1)
    // A nested Unity project inside the outer one is not a separate candidate.
    const nested = join(project, 'Packages', 'com.example.nested')
    mkdirSync(join(nested, 'Assets'), { recursive: true })
    mkdirSync(join(nested, 'ProjectSettings'), { recursive: true })
    assert.deepEqual(findUnityProjects(root).map((candidate) => candidate.path), [project])
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

// ── Only the Session directory and below it ─────────────────────────────────
// The search is deliberately downwards-only: a project in a parent directory, or
// beside an ancestor, is not this Session's project. The Settings page's
// workspace scan follows the same rule, so there is one answer everywhere.

test('a cwd inside the project does not walk up to it', () => {
  const root = sandbox(['unity-test'])
  try {
    const inside = join(root, 'unity-test', 'Assets')
    mkdirSync(inside, { recursive: true })
    assert.throws(
      () => resolveProjectRoot(undefined, ctx(inside)),
      /pass project_path/,
      'a directory below a project is not allowed to adopt it',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a project beside an ancestor is never adopted', () => {
  // The shape that used to be resolved: `repo/src/deep` found `unity-test`
  // beside `repo`. It must now fail, and a Session at the repository root must
  // not see it either — the sibling is outside every candidate root.
  const root = sandbox(['unity-test'], ['repo/src/deep', 'repo/docs'])
  try {
    assert.throws(() => resolveProjectRoot(undefined, ctx(join(root, 'repo', 'src', 'deep'))), /pass project_path/)
    assert.throws(() => resolveProjectRoot(undefined, ctx(join(root, 'repo', 'docs'))), /pass project_path/)
    assert.throws(() => resolveProjectRoot(undefined, ctx(join(root, 'repo'))), /pass project_path/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a repository cwd still finds a project nested below it, at any allowed depth', () => {
  // The downwards direction is what a monorepo with `game/unity-test` relies on,
  // so removing the upward search must not remove this.
  const root = sandbox([], ['repo/src'])
  try {
    const project = join(root, 'repo', 'game', 'unity-test')
    mkdirSync(join(project, 'Assets'), { recursive: true })
    mkdirSync(join(project, 'ProjectSettings'), { recursive: true })
    assert.equal(resolveProjectRoot(undefined, ctx(join(root, 'repo'))), resolve(project))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
