// Live render of the tab body against the running editor.
//
// `scripts/live-sidebar.mjs` proves the Host routes; this proves the *panel*:
// it loads the shipped `lib/client.js` plugin, mounts the tab body with a small
// React-shaped renderer (hooks included), lets its effects run, and prints what
// the tab actually draws for every format it claims.
//
// Like the route checks, nothing is named: every asset is discovered, so this
// runs against any Unity project. The renderer is deliberately not a real React
// — it exists to execute the body and every child component with working hook
// state, so a crash or an empty panel fails loudly, without adding a framework
// dependency to this package.
//
// Usage: node scripts/live-render.mjs [--project <dir>] [--prefab <Assets/…>] [--verbose]

import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

import { registerAssetRoutes } from '../src/sidebar/routes.js'
import { shutdownPool } from '../src/client-pool.js'
import { pickAsset, pickRichPrefab, pickScene } from './live-assets.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const valueOf = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const verbose = args.includes('--verbose')
const projectRoot = resolve(ROOT, valueOf('--project', 'unity-test'))
const prefabOverride = valueOf('--prefab', null)
const SESSION = 'live-render'

// ── a tiny React-with-hooks ────────────────────────────────────────────────

/**
 * One mount namespace: hook state per component path, effects per path.
 *
 * Paths are positional (`root/0/2`), which is what React itself effectively
 * uses for a list-free tree; the panel never reorders a list without re-keying,
 * so this stays stable across the rounds a load takes.
 */
function createRuntime() {
  const state = new Map()
  const refs = new Map()
  // path -> the effects declared by that component instance, in declaration
  // order. A component may declare several (the tab body declares three).
  const effects = new Map()
  // Effects already fired. React runs an effect when its deps change; this
  // harness has no dependency arrays, so "once per mount path" is the closest
  // honest approximation — re-firing them every round would keep the panel in
  // its loading state forever, which is a property of the harness, not the tab.
  const fired = new Set()
  let cursor = 0
  let effectCursor = 0
  let path = 'root'

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    // A ref is identity-stable across renders (React's contract); recreating it
    // per render would reset every `mounted` guard the panel keeps.
    useRef: (value) => {
      if (!refs.has(path)) refs.set(path, { current: value })
      return refs.get(path)
    },
    useEffect: (fn) => {
      const list = effects.get(path) ?? []
      const index = effectCursor++
      list[index] = fn
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

  /** Run a component under its own hook cursor. */
  function callComponent(component, props, at) {
    cursor = 0
    effectCursor = 0
    path = at
    return component(props)
  }

  /** Run every effect collected so far, once each. */
  async function flushEffects() {
    let ran = 0
    for (const [at, list] of effects) {
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

  /** Flatten an element tree to text, invoking function components. */
  function render(node, at = 'root', depth = 0) {
    if (node === null || node === undefined || node === false || node === true) return ''
    if (depth > 40) return ''
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map((child, index) => render(child, `${at}.${index}`, depth + 1)).join(' ')
    if (typeof node === 'function') return ''
    if (typeof node.type === 'function') {
      let rendered
      // A component that throws must not take the whole report down: the row
      // that failed is reported as text so the panel's failure is visible.
      try {
        rendered = callComponent(node.type, node.props, at)
      } catch (error) {
        return `[!${node.type.name || 'Component'}: ${String(error?.message ?? error)}]`
      }
      return render(rendered, `${at}.c`, depth + 1)
    }
    const props = node.props ?? {}
    const own = [props.className, props.title, typeof props.value === 'string' ? props.value : ''].filter(Boolean).join(' ')
    const children = (node.children ?? []).map((child, index) => render(child, `${at}.${index}`, depth + 1)).join(' ')
    return `${own} ${children}`.replace(/\s+/g, ' ').trim()
  }

  return { React, flushEffects, render }
}

// ── the plugin, loaded from the built bundle ───────────────────────────────

/** Load `lib/client.js` exactly as DSH does (a `__ModuleLoader__` factory). */
function loadPlugin(React, document) {
  const source = readFileSync(resolve(ROOT, 'lib', 'client.js'), 'utf8')
  const registrations = []
  const window = { __ModuleLoader__: { load: (registration) => registrations.push(registration) } }
  new Function('window', 'document', source)(window, document)
  const [registration] = registrations
  const exports = registration.factory(() => React)
  const types = []
  const bodies = []
  exports.apply({
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on: () => {},
    sidebarRightTabs: {
      register: (definition) => {
        types.push(definition)
        return () => {}
      },
    },
    slots: {
      inject: (_name, fn) => {
        fn()
        return () => {}
      },
      register: (definition, component) => {
        bodies.push({ definition, component })
        return () => {}
      },
    },
  })
  return { registration, types, body: bodies[0].component }
}

/** One case per format the tab claims, using discovered assets. */
function cases() {
  const prefab = prefabOverride ?? pickRichPrefab(projectRoot)
  const list = []
  if (prefab) {
    list.push({
      label: 'prefab',
      path: prefab,
      expect: [prefab.split('/').pop(), 'locus-asset-row'],
    })
  }
  const scriptable = pickAsset(projectRoot, ['asset'])
  if (scriptable) list.push({ label: 'scriptable object', path: scriptable, expect: [scriptable.split('/').pop()] })
  const material = pickAsset(projectRoot, ['mat'])
  if (material) list.push({ label: 'material', path: material, expect: [material.split('/').pop()] })
  const clip = pickAsset(projectRoot, ['anim'])
  if (clip) list.push({ label: 'animation clip', path: clip, expect: [clip.split('/').pop()] })
  const controller = pickAsset(projectRoot, ['controller'])
  if (controller) list.push({ label: 'animator controller', path: controller, expect: [controller.split('/').pop()] })
  const model = pickAsset(projectRoot, ['fbx', 'obj', 'dae'])
  if (model) list.push({ label: 'model', path: model, expect: [model.split('/').pop(), 'locus-asset-row'] })
  const texture = pickAsset(projectRoot, ['png', 'jpg', 'tga'])
  if (texture) list.push({ label: 'texture', path: texture, expect: [texture.split('/').pop()] })
  const scene = pickScene(projectRoot)
  if (scene) list.push({ label: 'scene', path: scene, expect: [scene.split('/').pop()] })
  list.push({ label: 'missing', path: 'Assets/__missing__/nope.prefab', expect: ['nope.prefab'] })
  return list
}

async function main() {
  const handlers = []
  const document = {
    documentElement: { dataset: {} },
    head: { querySelector: () => null, appendChild: () => {} },
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    baseURI: 'http://127.0.0.1/',
  }
  registerAssetRoutes({
    webServer: {
      register: (route) => {
        handlers.push(route)
        return () => {}
      },
    },
    effect: (fn) => {
      fn()
    },
    get: (name) => {
      if (name === 'sessions') return { get: (id) => (id === SESSION ? { header: { cwd: projectRoot } } : undefined) }
      if (name === 'workingDirectory') return { get: () => projectRoot }
      if (name === 'connection') return { requestRejection: () => undefined }
      return undefined
    },
  })
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const route = handlers.find((entry) => entry.path === pathname)
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { code: 'not-found', message: pathname } }))
      return
    }
    void route.handler(req, res).catch(() => {
      res.writeHead(500).end()
    })
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const origin = `http://127.0.0.1:${server.address().port}`
  // The panel resolves its routes against `document.baseURI` — a reverse proxy
  // prefix or the desktop shell's scheme changes that — so the harness points
  // it at the test server and leaves `fetch` alone.
  document.baseURI = `${origin}/`
  globalThis.document = document
  globalThis.window = globalThis
  // The preview pane probes a thumbnail/orbit frame with a detached <img>.
  // Here the stub resolves immediately, which is enough for the panel's state
  // machine; the bytes themselves are covered by scripts/live-sidebar.mjs.
  globalThis.Image = class {
    set src(value) {
      this._src = value
      queueMicrotask(() => this.onload?.())
    }
    get src() {
      return this._src
    }
  }

  const failures = []
  const list = cases()
  let announced = false
  try {
    for (const testCase of list) {
      const runtime = createRuntime()
      const { registration, types, body } = loadPlugin(runtime.React, document)
      if (!announced) {
        console.log(`project: ${projectRoot}`)
        console.log(`bundle ${registration.id}: type ${types[0]?.id} (kind ${types[0]?.kind}, ${types[0]?.patterns?.length ?? 0} patterns)\n`)
        announced = true
      }
      const address = `dsh-resource://file/session/${SESSION}/${testCase.path}`
      const props = {
        sessionId: SESSION,
        useTabInfo: () => ({
          tab: { id: `tab-${testCase.label}`, contentId: address, address, signal: new AbortController().signal },
          panel: { id: 'pane', isFloating: false },
          sidebar: { expanded: true, fullscreen: false },
        }),
      }
      try {
        let text = runtime.render(body(props), 'root')
        for (let round = 0; round < 24; round += 1) {
          await runtime.flushEffects()
          await new Promise((done) => setTimeout(done, 180))
          const next = runtime.render(body(props), 'root')
          if (round > 2 && next === text) break
          text = next
        }
        const missing = testCase.expect.filter((needle) => !text.includes(needle))
        if (missing.length > 0) failures.push(`${testCase.label}: rendered text is missing ${JSON.stringify(missing)}`)
        const threw = /\[!/.test(text)
        if (threw) failures.push(`${testCase.label}: a component threw: ${/\[![^\]]*\]/.exec(text)?.[0] ?? ''}`)
        console.log(`${missing.length === 0 && !threw ? 'ok  ' : 'FAIL'} ${testCase.label.padEnd(18)} ${text.slice(0, verbose ? 600 : 110)}`)
      } catch (error) {
        failures.push(`${testCase.label}: ${error?.stack?.split('\n').slice(0, 2).join(' | ') ?? error}`)
        console.log(`FAIL ${testCase.label.padEnd(18)} threw ${String(error?.message ?? error)}`)
      }
    }
  } finally {
    delete globalThis.document
    delete globalThis.window
    delete globalThis.Image
    await new Promise((done) => server.close(done))
    await shutdownPool().catch(() => {})
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} render failure(s):`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log(`\n${list.length}/${list.length} formats rendered`)
  process.exit(0)
}

await main()
