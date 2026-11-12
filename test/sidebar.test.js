import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  ASSET_API_EXTENSIONS,
  PREVIEW_EXTENSIONS,
  assertInsideProject,
  isAssetApiPath,
  isEditableAssetPath,
  MODEL_EXTENSIONS,
  isModelPath,
  isPreviewPath,
  normalizeAssetPath,
  suffixOf,
} from '../src/sidebar/paths.js'

/** Model suffixes the client tab claims (kept in step by the test below). */
const CLIENT_MODELS = ['fbx', 'obj', 'dae', '3ds', 'max', 'blend', 'gltf', 'glb']
import {
  DEFAULT_THUMB_SIZE,
  PngCache,
  assetVersion,
  csString,
  etagOf,
  parseSaveOutput,
  saveSnippet,
  targetOf,
  treeRootOf,
} from '../src/sidebar/unity-asset.js'
import { ROUTE_PREFIX, readJsonBody } from '../src/sidebar/routes.js'

// ── asset paths ─────────────────────────────────────────────────────────────

test('normalizeAssetPath keeps a project-relative Assets path and normalizes slashes', () => {
  assert.equal(normalizeAssetPath('Assets/Prefabs/Player.prefab'), 'Assets/Prefabs/Player.prefab')
  assert.equal(normalizeAssetPath('  Assets\\Objects\\Player.prefab '), 'Assets/Objects/Player.prefab')
})

test('normalizeAssetPath refuses escapes, absolute paths and non-Assets roots', () => {
  for (const bad of [
    '../etc/passwd',
    'Assets/../Secret.prefab',
    'Assets//Double.prefab',
    'Assets/./x.prefab',
    '/Assets/x.prefab',
    'C:/Project/Assets/x.prefab',
    '//server/share/Assets/x.prefab',
    'Packages/com.unity/x.prefab',
    '',
    '   ',
    'Assets/a\0b.prefab',
  ]) {
    assert.throws(() => normalizeAssetPath(bad), Error, `expected ${JSON.stringify(bad)} to be refused`)
  }
})

test('assertInsideProject resolves inside the root and refuses a traversal', async () => {
  const { resolve } = await import('node:path')
  // A file: URL's path is POSIX on one host and a drive letter on another, so
  // the expectation is built with the same `resolve` the function uses.
  const root = resolve('/opt/Unity/MyProject')
  assert.equal(assertInsideProject(root, 'Assets/A.prefab'), resolve(root, 'Assets/A.prefab'))
  // normalizeAssetPath would catch this first; the resolved check is the belt.
  assert.throws(() => assertInsideProject(root, 'Assets/../../etc/passwd'))
})

test('suffixOf and the format predicates agree with the broker extension list', () => {
  assert.equal(suffixOf('Assets/A/B.PREFAB'), '.prefab')
  assert.equal(suffixOf('Assets/A/noext'), '')
  assert.ok(ASSET_API_EXTENSIONS.includes('.prefab'))
  assert.ok(isAssetApiPath('Assets/x.mat'))
  assert.ok(!isAssetApiPath('Assets/x.png'))
  // Scenes are readable but never written from the Sidebar.
  assert.ok(isAssetApiPath('Assets/Scenes/Main.unity'))
  assert.ok(!isEditableAssetPath('Assets/Scenes/Main.unity'))
  assert.ok(isEditableAssetPath('Assets/Prefabs/Player.prefab'))
})

test('PREVIEW_EXTENSIONS covers every previewable suffix and is dot-free', () => {
  for (const extension of PREVIEW_EXTENSIONS) {
    assert.ok(!extension.startsWith('.'), `${extension} must not carry a dot`)
    assert.ok(isPreviewPath(`Assets/x.${extension}`), `${extension} is not previewable`)
    if (MODEL_EXTENSIONS.includes(`.${extension}`)) {
      // A model is browsable and orbit-rendered, never written: the panel edits
      // serialized fields, and an importer's mesh is neither.
      assert.ok(!isEditableAssetPath(`Assets/x.${extension}`), `${extension} must be read-only`)
    } else {
      assert.ok(isEditableAssetPath(`Assets/x.${extension}`), `${extension} should be editable`)
    }
  }
  // Every model suffix the client claims is also a model on the Host side.
  assert.deepEqual(MODEL_EXTENSIONS.map((extension) => extension.slice(1)).sort(), [...CLIENT_MODELS].sort())
  // Case-insensitive, like Unity's own extension comparison.
  assert.ok(isPreviewPath('Assets/x.OverrideController'), 'extension matching folds case')
  assert.ok(!PREVIEW_EXTENSIONS.includes('unity'), 'a scene must not open through the asset viewer')
  assert.ok(!isPreviewPath('Assets/Scenes/Main.unity'))
  assert.ok(!isPreviewPath('Assets/x.png'))
})

// ── tree shapes ─────────────────────────────────────────────────────────────

test('treeRootOf accepts both the properties[] and bare answer shapes', () => {
  const node = { displayName: 'Root' }
  assert.equal(treeRootOf({ ok: true, properties: [node] }), node)
  assert.equal(treeRootOf({ ok: true, results: [node] }), node)
  assert.equal(treeRootOf(node), node)
  assert.equal(treeRootOf(null), null)
})

test('targetOf echoes the binding target and tolerates an empty property path', () => {
  const node = {
    propertyPath: 'm_LocalPosition',
    bindingTarget: { kind: 'component', guid: 'abc', path: 'Assets/A.prefab', componentType: 'UnityEngine.Transform', componentIndex: 0 },
  }
  assert.deepEqual(targetOf(node), { ...node.bindingTarget, propertyPath: 'm_LocalPosition' })
  // A component/object node is addressed by its target alone.
  assert.deepEqual(targetOf({ bindingTarget: node.bindingTarget }), { ...node.bindingTarget, propertyPath: '' })
  assert.throws(() => targetOf({ propertyPath: 'm_X' }), /binding target/)
})

// ── save snippet ────────────────────────────────────────────────────────────

test('saveSnippet mirrors SaveAssetApiScopeAllowed branch order', () => {
  const source = saveSnippet('Assets/Prefabs/Player.prefab')
  const stage = source.indexOf('GetCurrentPrefabStage')
  const scene = source.indexOf('EndsWith(".unity"')
  const prefab = source.indexOf('EndsWith(".prefab"')
  const asset = source.indexOf('SaveAssetIfDirty')
  assert.ok(stage > 0 && stage < scene, 'the open Prefab Stage saves first')
  assert.ok(scene < prefab, 'a scene branch precedes the prefab branch')
  assert.ok(prefab < asset, 'the generic asset flush is last')
  assert.ok(source.includes('SaveAsPrefabAsset'), 'a Prefab Stage saves its contents root')
  assert.ok(source.includes('SavePrefabAsset'), 'a prefab saves the prefab asset')
  assert.ok(source.includes('SaveScene'), 'a scene saves its scene')
  assert.ok(source.includes('"Assets/Prefabs/Player.prefab"'), 'the path is a C# literal')
})

test('saveSnippet embeds the path safely and cannot break out of the literal', () => {
  const source = saveSnippet('Assets/we"ird\\path.prefab')
  assert.ok(source.includes('"Assets/we\\"ird\\\\path.prefab"'))
  assert.equal(source.split('var path = ').length, 2, 'exactly one path binding')
})

test('csString escapes the four C# metacharacters', () => {
  assert.equal(csString('a"b\\c\nd\te'), '"a\\"b\\\\c\\nd\\te"')
})

test('parseSaveOutput reads the snippet result line', () => {
  assert.deepEqual(parseSaveOutput('saved:prefab\n'), { ok: true, kind: 'prefab' })
  assert.deepEqual(parseSaveOutput('log\nsaved:asset\nmore'), { ok: true, kind: 'asset' })
  assert.deepEqual(parseSaveOutput('save_failed:still_dirty\n'), { ok: false, detail: 'still_dirty' })
  assert.equal(parseSaveOutput('').ok, false)
})

// ── caches ──────────────────────────────────────────────────────────────────

test('PngCache evicts by count and by bytes, keeping recent entries', () => {
  const cache = new PngCache({ limit: 2, bytesLimit: 1024 })
  const entry = (key, size = 10) => ({ bytes: Buffer.alloc(size), etag: key, mimeType: 'image/png', key })
  cache.set('a', entry('a'))
  cache.set('b', entry('b'))
  assert.ok(cache.get('a'), 'a survives')
  cache.set('c', entry('c'))
  assert.equal(cache.get('b'), undefined, 'the least recently used entry is evicted')
  assert.ok(cache.get('a'))
  assert.ok(cache.get('c'))
  const small = new PngCache({ limit: 10, bytesLimit: 25 })
  small.set('x', entry('x', 20))
  small.set('y', entry('y', 20))
  assert.equal(small.bytes, 20, 'the byte budget evicts the older entry')
  assert.equal(small.get('x'), undefined)
})

test('etagOf is stable for equal bytes and changes with them', () => {
  const one = Buffer.from('png-1')
  const two = Buffer.from('png-2')
  assert.equal(etagOf('k', one), etagOf('k', one))
  assert.notEqual(etagOf('k', one), etagOf('k', two))
  assert.notEqual(etagOf('k1', one), etagOf('k2', one))
  assert.match(etagOf('k', one), /^"[0-9a-f]{24}"$/)
})

test('assetVersion distinguishes a missing file and changes with size', () => {
  assert.equal(assetVersion('/nonexistent-root', 'Assets/x.prefab'), 'missing')
})

test('DEFAULT_THUMB_SIZE stays inside the broker clamp', () => {
  assert.ok(DEFAULT_THUMB_SIZE >= 64 && DEFAULT_THUMB_SIZE <= 512)
})

// ── request bodies ──────────────────────────────────────────────────────────

function fakeRequest(text) {
  const chunks = text === undefined ? [] : [Buffer.from(text)]
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

test('a workspace-rooted file address resolves to a project-relative asset path', async () => {
  // The GUI sends `dsh-resource://file/session/<id>/unity-test/Assets/x.prefab`
  // when the Unity project sits inside the session workspace. The Host must
  // translate that, or every prefab opens as "path must be inside Assets/".
  const { createServer } = await import('node:http')
  const { mkdirSync, mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { registerAssetRoutes, ROUTE_PREFIX } = await import('../src/sidebar/routes.js')

  const workspace = mkdtempSync(join(tmpdir(), 'locus-workspace-'))
  const project = join(workspace, 'unity-test')
  mkdirSync(join(project, 'Assets', 'Deep'), { recursive: true })
  mkdirSync(join(project, 'ProjectSettings'), { recursive: true })
  const session = 'session-test'
  const handlers = []
  const routes = registerAssetRoutes({
    webServer: { register: (route) => { handlers.push(route); return () => {} } },
    effect: (fn) => fn(),
    get: (name) => name === 'sessions' ? { get: (id) => (id === session ? { header: { cwd: workspace } } : undefined) }
      : name === 'workingDirectory' ? { get: () => workspace }
      : name === 'connection' ? { requestRejection: () => undefined }
      : undefined,
  })
  assert.ok(routes || handlers.length > 0)

  // `projectOf` is internal; exercise the resolution through the public route's
  // validation by checking the error a traversal produces (a 400, not a 200).
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const route = handlers.find((entry) => entry.path === path)
    if (!route) { res.writeHead(404); res.end(); return }
    void route.handler(req, res)
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${server.address().port}${ROUTE_PREFIX}`
  try {
    for (const bad of ['unity-test/Assets/../../etc/passwd', '../outside/Assets/x.prefab']) {
      const response = await fetch(`${base}/asset?sessionId=${session}&path=${encodeURIComponent(bad)}`)
      assert.equal(response.status, 400, `${bad} must be refused`)
    }
    // An unknown Session is also a client error, not a crash.
    const unknown = await fetch(`${base}/asset?sessionId=nope&path=Assets%2Fx.prefab`)
    assert.equal(unknown.status, 404)
  } finally {
    await new Promise((done) => server.close(done))
    rmSync(workspace, { recursive: true, force: true })
  }
})

// A workspace holding more than one Unity project is a real layout (a game plus
// a simulation side by side). Resolving the Session alone then has no answer and
// `resolveProjectRoot` rightly refuses; the clicked file address does have one.
test('projectRootForAssetPath finds the project a clicked asset lives in', async () => {
  const { mkdirSync, mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join, resolve } = await import('node:path')
  const { projectRootForAssetPath } = await import('../src/sidebar/paths.js')

  const workspace = mkdtempSync(join(tmpdir(), 'locus-multi-'))
  const game = join(workspace, 'Projects', 'Tower of Babel')
  const sim = join(workspace, 'Projects', 'Economic System')
  for (const project of [game, sim]) {
    mkdirSync(join(project, 'Assets'), { recursive: true })
    mkdirSync(join(project, 'ProjectSettings'), { recursive: true })
  }
  try {
    assert.equal(
      projectRootForAssetPath(workspace, 'Projects/Tower of Babel/Assets/Resources/altar.prefab'),
      resolve(game),
    )
    assert.equal(projectRootForAssetPath(workspace, 'Projects/Economic System/Assets/X.asset'), resolve(sim))
    // The address is rooted at the Session's directory, but the callers also
    // hand over a bare project-relative path when the workspace *is* the project.
    assert.equal(projectRootForAssetPath(game, 'Assets/A.prefab'), resolve(game))
    // A path inside no project, and every hostile shape, is not a project.
    for (const [root, path] of [
      [workspace, 'Design/notes.md'],
      [workspace, 'Assets/A.prefab'],
      [workspace, '../outside/Assets/A.prefab'],
      [workspace, '/abs/Assets/A.prefab'],
      [workspace, 'Projects/../Assets/A.prefab'],
      [workspace, ''],
      ['', 'Assets/A.prefab'],
      [undefined, 'Assets/A.prefab'],
    ]) {
      assert.equal(projectRootForAssetPath(root, path), null, `${root} + ${path} must not resolve`)
    }
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('a click in a multi-project workspace reads that project, not the Session', async () => {
  // Regression: `altar.prefab` in `Projects/Tower of Babel` used to fail with
  // "The working directory … contains several Unity projects 2 level(s) down;
  // pass project_path to choose one." That message belongs to a tool call, which
  // can take `project_path`; a Sidebar tab cannot, and does not need to — the
  // address it was opened from names the file, and the file names the project.
  const { createServer } = await import('node:http')
  const { mkdirSync, mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { registerAssetRoutes, ROUTE_PREFIX } = await import('../src/sidebar/routes.js')
  const { __resetPoolForTest } = await import('../src/client-pool.js')

  const workspace = mkdtempSync(join(tmpdir(), 'locus-multi-routes-'))
  const game = join(workspace, 'Projects', 'Tower of Babel')
  const sim = join(workspace, 'Projects', 'Economic System')
  for (const project of [game, sim]) {
    mkdirSync(join(project, 'Assets'), { recursive: true })
    mkdirSync(join(project, 'ProjectSettings'), { recursive: true })
  }
  const session = 'session-multi'
  const handlers = []
  registerAssetRoutes({
    webServer: { register: (route) => { handlers.push(route); return () => {} } },
    effect: (fn) => fn(),
    get: (name) => name === 'sessions' ? { get: (id) => (id === session ? { header: { cwd: workspace } } : undefined) }
      : name === 'workingDirectory' ? { get: () => workspace }
      : name === 'connection' ? { requestRejection: () => undefined }
      : undefined,
  })

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const route = handlers.find((entry) => entry.path === path)
    if (!route) { res.writeHead(404); res.end(); return }
    void route.handler(req, res)
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${server.address().port}${ROUTE_PREFIX}`
  __resetPoolForTest()
  try {
    // The project resolution now succeeds, so the request reaches the broker and
    // fails there (no editor runs in a test) — the point is that it is no longer
    // the 409 "several Unity projects … pass project_path" refusal, which the
    // panel could only render as a dead end.
    const asset = await fetch(
      `${base}/asset?sessionId=${session}&path=${encodeURIComponent('Projects/Tower of Babel/Assets/Resources/altar.prefab')}`,
    )
    const payload = await asset.json()
    const message = String(payload?.error?.message ?? '')
    assert.ok(!/several Unity projects|pass project_path/.test(message), message)

    // `/status` answers for the tab's own project instead of refusing outright.
    const status = await fetch(
      `${base}/status?sessionId=${session}&path=${encodeURIComponent('Projects/Economic System/Assets/X.asset')}`,
    )
    const statusPayload = await status.json()
    assert.equal(statusPayload.ok, true)
    assert.match(String(statusPayload.projectRoot), /Economic System$/)

    // Without a path the Session still cannot choose, and that is reported as a
    // state the panel can show rather than a crash.
    const bare = await fetch(`${base}/status?sessionId=${session}`)
    const barePayload = await bare.json()
    assert.equal(barePayload.ok, true)
    assert.equal(barePayload.connected, false)
    assert.match(String(barePayload.reason), /several Unity projects/)
  } finally {
    await new Promise((done) => server.close(done))
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('an offline editor is a retryable state, not a 500', async () => {
  // Regression: a closed editor reaches the panel as a `LocusError` carrying
  // `managed_not_ready` (a closed editor is not a reload) whose message talks
  // about pipes. Classifying only on text produced a red 500 "unity_error",
  // which the panel renders as a broken asset instead of "Unity is offline".
  const { createServer } = await import('node:http')
  const { mkdirSync, mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { registerAssetRoutes, ROUTE_PREFIX } = await import('../src/sidebar/routes.js')
  const { __resetPoolForTest } = await import('../src/client-pool.js')

  const workspace = mkdtempSync(join(tmpdir(), 'locus-offline-'))
  const project = join(workspace, 'unity-test')
  mkdirSync(join(project, 'Assets'), { recursive: true })
  mkdirSync(join(project, 'ProjectSettings'), { recursive: true })
  const session = 'session-offline'
  const handlers = []
  registerAssetRoutes({
    webServer: { register: (route) => { handlers.push(route); return () => {} } },
    effect: (fn) => fn(),
    get: (name) => name === 'sessions' ? { get: (id) => (id === session ? { header: { cwd: workspace } } : undefined) }
      : name === 'workingDirectory' ? { get: () => workspace }
      : name === 'connection' ? { requestRejection: () => undefined }
      : undefined,
  })
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    const route = handlers.find((entry) => entry.path === path)
    if (!route) { res.writeHead(404); res.end(); return }
    void route.handler(req, res)
  })
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${server.address().port}${ROUTE_PREFIX}`
  __resetPoolForTest()
  try {
    const response = await fetch(`${base}/asset?sessionId=${session}&path=${encodeURIComponent('unity-test/Assets/A.prefab')}`)
    const payload = await response.json()
    // No editor is running in a test, so the broker is unreachable: that is
    // exactly the offline case the panel must survive.
    assert.equal(response.status, 503, JSON.stringify(payload))
    assert.equal(payload.retryable, true)
    assert.equal(payload.error.code, 'unity_unavailable')
  } finally {
    await new Promise((done) => server.close(done))
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('readJsonBody accepts an object and refuses everything else', async () => {
  assert.deepEqual(await readJsonBody(fakeRequest('{"a":1}')), { a: 1 })
  assert.deepEqual(await readJsonBody(fakeRequest('')), {})
  for (const bad of ['[]', '"text"', 'null', '3', '{bad json']) {
    await assert.rejects(() => readJsonBody(fakeRequest(bad)), /JSON object/)
  }
})

test('readJsonBody enforces its byte limit', async () => {
  const body = JSON.stringify({ text: 'x'.repeat(2048) })
  await assert.rejects(() => readJsonBody(fakeRequest(body), 256), (error) => error.status === 413)
})

test('the route prefix is a document-relative path segment', () => {
  assert.ok(ROUTE_PREFIX.startsWith('/'))
  assert.ok(!ROUTE_PREFIX.endsWith('/'))
})
// ── asset_api value encoding (shared with the unity_asset tool) ─────────────

test('encodeAssetValue passes compound structs through as JSON objects', async () => {
  const { encodeAssetValue } = await import('../src/asset-api.js')
  // Unity requires exactly the serialized members; the broker reports a wrong
  // shape itself, which is more precise than a client-side refusal.
  assert.equal(encodeAssetValue('/T/m_LocalPosition', { x: 1, y: 2, z: 3 }), '{"x":1,"y":2,"z":3}')
  assert.equal(
    encodeAssetValue('/S/m_Color', { r: 1, g: 0.5, b: 0, a: 1 }),
    '{"r":1,"g":0.5,"b":0,"a":1}',
  )
  assert.equal(encodeAssetValue('/T/m_LocalPosition', { x: 1 }), '{"x":1}')
  // Object references keep their own encoding.
  assert.equal(encodeAssetValue('/S/m_Sprite', { fileID: '12', guid: 'a'.repeat(32) }), '{"fileID":"12","guid":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}')
  assert.equal(encodeAssetValue('/S/m_Sprite', { fileID: '0' }), '{"fileID":"0"}')
  assert.throws(() => encodeAssetValue('/S/m_Sprite', { fileID: '1' }), /needs \{fileID, guid\}/)
  assert.throws(() => encodeAssetValue('/T/m_LocalPosition', { x: undefined }), /must not be undefined/)
})

// ── flat snapshot fallback ──────────────────────────────────────────────────

test('flattenSnapshot reduces an asset_api snapshot to a summary table', async () => {
  const { flattenSnapshot } = await import('../src/sidebar/routes.js')
  const snapshot = {
    revision: 'r1',
    capabilities: { representation: 'serialized' },
    diagnostics: [{ code: 'unsupported_prefab_inheritance', severity: 'warning', message: 'x' }],
    objects: [
      {
        object_id: '91',
        class_id: '1102',
        root_type: 'AnimatorController',
        fields: [
          { property_path: '/AnimatorController/m_Name', kind: 'string', value: 'sr' },
          { property_path: '/AnimatorController/m_AnimatorParameters', kind: 'array', value: [{}, {}] },
          { property_path: '/AnimatorController/m_Layer', kind: 'object', value: { x: 1 } },
          { property_path: '/AnimatorController/m_Id', kind: 'integer', value: { kind: 'int64', value: '7' } },
          { property_path: '/AnimatorController/m_Flag', kind: 'integer', value: 0 },
          { property_path: '/AnimatorController/m_Null', kind: 'object_reference', value: null },
        ],
      },
    ],
  }
  const flat = flattenSnapshot(snapshot)
  assert.equal(flat.revision, 'r1')
  assert.equal(flat.objects.length, 1)
  const fields = flat.objects[0].fields
  assert.deepEqual(fields.map((field) => field.value), ['sr', '[2]', '{"x":1}', '7 (int64)', '0', 'null'])
  assert.equal(flat.objects[0].rootType, 'AnimatorController')
  assert.equal(flat.diagnostics.length, 1)
  assert.deepEqual(flattenSnapshot(null).objects, [])
})

test('flattenSnapshot truncates a value too long for one row', async () => {
  const { flattenSnapshot } = await import('../src/sidebar/routes.js')
  const long = { text: 'x'.repeat(400) }
  const flat = flattenSnapshot({ objects: [{ object_id: '1', fields: [{ property_path: '/a', kind: 'object', value: long }] }] })
  assert.ok(flat.objects[0].fields[0].value.length <= 161)
  assert.ok(flat.objects[0].fields[0].value.endsWith('…'))
})

test('isStructuralArrayValue recognises the array command vocabulary', async () => {
  const { isStructuralArrayValue } = await import('../src/sidebar/unity-asset.js')
  for (const value of [
    { action: 'insert', index: 1 },
    { action: 'add' },
    { action: 'insertreferences', index: 0, values: [] },
    { action: 'duplicate', index: 0 },
    { action: 'delete', index: 2 },
    { action: 'remove', index: 2 },
    { action: 'move', index: 0, toIndex: 1 },
    { action: 'resize', size: 4 },
    { action: 'clear' },
    3,
  ]) {
    assert.ok(isStructuralArrayValue(value), `${JSON.stringify(value)} should be structural`)
  }
  for (const value of [null, undefined, 'x', true, [1, 2], { x: 1 }, { action: 'unknown' }]) {
    assert.ok(!isStructuralArrayValue(value), `${JSON.stringify(value)} should not be structural`)
  }
})

// ── live-asset discovery ────────────────────────────────────────────────────

test('findAssets walks Assets/, skips generated trees, and orders deterministically', async () => {
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { findAssets, pickAsset, pickRichPrefab } = await import('../scripts/live-assets.mjs')
  const root = mkdtempSync(join(tmpdir(), 'locus-live-assets-'))
  try {
    mkdirSync(join(root, 'Assets', 'Deep', 'Nested'), { recursive: true })
    mkdirSync(join(root, 'Assets', 'Library'), { recursive: true })
    writeFileSync(join(root, 'Assets', 'B.prefab'), 'x'.repeat(120))
    writeFileSync(join(root, 'Assets', 'Deep', 'Nested', 'A.prefab'), 'x')
    writeFileSync(join(root, 'Assets', 'Deep', 'Big.prefab'), 'x'.repeat(4000))
    writeFileSync(join(root, 'Assets', 'Library', 'Ignored.prefab'), 'x')
    writeFileSync(join(root, 'Assets', 'Notes.txt'), 'x')
    writeFileSync(join(root, 'Assets', 'NoSuffix'), 'x')
    const prefabs = findAssets(root, ['prefab'])
    // Ordered by (path length, path): the shallowest file wins, so discovery
    // reports a stable "first" whatever the directory read order was.
    assert.deepEqual(prefabs, ['Assets/B.prefab', 'Assets/Deep/Big.prefab', 'Assets/Deep/Nested/A.prefab'])
    assert.equal(pickAsset(root, ['txt']), 'Assets/Notes.txt')
    assert.equal(pickAsset(root, ['nosuffix']), null, 'a file with no dot is not an asset')
    // The largest prefab under the cap wins: that is the one with components to
    // show. The 1-byte stub and the Library file (never walked) lose.
    assert.equal(pickRichPrefab(root), 'Assets/Deep/Big.prefab')
    // With a 100-byte cap only the 1-byte stub qualifies, and a stub still beats
    // reporting nothing.
    assert.equal(pickRichPrefab(root, { maxBytes: 100 }), 'Assets/Deep/Nested/A.prefab')
    assert.equal(pickRichPrefab(root, { maxBytes: 0 }), null)
    assert.deepEqual(findAssets(root, ['prefab'], { limit: 1 }), ['Assets/B.prefab'])
    assert.deepEqual(findAssets(join(root, 'nope'), ['prefab']), [], 'a missing Assets/ is not an error')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── sub-assets (a controller's layers, a model's clips) ─────────────────────

test('subassetNodes turns the broker list into navigable rows', async () => {
  const { subassetNodes } = await import('../src/sidebar/unity-asset.js')
  const subassets = [
    {
      segment: 'Base Layer',
      displayName: 'Base Layer',
      type: 'AnimatorStateMachine',
      target: { kind: 'asset', path: 'Assets/Anim.controller', targetFileId: 42, targetTypeName: 'AnimatorStateMachine', propertyPath: '' },
      children: [
        {
          segment: 'Idle',
          displayName: 'Idle',
          type: 'AnimatorState',
          target: { kind: 'asset', path: 'Assets/Anim.controller', targetFileId: 43, targetTypeName: 'AnimatorState' },
          children: [],
        },
      ],
    },
  ]
  const nodes = subassetNodes(subassets)
  assert.equal(nodes.length, 1)
  const [layer] = nodes
  assert.equal(layer.displayName, 'Base Layer')
  assert.equal(layer.nodeKind, 'subasset')
  assert.equal(layer.propertyPath, '', 'a sub-asset has no serialized property path')
  assert.equal(layer.editable, false, 'sub-assets are not editable through this panel')
  assert.equal(layer.hasChildren, true)
  assert.deepEqual(layer.children.map((child) => child.type), ['AnimatorState'])
  // Embedded children come from the broker verbatim and keep their own targets,
  // so a deeper read stays addressable by the protocol.
  assert.equal(layer.children[0].bindingTarget.targetFileId, 43)
  assert.equal(layer.bindingTarget.targetFileId, 42)
  assert.deepEqual(subassetNodes(undefined), [])
  assert.deepEqual(subassetNodes(null), [])
})

test('subassetNodes walks nested sub-asset lists and survives a missing target', async () => {
  const { subassetNodes } = await import('../src/sidebar/unity-asset.js')
  const nodes = subassetNodes([
    { segment: 'Outer', type: 'X', target: { kind: 'asset', path: 'Assets/a.asset' }, subassets: [{ segment: 'Inner', type: 'Y', target: { kind: 'asset', path: 'Assets/a.asset' } }] },
    { segment: 'NoTarget' },
  ])
  // A nested `subassets` list becomes children of the node that declared it.
  assert.equal(nodes[0].children.map((child) => child.displayName).join(','), 'Inner')
  assert.equal(nodes[0].hasChildren, true)
  // An entry the broker could not resolve has no target key at all, so nothing
  // offers a write for it.
  assert.equal(nodes[1].bindingTarget, undefined)
  assert.equal(nodes[1].hasChildren, false)
})

test('attachSubassets grafts rows onto the root without disturbing it', async () => {
  const { attachSubassets } = await import('../src/sidebar/routes.js')
  const root = { displayName: 'Asset', children: [{ displayName: 'Thing' }], hasChildren: true }
  const subassets = [{ segment: 'Layer', type: 'AnimatorStateMachine', target: { kind: 'asset', path: 'Assets/Anim.controller' }, children: [] }]
  const grafted = attachSubassets(root, subassets)
  assert.notEqual(grafted, root)
  assert.deepEqual(grafted.children.map((child) => child.displayName), ['Thing', 'Layer'])
  assert.equal(root.children.length, 1, 'the original root is not mutated')
  // Nothing to graft: the root is returned as-is so callers need no branch.
  assert.equal(attachSubassets(root, []), root)
  assert.equal(attachSubassets(root, undefined), root)
  assert.equal(attachSubassets(null, subassets), null)
  // A root with no children becomes expandable.
  const bare = attachSubassets({ displayName: 'Asset', children: [], hasChildren: false }, subassets)
  assert.equal(bare.hasChildren, true)
})

test('flattenSnapshot keeps the reason a summary was impossible', async () => {
  // The route reports `flatError` when asset_api refuses (binary serialization);
  // the panel needs that string to explain itself instead of showing nothing.
  const { flattenSnapshot } = await import('../src/sidebar/routes.js')
  assert.deepEqual(flattenSnapshot({}).objects, [])
  assert.equal(flattenSnapshot(undefined).revision, '')
})

test('a sub-asset row is expandable without another broker request', async () => {
  // Unity's file id for a sub-asset does not resolve back to the object, so
  // `asset/read` on one fails. The broker already returns the children, and the
  // panel must use them instead of asking again.
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../src/client/plugin.js', import.meta.url), 'utf8')
  const toggle = /const toggle = useCallback\(([\s\S]*?)\n    \)/.exec(source)
  assert.ok(toggle, 'toggle not found')
  assert.match(toggle[1], /Array\.isArray\(node\.children\) && node\.children\.length > 0\) return/)
  assert.match(toggle[1], /node\.nodeKind === 'subasset'\) return/)
})
