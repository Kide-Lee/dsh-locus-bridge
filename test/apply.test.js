// What one settings save does to a mounted plugin.
//
// The route, the change notification and the tool registry are three separate
// pieces, and the interesting bug is the one where a single save re-registers the
// catalog twice (once from the notification, once from the route's own callback).
// This drives the real `apply()` against a recording registry so both the
// count and the resulting catalog are observable.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { apply } from '../src/index.js'
import { HOME_ENV, readSettings, saveSettings } from '../src/settings.js'

/**
 * A context shaped like the one the Loader hands `apply()`.
 *
 * `tools.register` returns a disposer that really removes the entry, so a
 * re-registration cycle is visible exactly as it is in the Host: a tool that
 * disappears from `live` was disposed, not merely re-added.
 */
function mountContext({ services = {} } = {}) {
  const live = new Map()
  const registrations = []
  const ctx = {
    tools: {
      register(definition) {
        registrations.push(definition.name)
        live.set(definition.name, definition)
        return () => {
          live.delete(definition.name)
        }
      },
    },
    workingDirectory: { get: () => undefined },
    get: () => undefined,
    on: () => {},
    effect(fn) {
      fn()
    },
    // The real Loader resolves an injected dependency when it becomes available
    // and hands the callback a context carrying it. The stub does the same only
    // for the services a test supplies, so the `webServer`/`connection` branch
    // still never activates and the `skills` branch can be driven on purpose.
    inject(deps, fn) {
      if (typeof fn !== 'function') return () => {}
      if (!deps.every((dep) => services[dep] !== undefined)) return () => {}
      const result = fn({ ...ctx, ...services })
      return typeof result === 'function' ? result : () => {}
    },
  }
  return { ctx, live, registrations }
}

/** One throwaway bridge home so the test never reads the user's real switches. */
function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'locus-apply-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('a mounted plugin registers the catalog once', (t) => {
  const dir = home(t)
  const previous = process.env[HOME_ENV]
  process.env[HOME_ENV] = dir
  t.after(() => {
    if (previous === undefined) delete process.env[HOME_ENV]
    else process.env[HOME_ENV] = previous
  })
  const { ctx, live, registrations } = mountContext()
  apply(ctx)
  assert.ok(live.has('unity_status'))
  assert.ok(live.has('code_diagnostics'))
  // Each name is registered exactly once: a duplicate would show up here.
  assert.equal(new Set(registrations).size, registrations.length)
})

test('one save re-registers the catalog once and applies the switch', (t) => {
  const dir = home(t)
  const previous = process.env[HOME_ENV]
  process.env[HOME_ENV] = dir
  t.after(() => {
    if (previous === undefined) delete process.env[HOME_ENV]
    else process.env[HOME_ENV] = previous
  })
  saveSettings({ features: { unity: true, csharp: true } })
  const { ctx, live, registrations } = mountContext()
  apply(ctx)
  const before = registrations.length

  saveSettings({ features: { csharp: false } })

  const added = registrations.length - before
  // The whole catalog is registered once more, but no plane is duplicated: the
  // count equals the number of planes still on, not twice that.
  const expected = [...live.keys()].length
  assert.equal(added, expected, `one save must re-register the catalog exactly once (added ${added})`)
  assert.equal(
    [...live.keys()].filter((name) => name.startsWith('code_')).length,
    0,
    'the C# plane is gone from the registry',
  )
  assert.ok(live.has('unity_status'), 'the Unity plane survived')
})

test('switching a plane back on restores its tools', (t) => {
  const dir = home(t)
  const previous = process.env[HOME_ENV]
  process.env[HOME_ENV] = dir
  t.after(() => {
    if (previous === undefined) delete process.env[HOME_ENV]
    else process.env[HOME_ENV] = previous
  })
  saveSettings({ features: { unity: false } })
  const { ctx, live } = mountContext()
  apply(ctx)
  assert.equal(live.has('unity_status'), false)
  assert.ok(live.has('code_symbol_search'), 'the other plane is independent')

  saveSettings({ features: { unity: true } })
  assert.ok(live.has('unity_status'), 're-enabling re-registers the tools')
  assert.equal(readSettings().features.unity, true)
})

test('the skills switch registers one provider and disposes it when turned off', (t) => {
  const dir = home(t)
  const previous = process.env[HOME_ENV]
  process.env[HOME_ENV] = dir
  t.after(() => {
    if (previous === undefined) delete process.env[HOME_ENV]
    else process.env[HOME_ENV] = previous
  })
  const providers = []
  const skills = {
    registerProvider(create) {
      const provider = create({ signal: new AbortController().signal, invalidate: () => {} })
      providers.push(provider)
      return () => {
        const index = providers.lastIndexOf(provider)
        if (index >= 0) providers.splice(index, 1)
      }
    },
  }
  const { ctx } = mountContext({ services: { skills } })
  apply(ctx)
  assert.equal(providers.length, 0, 'the domain skills are off by default')

  saveSettings({ skills: { debugger: true } })
  assert.equal(providers.length, 1, 'switching a skill on registers the provider')
  assert.equal(providers[0].name, 'dsh-locus-bridge')

  // Another skill on must replace the provider, never stack a second one.
  saveSettings({ skills: { profiler: true } })
  assert.equal(providers.length, 1, 'a second switch still leaves one provider')

  saveSettings({ skills: { debugger: false, profiler: false } })
  assert.equal(providers.length, 0, 'switching the last skill off disposes the provider')
})