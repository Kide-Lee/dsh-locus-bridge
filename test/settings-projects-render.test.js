import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { SETTINGS_SECTION_ID } from '../src/client/plugin.js'

/**
 * A React small enough to fit in a test and real enough to run the page.
 *
 * `test/sidebar-client.test.js` renders with stubs whose `useState` never
 * re-renders and whose `useEffect` never runs, which is enough to check what a
 * component *builds* — but not enough to check a page that fetches on mount and
 * renders from the answer. The settings page is exactly that shape, and its
 * projects panel is a *child* component, so a renderer that does not call
 * function components reports the page and silently omits the panel.
 *
 * Hook state is keyed by the component's position (`root.c.2`), which is what
 * React effectively uses for a list-free tree: the panel never reorders
 * without re-keying, so the keys stay stable across the rounds a load takes.
 * Effects fire once per position, since there are no dependency arrays here.
 */
function createRuntime() {
  const state = new Map()
  const refs = new Map()
  const effects = new Map()
  const fired = new Set()
  let cursor = 0
  let effectCursor = 0
  let path = 'root'

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => {
      if (!refs.has(path)) refs.set(path, { current: value })
      return refs.get(path)
    },
    useEffect: (fn) => {
      const list = effects.get(path) ?? []
      list[effectCursor++] = fn
      effects.set(path, list)
    },
    useState: (initial) => {
      const slots = state.get(path) ?? []
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      state.set(path, slots)
      return [
        slots[index],
        (next) => {
          slots[index] = typeof next === 'function' ? next(slots[index]) : next
        },
      ]
    },
  }

  function callComponent(component, props, at) {
    cursor = 0
    effectCursor = 0
    path = at
    return component(props)
  }

  /** Run each pending effect once; returns how many ran. */
  async function flushEffects() {
    let ran = 0
    for (const [at, list] of [...effects]) {
      effects.delete(at)
      if (fired.has(at)) continue
      fired.add(at)
      for (const effect of list) {
        if (typeof effect !== 'function') continue
        const previous = path
        path = at
        effect()
        path = previous
        ran += 1
      }
    }
    return ran
  }

  /** Render to text, invoking every function component on the way. */
  function render(node, at = 'root', depth = 0) {
    if (node === null || node === undefined || node === false || node === true) return ''
    if (depth > 40) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map((child, index) => render(child, `${at}.${index}`, depth + 1)).join(' ')
    if (typeof node === 'function') return ''
    if (typeof node.type === 'function') {
      const rendered = callComponent(node.type, node.props, at)
      return render(rendered, `${at}.c`, depth + 1)
    }
    const props = node.props ?? {}
    const own = [props.className, props['data-locus-project']].filter(Boolean).join(' ')
    const children = (node.children ?? []).map((child, index) => render(child, `${at}.${index}`, depth + 1)).join(' ')
    return `${own} ${children}`.replace(/\s+/g, ' ').trim()
  }

  /** Every element in the tree, so a test can press a button it found. */
  function elements(node, at = 'root', depth = 0, out = []) {
    if (!node || typeof node !== 'object' || depth > 40) return out
    if (Array.isArray(node)) {
      node.forEach((child, index) => elements(child, `${at}.${index}`, depth + 1, out))
      return out
    }
    if (typeof node.type === 'function') {
      return elements(callComponent(node.type, node.props, at), `${at}.c`, depth + 1, out)
    }
    out.push(node)
    ;(node.children ?? []).forEach((child, index) => elements(child, `${at}.${index}`, depth + 1, out))
    return out
  }

  return { React, flushEffects, render, elements }
}

/**
 * Mount the settings page against a stubbed Host.
 *
 * `answers` maps a route fragment to the JSON the Host would return (or to a
 * `{status, error}` object for a refusal), so a test says what the Host is
 * doing instead of asserting against a hand-built payload in the component.
 *
 * The stubs replace process-global state (`fetch`, `document`, `window`), so
 * every one of them is restored with `t.after`: the suite also runs with
 * `--test-isolation=none`, where a leaked `fetch` would answer the *other*
 * cases' requests with this file's routes.
 */
async function mountSettings(t, answers) {
  const previous = { fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window }
  t.after(() => {
    globalThis.fetch = previous.fetch
    if (previous.document === undefined) delete globalThis.document
    else globalThis.document = previous.document
    if (previous.window === undefined) delete globalThis.window
    else globalThis.window = previous.window
  })

  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const registrations = []
  const document = {
    documentElement: { dataset: {} },
    head: { querySelector: () => null, appendChild() {} },
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    baseURI: 'http://127.0.0.1:3080/',
    hidden: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) }, addEventListener() {}, removeEventListener() {} }
  new Function('window', 'document', source)(window, document)

  const requests = []
  globalThis.fetch = async (url, init) => {
    const text = String(url)
    const method = init?.method ?? 'GET'
    requests.push({ url: text, method, body: init?.body })
    const key = Object.keys(answers).find((fragment) => text.includes(fragment))
    if (key === undefined) throw new Error(`unexpected request: ${method} ${text}`)
    const answer = typeof answers[key] === 'function' ? answers[key]({ url: text, method, body: init?.body }) : answers[key]
    if (answer?.status && answer.status >= 400) {
      return { ok: false, status: answer.status, json: async () => ({ ok: false, error: answer.error }) }
    }
    return { ok: true, status: 200, json: async () => answer }
  }

  const runtime = createRuntime()
  const bodies = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on: () => {},
    get: () => {},
    sidebarRightTabs: { register: () => () => {} },
    slots: {
      inject(_name, fn) {
        fn()
        return () => {}
      },
      register(definition, component) {
        bodies.push({ definition, component })
        return () => {}
      },
    },
  }
  const exports = registrations[0].factory((specifier) => {
    if (specifier === 'react') return runtime.React
    throw new Error(`unexpected module request: ${specifier}`)
  })
  exports.apply(ctx)

  const section = bodies.find((entry) => entry.definition.name === 'settings.section')
  assert.ok(section, 'the settings section registers')
  assert.equal(section.definition.id, SETTINGS_SECTION_ID)

  // Mounted as an element, never by calling the component directly: `render` is
  // what resets the hook cursors per instance, and a direct call would leave
  // the cursor inside the previous pass (the page would stay on "loading").
  const root = { type: section.component, props: { roots: ['E:/proj'], sessionId: 's1' }, children: [] }

  const settle = async (rounds = 10) => {
    let text = ''
    for (let round = 0; round < rounds; round += 1) {
      const next = runtime.render(root, 'root')
      const ran = await runtime.flushEffects()
      await new Promise((done) => setTimeout(done, 5))
      if (round > 1 && next === text && ran === 0) return next
      text = next
    }
    return text
  }

  return { runtime, root, settle, requests, section, document }
}

const SETTINGS = {
  ok: true,
  features: { unity: true, csharp: true, preview: true },
  effective: { unity: true, csharp: true, preview: true },
  preferences: { frameCache: true },
  locked: { csharp: false },
  path: 'C:/tmp/settings.json',
}

const PROJECTS = {
  ok: true,
  roots: ['E:/proj'],
  projects: [
    {
      projectRoot: 'E:/proj/Live',
      name: 'Live',
      state: 'connected',
      editorRunning: true,
      markerPresent: true,
      package: { installed: true, version: '0.1.0' },
      canInstall: false,
      payloadAvailable: true,
      blockers: [],
    },
    {
      projectRoot: 'E:/proj/Open',
      name: 'Open',
      state: 'not_connected',
      editorRunning: true,
      markerPresent: true,
      package: { installed: true },
      canInstall: false,
      payloadAvailable: true,
      blockers: [],
    },
    {
      projectRoot: 'E:/proj/Bare',
      name: 'Bare',
      state: 'plugin_missing',
      editorRunning: false,
      markerPresent: false,
      package: { installed: false },
      canInstall: true,
      payloadAvailable: true,
      blockers: ['package_missing'],
    },
  ],
}

test('the settings page renders its Unity projects panel with all three states', async (t) => {
  // The panel is a child component rendered from an async scan, so this is the
  // test that a page reaching the user actually lists projects: a renderer that
  // skipped function components would report the page and no rows at all.
  const page = await mountSettings(t, { '/projects': PROJECTS, settings: SETTINGS })
  const text = await page.settle()

  assert.match(text, /locus-settings-root/, 'the page mounts')
  assert.match(text, /locus-projects/, 'the projects panel renders')
  assert.equal((text.match(/locus-project-row/g) ?? []).length, 3, 'one row per project')
  // One badge per state, and the state is what the badge says.
  assert.match(text, /locus-project-badge is-connected/)
  assert.match(text, /locus-project-badge is-offline/)
  assert.match(text, /locus-project-badge is-missing/)
  // Every row prints its own project.
  for (const project of PROJECTS.projects) assert.ok(text.includes(project.projectRoot), `${project.projectRoot} is listed`)
  // The install button exists for the missing package and only there: the other
  // two rows must not offer to reinstall a working bridge.
  assert.equal((text.match(/安装插件/g) ?? []).length, 1, 'exactly one install button, on the plugin_missing row')
  assert.match(text, /locus-settings-path/, 'the storage path footer renders')
  // The scan asked the Host once, and it asked the projects route (not a guess
  // at the filesystem from the page).
  assert.equal(page.requests.filter((entry) => entry.url.includes('/projects')).length, 1)
  assert.ok(page.requests.every((entry) => entry.url.includes('/locus/api/')), 'every request goes through the plugin routes')
})

test('the install button posts the project to the Host and reports what came back', async (t) => {
  const answers = {
    '/projects/install': {
      ok: true,
      projectRoot: 'E:/proj/Bare',
      installed: true,
      marker: true,
      next: 'Reopen the Unity Editor: the bridge starts on launch once the marker is present.',
    },
    '/projects': PROJECTS,
    settings: SETTINGS,
  }
  const page = await mountSettings(t, answers)
  await page.settle()

  // Press the button the page drew, rather than calling a handler the test
  // would have to know the name of.
  const button = page
    .runtime
    .elements(page.root)
    .find((element) => element.type === 'button' && /安装插件/.test((element.children ?? []).join(' ')))
  assert.ok(button, 'the install button is in the rendered tree')
  button.props.onClick()
  const text = await page.settle()

  const install = page.requests.find((entry) => entry.url.includes('/projects/install'))
  assert.ok(install, 'clicking install posts to the Host')
  assert.equal(install.method, 'POST')
  assert.deepEqual(JSON.parse(install.body), { projectRoot: 'E:/proj/Bare' })
  // The Host's own sentence wins over the page's generic one: it names the next
  // action, which the page cannot infer.
  assert.match(text, /Reopen the Unity Editor/)
  // The panel rescans after an install, so the badge reflects the new state.
  assert.equal(page.requests.filter((entry) => entry.url.includes('/projects') && entry.method === 'GET').length, 2)
})

test('a refused install explains itself instead of looking like a broken button', async (t) => {
  // `editor_running` is the case the Host refuses on purpose: the editor holds
  // the package assemblies. The page must say that, not print a status code.
  const page = await mountSettings(t, {
    '/projects/install': {
      status: 409,
      error: { code: 'editor_running', message: 'The Unity Editor has this project open and holds the package assemblies.' },
    },
    '/projects': PROJECTS,
    settings: SETTINGS,
  })
  await page.settle()

  const button = page
    .runtime
    .elements(page.root)
    .find((element) => element.type === 'button' && /安装插件/.test((element.children ?? []).join(' ')))
  assert.ok(button)
  button.props.onClick()
  const text = await page.settle()

  assert.match(text, /locus-project-notice is-error/)
  assert.match(text, /先关闭编辑器/)
  assert.doesNotMatch(text, /409/, 'a status code is not an explanation')
})

test('a failed project scan is reported, and the switches still work', async (t) => {
  // The switches and the panel load independently: a projects failure must not
  // blank the page, or a user whose workspace is unusual loses the switches too.
  const page = await mountSettings(t, {
    '/projects': { status: 500, error: { code: 'unity_error', message: 'the project scan blew up' } },
    settings: SETTINGS,
  })
  const text = await page.settle()

  assert.match(text, /locus-settings-root/)
  assert.match(text, /locus-settings-switch/, 'the switches still render')
  assert.match(text, /the project scan blew up/, 'the scan failure is shown')
  assert.doesNotMatch(text, /\[!/, 'nothing threw')
})


