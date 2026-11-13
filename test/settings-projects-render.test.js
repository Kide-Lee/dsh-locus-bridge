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
 * child panels are components, so a renderer that does not call function
 * components reports the page and silently omits them.
 *
 * Hook state is keyed by the component's position (`root.c.2`), which is what
 * React effectively uses for a list-free tree: the panels never reorder without
 * re-keying, so the keys stay stable across the rounds a load takes. Effects
 * fire once per position, since there are no dependency arrays here.
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

  const settle = async (rounds = 12) => {
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

  const buttons = () => runtime.elements(root).filter((element) => element.type === 'button')
  const buttonWithText = (text) => buttons().find((element) => (element.children ?? []).join(' ').includes(text))
  const triggerById = (id) => runtime.elements(root).find((element) => element.props?.id === id)

  return { runtime, root, settle, requests, section, document, buttons, buttonWithText, triggerById }
}

const SETTINGS = {
  ok: true,
  features: { unity: true, csharp: true, preview: true },
  effective: { unity: true, csharp: true, preview: true },
  preferences: { frameCache: true, workspacePath: 'E:/proj', unityProject: 'E:/proj/Game' },
  locked: { csharp: false },
  path: 'C:/tmp/settings.json',
}

const WORKSPACES = {
  ok: true,
  workspaces: [{ id: 'w1', path: 'E:/proj', title: 'Proj' }],
  selected: 'E:/proj',
}

const PROJECTS = {
  ok: true,
  roots: ['E:/proj'],
  projects: [
    {
      projectRoot: 'E:/proj/Game',
      name: 'Game',
      state: 'connected',
      editorRunning: true,
      markerPresent: true,
      package: { installed: true, version: '0.9.3', missingAssemblies: [] },
      canInstall: false,
      payloadAvailable: true,
      blockers: [],
    },
    {
      projectRoot: 'E:/proj/Other',
      name: 'Other',
      state: 'plugin_missing',
      editorRunning: false,
      markerPresent: false,
      package: { installed: false, missingAssemblies: [] },
      canInstall: true,
      payloadAvailable: true,
      blockers: ['package_missing'],
    },
  ],
}

const SKILL_STATE = {
  ok: true,
  workspace: 'E:/proj',
  projectRoot: 'E:/proj/Game',
  candidates: [],
  skillsDir: 'E:/proj/.dsh/skills',
  packages: [
    {
      id: 'graphics-debugger',
      title: 'Unity Graphics Debugger',
      hint: 'Frame Debugger events and render targets, RenderDoc capture/replay.',
      executable: true,
      partial: 'RenderDoc needs Python.',
      downloaded: false,
    },
    {
      id: 'ui-toolkit',
      title: 'UI Toolkit DevTools',
      hint: 'UI Toolkit layout, style and interaction debugging.',
      executable: true,
      partial: null,
      downloaded: true,
    },
    { id: 'debugger', title: 'Unity Debugger', hint: 'PlayerLoop/Tick positioning and paused inspection.', executable: false, partial: null, downloaded: false },
    { id: 'profiler', title: 'Unity Profiler', hint: 'CPU/GPU/memory samples and baseline comparison.', executable: false, partial: null, downloaded: true },
    { id: 'view', title: 'Locus View', hint: 'Vue panels, inspectors, tables and graph editors.', executable: false, partial: null, downloaded: false },
  ],
  states: [],
}

function answersFor(overrides = {}) {
  return {
    '/workspaces': WORKSPACES,
    '/projects/install': {
      ok: true,
      projectRoot: 'E:/proj/Other',
      installed: true,
      marker: true,
      next: 'Reopen the Unity Editor: the bridge starts on launch once the marker is present.',
    },
    '/projects': PROJECTS,
    '/skills/state': SKILL_STATE,
    '/skills/activate': {
      ok: true,
      workspace: 'E:/proj',
      projectRoot: 'E:/proj/Game',
      packages: [{ id: 'graphics-debugger', state: 'compiled', assemblyId: 'asm-g' }],
      states: [],
    },
    '/skills/install': { ok: true, workspace: 'E:/proj', skillsDir: 'E:/proj/.dsh/skills', written: ['graphics-debugger'], unchanged: [] },
    settings: SETTINGS,
    ...overrides,
  }
}

test('the page renders the three groups with one row per skill and no cache switch', async (t) => {
  const page = await mountSettings(t, answersFor())
  const text = await page.settle()

  assert.match(text, /locus-settings-root/)
  assert.match(text, /工作区/)
  assert.match(text, /领域技能/)
  assert.match(text, /功能/)
  assert.equal((text.match(/locus-settings-card/g) ?? []).length, 3, 'each group is its own bordered card')
  // Two host-style selects: the workspace and the Unity project.
  assert.equal(
    page.runtime
      .elements(page.root)
      .filter((element) => String(element.props?.className ?? '').includes('locus-select-trigger')).length,
    2,
  )
  // The skills section names the workspace it writes into, right-aligned.
  const skillsMeta = page.runtime
    .elements(page.root)
    .find((element) => element.props?.className === 'locus-settings-group-meta')
  assert.ok(skillsMeta, 'the skills heading carries a workspace name')
  assert.equal((skillsMeta.children ?? []).join(' ').trim(), 'Proj')
  // Five skill rows, each either a Download button or the Downloaded label.
  assert.match(text, /Unity Graphics Debugger/)
  assert.match(text, /UI Toolkit DevTools/)
  assert.match(text, /Unity Debugger/)
  assert.match(text, /Unity Profiler/)
  assert.match(text, /Locus View/)
  // Every skill row carries its own one-line description, not just the one with
  // an extra capability note.
  assert.match(text, /Frame Debugger events/)
  assert.match(text, /UI Toolkit layout/)
  assert.match(text, /PlayerLoop\/Tick positioning/)
  assert.match(text, /CPU\/GPU\/memory samples/)
  assert.match(text, /Vue panels/)
  assert.equal((text.match(/已下载/g) ?? []).length, 2, 'only the two downloaded skills read as downloaded')
  assert.equal(
    page.buttons().filter((button) => (button.children ?? []).join(' ').includes('下载')).length,
    3,
  )
  // The cache preference lost its control but the three switches remain.
  assert.doesNotMatch(text, /缓存/)
  assert.equal(page.buttons().filter((button) => button.props.role === 'switch').length, 3)
  assert.doesNotMatch(text, /\[!/, 'nothing threw')
})

test('the Unity project picker lists scanned projects and remembers the choice', async (t) => {
  const page = await mountSettings(t, answersFor())
  const text = await page.settle()

  const trigger = page.triggerById('locus-project-select')
  assert.ok(trigger, 'the project picker renders')
  assert.match(text, /Game/, 'the stored project label is on the trigger')

  trigger.props.onClick()
  await page.settle()
  const menu = page.runtime.elements(page.root).filter((element) => element.props?.role === 'menuitem')
  assert.ok(menu.some((option) => option.props?.['data-label'] === 'Game'))
  assert.ok(menu.some((option) => option.props?.['data-label'] === 'Other'))

  const other = menu.find((option) => option.props?.['data-label'] === 'Other')
  other.props.onClick()
  await page.settle()
  const post = page.requests.find((entry) => entry.method === 'POST' && entry.url.includes('/settings'))
  assert.deepEqual(JSON.parse(post.body), { preferences: { unityProject: 'E:/proj/Other' } })
})

test('an installed, connected plugin reads "Connected" as a capsule and offers no install button', async (t) => {
  const page = await mountSettings(t, answersFor())
  const text = await page.settle()

  assert.match(text, /Locus 插件/)
  assert.match(text, /locus-project-badge is-connected/)
  assert.match(text, /已连接/)
  // The capsule belongs beside the label, not in the right-hand control slot
  // where the install button lives.
  const label = page.runtime
    .elements(page.root)
    .find((element) => String(element.props?.className ?? '').includes('locus-plugin-label'))
  assert.ok(label, 'the plugin label wraps the capsule')
  assert.ok(
    (label.children ?? []).some((child) => String(child?.props?.className ?? '').includes('locus-project-badge')),
    'the capsule is inside the label',
  )
  assert.equal(page.buttonWithText('安装'), undefined, 'nothing to install for the selected project')
})

test('an installed plugin without an open editor reads "Unity not open"', async (t) => {
  const projects = {
    ok: true,
    roots: ['E:/proj'],
    projects: [
      {
        projectRoot: 'E:/proj/Game',
        name: 'Game',
        state: 'not_connected',
        editorRunning: false,
        markerPresent: true,
        package: { installed: true, version: '0.9.3', missingAssemblies: [] },
        canInstall: false,
        payloadAvailable: true,
        blockers: [],
      },
    ],
  }
  const page = await mountSettings(t, answersFor({ '/projects': projects }))
  const text = await page.settle()

  assert.match(text, /locus-project-badge is-offline/)
  assert.match(text, /未打开 Unity/)
})

test('an editor that is open but unreachable reads "Connection failed"', async (t) => {
  const projects = {
    ok: true,
    roots: ['E:/proj'],
    projects: [
      {
        projectRoot: 'E:/proj/Game',
        name: 'Game',
        state: 'not_connected',
        editorRunning: true,
        markerPresent: false,
        package: { installed: true, version: '0.9.3', missingAssemblies: [] },
        canInstall: false,
        payloadAvailable: true,
        blockers: [],
      },
    ],
  }
  const page = await mountSettings(t, answersFor({ '/projects': projects }))
  const text = await page.settle()

  assert.match(text, /locus-project-badge is-missing/)
  assert.match(text, /连接失败/)
})

test('a project without the plugin shows the install button and installs on click', async (t) => {
  const settings = { ...SETTINGS, preferences: { ...SETTINGS.preferences, unityProject: 'E:/proj/Other' } }
  const page = await mountSettings(t, answersFor({ settings }))
  const text = await page.settle()

  assert.match(text, /没有插件/)
  const install = page.buttonWithText('安装')
  assert.ok(install, 'the install button is offered')
  install.props.onClick()
  const after = await page.settle()

  const post = page.requests.find((entry) => entry.url.includes('/projects/install'))
  assert.ok(post, 'clicking install posts to the Host')
  assert.deepEqual(JSON.parse(post.body), { projectRoot: 'E:/proj/Other' })
  assert.match(after, /Reopen the Unity Editor/)
})

test('downloading one skill writes that skill and activates the executable ones', async (t) => {
  const page = await mountSettings(t, answersFor())
  await page.settle()

  const download = page.buttonWithText('下载')
  assert.ok(download, 'the first undownloaded skill offers Download')
  download.props.onClick()
  const text = await page.settle()

  const post = page.requests.find((entry) => entry.url.includes('/skills/install'))
  assert.ok(post, 'the download goes through the Host')
  assert.deepEqual(JSON.parse(post.body), { workspacePath: 'E:/proj', skillId: 'graphics-debugger' })
  assert.ok(
    page.requests.some((entry) => entry.url.includes('/skills/activate') && entry.method === 'POST'),
    'an executable skill is compiled after its docs are written',
  )
  assert.match(text, /已下载/)
})

test('without a workspace the skill buttons are disabled and the page says why', async (t) => {
  const settings = { ...SETTINGS, preferences: { frameCache: true, workspacePath: '', unityProject: '' } }
  const page = await mountSettings(t, answersFor({ settings }))
  const text = await page.settle()

  const download = page.buttonWithText('下载')
  assert.ok(download)
  assert.equal(download.props.disabled, true)
  assert.match(text, /先在上面选择一个工作区/)
})

test('a failed project scan is reported, and the switches still work', async (t) => {
  const page = await mountSettings(
    t,
    answersFor({ '/projects': { status: 500, error: { code: 'unity_error', message: 'the project scan blew up' } } }),
  )
  const text = await page.settle()

  assert.match(text, /locus-settings-root/)
  assert.match(text, /locus-settings-switch/)
  assert.match(text, /the project scan blew up/)
  assert.doesNotMatch(text, /\[!/, 'nothing threw')
})