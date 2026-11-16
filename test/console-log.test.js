// Tests for the Editor.log fallback (src/console.js `readEditorLogEntries`).
//
// These run against a synthetic `<project>/Logs/Editor.log`, which is the
// project-local copy Unity leaves behind for builds and `-logFile` runs. The
// per-user path is only consulted when the project has no log of its own, so a
// temporary project keeps the real `~/.config/unity3d/Editor.log` out of the way.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { MAX_TAIL_BYTES, classifyLogLine, formatEditorLog, readEditorLogEntries } from '../src/console.js'

/** A project with whatever `Logs/Editor.log` content a test needs. */
function project(t, logText) {
  const root = mkdtempSync(join(tmpdir(), 'locus-editorlog-'))
  mkdirSync(join(root, 'Assets'), { recursive: true })
  mkdirSync(join(root, 'ProjectSettings'), { recursive: true })
  if (logText !== undefined) {
    mkdirSync(join(root, 'Logs'), { recursive: true })
    writeFileSync(join(root, 'Logs', 'Editor.log'), logText)
  }
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

const LOG = [
  'Mono path[0] = /opt/unity/Editor/Data/Managed/UnityEngine',
  'Refreshing native plugins compatible for Editor',
  '[2026-11-16 01:02:03] Assets/Scripts/Player.cs(12,9): error CS0103: The name `speeed` does not exist.',
  '[2026-11-16 01:02:04] Assets/Scripts/Enemy.cs(3,5): warning CS0414: The field `hp` is assigned but never used.',
  '[2026-11-16 01:02:05] Assets/Scripts/Player.cs(12,9): error CS0103: The name `speeed` does not exist.',
  '[2026-11-16 01:02:06] Script compilation error',
  '[2026-11-16 01:02:07] NullReferenceException: Object reference not set to an instance of an object',
  '[2026-11-16 01:02:08] Safe Mode: Only loading a subset of assemblies',
  'Unloading 12 unused Assets to reduce memory usage.',
  '',
].join('\n')

describe('readEditorLogEntries', () => {
  test('prefers the project log and returns classified, deduplicated entries', async (t) => {
    const root = project(t, LOG)
    const result = await readEditorLogEntries(root)
    assert.equal(result.source, 'Editor.log')
    assert.equal(result.path, join(root, 'Logs', 'Editor.log'))
    assert.equal(result.supported, true)
    assert.equal(result.matched, 6)
    // The duplicated CS0103 line is one entry with a count.
    const error = result.entries.find((entry) => entry.level === 'error' && /CS0103/.test(entry.message))
    assert.equal(error.count, 2)
    assert.equal(error.time, '2026-11-16 01:02:03')
    assert.ok(result.entries.some((entry) => entry.level === 'warn' && /CS0414/.test(entry.message)))
    // Import chatter is not a diagnostic.
    assert.ok(!result.entries.some((entry) => /Refreshing native plugins/.test(entry.message)))
    assert.ok(!result.entries.some((entry) => /Unloading 12 unused Assets/.test(entry.message)))
  })

  test('filters by level', async (t) => {
    const root = project(t, LOG)
    const onlyWarnings = await readEditorLogEntries(root, { levels: ['warn'] })
    assert.ok(onlyWarnings.entries.length > 0)
    assert.ok(onlyWarnings.entries.every((entry) => entry.level === 'warn'))
    const single = await readEditorLogEntries(root, { levels: 'error' })
    assert.ok(single.entries.every((entry) => entry.level === 'error'))
  })

  test('honours since and limit', async (t) => {
    const root = project(t, LOG)
    const recent = await readEditorLogEntries(root, { since: '2026-11-16 01:02:05' })
    assert.ok(recent.entries.every((entry) => entry.time >= '2026-11-16 01:02:05'), JSON.stringify(recent.entries.map((entry) => entry.time)))
    // Epoch milliseconds work too, and a far-future cutoff matches nothing.
    const future = await readEditorLogEntries(root, { since: Date.parse('2030-01-01T00:00:00Z') })
    assert.deepEqual(future.entries, [])

    const limited = await readEditorLogEntries(root, { limit: 2 })
    assert.equal(limited.entries.length, 2)
    assert.equal(limited.truncated, true)
    // The limit keeps the newest entries, not the oldest.
    assert.equal(limited.entries.at(-1).time, '2026-11-16 01:02:08')
  })

  test('reads only the tail of a large log and drops the partial first line', async (t) => {
    const filler = `${'x'.repeat(200)}\n`
    const head = `[2026-11-16 00:00:00] Assets/Old.cs(1,1): error CS1002: ; expected\n`
    const body = filler.repeat(Math.ceil(MAX_TAIL_BYTES / filler.length))
    const root = project(t, head + body + '[2026-11-16 09:00:00] Assets/New.cs(1,1): error CS9999: tail error\n')
    const result = await readEditorLogEntries(root)
    assert.ok(result.bytesRead <= MAX_TAIL_BYTES)
    assert.equal(result.matched, 1, 'only the tail entry is inside the window')
    assert.match(result.entries[0].message, /CS9999/)
  })

  test('reports unsupported, with the paths it tried, when there is no log', async (t) => {
    const root = project(t)
    const result = await readEditorLogEntries(root)
    assert.equal(result.supported, false)
    assert.equal(result.path, null)
    assert.deepEqual(result.entries, [])
    assert.match(result.reason, /No Editor\.log found/)
    assert.match(result.reason, /Logs[/\\]Editor\.log/)
    assert.match(formatEditorLog(result), /^\[source: Editor\.log\]\nunavailable: No Editor\.log found/)
  })

  test('renders entries with their source tag', async (t) => {
    const root = project(t, LOG)
    const text = formatEditorLog(await readEditorLogEntries(root))
    assert.match(text, /^\[source: Editor\.log\] .*Logs[/\\]Editor\.log\nUnity Console: \d+ entr/)
    assert.match(text, /^\[error\] \(x2\) 2026-11-16 01:02:03 Assets\/Scripts\/Player\.cs\(12,9\): error CS0103/m)
  })

  test('rejects an invalid level, limit or since', async (t) => {
    const root = project(t, LOG)
    await assert.rejects(() => readEditorLogEntries(root, { levels: ['trace'] }), /Invalid levels entry 'trace'/)
    await assert.rejects(() => readEditorLogEntries(root, { levels: [] }), /non-empty array/)
    await assert.rejects(() => readEditorLogEntries(root, { limit: 0 }), /limit must be an integer in 1\.\.200/)
    await assert.rejects(() => readEditorLogEntries(root, { limit: 201 }), /limit must be an integer in 1\.\.200/)
    await assert.rejects(() => readEditorLogEntries(root, { since: 'yesterday' }), /since must be an ISO timestamp/)
  })
})

describe('classifyLogLine', () => {
  test('follows Unity’s own wording', () => {
    assert.equal(classifyLogLine('Assets/P.cs(1,1): error CS0103: nope'), 'error')
    assert.equal(classifyLogLine('Tundra build failed (0.2 seconds)'), 'error')
    assert.equal(classifyLogLine('Script compilation failed because: nope'), 'error')
    assert.equal(classifyLogLine('Crash!!!'), 'error')
    assert.equal(classifyLogLine('InvalidOperationException: bad state'), 'error')
    assert.equal(classifyLogLine('Assets/P.cs(1,1): warning CS0414: unused'), 'warn')
    assert.equal(classifyLogLine('warning: something'), 'warn')
    assert.equal(classifyLogLine('[ScriptCompilation] recompiled'), 'info')
    assert.equal(classifyLogLine('[Locus] bridge attached'), 'info')
    assert.equal(classifyLogLine('Safe Mode: Only loading a subset of assemblies'), 'info')
    assert.equal(classifyLogLine('Refreshing native plugins'), null)
    assert.equal(classifyLogLine(''), null)
  })
})