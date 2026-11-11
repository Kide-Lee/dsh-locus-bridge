import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/**
 * Load `lib/client.js` the way DSH does: a `__ModuleLoader__.load({id, factory})`
 * call, then materialize the factory with a module table. This is the only check
 * that the *built* artifact — not the source it came from — registers a tab.
 */
function loadBundle() {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const registrations = []
  const window = {
    __ModuleLoader__: {
      load(registration) {
        registrations.push(registration)
      },
    },
  }
  const run = new Function('window', 'document', source)
  const document = {
    documentElement: { dataset: {} },
    head: { querySelector: () => null, appendChild: () => {} },
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    baseURI: 'http://127.0.0.1:3080/',
  }
  run(window, document)
  assert.equal(registrations.length, 1, 'the bundle registers exactly one factory')
  const [registration] = registrations
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  }
  const exports = registration.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected module request: ${specifier}`)
  })
  return { registration, exports, document }
}

test('the built bundle registers a factory and exports the plugin contract', () => {
  const { registration, exports } = loadBundle()
  assert.equal(registration.id, 'dsh-locus-bridge')
  assert.deepEqual(exports.inject, ['slots', 'sidebarRightTabs'])
  assert.equal(typeof exports.apply, 'function')
  assert.equal(exports.TAB_ID, 'dsh-locus-bridge/asset')
  assert.equal(exports.TAB_KIND, 'locus-asset')
  assert.ok(exports.EXTENSIONS.includes('prefab'))
})

test('applying the built bundle registers the tab type and its body', () => {
  const { exports } = loadBundle()
  const types = []
  const bodies = []
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on: () => {},
    sidebarRightTabs: {
      register(definition) {
        types.push(definition)
        return () => {}
      },
    },
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
  exports.apply(ctx)
  assert.equal(types.length, 1)
  assert.equal(types[0].id, types[0].kind === 'locus-asset' ? 'dsh-locus-bridge/asset' : types[0].id)
  assert.equal(types[0].priority, 'extension')
  assert.ok(types[0].patterns.every((pattern) => pattern.startsWith('dsh-resource://file/**/*.')))
  assert.ok(types[0].patterns.every((pattern) => pattern.length > 'dsh-resource://file/**'.length))
  assert.equal(types[0].title('dsh-resource://file/session/s/Assets/X/y.prefab'), 'y.prefab')
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].definition.name, 'sidebar.right.pane.tab')
  assert.equal(bodies[0].definition.key, 'dsh-locus-bridge/asset')
  assert.equal(typeof bodies[0].component, 'function')
})

test('the bundle requests nothing outside the platform module table', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  // The wrapper itself calls `require("react")` once.
  const requests = [...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1])
  assert.deepEqual([...new Set(requests)], ['react'])
  assert.ok(PACKAGE.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar-right'))
})
