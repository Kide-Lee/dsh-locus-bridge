// Model-preview transport and frame-cache behavior.
//
// These tests stay off Unity: they cover the two Host-side pieces the browser
// model viewer and the prefab orbit cache rely on — raw `.fbx`/`.glb` bytes and
// the "last frame" sidecar — plus the path/format gates that keep both inside
// the project.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FRAME_CACHE_DIR,
  frameCacheKey,
  frameParamsMatch,
  readFrameCache,
  sourceMtimeMs,
  writeFrameCache,
} from '../src/sidebar/frame-cache.js'
import { isWebModelPath, webModelMimeType } from '../src/sidebar/paths.js'
import { registerAssetRoutes, ROUTE_PREFIX } from '../src/sidebar/routes.js'

/** One throwaway Unity project with a session pointing at it. */
function fixture() {
  const project = mkdtempSync(join(tmpdir(), 'locus-model-'))
  mkdirSync(join(project, 'Assets', 'Models'), { recursive: true })
  mkdirSync(join(project, 'ProjectSettings'), { recursive: true })
  const session = 'session-model'
  const handlers = []
  registerAssetRoutes({
    webServer: {
      register(route) {
        handlers.push(route)
        return () => {}
      },
    },
    effect: (fn) => fn(),
    get: (name) =>
      name === 'sessions'
        ? { get: (id) => (id === session ? { header: { cwd: project } } : undefined) }
        : name === 'workingDirectory'
          ? { get: () => project }
          : name === 'connection'
            ? { requestRejection: () => undefined }
            : undefined,
  })
  return { project, session, handlers }
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

test('web model formats are fbx/glb only and get a useful MIME type', () => {
  assert.ok(isWebModelPath('Assets/Models/Hero.fbx'))
  assert.ok(isWebModelPath('Assets/Models/Hero.GLB'))
  assert.ok(!isWebModelPath('Assets/Models/Hero.obj'))
  assert.ok(!isWebModelPath('Assets/Models/Hero.gltf'))
  assert.ok(!isWebModelPath('Assets/Prefabs/Hero.prefab'))
  assert.equal(webModelMimeType('Assets/Hero.glb'), 'model/gltf-binary')
  assert.equal(webModelMimeType('Assets/Hero.fbx'), 'application/octet-stream')
})

test('the frame cache key is case-insensitive and stable', () => {
  assert.equal(frameCacheKey('Assets/Models/Hero.prefab'), frameCacheKey('assets/models/hero.prefab'))
  assert.notEqual(frameCacheKey('Assets/A.prefab'), frameCacheKey('Assets/B.prefab'))
  assert.match(frameCacheKey('Assets/A.prefab'), /^[a-f0-9]{64}$/)
})

test('a frame sidecar round-trips, and a changed asset invalidates it', () => {
  const project = mkdtempSync(join(tmpdir(), 'locus-frame-cache-'))
  const asset = 'Assets/Models/Hero.prefab'
  mkdirSync(join(project, 'Assets', 'Models'), { recursive: true })
  writeFileSync(join(project, asset), 'prefab-v1')
  try {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    writeFrameCache(project, asset, {
      bytes,
      width: 480,
      height: 360,
      yaw: 31,
      pitch: -9,
      distance: 1.2,
      panX: 0.1,
      panY: 0.2,
      panZ: 0.3,
    })
    assert.ok(sourceMtimeMs(project, asset) > 0)
    const cached = readFrameCache(project, asset)
    assert.ok(cached)
    assert.deepEqual(cached.bytes, bytes)
    assert.equal(cached.width, 480)
    assert.equal(cached.yaw, 31)
    assert.equal(cached.pitch, -9)
    assert.ok(frameParamsMatch(cached, { yaw: 31, pitch: -9, distance: 1.2, panX: 0.1, panY: 0.2, panZ: 0.3 }))
    assert.ok(!frameParamsMatch(cached, { yaw: 0, pitch: -9, distance: 1.2, panX: 0.1, panY: 0.2, panZ: 0.3 }))

    // The cache lives where Locus puts it.
    assert.ok(FRAME_CACHE_DIR.join('/').includes('asset-preview-cache'))

    // Rewriting the source (new mtime) must invalidate the sidecar. `utimesSync`
    // makes the change deterministic: two writes can land in the same
    // millisecond on a coarse filesystem.
    const absolute = join(project, asset)
    const before = statSync(absolute)
    writeFileSync(absolute, 'prefab-v2')
    const stamp = new Date(before.mtimeMs + 10_000)
    utimesSync(absolute, stamp, stamp)
    assert.equal(readFrameCache(project, asset), null)
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('the lazy model viewer bundle is served as same-origin JavaScript', async () => {
  const { project, handlers } = fixture()
  try {
    await serve(handlers, async (base) => {
      const response = await fetch(`${base}/model-viewer.js`)
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /^text\/javascript/)
      const source = await response.text()
      assert.ok(source.length > 100_000, 'the three.js bundle should be built, not a stub')
      assert.match(source, /export\{[^}]*\bmount\b[^}]*\}/)
    })
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('the model route serves raw glb bytes and refuses everything else', async () => {
  const { project, session, handlers } = fixture()
  const glb = Buffer.from('glTF\x02\x00\x00\x00payload')
  writeFileSync(join(project, 'Assets', 'Models', 'Hero.glb'), glb)
  writeFileSync(join(project, 'Assets', 'Models', 'Hero.obj'), 'v 0 0 0\n')
  try {
    await serve(handlers, async (base) => {
      const model = await fetch(`${base}/model?sessionId=${session}&path=${encodeURIComponent('Assets/Models/Hero.glb')}`)
      assert.equal(model.status, 200)
      assert.equal(model.headers.get('content-type'), 'model/gltf-binary')
      assert.deepEqual(Buffer.from(await model.arrayBuffer()), glb)

      const unsupported = await fetch(`${base}/model?sessionId=${session}&path=${encodeURIComponent('Assets/Models/Hero.obj')}`)
      assert.equal(unsupported.status, 400)

      const missing = await fetch(`${base}/model?sessionId=${session}&path=${encodeURIComponent('Assets/Models/Nope.glb')}`)
      assert.equal(missing.status, 404)

      const traversal = await fetch(`${base}/model?sessionId=${session}&path=${encodeURIComponent('Assets/../Secret.glb')}`)
      assert.equal(traversal.status, 400)
    })
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('the frame route serves a matching disk frame without Unity', async () => {
  const { project, session, handlers } = fixture()
  const prefab = 'Assets/Models/Hero.prefab'
  writeFileSync(join(project, prefab), 'prefab')
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01])
  writeFrameCache(project, prefab, {
    bytes,
    width: 480,
    height: 360,
    yaw: 33,
    pitch: -7,
    distance: 1.3,
    panX: 0.2,
    panY: 0.1,
    panZ: 0.4,
  })
  try {
    await serve(handlers, async (base) => {
      const query = new URLSearchParams({
        sessionId: session,
        path: prefab,
        yaw: '33',
        pitch: '-7',
        distance: '1.3',
        panX: '0.2',
        panY: '0.1',
        panZ: '0.4',
        cache: '0',
      })
      const response = await fetch(`${base}/frame?${query.toString()}`)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('x-locus-frame-source'), 'cache')
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
    })
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('the frame route restores the cached camera and PNG without Unity', async () => {
  const { project, session, handlers } = fixture()
  const prefab = 'Assets/Models/Hero.prefab'
  writeFileSync(join(project, prefab), 'prefab')
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
  writeFrameCache(project, prefab, {
    bytes,
    width: 480,
    height: 360,
    yaw: 33,
    pitch: -7,
    distance: 1.3,
    panX: 0.2,
    panY: 0.1,
    panZ: 0.4,
  })
  try {
    await serve(handlers, async (base) => {
      const restored = await fetch(`${base}/frame?sessionId=${session}&path=${encodeURIComponent(prefab)}&restore=1`)
      assert.equal(restored.status, 200)
      assert.equal(restored.headers.get('content-type'), 'image/png')
      assert.equal(restored.headers.get('x-locus-frame-yaw'), '33')
      assert.equal(restored.headers.get('x-locus-frame-source'), 'cache')
      assert.deepEqual(Buffer.from(await restored.arrayBuffer()), bytes)

      const miss = await fetch(
        `${base}/frame?sessionId=${session}&path=${encodeURIComponent('Assets/Models/Other.prefab')}&restore=1`,
      )
      assert.equal(miss.status, 404)
      assert.equal((await miss.json()).error.code, 'frame_cache_miss')
    })
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})
