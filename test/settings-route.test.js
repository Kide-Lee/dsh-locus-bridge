// The settings route, and the preview plane refusing while it is off.
//
// The route is the only way the settings page reaches the Host, and the only
// place the switch becomes a change in the running process, so both halves are
// exercised over real HTTP against a throwaway bridge home.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { registerAssetRoutes, ROUTE_PREFIX } from '../src/sidebar/routes.js'
import { HOME_ENV, readSettings, saveSettings, settingsPath } from '../src/settings.js'

/** One registered route table over a throwaway settings document. */
function fixture(t, { features = {}, preferences = {} } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'locus-settings-route-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const env = { [HOME_ENV]: home }
  if (Object.keys(features).length > 0 || Object.keys(preferences).length > 0) {
    saveSettings({ features, preferences }, env)
  }
  const handlers = []
  const applied = []
  registerAssetRoutes(
    {
      webServer: {
        register(route) {
          handlers.push(route)
          return () => {}
        },
      },
      effect: (fn) => fn(),
      // No Session, no editor: these tests only exercise the settings surface and
      // the guard that runs before any Unity call.
      get: (name) => (name === 'connection' ? { requestRejection: () => undefined } : undefined),
    },
    {
      env,
      onFeaturesChanged: (effective) => applied.push(effective),
    },
  )
  return { env, home, handlers, applied }
}

async function serve(handlers, run) {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const route = handlers.find((entry) => entry.path === path)
    if (!route) {
      res.writeHead(404)
      res.end()
      return
    }
    void route.handler(req, res)
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  try {
    return await run(`http://127.0.0.1:${server.address().port}${ROUTE_PREFIX}`)
  } finally {
    await new Promise((done) => server.close(done))
  }
}

test('GET reports the stored switches, the effective ones and the path', async (t) => {
  const { env, handlers } = fixture(t, { features: { csharp: false } })
  await serve(handlers, async (base) => {
    const response = await fetch(`${base}/settings`)
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.ok, true)
    assert.equal(payload.features.csharp, false)
    assert.equal(payload.features.unity, true)
    assert.equal(payload.effective.csharp, false)
    assert.equal(payload.preferences.frameCache, true)
    assert.equal(payload.locked.csharp, false)
    assert.equal(payload.path, settingsPath(env))
  })
})

test('POST merges one switch, persists it and notifies the Host', async (t) => {
  const { env, handlers, applied } = fixture(t)
  await serve(handlers, async (base) => {
    const response = await fetch(`${base}/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ features: { unity: false } }),
    })
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.features.unity, false)
    assert.equal(payload.features.csharp, true, 'untouched planes survive the merge')
    assert.equal(readSettings(env).features.unity, false, 'the write reached the document')
    assert.equal(applied.length, 1, 'the Host re-registers on this callback')
    assert.equal(applied[0].unity, false)
  })
})

test('a patch that is not a boolean switch is refused, not silently ignored', async (t) => {
  const { env, handlers, applied } = fixture(t)
  await serve(handlers, async (base) => {
    for (const body of [
      { features: { unity: 'off' } },
      { features: { nonsense: true } },
      { preferences: { nonsense: true } },
      { unknown: true },
      { features: [] },
    ]) {
      const response = await fetch(`${base}/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      assert.equal(response.status, 400, `${JSON.stringify(body)} must be a bad request`)
    }
    assert.equal(applied.length, 0, 'a refused write must not reach the Host')
    assert.equal(readSettings(env).features.unity, true, 'and must not touch the document')
  })
})

test('a method the route does not serve is a 405, not a read', async (t) => {
  const { handlers } = fixture(t)
  await serve(handlers, async (base) => {
    const response = await fetch(`${base}/settings`, { method: 'DELETE' })
    assert.equal(response.status, 405)
  })
})

test('the asset routes refuse with feature_disabled while the preview is off', async (t) => {
  const { handlers } = fixture(t, { features: { preview: false } })
  await serve(handlers, async (base) => {
    // Every Unity-backed route shares the guard; the two most reachable ones
    // stand for the group.
    for (const [path, method] of [
      [`/status?sessionId=s`, 'GET'],
      [`/asset?sessionId=s&path=Assets%2Fx.prefab`, 'GET'],
      [`/frame?sessionId=s&path=Assets%2Fx.prefab`, 'GET'],
    ]) {
      const response = await fetch(`${base}${path}`, { method })
      const payload = await response.json()
      assert.equal(response.status, 409, path)
      assert.equal(payload.error.code, 'feature_disabled', path)
    }
    // The settings surface itself stays reachable: it is how the switch comes
    // back on.
    const settings = await fetch(`${base}/settings`)
    assert.equal(settings.status, 200)
  })
})

test('the bundled model viewer is still served with the preview off', async (t) => {
  // It is a static asset, not a Unity read: refusing it would break the
  // settings page's own fetch path for no gain.
  const { handlers } = fixture(t, { features: { preview: false } })
  await serve(handlers, async (base) => {
    const response = await fetch(`${base}/model-viewer.js`, { method: 'GET' })
    assert.notEqual(response.status, 409)
  })
})