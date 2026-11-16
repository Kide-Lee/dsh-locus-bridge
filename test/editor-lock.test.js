// Tests for the cooperative project lock (src/editor-lock.js).

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'

import { LockTimeout, acquireLock, lockStatus, releaseLock } from '../src/editor-lock.js'

/** A bare project directory; the lock only writes under `Library/Locus/`. */
function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'locus-lock-'))
  mkdirSync(join(root, 'Assets'), { recursive: true })
  mkdirSync(join(root, 'ProjectSettings'), { recursive: true })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

function lockFile(root) {
  return join(root, 'Library', 'Locus', 'session-lock.json')
}

describe('acquireLock', () => {
  test('takes a free lock and records who holds it', async (t) => {
    const root = project(t)
    const result = await acquireLock(root, { owner: 'session-a', reason: 'editing the player prefab' })
    assert.equal(result.acquired, true)
    assert.equal(result.holder, 'session-a')
    assert.ok(Number.isFinite(result.acquiredAt))
    assert.ok(result.waitedMs >= 0)

    const stored = JSON.parse(readFileSync(lockFile(root), 'utf8'))
    assert.equal(stored.owner, 'session-a')
    assert.equal(stored.reason, 'editing the player prefab')
    assert.equal(stored.pid, process.pid)

    const status = await lockStatus(root)
    assert.equal(status.held, true)
    assert.equal(status.holder, 'session-a')
    assert.equal(status.stale, false)
  })

  test('is re-entrant for the same owner', async (t) => {
    const root = project(t)
    const first = await acquireLock(root, { owner: 'session-a' })
    const second = await acquireLock(root, { owner: 'session-a' })
    assert.equal(second.acquired, true)
    assert.equal(second.acquiredAt, first.acquiredAt, 'the original acquisition time stands')
    assert.equal(second.holder, 'session-a')
  })

  test('try mode reports the other holder immediately instead of waiting', async (t) => {
    const root = project(t)
    await acquireLock(root, { owner: 'session-a' })
    const startedAt = Date.now()
    const result = await acquireLock(root, { owner: 'session-b', mode: 'try' })
    assert.equal(result.acquired, false)
    assert.equal(result.holder, 'session-a')
    assert.ok(result.acquiredAt !== null)
    assert.ok(Date.now() - startedAt < 2_000, 'try must not poll')
  })

  test('wait mode throws LockTimeout naming the holder', async (t) => {
    const root = project(t)
    await acquireLock(root, { owner: 'session-a', reason: 'recompile' })
    await assert.rejects(
      () => acquireLock(root, { owner: 'session-b', timeoutSeconds: 1, reason: 'prefab edit' }),
      (error) => {
        assert.ok(error instanceof LockTimeout)
        assert.equal(error.name, 'LockTimeout')
        assert.equal(error.holder, 'session-a')
        assert.match(error.message, /Timed out after 1s/)
        assert.match(error.message, /session-a \(recompile\)/)
        return true
      },
    )
  })

  test('wait mode succeeds once the holder releases', async (t) => {
    const root = project(t)
    await acquireLock(root, { owner: 'session-a' })
    const waiter = acquireLock(root, { owner: 'session-b', timeoutSeconds: 10 })
    // Give the waiter a couple of polls to run, then let go.
    setTimeout(() => {
      void releaseLock(root, { owner: 'session-a' })
    }, 300)
    const result = await waiter
    assert.equal(result.acquired, true)
    assert.equal(result.holder, 'session-b')
    assert.ok(result.waitedMs >= 200)
  })

  test('breaks a lock left behind by a dead process', async (t) => {
    const root = project(t)
    mkdirSync(join(root, 'Library', 'Locus'), { recursive: true })
    // A pid no live process can have: starting one allocates pids upward, so
    // this one is guaranteed free (pid 0 means "my process group", not a pid).
    writeFileSync(
      lockFile(root),
      JSON.stringify({ owner: 'crashed-session', pid: 2_000_000_000, acquiredAt: Date.now() - 60_000, reason: 'old' }),
    )
    assert.equal((await lockStatus(root)).stale, true)
    const result = await acquireLock(root, { owner: 'session-b', mode: 'try' })
    assert.equal(result.acquired, true)
    assert.equal(result.holder, 'session-b')
  })

  test('leaves a lock whose process is still alive alone', async (t) => {
    const root = project(t)
    mkdirSync(join(root, 'Library', 'Locus'), { recursive: true })
    // The test runner's own pid is the one process guaranteed to be running.
    writeFileSync(lockFile(root), JSON.stringify({ owner: 'live-session', pid: process.ppid, acquiredAt: Date.now() }))
    const status = await lockStatus(root)
    assert.equal(status.stale, false)
    assert.equal((await acquireLock(root, { owner: 'session-b', mode: 'try' })).acquired, false)
  })

  test('rejects a missing owner and a bad mode', async (t) => {
    const root = project(t)
    await assert.rejects(() => acquireLock(root, {}), /owner is required/)
    await assert.rejects(() => acquireLock(root, { owner: '   ' }), /owner is required/)
    await assert.rejects(() => acquireLock(root, { owner: 'a', mode: 'maybe' }), /mode must be 'wait' or 'try'/)
  })

  test('clamps the timeout to the documented 1..900s range', async (t) => {
    const root = project(t)
    await acquireLock(root, { owner: 'session-a' })
    // A negative timeout still means "give up at the first poll", not "wait forever".
    await assert.rejects(() => acquireLock(root, { owner: 'session-b', timeoutSeconds: -5 }), LockTimeout)
  })
})

describe('releaseLock', () => {
  test('releases only for the holder', async (t) => {
    const root = project(t)
    await acquireLock(root, { owner: 'session-a' })
    const refused = await releaseLock(root, { owner: 'session-b' })
    assert.equal(refused.released, false)
    assert.equal(refused.holder, 'session-a')
    assert.match(refused.reason, /only the holder can release it/)
    assert.ok(existsSync(lockFile(root)))

    const released = await releaseLock(root, { owner: 'session-a' })
    assert.equal(released.released, true)
    assert.equal(existsSync(lockFile(root)), false)
    const status = await lockStatus(root)
    assert.equal(status.held, false)
  })

  test('releasing a free lock is a no-op', async (t) => {
    const root = project(t)
    const result = await releaseLock(root, { owner: 'session-a' })
    assert.equal(result.released, false)
    assert.equal(result.holder, null)
    assert.equal(result.reason, 'no lock is held')
  })
})

describe('lockStatus', () => {
  test('reports a free project without creating anything', async (t) => {
    const root = project(t)
    const status = await lockStatus(root)
    assert.deepEqual(status, {
      held: false,
      holder: null,
      acquiredAt: null,
      reason: null,
      stale: false,
      path: lockFile(root),
    })
    assert.equal(existsSync(join(root, 'Library')), false)
  })

  test('treats an unparseable lock file as absent', async (t) => {
    const root = project(t)
    mkdirSync(join(root, 'Library', 'Locus'), { recursive: true })
    writeFileSync(lockFile(root), 'not json at all')
    const status = await lockStatus(root)
    assert.equal(status.held, false)
    // And the next acquirer simply replaces it.
    const result = await acquireLock(root, { owner: 'session-a', mode: 'try' })
    assert.equal(result.acquired, true)
  })
})