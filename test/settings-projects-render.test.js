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
  features: { unity: true, csharp: true, preview: true, skills: false },
  effective: { unity: true, csharp: true, preview: true, skills: false },
  preferences: { frameCache: true, workspacePath: 'E:/proj', unityProject: 'E:/proj/Game' },
  skills: { debugger: false, profiler: false, 'graphics-debugger': false, 'ui-toolkit': false, view: false },
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
  packages: [
    {
      id: 'graphics-debugger',
      title: 'Unity Graphics Debugger',
      hint: 'Frame Debugger events and render targets, RenderDoc capture/replay.',
      executable: true,
      enabled: false,
    },
    {
      id: 'ui-toolkit',
      title: 'UI Toolkit DevTools',
      hint: 'UI Toolkit layout, style and interaction debugging.',
      executable: true,
      enabled: false,
    },
    { id: 'debugger', title: 'Unity Debugger', hint: 'PlayerLoop/Tick positioning and paused inspection.', executable: false, enabled: false },
    { id: 'profiler', title: 'Unity Profiler', hint: 'CPU/GPU/memory samples and baseline comparison.', executable: false, enabled: false },
    { id: 'view', title: 'Locus View', hint: 'Vue panels, inspectors, tables and graph editors.', executable: false, enabled: false },
  ],
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
    settings: SETTINGS,
    ...overrides,
  }
}

test('the page renders the three groups with one row per skill and a switch each', async (t) => {
  const page = await mountSettings(t, answersFor())
  const text = await page.settle()

  assert.match(text, /locus-settings-root/)
  assert.match(text, /工作区/)
  assert.match(text, /领域技能/)
  assert.match(text, /功能/)
  assert.equal((text.match(/locus-settings-card/g) ?? []).length, 3, 'each group is its own bordered card')
  // Features (the tool planes) come before the domain skills.
  assert.ok(text.indexOf('功能') < text.indexOf('领域技能'), 'the tools group is listed above the skills group')
  // Two host-style selects: the workspace and the Unity project.
  assert.equal(
    page.runtime
      .elements(page.root)
      .filter((element) => String(element.props?.className ?? '').includes('locus-select-trigger')).length,
    2,
  )
  // The skills heading no longer names a workspace: nothing is written anywhere.
  assert.equal(
    page.runtime
      .elements(page.root)
      .filter((element) => String(element.props?.className ?? '').includes('locus-settings-group-meta')).length,
    0,
  )
  // Five skill rows, each with its own switch — and no master switch above them.
  for (const id of ['debugger', 'profiler', 'graphics-debugger', 'ui-toolkit', 'view']) {
    assert.ok(
      page.runtime.elements(page.root).some((element) => element.props?.['data-locus-switch'] === `skill-${id}`),
      `${id} renders a switch row`,
    )
  }
  // Five skill switches, plus the three feature switches in the group above.
  assert.equal(
    page.runtime
      .elements(page.root)
      .filter((element) => String(element.props?.['data-locus-switch'] ?? '').startsWith('skill-')).length,
    5,
    'one switch per skill',
  )
  assert.match(text, /Unity Graphics Debugger/)
  assert.match(text, /UI Toolkit DevTools/)
  assert.match(text, /Unity Debugger/)
  assert.match(text, /Unity Profiler/)
  assert.match(text, /Locus View/)
  // Every skill row carries its own one-line description.
  assert.match(text, /Frame Debugger events/)
  assert.match(text, /UI Toolkit layout/)
  assert.match(text, /PlayerLoop\/Tick positioning/)
  assert.match(text, /CPU\/GPU\/memory samples/)
  assert.match(text, /Vue panels/)
  assert.doesNotMatch(text, /仅文档/, 'a row no longer reports a capability label')
  assert.doesNotMatch(text, /未激活/, 'C# state is implicit now')
  assert.doesNotMatch(text, /缓存/)
  assert.equal(page.buttonWithText('下载'), undefined, 'there is nothing to download')
  assert.equal(page.buttonWithText('激活 C# 能力'), undefined, 'there is no activation button')
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

test('each skill switch posts its own toggle and nothing else', async (t) => {
  const page = await mountSettings(t, answersFor())
  await page.settle()

  const row = page.runtime
    .elements(page.root)
    .find((element) => element.props?.['data-locus-switch'] === 'skill-debugger')
  assert.ok(row, 'the debugger row carries a switch')
  const toggle = (row.children ?? []).find((child) => child?.props?.role === 'switch')
  assert.ok(toggle, 'the row control is the switch')
  assert.equal(toggle.props['aria-checked'], 'false', 'every skill starts off')

  toggle.props.onClick()
  await page.settle()
  const post = page.requests.find((entry) => entry.method === 'POST' && entry.url.includes('/settings'))
  assert.deepEqual(JSON.parse(post.body), { skills: { debugger: true } })
  assert.equal(
    page.requests.some((entry) => entry.url.includes('/skills/activate')),
    false,
    'compilation has no route of its own',
  )
})

test('the skill rows stand on their own, with no status line and no warning', async (t) => {
  // `PROJECTS` holds two projects; nothing in the skills panel may depend on
  // that, on a selected workspace, or on a compile target.
  const settings = {
    ...SETTINGS,
    preferences: { ...SETTINGS.preferences, unityProject: '' },
    skills: { ...SETTINGS.skills, 'ui-toolkit': true },
  }
  const page = await mountSettings(t, answersFor({ settings }))
  const text = await page.settle()

  assert.doesNotMatch(text, /多个 Unity 工程/)
  assert.doesNotMatch(text, /自动编译/)
  assert.doesNotMatch(text, /Unity 工程：/)
  assert.equal(page.buttonWithText('激活 C# 能力'), undefined, 'there is no activation button')
  assert.equal(
    page.runtime
      .elements(page.root)
      .filter((element) => String(element.props?.['data-locus-switch'] ?? '').startsWith('skill-')).length,
    5,
    'the five switches render regardless of the project scan',
  )
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