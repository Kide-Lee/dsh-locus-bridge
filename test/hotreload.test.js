// Hot reload: the JS half of `unity_hot_reload` (contracts.md §2.2/§2.3).
//
// Everything here runs against test/fake-broker.js with `onMessage`
// interception, so no Unity editor is needed: the four `dsh_hot_reload_*`
// extension messages are answered from fixtures exactly as
// packages/unity-bridge/Editor/HotReload/ answers them in a real domain.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocusClient, LocusError } from '../src/locus-client.js'
import { __resetPoolForTest, __setClientForTest, shutdownPool } from '../src/client-pool.js'
import { resolvePipeName } from '../src/pipe-name.js'
import {
  HOT_RELOAD_MODES,
  applyHotPatch,
  classifyHotEdit,
  disposeHotPatches,
  formatHotReload,
  hotReload,
  hotReloadStatus,
} from '../src/hotreload.js'
import { recompile, runRecompile, scriptReloadPayload } from '../src/recompile.js'
import { startFakeBroker } from './fake-broker.js'

const PROJECT = mkdtempSync(join(tmpdir(), 'locus-hotreload-test-'))
mkdirSync(join(PROJECT, 'Assets', 'Scripts'), { recursive: true })
mkdirSync(join(PROJECT, 'ProjectSettings'), { recursive: true })
process.on('exit', () => rmSync(PROJECT, { recursive: true, force: true }))

const TARGET = { projectRoot: PROJECT }

/** Reply to one request the way the payload's extension dispatcher does. */
function answer(socket, request, body) {
  socket.write(JSON.stringify({ type: 'response', reply_to: request.id, ok: true, message: JSON.stringify(body) }) + '\n')
  return true
}

/** Reply the way LocusBridge.HandleExtensionMessageAsync does on a handler throw. */
function refuse(socket, request, error) {
  socket.write(JSON.stringify({ type: 'response', reply_to: request.id, ok: false, error }) + '\n')
  return true
}

// The editor speaks `source_path` (HotPatchMethodDto); a regression once dropped
// every hot method because only `path` was read, so the tool claimed "no edited
// scripts were given" while the classifier had answered correctly.
// Both spellings appear in practice: the classifier answers `source_path`
// (HotPatchMethodDto, like the payload), while a caller round-tripping the
// normalized form sends `path`. A regression once dropped every hot method
// because only `path` was read, so the tool claimed "no edited scripts were
// given" although the editor had answered correctly.
function hotMethod(overrides = {}) {
  return {
    source_path: 'Assets/Scripts/Player.cs',
    method_key: 'Game.Player|Update||i',
    declaring_type: 'Game.Player',
    name: 'Update',
    param_type_names: [],
    param_type_sigs: [],
    is_static: false,
    is_ctor: false,
    ...overrides,
  }
}

async function withEditor(fn, { onMessage } = {}) {
  const requests = []
  const handler = onMessage ?? (() => undefined)
  const broker = await startFakeBroker({
    onMessage: (request, helpers, socket) => {
      requests.push(request)
      return handler(request, { ...helpers, broker }, socket)
    },
  })
  const client = new LocusClient({ pipe: 'fake', stream: broker.stream })
  await client.connect()
  __resetPoolForTest()
  __setClientForTest(resolvePipeName({ projectRoot: PROJECT }), client)
  try {
    return await fn({ broker, client, requests })
  } finally {
    await shutdownPool()
    __resetPoolForTest()
    await broker.close()
  }
}

test('HOT_RELOAD_MODES matches the unity_recompile mode enum', () => {
  assert.deepEqual([...HOT_RELOAD_MODES], ['auto', 'compile', 'scripts'])
  assert.ok(Object.isFrozen(HOT_RELOAD_MODES))
})

test('classifyHotEdit sends paths and decodes the editor answer', async () => {
  await withEditor(
    async ({ requests, client }) => {
      const result = await classifyHotEdit(client, {
        paths: ['Assets/Scripts/Player.cs', 'Assets/Scripts/Enemy.cs'],
      })
      const request = requests.find((item) => item.type === 'dsh_hot_reload_classify')
      const body = JSON.parse(request.message)
      assert.deepEqual(body.paths, ['Assets/Scripts/Player.cs', 'Assets/Scripts/Enemy.cs'])
      assert.match(body.patch_id, /^dsh-hot-/)

      assert.equal(result.hot.length, 1)
      assert.equal(result.hot[0].method_key, 'Game.Player|Update||i')
      assert.equal(result.hot[0].declaring_type, 'Game.Player')
      assert.deepEqual(result.hot[0].param_type_names, [])
      assert.equal(result.hot[0].is_ctor, false)
      assert.deepEqual(result.needCompile, [{ path: 'Assets/Scripts/Enemy.cs', reason: 'field layout changed' }])
      assert.deepEqual(result.failed, [])
      assert.equal(result.supported, true)
    },
    {
      onMessage: (request, _helpers, socket) => {
        if (request.type !== 'dsh_hot_reload_classify') return undefined
        return answer(socket, request, {
          hot: [hotMethod()],
          needCompile: [{ path: 'Assets/Scripts/Enemy.cs', reason: 'field layout changed' }],
          failed: [],
          supported: true,
        })
      },
    },
  )
})

test('classifyHotEdit rejects an empty path list before touching the broker', async () => {
  await withEditor(
    async ({ requests, client }) => {
      const before = requests.length
      await assert.rejects(() => classifyHotEdit(client, { paths: [] }), /at least one Assets\/ or Packages\/ path/)
      assert.equal(requests.length, before, 'no classify request was written')
    },
  )
})

test('classifyHotEdit surfaces a handler-side {"error": …} body', async () => {
  await withEditor(
    async ({ client }) => {
      await assert.rejects(() => classifyHotEdit(client, { paths: ['Assets/Scripts/Player.cs'] }), /sidecar not ready/)
    },
    {
      onMessage: (request, _helpers, socket) => {
        if (request.type === 'dsh_hot_reload_classify') return answer(socket, request, { error: 'sidecar not ready' })
        return undefined
      },
    },
  )
})

test('classifyHotEdit surfaces a non-JSON answer honestly', async () => {
  await withEditor(
    async ({ client }) => {
      await assert.rejects(() => classifyHotEdit(client, { paths: ['Assets/Scripts/Player.cs'] }), /invalid JSON/)
    },
    {
      onMessage: (request, _helpers, socket) => {
        if (request.type !== 'dsh_hot_reload_classify') return undefined
        socket.write(JSON.stringify({ type: 'response', reply_to: request.id, ok: true, message: 'not json' }) + '\n')
        return true
      },
    },
  )
})

test('classifyHotEdit surfaces a bridge refusal (unknown message type)', async () => {
  // A payload without this sidecar package answers `unknown command …`; that is
  // a real refusal, not a transient-domain condition, so it must not be retried.
  await withEditor(async ({ client }) => {
    await assert.rejects(() => classifyHotEdit(client, { paths: ['Assets/Scripts/Player.cs'] }), /unknown command/)
  })
})

test('applyHotPatch sends the patch body and reports skipped methods', async () => {
  await withEditor(
    async ({ requests, client }) => {
      const result = await applyHotPatch(client, {
        patchId: 'patch-1',
        assemblyB64: 'AAECAwQ=',
        methods: [hotMethod()],
        domainGeneration: 'gen-1',
      })
      const request = requests.find((item) => item.type === 'dsh_hot_reload_apply')
      const body = JSON.parse(request.message)
      assert.equal(body.patch_id, 'patch-1')
      assert.equal(body.assembly_b64, 'AAECAwQ=')
      assert.equal(body.domain_generation, 'gen-1')
      assert.equal(body.methods.length, 1)
      assert.equal(body.methods[0].method_key, 'Game.Player|Update||i')

      assert.equal(result.applied, 0)
      assert.equal(result.skipped.length, 1)
      assert.equal(result.skipped[0].reason, 'original method not found in the loaded assemblies')
      assert.equal(result.detourEngine, 'detour')
    },
    {
      onMessage: (request, _helpers, socket) => {
        if (request.type !== 'dsh_hot_reload_apply') return undefined
        return answer(socket, request, {
          applied: 0,
          skipped: [{ method_key: 'Game.Player|Update||i', reason: 'original method not found in the loaded assemblies' }],
          detour_engine: 'detour',
          domain_generation: 'gen-1',
        })
      },
    },
  )
})

test('applyHotPatch requires the assembly and a patch id', async () => {
  await withEditor(async ({ requests, client }) => {
    await assert.rejects(() => applyHotPatch(client, { assemblyB64: 'AA==' }), /requires a patchId/)
    const before = requests.length
    await assert.rejects(() => applyHotPatch(client, { patchId: 'p' }), /requires the patch assembly bytes/)
    assert.equal(requests.length, before, 'no apply request was written')
  })
})

test('hotReloadStatus reports the editor detour ledger', async () => {
  await withEditor(
    async ({ client }) => {
      const status = await hotReloadStatus(client)
      assert.equal(status.detours, 1)
      assert.deepEqual(status.patchedMethods, ['Game.Player|Update||i'])
      assert.equal(status.lastError, null)
      assert.equal(status.domainGeneration, 'gen-1')
    },
    {
      onMessage: (request, _helpers, socket) => {
        if (request.type !== 'dsh_hot_reload_status') return undefined
        return answer(socket, request, {
          detours: 1,
          patched_methods: ['Game.Player|Update||i'],
          domain_generation: 'gen-1',
          entries: [{ method_key: 'Game.Player|Update||i', patch_id: 'p', engine: 'detour' }],
        })
      },
    },
  )
})

test('disposeHotPatches sends the patch id, and nothing for "all"', async () => {
  const seen = []
  await withEditor(
    async ({ client }) => {
      assert.deepEqual(await disposeHotPatches(client, { patchId: 'patch-1' }), { disposed: 2 })
      assert.deepEqual(await disposeHotPatches(client), { disposed: 5 })
      assert.deepEqual(seen, [{ patch_id: 'patch-1' }, {}])
    },
    {
      onMessage: (request, _helpers, socket) => {
        if (request.type !== 'dsh_hot_reload_dispose') return undefined
        const body = JSON.parse(request.message)
        seen.push(body)
        return answer(socket, request, { disposed: body.patch_id ? 2 : 5 })
      },
    },
  )
})

test('hotReload normalizes project-relative paths and builds details[]', async () => {
  await withEditor(
    async ({ requests }) => {
      const result = await hotReload(TARGET, {
        paths: ['Assets/Scripts/Player.cs', '/etc/passwd', 'Packages/com.x/Runtime/Y.cs'],
      })
      const request = requests.find((item) => item.type === 'dsh_hot_reload_classify')
      // normalizeChangedPaths drops anything that is not an Assets/ or Packages/ asset.
      assert.deepEqual(JSON.parse(request.message).paths, ['Assets/Scripts/Player.cs', 'Packages/com.x/Runtime/Y.cs'])

      assert.deepEqual(result.details, [
        { path: 'Assets/Scripts/Player.cs', method: 'Game.Player|Update||i', state: 'hot' },
        { path: 'Assets/Scripts/Enemy.cs', state: 'need-compile', reason: 'field layout changed' },
        { path: 'Assets/Broken.cs', state: 'failed', reason: 'CS1002' },
      ])
      assert.equal(result.dryRun, false)
      assert.equal(result.projectRoot, PROJECT)
    },
    {
      onMessage: (request, _helpers, socket) => {
        if (request.type !== 'dsh_hot_reload_classify') return undefined
        return answer(socket, request, {
          hot: [hotMethod()],
          needCompile: [{ path: 'Assets/Scripts/Enemy.cs', reason: 'field layout changed' }],
          failed: [{ path: 'Assets/Broken.cs', error: 'CS1002' }],
          supported: true,
        })
      },
    },
  )
})

test('hotReload retries once across a domain reload window', async () => {
  // A transport-class failure (the reload tore the connection down) is retried
  // once, on a freshly connected client — what `getClient` hands back after a
  // reconnect. The fixture's seeded stream cannot be swapped for a new one, so
  // the reconnect itself is stubbed and the retry's request is what is asserted.
  let calls = 0
  const requests = []
  const transportLoss = new LocusError('locus stream closed', { code: null })
  const client = {
    async request(type, message) {
      requests.push({ type, message })
      calls += 1
      if (calls === 1) throw transportLoss
      return { ok: true, message: JSON.stringify({ hot: [hotMethod()], needCompile: [], failed: [], supported: true }) }
    },
  }
  const broker = await startFakeBroker({ onMessage: () => undefined })
  try {
    __resetPoolForTest()
    __setClientForTest(resolvePipeName({ projectRoot: PROJECT }), {
      connected: true,
      state: 'connected',
      connect: async () => {},
      request: (type, message) => client.request(type, message),
    })
    const result = await hotReload(TARGET, { paths: ['Assets/Scripts/Player.cs'] })
    assert.equal(calls, 2, 'retried exactly once')
    assert.equal(result.hot.length, 1)
    assert.equal(result.hot[0].method_key, 'Game.Player|Update||i')
    assert.deepEqual(
      requests.map((item) => item.type),
      ['dsh_hot_reload_classify', 'dsh_hot_reload_classify'],
    )
  } finally {
    __resetPoolForTest()
    await broker.close()
  }
})

test('hotReload does not retry a refusal that is not about the reload window', async () => {
  let calls = 0
  await withEditor(
    async () => {
      await assert.rejects(() => hotReload(TARGET, { paths: ['Assets/Scripts/Player.cs'] }), /unknown command/)
      assert.equal(calls, 1)
    },
    {
      onMessage: (request) => {
        if (request.type !== 'dsh_hot_reload_classify') return undefined
        calls += 1
        return undefined
      },
    },
  )
})

test('formatHotReload renders hot, needs-compile and failed rows', () => {
  // A normalized entry (`path`, not the editor's `source_path`).
  const text = formatHotReload({
    hot: [hotMethod({ path: 'Assets/Scripts/Player.cs' })],
    needCompile: [{ path: 'Assets/Scripts/Enemy.cs', reason: 'field layout changed' }],
    failed: [{ path: 'Assets/Broken.cs', error: 'CS1002' }],
    details: [],
    dryRun: false,
  })
  assert.match(text, /hot: Assets\/Scripts\/Player\.cs \(1 method\)/)
  assert.match(text, /· Game\.Player\|Update\|\|i/)
  assert.match(text, /needs compile: Assets\/Scripts\/Enemy\.cs — field layout changed/)
  assert.match(text, /failed: Assets\/Broken\.cs — CS1002/)
  assert.match(text, /1 file hot-patchable, 1 needs a compile, 1 could not be read/)
  // No patch was applied, so the rendering must say so rather than imply the
  // method is live.
  assert.match(text, /No method bodies were patched/)
  assert.match(text, /unity_recompile \(mode "auto"/)
})

test('hotReload skips a file the editor reported no revision pair for', async () => {
  // Classification alone still works, but the patch has to reproduce the file's
  // current text: with no readable file there is nothing to compile against, and
  // patching the file onto itself would report a success that changed nothing.
  await withEditor(
    async () => {
      const result = await hotReload(TARGET, { paths: ['Assets/Scripts/Player.cs'] })
      assert.equal(result.dryRun, false)
      assert.deepEqual(result.patches, [])
      assert.deepEqual(result.applied, [])
      assert.equal(result.skipped.length, 1)
      assert.match(result.skipped[0].reason, /no baseline for this file/)
    },
    {
      onMessage: (request, _helpers, socket) => {
        if (request.type !== 'dsh_hot_reload_classify') return undefined
        return answer(socket, request, { hot: [hotMethod()], needCompile: [], failed: [], supported: true })
      },
    },
  )
})

test('formatHotReload reports a patch that could not be compiled', () => {
  const text = formatHotReload({
    hot: [hotMethod({ path: 'Assets/Scripts/Player.cs' })],
    needCompile: [],
    failed: [],
    patches: [],
    applied: [],
    skipped: [{ path: 'Assets/Scripts/Player.cs', reason: 'the patch assembly did not compile' }],
    patchError: '[no_dotnet] no .NET SDK',
    dryRun: false,
  })
  assert.match(text, /not patched: \[no_dotnet\] no \.NET SDK/)
  assert.match(text, /run unity_recompile to converge the edit instead/)
})

test('formatHotReload reports the methods that were detoured', () => {
  const text = formatHotReload({
    hot: [hotMethod({ path: 'Assets/Scripts/Player.cs' })],
    needCompile: [],
    failed: [],
    patches: [{ id: 'dsh-hot-abc-1', path: 'Assets/Scripts/Player.cs', methods: 1, applied: 1 }],
    applied: [{ patchId: 'dsh-hot-abc-1', path: 'Assets/Scripts/Player.cs', method: 'Game.Player.Update()' }],
    skipped: [],
    patchError: null,
    dryRun: false,
  })
  assert.match(text, /patched: 1 method in 1 patch assembly\./)
  assert.match(text, /· Assets\/Scripts\/Player\.cs — 1\/1 method\(s\), patch dsh-hot-abc-1/)
  assert.doesNotMatch(text, /No method bodies were patched/)
})

test('formatHotReload is explicit about a dry run', () => {
  // `path` spelling, the normalized shape a caller round-trips.
  const text = formatHotReload({ hot: [hotMethod({ path: 'Assets/Scripts/Player.cs' })], needCompile: [], failed: [], dryRun: true })
  assert.match(text, /Dry run: nothing was patched\./)
  assert.doesNotMatch(text, /does not compile patch assemblies/)
})

test('formatHotReload handles an empty classification', () => {
  assert.match(formatHotReload({ hot: [], needCompile: [], failed: [] }), /nothing to classify/)
})

// ── src/recompile.js modes (§2.3) ───────────────────────────────────────────

test('runRecompile mode "compile" preserves the classic recompile result', async () => {
  await withEditor(
    async ({ requests }) => {
      const result = await runRecompile(TARGET, { mode: 'compile', reason: 'test' })
      assert.equal(result.mode, 'compile')
      assert.equal(result.status, 'ok')
      assert.equal(result.operationId, JSON.parse(requests.find((item) => item.type === 'request_recompile').message).operationId)
    },
    { onMessage: answeredCompile() },
  )
})

test('runRecompile defaults to the classic compile', async () => {
  await withEditor(
    async () => {
      const result = await runRecompile(TARGET, { reason: 'test' })
      assert.equal(result.mode, 'compile')
      assert.equal(result.status, 'ok')
    },
    { onMessage: answeredCompile() },
  )
})

test('runRecompile rejects an unknown mode without contacting the editor', async () => {
  await withEditor(async ({ requests }) => {
    const before = requests.length
    await assert.rejects(() => runRecompile(TARGET, { mode: 'warp' }), /Invalid mode 'warp'\. Allowed values: auto, compile, scripts\./)
    assert.equal(requests.length, before, 'no compile request was written')
  })
})

test('runRecompile mode "scripts" uses request_script_reload', async () => {
  await withEditor(
    async ({ requests }) => {
      const result = await runRecompile(TARGET, { mode: 'scripts', paths: ['Assets/Scripts/Player.cs'], reason: 'test' })
      const request = requests.find((item) => item.type === 'request_script_reload')
      const body = JSON.parse(request.message)
      assert.equal(body.schema, 1)
      assert.deepEqual(body.paths, ['Assets/Scripts/Player.cs'])
      assert.equal(result.mode, 'scripts')
      assert.equal(result.status, 'reload_requested')
      assert.equal(requests.filter((item) => item.type === 'request_recompile').length, 0)
    },
    {
      onMessage: (request, _helpers, socket) => {
        if (request.type !== 'request_script_reload') return undefined
        socket.write(JSON.stringify({ type: 'response', reply_to: request.id, ok: true, message: 'reload_requested' }) + '\n')
        return true
      },
    },
  )
})

test('runRecompile mode "auto" stops at a fully hot-patchable edit', async () => {
  await withEditor(
    async ({ requests }) => {
      const result = await runRecompile(TARGET, { mode: 'auto', paths: ['Assets/Scripts/Player.cs'] })
      assert.equal(result.mode, 'hot')
      assert.equal(result.status, 'hot')
      assert.equal(result.classification.hot.length, 1)
      assert.equal(requests.filter((item) => item.type === 'request_recompile').length, 0, 'no compile was requested')
    },
    {
      onMessage: (request, _helpers, socket) => {
        if (request.type !== 'dsh_hot_reload_classify') return undefined
        return answer(socket, request, { hot: [hotMethod()], needCompile: [], failed: [], supported: true })
      },
    },
  )
})

test('runRecompile mode "auto" compiles when an edit needs it', async () => {
  await withEditor(
    async ({ requests }) => {
      const result = await runRecompile(TARGET, { mode: 'auto', paths: ['Assets/Scripts/Enemy.cs'] })
      assert.equal(result.mode, 'compile')
      assert.equal(result.status, 'ok')
      assert.equal(result.classification.needCompile.length, 1)
      assert.equal(requests.filter((item) => item.type === 'request_recompile').length, 1)
    },
    {
      onMessage: (request, _helpers, socket) => {
        if (request.type === 'dsh_hot_reload_classify') {
          return answer(socket, request, {
            hot: [],
            needCompile: [{ path: 'Assets/Scripts/Enemy.cs', reason: 'field layout changed' }],
            failed: [],
            supported: true,
          })
        }
        return answeredCompile()(request, _helpers, socket)
      },
    },
  )
})

test('runRecompile mode "auto" still compiles when classification is unavailable', async () => {
  // A payload without the sidecar package answers `unknown command …`; the
  // classic compile must keep working rather than the tool failing.
  await withEditor(
    async ({ requests }) => {
      const result = await runRecompile(TARGET, { mode: 'auto', paths: ['Assets/Scripts/Player.cs'] })
      assert.equal(result.mode, 'compile')
      assert.equal(result.status, 'ok')
      assert.match(result.classificationError, /unknown command/)
      assert.equal(requests.filter((item) => item.type === 'request_recompile').length, 1)
    },
    { onMessage: answeredCompile() },
  )
})

test('scriptReloadPayload carries the recompile request shape', () => {
  const body = JSON.parse(scriptReloadPayload({ paths: ['Assets/A.cs'], reason: 'why', operationId: 'op-1' }))
  assert.deepEqual(body, { schema: 1, paths: ['Assets/A.cs'], reason: 'why', operationId: 'op-1' })
})

test('recompile() keeps its original signature and result shape', async () => {
  await withEditor(
    async () => {
      const result = await recompile(TARGET, { syncMode: 'none', paths: [], reason: 'test' })
      assert.deepEqual(Object.keys(result).sort(), ['adopted', 'elapsedMs', 'message', 'operationId', 'startedAt', 'status'])
      assert.equal(result.status, 'ok')
    },
    { onMessage: answeredCompile() },
  )
})

/** The fake broker's own compile register, but with the start acknowledged. */
function answeredCompile() {
  return (request, _helpers, socket) => {
    if (request.type !== 'request_recompile') return undefined
    socket.write(JSON.stringify({ type: 'response', reply_to: request.id, ok: true, message: 'recompile_started' }) + '\n')
    return true
  }
}
