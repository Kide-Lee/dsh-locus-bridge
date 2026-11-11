// Live smoke test for the right-Sidebar asset routes.
//
// It boots a tiny fake "web host" that supplies the three Context services the
// route module asks for, registers the routes, and calls them over a real HTTP
// socket against the running Unity editor. That is the closest a headless run
// can get to "open an asset in the Sidebar".
//
// Every asset it touches is DISCOVERED, never named: the project under test is
// somebody's real project, so this script must run against anything. It is also
// careful about side effects:
//
//   * reads, thumbnails, orbit frames and traversal refusals change nothing;
//   * a property edit happens in memory only (that is Unity's own model — an
//     edit dirties the object and never rewrites the file), is reverted to its
//     original value, and the file's digest is compared before and after;
//   * `/asset/save` is exercised on a scratch copy this script creates and then
//     deletes, never on the project's own content.
//
// Usage: node scripts/live-sidebar.mjs [--project <dir>] [--prefab <Assets/…>]
//                                      [--skip-save] [--verbose]

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { ROUTE_PREFIX, registerAssetRoutes } from '../src/sidebar/routes.js'
import { shutdownPool } from '../src/client-pool.js'
import { findAssets, pickAsset, pickRichPrefab, pickScene } from './live-assets.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const valueOf = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const projectRoot = resolve(ROOT, valueOf('--project', 'unity-test'))
const verbose = flag('--verbose')
const skipSave = flag('--skip-save')
const SESSION = 'live-sidebar-session'

/** Minimal Context face: the routes ask for a web server and three services. */
function makeHost() {
  const handlers = []
  const effects = []
  const ctx = {
    webServer: {
      register(route) {
        handlers.push(route)
        return () => {}
      },
    },
    effect(fn) {
      const dispose = fn()
      effects.push(dispose)
    },
    get(name) {
      if (name === 'sessions') {
        return { get: (id) => (id === SESSION ? { header: { cwd: projectRoot } } : undefined) }
      }
      if (name === 'workingDirectory') return { get: () => projectRoot }
      if (name === 'connection') return { requestRejection: () => undefined }
      return undefined
    },
    handlers,
    effects,
  }
  registerAssetRoutes(ctx)
  return ctx
}

function listen(handlers) {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://dsh.internal').pathname
    const route = handlers.find((entry) => entry.path === path)
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { code: 'not-found', message: `no route for ${path}` } }))
      return
    }
    void route.handler(req, res).catch((error) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: { code: 'host-error', message: String(error?.message ?? error) } }))
    })
  })
  return new Promise((done) => {
    server.listen(0, '127.0.0.1', () => done(server))
  })
}

const baseOf = (server) => `http://127.0.0.1:${server.address().port}${ROUTE_PREFIX}`

async function request(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { raw: text.slice(0, 200) }
  }
  return { status: response.status, headers: response.headers, body }
}

const getJson = (url) => request(url, {})
const postJson = (url, payload) => request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function findNode(root, predicate, depth = 0) {
  if (!root || depth > 12) return null
  if (predicate(root)) return root
  for (const child of root.children ?? []) {
    const found = findNode(child, predicate, depth + 1)
    if (found) return found
  }
  return null
}

const report = []
function step(name, ok, detail) {
  report.push({ name, ok, detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')
const assetPathOf = (path) => join(projectRoot, path)

/** Run one named check; a throw records a failure instead of ending the run. */
async function check(name, fn) {
  try {
    const detail = await fn()
    step(name, true, detail)
  } catch (error) {
    step(name, false, String(error?.message ?? error).slice(0, 300))
  }
}

/**
 * A leaf the panel can write, and whose write Unity will actually persist.
 *
 * Two exclusions, both real Unity behaviour rather than test convenience:
 *
 *   * **The prefab root's `m_Name`.** Unity derives a prefab asset's root name
 *     from the file name and drops a change to it on save, so a write there is
 *     accepted and then silently discarded. Any *other* object's name persists.
 *   * **Anything not addressable** (a node without a binding target).
 *
 * A child Transform's position is preferred because it is numeric, obviously
 * persisted, and cheap to compare.
 */
function pickEditableLeaf(root, { allowRootName = false } = {}) {
  const kinds = new Set(['Float', 'Double', 'Integer', 'String', 'Vector3', 'Vector2', 'Color', 'Boolean'])
  const rootTarget = root?.bindingTarget ? nodeTargetKey(root) : null
  const candidates = []
  const walk = (node, depth) => {
    for (const child of node.children ?? []) {
      const usable = child.editable !== false && !child.hasChildren && kinds.has(String(child.valueType ?? child.type)) && child.bindingTarget
      if (usable) {
        const isRootName = child.propertyPath === 'm_Name' && nodeTargetKey(child) === rootTarget
        if (allowRootName || !isRootName) candidates.push({ node: child, depth })
      }
      walk(child, depth + 1)
    }
  }
  walk(root, 0)
  // Prefer a vector deeper in the tree (a Transform position on a child), then
  // any deeper leaf, then whatever is left.
  const vector = candidates.find((entry) => entry.node.valueType === 'Vector3' && entry.depth >= 2)
  return (vector ?? candidates.find((entry) => entry.depth >= 1) ?? candidates[0])?.node ?? null
}

/** Identity of a node's target object, without its property path. */
function nodeTargetKey(node) {
  const binding = node?.bindingTarget ?? {}
  return binding.globalObjectId || `${binding.path ?? ''}#${binding.targetFileId ?? ''}#${binding.componentType ?? ''}`
}

/** The write payload for a leaf that means "same value, imperceptibly changed". */
function nudge(leaf) {
  const type = String(leaf.valueType ?? leaf.type)
  if (type === 'Boolean') return !(leaf.value === true || leaf.value === 1)
  if (type === 'Integer') return Number(leaf.value ?? 0) + 1
  if (type === 'Float' || type === 'Double') return Number(leaf.value ?? 0) + 0.125
  if (type === 'String') return `${String(leaf.value ?? '')}`
  if (type === 'Color') {
    const value = leaf.value ?? {}
    return { r: Number(value.r ?? 1), g: Number(value.g ?? 1), b: Number(value.b ?? 1), a: Number(value.a ?? 1) }
  }
  // A vector / rect / quaternion: move every numeric component so the diff is
  // unmistakable, and keep any extra members (a `Rect` has four).
  const value = leaf.value ?? {}
  const next = {}
  for (const [key, component] of Object.entries(value)) {
    if (typeof component === 'number') next[key] = component + 0.25
  }
  return next
}

const close = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-4

async function run() {
  const host = makeHost()
  const server = await listen(host.handlers)
  const base = baseOf(server)
  const prefab = valueOf('--prefab', pickRichPrefab(projectRoot))
  const scene = pickScene(projectRoot)
  const formats = {
    prefab,
    scriptable: pickAsset(projectRoot, ['asset']),
    material: pickAsset(projectRoot, ['mat']),
    clip: pickAsset(projectRoot, ['anim']),
    controller: pickAsset(projectRoot, ['controller']),
    texture: pickAsset(projectRoot, ['png', 'jpg', 'tga', 'psd']),
    model: pickAsset(projectRoot, ['fbx', 'obj', 'dae']),
    scene,
  }
  console.log(`project: ${projectRoot}`)
  for (const [kind, path] of Object.entries(formats)) console.log(`  ${kind.padEnd(11)} ${path ?? '(none found)'}`)
  console.log(`  ${'prefabs'.padEnd(11)} ${findAssets(projectRoot, ['prefab']).length} discovered\n`)

  try {
    // ── connection ─────────────────────────────────────────────────────────
    await check('GET status', async () => {
      const answer = await getJson(`${base}/status?sessionId=${SESSION}`)
      assert(answer.status === 200, `HTTP ${answer.status}: ${JSON.stringify(answer.body).slice(0, 200)}`)
      assert(answer.body.connected === true || answer.body.error, 'neither connected nor an error')
      return `${answer.body.projectName ?? '?'} / ${String(answer.body.status ?? answer.body.error ?? '').split('|')[0]}`
    })

    // ── every format the panel claims ──────────────────────────────────────
    const readAsset = async (label, path, { minRows = 1 } = {}) => {
      const answer = await getJson(`${base}/asset?sessionId=${SESSION}&path=${encodeURIComponent(path)}`)
      assert(answer.status === 200, `${label}: HTTP ${answer.status}: ${JSON.stringify(answer.body.error ?? answer.body).slice(0, 200)}`)
      const rows = (answer.body.tree?.children ?? []).length
      const flatObjects = answer.body.flat?.objects?.length ?? 0
      assert(rows >= minRows || flatObjects > 0, `${label}: empty tree and no summary`)
      return { ...answer.body, rows, flatObjects }
    }

    if (prefab) {
      await check('GET asset (prefab)', async () => {
        const body = await readAsset('prefab', prefab)
        const objects = (body.tree?.children ?? []).map((child) => child.type).filter(Boolean)
        return `${body.rows} objects${objects.length ? `: ${[...new Set(objects)].slice(0, 4).join(', ')}` : ''}${body.flatObjects ? `, ${body.flatObjects} flat objects` : ''}`
      })
    }
    for (const [label, path] of [
      ['scriptable object', formats.scriptable],
      ['material', formats.material],
      ['animation clip', formats.clip],
      ['texture', formats.texture],
    ]) {
      if (!path) continue
      await check(`GET asset (${label})`, async () => {
        const body = await readAsset(label, path)
        return `${body.rows} rows`
      })
    }
    if (formats.controller) {
      await check('GET asset (controller sub-assets)', async () => {
        const body = await readAsset('controller', formats.controller, { minRows: 0 })
        // A controller has no serialized children; its layers and states are
        // sub-assets, which the route grafts on as ordinary rows. (A text-YAML
        // project may instead get a flat `asset_api` summary — either is fine,
        // an empty panel is not.)
        assert(body.rows > 0 || body.flatObjects > 0, 'a controller must expose sub-assets or a summary')
        return `${body.rows} sub-asset rows${body.flatObjects ? `, ${body.flatObjects} flat objects` : ''}`
      })
    }
    if (scene) {
      await check('GET asset (scene, read-only)', async () => {
        const answer = await getJson(`${base}/asset?sessionId=${SESSION}&path=${encodeURIComponent(scene)}`)
        if (answer.status === 200) {
          assert(answer.body.editable === false, 'a scene must never be editable from the Sidebar')
          return `${(answer.body.tree?.children ?? []).length} roots, editable=false`
        }
        // Reading a scene requires it to be open in the editor — a precondition
        // the panel reports rather than satisfying by loading the scene.
        assert(answer.status === 409 && answer.body.error?.code === 'unity_scene_not_loaded', `HTTP ${answer.status}: ${JSON.stringify(answer.body.error ?? answer.body).slice(0, 160)}`)
        return '409 unity_scene_not_loaded (the editor has no such scene open)'
      })
      await check('POST asset/write refuses a scene', async () => {
        // A synthetic node is enough: the read-only refusal is a precondition of
        // the path, not a property of the node.
        const node = { propertyPath: 'm_Name', bindingTarget: { kind: 'asset', path: scene }, valueType: 'String', value: 'x' }
        const answer = await postJson(`${base}/asset/write`, { sessionId: SESSION, path: scene, node, value: 'y' })
        assert(answer.status === 409, `HTTP ${answer.status}: ${JSON.stringify(answer.body.error ?? answer.body).slice(0, 160)}`)
        assert(answer.body.error?.code === 'unity_read_only', `unexpected code ${answer.body.error?.code}`)
        return answer.body.error.code
      })
    }

    // ── nested subtree ─────────────────────────────────────────────────────
    if (prefab) {
      await check('POST asset/read (subtree)', async () => {
        const root = (await readAsset('prefab', prefab)).tree
        const object = findNode(root, (node) => Array.isArray(node.children) && node.children.length > 0 && node.nodeKind === 'object')
        assert(object, 'no expandable object node')
        const answer = await postJson(`${base}/asset/read`, { sessionId: SESSION, path: prefab, node: object, depth: 2 })
        assert(answer.status === 200 && answer.body.tree, `HTTP ${answer.status}: ${JSON.stringify(answer.body.error ?? answer.body).slice(0, 200)}`)
        return `${object.displayName}: ${(answer.body.tree.children ?? []).length} children`
      })
    }

    // ── an in-memory edit, then its revert, with the file digest as witness ─
    if (prefab) {
      await check('POST asset/write (in-memory) + revert', async () => {
        const before = sha256(assetPathOf(prefab))
        const body = await readAsset('prefab', prefab)
        const leaf = pickEditableLeaf(body.tree)
        assert(leaf, 'no editable leaf found in this prefab')
        const original = leaf.value
        const probe = nudge(leaf)
        const write = await postJson(`${base}/asset/write`, { sessionId: SESSION, path: prefab, node: leaf, value: probe })
        assert(write.status === 200, `write answered ${write.status}: ${JSON.stringify(write.body.error ?? write.body).slice(0, 200)}`)
        const changed = write.body.node?.value
        const reverted = await postJson(`${base}/asset/write`, { sessionId: SESSION, path: prefab, node: leaf, value: original })
        assert(reverted.status === 200, `revert answered ${reverted.status}: ${JSON.stringify(reverted.body.error ?? reverted.body).slice(0, 200)}`)
        const after = sha256(assetPathOf(prefab))
        assert(before === after, 'the asset file changed on disk; a Sidebar edit must stay in memory until Save')
        return `${leaf.displayName} ${JSON.stringify(original)} → ${JSON.stringify(changed)} → reverted, file digest unchanged`
      })
    }

    // ── Save, on a scratch copy this run owns ─────────────────────────────
    if (prefab && !skipSave) {
      await check('POST asset/save (scratch copy)', async () => {
        const scratchDir = `Assets/__locus_sidebar_probe_${Date.now().toString(36)}`
        const scratch = `${scratchDir}/probe.prefab`
        const source = sha256(assetPathOf(prefab))
        try {
          const made = await postJson(`${base}/asset/read`, {
            sessionId: SESSION,
            path: prefab,
            node: { bindingTarget: { kind: 'asset', path: prefab }, propertyPath: '' },
            depth: 1,
          })
          void made
          // Create the copy through the editor, which is the only route that
          // can produce a valid asset (a byte copy is not enough for Unity).
          const created = await callEditor(`AssetDatabase.CreateFolder("Assets", ${JSON.stringify(scratchDir.split('/').pop())});\n` +
            `var src = AssetDatabase.LoadAssetAtPath<UnityEngine.GameObject>(${JSON.stringify(prefab)});\n` +
            `if (src == null) { print("no_prefab"); } else { var copy = UnityEngine.Object.Instantiate(src); bool ok; PrefabUtility.SaveAsPrefabAsset(copy, ${JSON.stringify(scratch)}, out ok); UnityEngine.Object.DestroyImmediate(copy); print("created:" + ok); }`)
          assert(/created:True/i.test(created), `could not create the scratch copy: ${created.slice(0, 120)}`)
          const tree = (await readAsset('scratch', scratch)).tree
          // Never the prefab root's name: Unity drops that on save (see
          // pickEditableLeaf), so it cannot witness persistence.
          const leaf = pickEditableLeaf(tree)
          assert(leaf, 'the scratch copy has no editable leaf')
          const probe = nudge(leaf)
          const write = await postJson(`${base}/asset/write`, { sessionId: SESSION, path: scratch, node: leaf, value: probe })
          assert(write.status === 200, `scratch write answered ${write.status}`)
          assert(
            JSON.stringify(write.body.node?.value) !== JSON.stringify(leaf.value),
            `the write did not change ${leaf.displayName}: ${JSON.stringify(leaf.value)} -> ${JSON.stringify(write.body.node?.value)}`,
          )
          const before = sha256(assetPathOf(scratch))
          const saved = await postJson(`${base}/asset/save`, { sessionId: SESSION, path: scratch })
          assert(saved.status === 200, `save answered ${saved.status}: ${JSON.stringify(saved.body.error ?? saved.body).slice(0, 200)}`)
          const after = sha256(assetPathOf(scratch))
          assert(before !== after, 'save reported success but the scratch prefab did not change on disk')
          assert(sha256(assetPathOf(prefab)) === source, "the source asset's digest changed")
          return `${saved.body.kind}, ${before.slice(0, 8)} → ${after.slice(0, 8)}`
        } finally {
          await callEditor(`AssetDatabase.DeleteAsset(${JSON.stringify(scratchDir)}); print("cleaned");`).catch(() => {})
        }
      })
    }

    // ── images ─────────────────────────────────────────────────────────────
    const imageOf = async (path, query) => {
      const response = await fetch(`${base}/${query}&sessionId=${SESSION}&path=${encodeURIComponent(path)}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      return { response, bytes }
    }
    if (formats.model) {
      await check('GET asset (model, read-only)', async () => {
        const body = await readAsset('model', formats.model, { minRows: 0 })
        assert(body.editable === false, 'a model must be read-only')
        return `${body.rows} rows, editable=false`
      })
      await check('GET frame (model orbit)', async () => {
        const version = (await readAsset('frame', formats.model)).version
        const first = await imageOf(formats.model, `frame?w=320&h=240&yaw=30&pitch=-10&v=${encodeURIComponent(version)}`)
        assert(first.response.status === 200, `HTTP ${first.response.status}: ${first.bytes.toString('utf8').slice(0, 120)}`)
        return `${first.bytes.length} bytes`
      })
      await check('POST asset/write refuses a model', async () => {
        const read = await getJson(`${base}/asset?sessionId=${SESSION}&path=${encodeURIComponent(formats.model)}`)
        const node = read.body.tree?.children?.[0]
        assert(node, 'the model tree has no rows')
        const answer = await postJson(`${base}/asset/write`, { sessionId: SESSION, path: formats.model, node, value: 'x' })
        assert(answer.status === 409, `HTTP ${answer.status}: ${JSON.stringify(answer.body.error ?? answer.body).slice(0, 140)}`)
        return answer.body.error.code
      })
    }
    if (prefab || formats.texture) {
      await check('GET thumb (PNG + ETag revalidation)', async () => {
        const path = formats.texture ?? prefab
        const version = (await readAsset('thumb', path)).version
        const first = await imageOf(path, `thumb?size=192&v=${encodeURIComponent(version)}`)
        assert(first.response.status === 200, `HTTP ${first.response.status}`)
        assert(first.bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'not a PNG')
        const etag = first.response.headers.get('etag')
        const revalidated = await fetch(
          `${base}/thumb?size=192&v=${encodeURIComponent(version)}&sessionId=${SESSION}&path=${encodeURIComponent(path)}`,
          { headers: { 'if-none-match': etag ?? '' } },
        )
        assert(revalidated.status === 304, `revalidation answered ${revalidated.status}`)
        return `${path.split('/').pop()}: ${first.bytes.length} bytes + 304`
      })
    }
    if (prefab) {
      await check('GET frame (orbit render)', async () => {
        const version = (await readAsset('frame', prefab)).version
        const first = await imageOf(prefab, `frame?w=320&h=240&yaw=30&pitch=-10&v=${encodeURIComponent(version)}`)
        assert(first.response.status === 200, `HTTP ${first.response.status}: ${first.bytes.toString('utf8').slice(0, 120)}`)
        return `${first.bytes.length} bytes`
      })
    }

    // ── locking an asset into the editor ───────────────────────────────────
    if (prefab) {
      await check('POST asset/select', async () => {
        const answer = await postJson(`${base}/asset/select`, { sessionId: SESSION, path: prefab })
        assert(answer.status === 200, `HTTP ${answer.status}: ${JSON.stringify(answer.body.error ?? answer.body).slice(0, 160)}`)
        return ''
      })
    }

    // ── refusals ───────────────────────────────────────────────────────────
    for (const [label, path] of [
      ['traversal', 'Assets/../../etc/passwd'],
      ['absolute path', '/etc/hosts'],
      ['outside Assets', 'Packages/manifest.json'],
    ]) {
      await check(`refuses ${label}`, async () => {
        const answer = await getJson(`${base}/asset?sessionId=${SESSION}&path=${encodeURIComponent(path)}`)
        assert(answer.status === 400, `HTTP ${answer.status}`)
        return answer.body.error?.message?.slice(0, 60) ?? ''
      })
    }
    await check('refuses an unknown Session', async () => {
      const answer = await getJson(`${base}/asset?sessionId=nope&path=${encodeURIComponent(prefab ?? 'Assets/x.prefab')}`)
      assert(answer.status === 404, `HTTP ${answer.status}`)
      return ''
    })
    await check('refuses a missing asset', async () => {
      const answer = await getJson(`${base}/asset?sessionId=${SESSION}&path=${encodeURIComponent('Assets/__missing__/nope.prefab')}`)
      assert(answer.status >= 400, `HTTP ${answer.status}`)
      return `HTTP ${answer.status} ${answer.body.error?.code ?? ''}`
    })
  } finally {
    await new Promise((done) => server.close(done))
    for (const dispose of host.effects) await dispose?.()
  }
}

/** Run one C# snippet through the same broker the routes use. */
async function callEditor(code) {
  const { withClient } = await import('../src/client-pool.js')
  const { executeSnippet } = await import('../src/execute.js')
  const { randomUUID } = await import('node:crypto')
  const result = await withClient({ projectRoot }, (client) => executeSnippet(client, { code, executionId: randomUUID(), timeoutMs: 120_000 }))
  if (result.error) throw new Error(String(result.error).slice(0, 300))
  return String(result.output ?? '')
}

run()
  .catch((error) => {
    console.error(verbose ? error : String(error?.message ?? error))
    process.exitCode = 1
  })
  .finally(async () => {
    await shutdownPool().catch(() => {})
    const failed = report.filter((entry) => !entry.ok)
    console.log(`\n${report.length - failed.length}/${report.length} live checks passed`)
    process.exitCode = failed.length > 0 ? 1 : 0
    process.exit(process.exitCode)
  })
