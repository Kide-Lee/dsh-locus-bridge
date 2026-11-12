import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { resolveProjectRoot, attachWorkingDirectory } from '../src/args.js'

/** A throwaway directory containing real `Assets/` + `ProjectSettings/`. */
function unityProject(root, name) {
  const dir = join(root, name)
  mkdirSync(join(dir, 'Assets'), { recursive: true })
  mkdirSync(join(dir, 'ProjectSettings'), { recursive: true })
  return dir
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'locus-cwd-'))
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('a live working-directory service overrides the frozen session cwd', (t) => {
  const { root, cleanup } = workspace()
  t.after(cleanup)
  const first = unityProject(root, 'First')
  const second = unityProject(root, 'Second')
  // The Session was created in `first`; the user then switched to `second`.
  const session = { header: { cwd: first } }
  const exec = { name: 'unity_status', callId: 'c1', signal: { aborted: false }, agent: { session } }

  // Without the service the resolution can only see the frozen header.
  assert.equal(resolveProjectRoot(undefined, exec), first)

  // Registering the service (what `apply()` does) makes the switch take effect.
  attachWorkingDirectory({ get: (target) => (target === session ? second : null) })
  try {
    assert.equal(resolveProjectRoot(undefined, exec), second)
  } finally {
    attachWorkingDirectory(null)
  }

  // Clearing it restores the previous behaviour instead of pinning the old value.
  assert.equal(resolveProjectRoot(undefined, exec), first)
})

test('a context-supplied service wins over the registered one', (t) => {
  const { root, cleanup } = workspace()
  t.after(cleanup)
  const fallback = unityProject(root, 'Fallback')
  const explicit = unityProject(root, 'Explicit')
  const session = { header: { cwd: fallback } }
  attachWorkingDirectory({ get: () => fallback })
  try {
    // The sidebar route passes the real plugin context on the object itself.
    const withService = { agent: { session }, workingDirectory: { get: () => explicit } }
    assert.equal(resolveProjectRoot(undefined, withService), explicit)
  } finally {
    attachWorkingDirectory(null)
  }
})

test('an explicit project_path still beats the live directory', (t) => {
  const { root, cleanup } = workspace()
  t.after(cleanup)
  const current = unityProject(root, 'Current')
  const chosen = unityProject(root, 'Chosen')
  const session = { header: { cwd: current } }
  attachWorkingDirectory({ get: () => current })
  try {
    const exec = { agent: { session } }
    assert.equal(resolveProjectRoot(chosen, exec), chosen)
  } finally {
    attachWorkingDirectory(null)
  }
})
