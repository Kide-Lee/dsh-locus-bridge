// The settings route, and the preview plane refusing while it is off.
//
// The route is the only way the settings page reaches the Host, and the only
// place the switch becomes a change in the running process, so both halves are
// exercised over real HTTP against a throwaway bridge home.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { registerAssetRoutes, ROUTE_PREFIX } from '../src/sidebar/routes.js'
import { HOME_ENV, readSettings, saveSettings, settingsPath } from '../src/settings.js'
import { skillSourceHash } from '../src/skills/activation.js'
import { UNITY_SKILLS } from '../src/skills/catalog.js'

/** One registered route table over a throwaway settings document. */
function fixture(t, { features = {}, preferences = {}, workspaces = [], activateSkills = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'locus-settings-route-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const env = { [HOME_ENV]: home }
  if (Object.keys(features).length > 0 || Object.keys(preferences).length > 0) {
    saveSettings({ features, preferences }, env)
  }
  const handlers = []
  const applied = []
  const activations = []
  const registry = {
    list: () => workspaces.map((workspace, index) => ({ id: `w${index}`, title: `W${index}`, ...workspace })),
  }
  const activate = activateSkills ?? (async (projectRoot) => {
    activations.push(projectRoot)
    return {
      generation: 'test-generation',
      packages: UNITY_SKILLS.map((skill) => ({
        id: skill.id,
        sourceHash: skillSourceHash(skill),
        state: 'compiled',
        assemblyId: `asm-${skill.id}`,
      })),
    }
  })
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
      // the guard that runs before any Unity call. The workspace registry is the
      // one service the settings page genuinely needs.
      get: (name) => {
        if (name === 'connection') return { requestRejection: () => undefined }
        if (name === 'workspaceRegistry') return registry
        return undefined
      },
    },
    {
      env,
      onFeaturesChanged: (effective) => applied.push(effective),
      activateSkills: activate,
    },
  )
  return { env, home, handlers, applied, activations }
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

test('GET /workspaces lists the DSH workspaces and the stored selection', async (t) => {
  const workspace = join(tmpdir(), 'locus-ws-a')
  const { handlers } = fixture(t, {
    preferences: { workspacePath: workspace },
    workspaces: [{ path: workspace }],
  })
  await serve(handlers, async (base) => {
    const response = await fetch(`${base}/workspaces`)
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(payload.workspaces.map((entry) => entry.path), [workspace])
    assert.equal(payload.selected, workspace)
  })
})

test('POST /settings stores the workspace path as a string preference', async (t) => {
  const { env, handlers } = fixture(t)
  await serve(handlers, async (base) => {
    const response = await fetch(`${base}/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preferences: { workspacePath: 'E:/ws' } }),
    })
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.preferences.workspacePath, 'E:/ws')
    assert.equal(readSettings(env).preferences.workspacePath, 'E:/ws')
  })
})

test('a workspace path of the wrong type is refused like any other bad preference', async (t) => {
  const { handlers, applied } = fixture(t)
  await serve(handlers, async (base) => {
    for (const body of [{ preferences: { workspacePath: 42 } }, { preferences: { workspacePath: null } }]) {
      const response = await fetch(`${base}/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      assert.equal(response.status, 400, JSON.stringify(body))
    }
    assert.equal(applied.length, 0, 'a refused write must not reach the Host')
  })
})

test('the projects scan follows the stored workspace and never a sibling', async (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'locus-ws-scan-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const workspace = join(parent, 'workspace')
  const sibling = join(parent, 'sibling')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(sibling, 'Assets'), { recursive: true })
  mkdirSync(join(sibling, 'ProjectSettings'), { recursive: true })

  const { handlers } = fixture(t, { preferences: { workspacePath: workspace } })
  await serve(handlers, async (base) => {
    const response = await fetch(`${base}/projects`)
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(payload.roots, [workspace], 'only the selected workspace is scanned')
    assert.deepEqual(payload.projects, [], 'the sibling project lies outside the workspace')
  })
})

test('POST /skills/install writes the five domain skills into the workspace', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'locus-ws-skills-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  // DSH resolves a project root by its nearest `.git`; the workspace itself is
  // the project here, so the skills land directly under it.
  mkdirSync(join(workspace, '.git'), { recursive: true })
  const { handlers } = fixture(t, { workspaces: [{ path: workspace }] })
  await serve(handlers, async (base) => {
    const first = await fetch(`${base}/skills/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath: workspace }),
    })
    const payload = await first.json()
    assert.equal(first.status, 200)
    assert.deepEqual(payload.written, ['debugger', 'profiler', 'graphics-debugger', 'ui-toolkit', 'view'])
    assert.equal(payload.skillsDir, join(workspace, '.dsh', 'skills'))
    const text = readFileSync(join(workspace, '.dsh', 'skills', 'debugger', 'SKILL.md'), 'utf8')
    assert.match(text, /^---\nname: debugger\n/)
    assert.match(text, /portedFrom: locus/)

    const second = await fetch(`${base}/skills/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath: workspace }),
    })
    const again = await second.json()
    assert.deepEqual(again.written, [], 'a second run rewrites nothing')
    assert.equal(again.unchanged.length, 5)
  })
})

test('a skills install refuses a directory the registry does not own', async (t) => {
  const outside = mkdtempSync(join(tmpdir(), 'locus-ws-outside-'))
  t.after(() => rmSync(outside, { recursive: true, force: true }))
  const { handlers } = fixture(t, { workspaces: [{ path: outside }] })
  await serve(handlers, async (base) => {
    const response = await fetch(`${base}/skills/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath: join(outside, 'elsewhere') }),
    })
    assert.equal(response.status, 400)
  })
})

test('GET /skills/state lists the executable packages and their activation state', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'locus-ws-state-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const project = join(workspace, 'game')
  mkdirSync(join(project, 'Assets'), { recursive: true })
  mkdirSync(join(project, 'ProjectSettings'), { recursive: true })
  const { handlers, activations } = fixture(t, { workspaces: [{ path: workspace }] })
  await serve(handlers, async (base) => {
    const before = await fetch(`${base}/skills/state?workspacePath=${encodeURIComponent(workspace)}`)
    const beforePayload = await before.json()
    assert.equal(before.status, 200)
    assert.equal(beforePayload.projectRoot, project)
    assert.deepEqual(
      beforePayload.packages.filter((entry) => entry.executable).map((entry) => entry.id),
      ['graphics-debugger', 'ui-toolkit'],
    )
    assert.deepEqual(
      beforePayload.states.map((entry) => entry.state),
      ['inactive', 'inactive'],
      'nothing activated yet',
    )

    const activation = await fetch(`${base}/skills/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath: workspace }),
    })
    const activationPayload = await activation.json()
    assert.equal(activation.status, 200)
    assert.deepEqual(activations, [project], 'compilation targets the workspace project')
    assert.deepEqual(activationPayload.packages.map((entry) => entry.state), ['compiled', 'compiled'])

    const after = await fetch(`${base}/skills/state?workspacePath=${encodeURIComponent(workspace)}`)
    const afterPayload = await after.json()
    assert.deepEqual(afterPayload.states.map((entry) => entry.state), ['active', 'active'])
    assert.equal(afterPayload.states[0].assemblyId, 'asm-graphics-debugger')
  })
})

test('activation reports a workspace without a Unity project instead of failing', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'locus-ws-empty-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  mkdirSync(join(workspace, 'docs'), { recursive: true })
  const { handlers, activations } = fixture(t, { workspaces: [{ path: workspace }] })
  await serve(handlers, async (base) => {
    const response = await fetch(`${base}/skills/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath: workspace }),
    })
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.projectRoot, null)
    assert.deepEqual(payload.packages, [])
    assert.match(payload.message, /No Unity project/)
    assert.deepEqual(activations, [], 'nothing is compiled without a project')
  })
})

test('an explicit projectRoot must be a Unity project inside the workspace', async (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'locus-ws-bound-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const workspace = join(parent, 'ws')
  const outside = join(parent, 'outside')
  mkdirSync(join(workspace, 'game', 'Assets'), { recursive: true })
  mkdirSync(join(workspace, 'game', 'ProjectSettings'), { recursive: true })
  mkdirSync(join(outside, 'Assets'), { recursive: true })
  mkdirSync(join(outside, 'ProjectSettings'), { recursive: true })
  const { handlers } = fixture(t, { workspaces: [{ path: workspace }] })
  await serve(handlers, async (base) => {
    const response = await fetch(`${base}/skills/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath: workspace, projectRoot: outside }),
    })
    assert.equal(response.status, 400)
  })
})

test('one skill can be downloaded on its own, and state reports what is on disk', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'locus-ws-single-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const { handlers } = fixture(t, { workspaces: [{ path: workspace }] })
  await serve(handlers, async (base) => {
    const response = await fetch(`${base}/skills/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath: workspace, skillId: 'ui-toolkit' }),
    })
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.deepEqual(payload.written, ['ui-toolkit'])

    const state = await fetch(`${base}/skills/state?workspacePath=${encodeURIComponent(workspace)}`)
    const statePayload = await state.json()
    const downloaded = statePayload.packages.filter((entry) => entry.downloaded).map((entry) => entry.id)
    assert.deepEqual(downloaded, ['ui-toolkit'], 'only the written skill reads as downloaded')
    assert.equal(statePayload.skillsDir, join(workspace, '.dsh', 'skills'))
  })
})

test('an unknown skill id is a bad request, not a silent no-op', async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), 'locus-ws-unknown-'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
  const { handlers } = fixture(t, { workspaces: [{ path: workspace }] })
  await serve(handlers, async (base) => {
    const response = await fetch(`${base}/skills/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspacePath: workspace, skillId: 'no-such-skill' }),
    })
    assert.equal(response.status, 400)
  })
})

test('skills state still lists the packages without a workspace', async (t) => {
  const { handlers } = fixture(t)
  await serve(handlers, async (base) => {
    const response = await fetch(`${base}/skills/state`)
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.workspace, '')
    assert.equal(payload.skillsDir, null)
    assert.equal(payload.packages.length, 5)
    assert.equal(payload.packages.every((entry) => entry.downloaded === false), true)
    assert.deepEqual(payload.states, [])
  })
})

test('POST /settings stores the Unity project choice as a string preference', async (t) => {
  const { env, handlers } = fixture(t)
  await serve(handlers, async (base) => {
    const response = await fetch(`${base}/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ preferences: { unityProject: 'E:/ws/Game' } }),
    })
    const payload = await response.json()
    assert.equal(response.status, 200)
    assert.equal(payload.preferences.unityProject, 'E:/ws/Game')
    assert.equal(readSettings(env).preferences.unityProject, 'E:/ws/Game')
  })
})