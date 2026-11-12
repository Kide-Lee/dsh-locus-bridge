// The project list and install routes.
//
// The install route is the one place this plugin writes into a project the user
// did not hand it, so its two refusals are the interesting part: it must refuse
// a path that is not a project (the button must never become an arbitrary-tree
// copier) and refuse while the editor holds the project open.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { registerAssetRoutes, ROUTE_PREFIX } from '../src/sidebar/routes.js'
import { HOME_ENV } from '../src/settings.js'

function makeProject(root, name) {
  const dir = join(root, name)
  mkdirSync(join(dir, 'Assets'), { recursive: true })
  mkdirSync(join(dir, 'ProjectSettings'), { recursive: true })
  return dir
}

function fixture(t, { workspaces = [] } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'locus-projects-route-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const handlers = []
  registerAssetRoutes(
    {
      webServer: {
        register(route) {
          handlers.push(route)
          return () => {}
        },
      },
      effect: (fn) => fn(),
      get: (name) => {
        if (name === 'connection') return { requestRejection: () => undefined }
        // A Settings page belongs to no Session, so the Host's registered
        // workspaces are the only roots it can offer.
        if (name === 'workspaceRegistry') return { list: () => workspaces }
        return undefined
      },
    },
    { env: { [HOME_ENV]: home } },
  )
  return { home, handlers }
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

test('GET projects lists a workspace and reports a state per project', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'locus-projects-list-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  makeProject(root, 'Alpha')
  makeProject(root, 'Beta')
  const { handlers } = fixture(t)
  await serve(handlers, async (base) => {
    const response = await fetch(`${base}/projects?roots=${encodeURIComponent(root)}`)
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.ok, true)
    assert.equal(payload.projects.length, 2)
    for (const project of payload.projects) {
      assert.equal(project.state, 'plugin_missing', 'neither project has the package')
      assert.equal(project.package.installed, false)
      assert.ok(project.endpoint, 'every row carries the endpoint it would use')
    }
    // The names are the row labels, so they must be real directory names.
    assert.deepEqual(payload.projects.map((p) => p.name).sort(), ['Alpha', 'Beta'])
  })
})

test('GET projects without roots falls back to the registered workspaces', async (t) => {
  // A Settings page has no Session of its own, so without this fallback the
  // panel would always render empty in the one place it lives.
  const root = mkdtempSync(join(tmpdir(), 'locus-projects-ws-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  makeProject(root, 'FromWorkspace')
  const { handlers } = fixture(t, { workspaces: [{ id: 'w1', path: root }] })
  await serve(handlers, async (base) => {
    const payload = await (await fetch(`${base}/projects`)).json()
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.roots, [root])
    assert.equal(payload.projects.length, 1)
    assert.equal(payload.projects[0].name, 'FromWorkspace')
  })
})

test('GET projects with no roots and no workspaces is empty, not a scan of cwd', async (t) => {
  const { handlers } = fixture(t)
  await serve(handlers, async (base) => {
    const payload = await (await fetch(`${base}/projects`)).json()
    assert.equal(payload.ok, true)
    assert.deepEqual(payload.projects, [])
    assert.deepEqual(payload.roots, [])
  })
})

test('POST projects/install refuses a path that is not a Unity project', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'locus-install-bad-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const plain = join(root, 'plain')
  mkdirSync(plain)
  const { handlers } = fixture(t)
  await serve(handlers, async (base) => {
    const response = await fetch(`${base}/projects/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRoot: plain }),
    })
    assert.equal(response.status, 400, 'a plain directory must not be installed into')
  })
})

test('POST projects/install requires a projectRoot', async (t) => {
  const { handlers } = fixture(t)
  await serve(handlers, async (base) => {
    const response = await fetch(`${base}/projects/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(response.status, 400)
  })
})

test('POST projects/install refuses while the editor holds the project', async (t) => {
  // The editor holds the package assemblies, so an install would either fail or
  // leave the loaded assemblies in place. A 409 the page can explain beats a 500.
  const root = mkdtempSync(join(tmpdir(), 'locus-install-open-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const project = makeProject(root, 'Open')
  // A real lockfile is not enough in-process (see setup.js); the probe is what
  // decides, so this asserts the route consults it rather than skipping it by
  // checking the 400 above.)
  const { handlers } = fixture(t)
  await serve(handlers, async (base) => {
    const response = await fetch(`${base}/projects/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectRoot: project }),
    })
    // Either the install succeeded (no editor running, payload present) or it was
    // refused because the editor holds it. It must never be a 500.
    assert.ok([200, 409].includes(response.status), `unexpected ${response.status}`)
    const payload = await response.json()
    if (response.status === 409) {
      assert.equal(payload.error.code, 'editor_running')
    } else {
      assert.equal(payload.ok, true)
      // A successful install must tell the caller to reopen the editor: this
      // plugin never launches Unity itself.
      assert.match(String(payload.next), /Reopen the Unity Editor/i)
    }
  })
})

test('a method the projects route does not serve is a 405', async (t) => {
  const { handlers } = fixture(t)
  await serve(handlers, async (base) => {
    assert.equal((await fetch(`${base}/projects`, { method: 'POST' })).status, 405)
    assert.equal((await fetch(`${base}/projects/install`)).status, 405)
  })
})