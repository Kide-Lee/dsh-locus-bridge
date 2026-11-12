import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  EXTENSIONS,
  LOCALE_NS,
  MODEL_EXTENSIONS,
  SETTINGS_SECTION_ID,
  TAB_ID,
  TAB_KIND,
  activeLocaleId,
  apiUrl,
  arrayCommand,
  attachLocale,
  basenameOf,
  colorToHex,
  copyKeys,
  createLocusAssetPlugin,
  detectModelFormat,
  editorFor,
  editorStatusLabel,
  encodeWrite,
  flattenTree,
  hasChildren,
  hexToColor,
  isChineseUi,
  isLeaf,
  nodeChildren,
  nodeKey,
  parseFileAddress,
  patternsFor,
  replaceNode,
  rowKey,
  severityLabel,
  subscribeLocale,
  suffixOf,
  t,
  targetKey,
  valueSummary,
} from '../src/client/plugin.js'

/**
 * Force one UI language for the duration of `run`.
 *
 * `t()` falls back to `navigator.language`, which is the machine's language and
 * therefore not a stable input for a test: assertions about *copy* must pin the
 * locale instead of depending on whoever runs the suite.
 */
async function withLocale(active, run) {
  attachLocale({ getSnapshot: () => ({ active }), register: () => () => {}, subscribe: () => () => {} })
  try {
    return await run()
  } finally {
    attachLocale(null)
  }
}


// ── addresses ───────────────────────────────────────────────────────────────

test('parseFileAddress reads the Session scope of a file address', () => {
  assert.deepEqual(parseFileAddress('dsh-resource://file/session/s1/Assets/Prefabs/Player.prefab'), {
    sessionId: 's1',
    path: 'Assets/Prefabs/Player.prefab',
  })
  assert.deepEqual(parseFileAddress('dsh-resource://file/session/s1/Assets/a%20b%23c.prefab?line=3'), {
    sessionId: 's1',
    path: 'Assets/a b#c.prefab',
  })
  assert.equal(parseFileAddress('dsh-resource://file/absolute/etc/passwd'), undefined)
  assert.equal(parseFileAddress('dsh-resource://file/session/s1'), undefined)
  assert.equal(parseFileAddress('https://example.test/x.prefab'), undefined)
  assert.equal(parseFileAddress(''), undefined)
})

test('basenameOf and suffixOf mirror the Server-side helpers', () => {
  assert.equal(basenameOf('Assets/A/B.PREFAB'), 'B.PREFAB')
  assert.equal(suffixOf('Assets/A/B.PREFAB'), 'prefab')
  assert.equal(suffixOf('Assets/A/noext'), '')
})

test('detectModelFormat lets content override a wrong extension', () => {
  const bytes = (text) => Uint8Array.from(text, (character) => character.charCodeAt(0)).buffer
  assert.equal(detectModelFormat(bytes('glTF\x02\x00\x00\x00'), 'fbx'), 'glb')
  assert.equal(detectModelFormat(bytes('Kaydara FBX Binary  \x00'), 'glb'), 'fbx')
  assert.equal(detectModelFormat(bytes('; FBX 7.4.0 project'), 'glb'), 'fbx')
  assert.equal(detectModelFormat(bytes('not a model'), 'glb'), 'glb')
})

test('EXTENSIONS matches the Host preview list', () => {
  const host = readFileSync(new URL('../src/sidebar/paths.js', import.meta.url), 'utf8')
  const block = /export const PREVIEW_EXTENSIONS = Object\.freeze\(\[([\s\S]*?)\]\)/.exec(host)
  assert.ok(block, 'PREVIEW_EXTENSIONS not found')
  const hostList = [...block[1].matchAll(/'([^']+)'/g)].map((match) => match[1])
  assert.deepEqual([...EXTENSIONS], hostList, 'the browser and the Host must claim the same suffixes')
})

// ── tree walking ────────────────────────────────────────────────────────────

function node(overrides = {}) {
  return {
    displayName: 'X',
    propertyPath: '',
    bindingTarget: { kind: 'asset', path: 'Assets/A.prefab', globalObjectId: 'gid', targetFileId: 1 },
    valueType: 'String',
    children: [],
    ...overrides,
  }
}

test('nodeKey is stable per target+path and changes with either', () => {
  const a = node({ propertyPath: 'm_Name' })
  const b = node({ propertyPath: 'm_Name' })
  const c = node({ propertyPath: 'm_Tag' })
  assert.equal(nodeKey(a), nodeKey(b))
  assert.notEqual(nodeKey(a), nodeKey(c))
  // A global object id IS the identity; without one the local ids decide.
  const localA = node({ propertyPath: 'm_Name', bindingTarget: { kind: 'component', path: 'Assets/A.prefab', targetFileId: 1, componentType: 'Transform' } })
  const localB = node({ propertyPath: 'm_Name', bindingTarget: { kind: 'component', path: 'Assets/A.prefab', targetFileId: 2, componentType: 'Transform' } })
  assert.notEqual(nodeKey(localA), nodeKey(localB))
  assert.equal(nodeKey(localA), nodeKey(node({ propertyPath: 'm_Name', bindingTarget: { ...localA.bindingTarget } })))
  // Every field of one component shares its target key.
  assert.equal(targetKey(a), targetKey(c))
})

test('rowKey adds the ancestor chain so sibling identities stay distinct', () => {
  const shared = node({ propertyPath: '' })
  assert.equal(rowKey(null, shared), nodeKey(shared))
  assert.equal(rowKey('parent', shared), `${'parent'}>${nodeKey(shared)}`)
})

test('flattenTree shows only expanded branches, in document order', () => {
  const leaf = node({ displayName: 'Leaf', propertyPath: 'm_Leaf' })
  const group = node({ displayName: 'Group', propertyPath: '', children: [leaf, leaf] })
  const root = node({ displayName: 'Root', children: [group, leaf] })
  const collapsed = flattenTree(root, new Set(), new Map())
  assert.deepEqual(collapsed.map((row) => row.node.displayName), ['Root'])
  const expanded = flattenTree(root, new Set([rowKey(null, root), rowKey(rowKey(null, root), group)]), new Map())
  assert.deepEqual(expanded.map((row) => row.node.displayName), ['Root', 'Group', 'Leaf', 'Leaf', 'Leaf'])
  assert.deepEqual(expanded.map((row) => row.depth), [0, 1, 2, 2, 1])
})

test('flattenTree prefers a lazily fetched subtree over the embedded children', () => {
  const lazyChild = node({ displayName: 'Lazy', propertyPath: 'm_Lazy' })
  const group = node({ displayName: 'Group' })
  const root = node({ displayName: 'Root', children: [group] })
  const rootKey = rowKey(null, root)
  const groupKey = rowKey(rootKey, group)
  const cache = new Map([[groupKey, [lazyChild]]])
  const rows = flattenTree(root, new Set([rootKey, groupKey]), cache)
  assert.deepEqual(rows.map((row) => row.node.displayName), ['Root', 'Group', 'Lazy'])
  assert.deepEqual(nodeChildren(group, new Map()), [])
  assert.deepEqual(nodeChildren(group, cache, groupKey).map((child) => child.displayName), ['Lazy'])
})

test('flattenTree stops at its depth limit', () => {
  const deep = node({ displayName: 'a', children: [node({ displayName: 'b', children: [node({ displayName: 'c' })] })] })
  const keys = new Set()
  const walk = (current, parentKey) => {
    const key = rowKey(parentKey, current)
    keys.add(key)
    for (const child of current.children ?? []) walk(child, key)
  }
  walk(deep, null)
  assert.equal(flattenTree(deep, keys, new Map(), 1).length, 2)
})

test('replaceNode patches one node immutably and leaves the rest alone', () => {
  const a = node({ displayName: 'A', propertyPath: 'm_A', value: 'one' })
  const b = node({ displayName: 'B', propertyPath: 'm_B', value: 'two' })
  const root = node({ displayName: 'Root', children: [a, b] })
  const next = replaceNode(root, rowKey(rowKey(null, root), b), { value: 'three', displayValue: 'three' })
  assert.notEqual(next, root)
  assert.equal(next.children[0], a, 'the untouched sibling keeps its identity')
  assert.equal(next.children[1].value, 'three')
  assert.equal(root.children[1].value, 'two', 'the original tree is not mutated')
  assert.equal(replaceNode(root, 'missing', { value: 1 }), root, 'a miss returns the same root')
})

// ── editor descriptors ──────────────────────────────────────────────────────

test('isLeaf reflects hasChildren, not the array flag', () => {
  assert.ok(isLeaf(node({ propertyPath: 'm_X' })))
  assert.ok(!isLeaf(node({ propertyPath: '', hasChildren: true })))
})

test('editorFor maps Unity value types onto the field kinds the panel draws', () => {
  const kind = (valueType, extra = {}) => editorFor(node({ valueType, propertyPath: 'm_X', ...extra }))?.kind ?? null
  assert.equal(kind('Boolean'), 'boolean')
  assert.equal(kind('Integer'), 'integer')
  assert.equal(kind('LayerMask'), 'integer')
  assert.equal(kind('Float'), 'number')
  assert.equal(kind('Double'), 'number')
  assert.equal(kind('String'), 'string')
  assert.equal(kind('Enum'), 'enum')
  assert.equal(kind('Color'), 'color')
  assert.equal(kind('Vector2'), 'vector')
  assert.equal(kind('Vector3Int'), 'vector')
  assert.equal(kind('Quaternion'), 'vector')
  assert.equal(kind('Rect'), 'vector')
  assert.equal(kind('ObjectReference'), 'reference')
  assert.equal(kind('Generic'), null)
  assert.equal(editorFor(node({ propertyPath: 'm_X', valueType: 'Float', editable: false })), null)
  assert.equal(editorFor(node({ propertyPath: 'm_X', valueType: 'Float', hasChildren: true, children: [node()] })), null)
})

test('editorFor reports the vector keys and enum options', () => {
  const vector = editorFor(node({ valueType: 'Vector4', propertyPath: 'm_X' }))
  assert.deepEqual(vector.keys, ['x', 'y', 'z', 'w'])
  const rect = editorFor(node({ valueType: 'Rect', propertyPath: 'm_X' }))
  assert.deepEqual(rect.keys, ['x', 'y', 'width', 'height'])
  const flags = editorFor(node({ valueType: 'Enum', propertyPath: 'm_X', isFlagsEnum: true, enumValueFlag: 5, enumOptions: [{ label: 'A', numericValue: 1 }] }))
  assert.equal(flags.flags, true)
  assert.equal(flags.flagValue, 5)
})

// ── write encoding ──────────────────────────────────────────────────────────

test('encodeWrite produces the valueJson vocabulary SetSerializedPropertyValue parses', () => {
  const write = (valueType, value, extra = {}) => encodeWrite(node({ valueType, propertyPath: 'm_X', ...extra }), value)
  assert.equal(write('Boolean', true), true)
  assert.equal(write('Integer', 3.7), 4, 'integers round')
  assert.equal(write('Float', 1.5), 1.5)
  assert.equal(write('String', 'hi'), 'hi')
  assert.deepEqual(write('Enum', 2), { index: 2 })
  assert.deepEqual(write('Enum', 3, { isFlagsEnum: true }), { action: 'setflags', flagValue: 3 })
  assert.deepEqual(write('Vector3', { x: 1, y: 2, z: 3 }), { x: 1, y: 2, z: 3 })
  assert.deepEqual(write('Vector3', { x: 1 }), { x: 1, y: 0, z: 0 }, 'missing components default to 0')
  assert.deepEqual(write('Color', { r: 2, g: -1, b: 0.5 }), { r: 1, g: 0, b: 0.5, a: 1 }, 'channels clamp')
  assert.deepEqual(write('ObjectReference', { globalObjectId: 'g' }), { globalObjectId: 'g' })
  assert.equal(write('ObjectReference', null), null)
  // The refusal messages are localised copy now, so the assertion pins the
  // language instead of matching an English sentence.
  return withLocale('en', () => {
    assert.throws(() => write('Float', 'abc'), /finite number/)
    assert.throws(() => encodeWrite(node({ valueType: 'Generic', propertyPath: 'm_X' }), 1), /not editable/)
  })
})

test('arrayCommand carries only the fields the command needs', () => {
  assert.deepEqual(arrayCommand('insert', { index: 2 }), { action: 'insert', index: 2 })
  assert.deepEqual(arrayCommand('delete', { index: 0 }), { action: 'delete', index: 0 })
  assert.deepEqual(arrayCommand('move', { index: 0, toIndex: 2 }), { action: 'move', index: 0, toIndex: 2 })
  assert.deepEqual(arrayCommand('resize', { size: 0 }), { action: 'resize', size: 0 })
  assert.deepEqual(arrayCommand('clear'), { action: 'clear' })
})

// ── color round trip ────────────────────────────────────────────────────────

test('colorToHex writes sRGB and hexToColor inverts it back to linear', () => {
  assert.equal(colorToHex({ r: 1, g: 1, b: 1 }), '#ffffff')
  assert.equal(colorToHex({ r: 0, g: 0, b: 0 }), '#000000')
  const linear = { r: 0.5, g: 0.25, b: 0.1 }
  const round = hexToColor(colorToHex(linear))
  for (const key of ['r', 'g', 'b']) {
    assert.ok(Math.abs(round[key] - linear[key]) < 0.01, `${key} round trips: ${round[key]} vs ${linear[key]}`)
  }
  assert.equal(hexToColor('nope'), null)
})

// ── summaries ───────────────────────────────────────────────────────────────

test('valueSummary prefers displayValue and falls back per shape', () => {
  assert.equal(valueSummary(node({ displayValue: 'Center' })), 'Center')
  assert.equal(valueSummary(node({ value: true })), 'true')
  return withLocale('en', () => {
    assert.equal(valueSummary(node({ value: [1, 2, 3] })), '3 item(s)')
  })
  .then(() =>
    withLocale('zh', () => {
      assert.equal(valueSummary(node({ value: [1, 2, 3] })), '3 项')
    }),
  )
  .then(() => {
    assert.equal(valueSummary(node({ value: { x: 1 } })), '{"x":1}')
    assert.equal(valueSummary(null), '')
  })
})

// ── localisation ───────────────────────────────────────────────────────────

test('both dictionaries define exactly the same keys', () => {
  // The zh dictionary is the source of truth; a key present in one and not the
  // other would silently fall back to English (or to raw keys) in one language.
  const keys = copyKeys()
  assert.ok(keys.length > 40, `expected a full dictionary, got ${keys.length} keys`)
  return withLocale('en', () => {
    const english = keys.map((key) => t(key))
    for (const [index, key] of keys.entries()) {
      assert.notEqual(english[index], key, `${key} is missing from the English dictionary`)
    }
  }).then(() =>
    withLocale('zh', () => {
      for (const key of keys) {
        const text = t(key)
        assert.notEqual(text, key, `${key} is missing from the Chinese dictionary`)
      }
    }),
  )
})

test('t() resolves the active locale and interpolates placeholders', () => {
  return withLocale('zh-CN', () => {
    assert.equal(isChineseUi(), true)
    assert.equal(t('save'), '保存')
    assert.equal(t('saveWithCount', { n: 3 }), '保存（3）')
    assert.equal(t('dirtyFooter', { n: 2 }), '2 项未保存的修改（仅在内存中，按保存写入文件）')
  })
    .then(() =>
      withLocale('en-US', () => {
        assert.equal(isChineseUi(), false)
        assert.equal(t('save'), 'Save')
        assert.equal(t('saveWithCount', { n: 3 }), 'Save (3)')
      }),
    )
    .then(() =>
      withLocale('ja-JP', () => {
        // A language this plugin does not carry falls back to English rather
        // than to raw keys.
        assert.equal(isChineseUi(), false)
        assert.equal(t('save'), 'Save')
      }),
    )
})

test('an unknown key degrades to the key itself, never to undefined', () => {
  return withLocale('zh', () => {
    assert.equal(t('noSuchKey'), 'noSuchKey')
    assert.equal(t('noSuchKey', { n: 1 }), 'noSuchKey')
  })
})

test('activeLocaleId prefers the locale service over the browser language', () => {
  return withLocale('zh', () => {
    assert.equal(activeLocaleId(), 'zh')
  }).then(() => {
    // With no service attached the browser language is the fallback, so the
    // answer must at least be a string and never a crash.
    attachLocale(null)
    assert.equal(typeof activeLocaleId(), 'string')
  })
})

test('editorStatusLabel and severityLabel localise values the broker sends', async () => {
  await withLocale('zh', () => {
    assert.equal(editorStatusLabel('editing'), '编辑中')
    assert.equal(editorStatusLabel('playing'), '运行中')
    assert.equal(editorStatusLabel('playing_paused'), '已暂停')
    assert.equal(severityLabel('warning'), '警告')
    assert.equal(severityLabel('error'), '错误')
    assert.equal(severityLabel('info'), '信息')
  })
  await withLocale('en', () => {
    assert.equal(editorStatusLabel('editing'), 'editing')
    assert.equal(editorStatusLabel('playing_paused'), 'paused')
    assert.equal(severityLabel('warning'), 'warning')
  })
})

test('an unknown editor status and severity pass through unchanged', async () => {
  await withLocale('zh', () => {
    // A future editor state must not print a fabricated translation.
    assert.equal(editorStatusLabel('compiling'), 'compiling')
    assert.equal(severityLabel(undefined), '警告')
  })
})

test('subscribeLocale tolerates a service without subscribe and never throws', () => {
  attachLocale({ getSnapshot: () => ({ active: 'zh' }) })
  try {
    const off = subscribeLocale(() => {})
    assert.equal(typeof off, 'function')
    off()
  } finally {
    attachLocale(null)
  }
  // No service at all.
  assert.equal(typeof subscribeLocale(() => {}), 'function')
})

test('the locale service is attached and both dictionaries are registered', () => {
  const registered = []
  const disposed = []
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  }
  const locale = {
    getSnapshot: () => ({ active: 'zh' }),
    register: (ns, id, dict) => {
      registered.push({ ns, id, dict })
      return () => disposed.push(id)
    },
    subscribe: () => () => {},
  }
  const ctx = {
    get: (name) => (name === 'locale' ? locale : undefined),
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') ctx.disposers.push(dispose)
    },
    on: () => {},
    disposers: [],
    sidebarRightTabs: { register: () => () => {} },
    slots: { inject: () => () => {}, register: () => () => {} },
  }
  globalThis.document = {
    documentElement: { dataset: {} },
    head: { querySelector: () => null, appendChild: () => {} },
    createElement: () => ({ setAttribute() {}, textContent: '' }),
  }
  try {
    const plugin = createLocusAssetPlugin(() => fakeReact)
    plugin.apply(ctx)
    assert.deepEqual(
      registered.map((entry) => `${entry.ns}/${entry.id}`),
      [`${LOCALE_NS}/zh`, `${LOCALE_NS}/en`],
    )
    // Registered dictionaries are the real ones, so the Host can resolve copy.
    assert.equal(registered[0].dict.save, '保存')
    assert.equal(registered[1].dict.save, 'Save')
    // Disposal unregisters both and detaches the service.
    for (const dispose of ctx.disposers) dispose()
    assert.deepEqual(disposed.sort(), ['en', 'zh'])
  } finally {
    attachLocale(null)
    delete globalThis.document
  }
})

// ── urls ────────────────────────────────────────────────────────────────────

test('apiUrl resolves under the page directory and encodes parameters', () => {
  const url = apiUrl('asset', { sessionId: 's 1', path: 'Assets/a b.prefab', depth: undefined })
  assert.ok(url.pathname.endsWith('/locus/api/asset'), url.pathname)
  assert.equal(url.searchParams.get('sessionId'), 's 1')
  assert.equal(url.searchParams.get('path'), 'Assets/a b.prefab')
  assert.equal(url.searchParams.has('depth'), false)
})

// ── plugin shape ────────────────────────────────────────────────────────────

test('the settings switch copies the host primitive instead of inventing one', async () => {
  // The whole point of this test is that the control *looks like the host's*.
  // A future edit that "improves" the capsule silently breaks that, so the
  // geometry and the aria keying are asserted, not just "there is a button".
  const source = readFileSync(new URL('../src/client/plugin.js', import.meta.url), 'utf8')
  const css = source.slice(source.indexOf('.locus-settings-switch{'))
  const rule = css.slice(0, css.indexOf('}'))

  // 36×20 capsule with 2px padding and a 10px radius (half the height), matching
  // Switch.module.css in @deepseek-ai/dsh-client-ui-primitives.
  assert.match(rule, /width:36px/)
  assert.match(rule, /height:20px/)
  assert.match(rule, /padding:2px/)
  assert.match(rule, /border-radius:10px/)
  // The capsule must opt out of the global superellipse, or its ends square off
  // against the round thumb inside it.
  assert.match(rule, /corner-shape:round/)
  // The track colour is keyed off aria-checked, never a parallel modifier class:
  // that is what keeps the picture and the accessible state from disagreeing.
  assert.match(css, /\.locus-settings-switch\[aria-checked='true'\]\{background:/)
  assert.doesNotMatch(css, /\.locus-settings-switch\.is-on/)
  // 16px thumb translating exactly one track-width of travel (36 - 2*2 - 16).
  assert.match(css, /\.locus-settings-switch-thumb\{[^}]*width:16px/)
  assert.match(css, /\.locus-settings-switch-thumb\{[^}]*height:16px/)
  assert.match(css, /\[aria-checked='true'\] \.locus-settings-switch-thumb\{transform:translateX\(16px\)/)

  // The rendered control carries the switch role and copies no primitive module.
  assert.match(source, /role: 'switch'/)
  const component = source.slice(source.indexOf('function SwitchRow'))
  const body = component.slice(0, component.indexOf('\n  }'))
  assert.match(body, /'aria-checked': on \? 'true' : 'false'/)
  assert.match(body, /'aria-label': label/)
  // A bare capsule, like the host's: the visible copy belongs to the row.
  assert.doesNotMatch(body, /settingsOn|settingsOff|switch-text/)

  const requests = [...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1])
  assert.deepEqual(requests, [], 'a plain-JS client plugin imports no packages at all')
})

test('the settings nav icon is the supplied Unity mark, drawn verbatim', async () => {
  // The artwork was supplied by the user as a 128-unit three-facet Unity logo.
  // Rendering it means keeping its viewBox, its three paths (in order) and its
  // own greys; a redrawn or recoloured "equivalent" is a different logo, so the
  // exact geometry is asserted rather than "some svg exists".
  const source = readFileSync(new URL('../src/client/plugin.js', import.meta.url), 'utf8')
  const block = source.slice(source.indexOf("ctx.slots.inject('settings.section.icon'"))
  const component = block.slice(0, block.indexOf("ctx.slots.inject('settings.section',"))

  assert.match(component, /viewBox: '0 0 128 128'/)
  // The three supplied paths, in the supplied order, with the supplied fills.
  assert.match(component, /d: 'm64\.414 122\.93 47\.606-27\.49/)
  assert.match(component, /fill: '#4d4d4d'/)
  assert.match(component, /d: 'm53\.738 95\.676-18\.664-10\.79/)
  assert.match(component, /fill: 'gray'/)
  assert.match(component, /d: 'M68\.988 5\.07v21\.086/)
  assert.equal([...component.matchAll(/\bh\('path'/g)].length, 3, 'exactly the three supplied paths')
  // The dark facet is a literal, so the mark must NOT be turned into a
  // currentColor stroke icon: that would drop the fills entirely.
  assert.doesNotMatch(component, /stroke: 'currentColor'/)
  // Sized by the slot, hidden from assistive tech, and addressable by the dark
  // theme override.
  assert.match(component, /width: size/)
  assert.match(component, /height: size/)
  assert.match(component, /'aria-hidden': 'true'/)
  assert.match(component, /className: 'locus-unity-mark'/)
})

test('the nav icon is recoloured for dark mode and left alone in light', async () => {
  // The supplied mark's darkest facet is near-black, which disappears on a dark
  // panel. The fix is a CSS override keyed off the Host's own dark marker
  // (`body[data-ds-dark-theme]` — verified against the Host theme stylesheet;
  // there is no `data-theme`), never a redraw of the artwork.
  const source = readFileSync(new URL('../src/client/plugin.js', import.meta.url), 'utf8')
  const css = source.slice(source.indexOf('.locus-unity-mark{'))

  // One rule per facet, so the mark keeps its three-tone structure in dark mode.
  for (const facet of ['1', '2', '3']) {
    assert.match(
      css,
      new RegExp(`body\\[data-ds-dark-theme\\] \\.locus-unity-mark path:nth-of-type\\(${facet}\\)\\{fill:`),
      `facet ${facet} needs a dark-theme fill`,
    )
  }
  // Every dark fill resolves through a registered theme token, so a palette
  // change follows automatically instead of leaving a hard-coded grey behind.
  // Slice exactly the dark rules: neighbouring settings rules use other tokens.
  const darkRules = css.slice(css.indexOf('body[data-ds-dark-theme]'))
  const darkBlock = darkRules.slice(0, darkRules.indexOf('.locus-settings-note'))
  assert.doesNotMatch(darkBlock, /fill:#[0-9a-fA-F]{3,8}/, 'dark fills must be tokens, not literals')
  assert.match(darkBlock, /--dsw-alias-label-primary/)
  assert.match(darkBlock, /--dsw-alias-label-secondary/)
  // Only registered tokens: the theme token list has no label-tertiary. Strip
  // comments first, because the note above the third rule names that token to
  // explain why it is not used.
  const darkDeclarations = darkBlock.replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(darkDeclarations, /--dsw-alias-label-tertiary/)
  // Light mode is the supplied artwork: the override is scoped to dark only, so
  // there is no unscoped .locus-unity-mark path { fill } rule that would also
  // repaint the light theme.
  const lightRules = [...css.matchAll(/^\.locus-unity-mark path[^{]*\{[^}]*fill:[^}]*\}/gm)]
  assert.deepEqual(lightRules.map((m) => m[0]), [], 'no light-mode fill override may exist')
})

test('the plugin registers one tab type and one body under that key', () => {
  const registrations = []
  const effects = []
  const disposers = []
  const types = []
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
  }
  const ctx = {
    effect(fn, label) {
      effects.push({ label })
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    on: () => {},
    sidebarRightTabs: {
      register(definition) {
        types.push(definition)
        return () => {}
      },
    },
    slots: {
      inject(name, fn) {
        registrations.push({ injected: name, result: fn() })
        return () => {}
      },
      register(definition, component) {
        registrations.push({ definition, component })
        return () => {}
      },
    },
  }
  globalThis.document = {
    documentElement: { dataset: {} },
    head: { querySelector: () => null, appendChild: () => {} },
    createElement: () => ({ setAttribute() {}, textContent: '' }),
  }
  try {
    const plugin = createLocusAssetPlugin(() => fakeReact)
    assert.deepEqual(plugin.inject, ['slots', 'sidebarRightTabs'])
    plugin.apply(ctx)
    assert.equal(types.length, 1)
    const type = types[0]
    assert.equal(type.id, TAB_ID)
    assert.equal(type.kind, TAB_KIND)
    assert.equal(type.priority, 'extension')
    assert.equal(type.keepMounted, true)
    // Scheme-qualified and longer than a generic `dsh-resource://file/**`, so
    // this tab outranks another plugin that claims every file (see patternsFor).
    assert.deepEqual(type.patterns, EXTENSIONS.map((extension) => `dsh-resource://file/**/*.${extension}`))
    for (const pattern of type.patterns) {
      assert.ok(pattern.length > 'dsh-resource://file/**'.length, `${pattern} must outrank the generic claim`)
    }
    assert.equal(type.title('dsh-resource://file/session/s/Assets/Prefabs/Player.prefab'), 'Player.prefab')
    const body = registrations.find((entry) => entry.definition?.key === TAB_ID)
    assert.ok(body, 'the body registers under the type id')
    assert.equal(typeof body.component, 'function')
    assert.equal(typeof body.definition.inject('s1').sessionId, 'string')
    // The settings page and its nav icon share one id: the shell matches icons to
    // sections by id and silently keeps the default glyph on a mismatch.
    const section = registrations.find((entry) => entry.definition?.name === 'settings.section')
    const icon = registrations.find((entry) => entry.definition?.name === 'settings.section.icon')
    assert.ok(section, 'the settings page registers')
    assert.ok(icon, 'the settings nav icon registers')
    assert.equal(section.definition.id, SETTINGS_SECTION_ID)
    assert.equal(icon.definition.id, SETTINGS_SECTION_ID)
    assert.equal(typeof section.component, 'function')
  } finally {
    delete globalThis.document
  }
})
test('rowKey, flattenTree and expand-by-position agree on one key space', () => {
  const leaf = node({ displayName: 'Leaf', propertyPath: 'm_Leaf', valueType: 'Float' })
  const group = node({ displayName: 'Group', propertyPath: '', hasChildren: true, children: [leaf] })
  const root = node({ displayName: 'Root', children: [group] })
  const auto = new Set()
  const walk = (current, parentKey, level) => {
    if (!current || level > 1) return
    const key = rowKey(parentKey, current)
    if (level < 2 && Array.isArray(current.children) && current.children.length > 0) auto.add(key)
    for (const child of current.children ?? []) walk(child, key, level + 1)
  }
  walk(root, null, 0)
  const rows = flattenTree(root, auto, new Map())
  // Two levels of expansion: the root and the object it holds, not the leaves.
  assert.deepEqual(rows.map((row) => row.node.displayName), ['Root', 'Group', 'Leaf'])
  assert.equal(auto.size, 2)
  for (const row of rows.slice(0, 2)) assert.ok(auto.has(row.key), `${row.node.displayName} is expanded by its row key`)
})

test('patternsFor uses whole, scheme-qualified file addresses longer than a generic claim', () => {
  const patterns = patternsFor()
  assert.equal(patterns.length, EXTENSIONS.length)
  assert.deepEqual(patterns.slice(0, 2), ['dsh-resource://file/**/*.prefab', 'dsh-resource://file/**/*.asset'])
  const generic = 'dsh-resource://file/**'
  for (const pattern of patterns) {
    // Sidebar ranking breaks a same-band tie on pattern length, so a generic
    // claim from another plugin must lose to every pattern here.
    assert.ok(pattern.length > generic.length, `${pattern} is not longer than ${generic}`)
    assert.ok(pattern.startsWith('dsh-resource://file/**/*.'), `${pattern} must only match a file address`)
  }
})

test('the client and Host agree on which suffixes are models', async () => {
  const { MODEL_EXTENSIONS: hostModels } = await import('../src/sidebar/paths.js')
  assert.deepEqual([...MODEL_EXTENSIONS].sort(), [...hostModels.map((extension) => extension.slice(1))].sort())
})

test('a prefab/model address outranks a generic file-editor claim', () => {
  // The Sidebar ranks same-band claimants by pattern length, and a generic
  // `dsh-resource://file/**` (another plugin's file editor) has 22 characters.
  // This is the failure that made prefabs open in the wrong tab; it is asserted
  // here with a tiny glob so the test needs no dependency on minimatch.
  const generic = 'dsh-resource://file/**'
  const { minimatch } = makeGlob()
  const rank = (address) => {
    const ours = patternsFor()
      .filter((pattern) => minimatch(address, pattern))
      .map((pattern) => pattern.length)
    if (ours.length > 0) return Math.max(...ours)
    return minimatch(address, generic) ? generic.length : -1
  }
  const prefab = 'dsh-resource://file/session/s1/Assets/Prefabs/Player.prefab'
  const model = 'dsh-resource://file/session/s1/Assets/Models/hero.fbx'
  for (const address of [prefab, model]) {
    const length = rank(address)
    assert.ok(length > generic.length, `${address} is claimed by the generic editor (${length} <= ${generic.length})`)
  }
  // And a suffix this tab does not claim must not win.
  assert.equal(rank('dsh-resource://file/session/s1/Assets/notes.txt'), generic.length)
  assert.equal(rank('dsh-resource://file/session/s1/Assets/shot.png'), generic.length)
})

/**
 * The subset of glob the Sidebar's matcher needs for `dsh-resource://file/**\/*.ext`:
 * `**` spans segments, `*` stays inside one, `?` is one character.
 */
function makeGlob() {
  const toRegExp = (pattern) =>
    new RegExp(
      `^${pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*/g, '\u0000')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '.*')
        .replace(/\?/g, '.')}$`,
      'i',
    )
  return { minimatch: (address, pattern) => toRegExp(pattern).test(address) }
}
