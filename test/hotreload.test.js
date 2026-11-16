// Hot reload: the JS half of `unity_hot_reload`.
//
// Classification runs in this process now (`src/hotreload-classify.js`), so the
// fixtures are real files under a throwaway project; only applying a patch talks
// to the editor, and those messages are answered by test/fake-broker.js.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocusClient } from '../src/locus-client.js'
import { __resetPoolForTest, __setClientForTest, shutdownPool } from '../src/client-pool.js'
import { resolvePipeName } from '../src/pipe-name.js'
import {
  HOT_RELOAD_MODES,
  applyHotPatch,
  classifyHotEdit,
  detourKey,
  disposeHotPatches,
  formatHotReload,
  hotReload,
  hotReloadStatus,
  methodKey,
  probeDetourEngine,
} from '../src/hotreload.js'
import { runRecompile, scriptReloadPayload } from '../src/recompile.js'
import { startFakeBroker } from './fake-broker.js'

const PROJECT = mkdtempSync(join(tmpdir(), 'locus-hotreload-test-'))
const SCRIPTS = join(PROJECT, 'Assets', 'Scripts')
mkdirSync(SCRIPTS, { recursive: true })
mkdirSync(join(PROJECT, 'ProjectSettings'), { recursive: true })
process.on('exit', () => rmSync(PROJECT, { recursive: true, force: true }))

/** A method-body edit under Allman braces: the shape that used to classify as empty. */
const PLAYER_SOURCE = `namespace Game
{
    public class Player
    {
        public void Update()
        {
            int x = 1;
        }
    }
}
`

/** A field declaration at member position: cold without a real compile. */
const ENEMY_SOURCE = `namespace Game
{
    public class Enemy
    {
        public int hp;

        public void Tick()
        {
        }
    }
}
`

const ONLY_COMMENTS = `// nothing to detour here
`

/** A different type name: importing Broken.cs must not make Player.cs look duplicated. */
const BROKEN_SOURCE = `public class BrokenProbe
{
}
`

function writeScript(name, source, { meta = true } = {}) {
  const path = join(SCRIPTS, name)
  writeFileSync(path, source)
  if (meta) writeFileSync(`${path}.meta`, '')
}

writeScript('Player.cs', PLAYER_SOURCE)
writeScript('Enemy.cs', ENEMY_SOURCE)
writeScript('OnlyComments.cs', ONLY_COMMENTS)
writeScript('Broken.cs', BROKEN_SOURCE, { meta: false })
writeFileSync(join(SCRIPTS, 'Notes.txt'), 'not a script')

const TARGET = { projectRoot: PROJECT }

/** Reply to one request the way the payload's extension dispatcher does. */
function answer(socket, request, body, asJson = true) {
  const message = asJson ? JSON.stringify(body) : String(body)
  socket.write(JSON.stringify({ type: 'response', reply_to: request.id, ok: true, message }) + '\n')
  return true
}

/** A method identity in the shape the classifier emits. */
function hotMethod(overrides = {}) {
  return {
    path: 'Assets/Scripts/Player.cs',
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

/** A compiled method in the snake_case shape the payload's DTO expects. */
function toDto(method) {
  return {
    declaring_type: method.declaring_type,
    patch_declaring_type: 'Locus.DshHotPatch.__DshPatch_Game_Player',
    name: method.name,
    param_type_names: method.param_type_names,
    param_type_sigs: method.param_type_sigs,
    is_static: method.is_static,
    is_ctor: method.is_ctor,
    original_assembly: null,
  }
}

/** Refuse a request the way the payload's dispatcher does (`ok:false` + text). */
function refuse(socket, request, error) {
  socket.write(JSON.stringify({ type: 'response', reply_to: request.id, ok: false, error }) + '\n')
  return true
}

/**
 * The payload's own answers for the three hot-patch messages: `get_reload_state`
 * (actually answered by the fake broker), `hot_reload_probe`, `hot_patch_loaded`.
 */
function payloadAnswers() {
  return (request, _helpers, socket) => {
    if (request.type === 'hot_reload_probe') {
      return answer(socket, request, {
        detour_ok: true,
        detour_engine: 'detour',
        code_optimization: 'debug',
        domain_reload_on_play: true,
      })
    }
    if (request.type === 'hot_patch_loaded') {
      const body = JSON.parse(request.message)
      return answer(socket, request, {
        patch_id: body.patch_id,
        method_count: body.methods?.length ?? 0,
        detour_engine: 'detour',
        inlined_method_keys: [],
        inlined_sources: [],
        pump_supported: true,
        pumped_count: 0,
        pump_skipped_count: 0,
        pump_skipped_messages: [],
        pump_failed_count: 0,
      })
    }
    return undefined
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

// ── local classification ────────────────────────────────────────────────────

test('classifyHotEdit reads method identities from disk', () => {
  const result = classifyHotEdit(PROJECT, ['Assets/Scripts/Player.cs', 'Assets/Scripts/Enemy.cs'])
  assert.equal(result.hot.length, 1)
  assert.equal(result.hot[0].method_key, 'Game.Player|Update||i')
  assert.equal(result.hot[0].declaring_type, 'Game.Player')
  assert.deepEqual(result.hot[0].param_type_names, [])
  assert.equal(result.hot[0].is_ctor, false)
  assert.equal(result.needCompile.length, 1)
  assert.match(result.needCompile[0].reason, /field layout changed/)
  assert.deepEqual(result.failed, [])
  assert.equal(result.supported, true)
})

test('classifyHotEdit needs no editor connection at all', () => {
  // No broker, no client: classification only reads the project.
  __resetPoolForTest()
  const result = classifyHotEdit(PROJECT, ['Assets/Scripts/Player.cs'])
  assert.equal(result.hot.length, 1)
})

test('classifyHotEdit rejects an empty path list', () => {
  assert.throws(() => classifyHotEdit(PROJECT, []), /at least one Assets\/ or Packages\/ path/)
})

test('classifyHotEdit separates failed files from cold ones', () => {
  const result = classifyHotEdit(PROJECT, ['Assets/Scripts/Notes.txt', '../outside.cs', 'Assets/Nope.cs'])
  assert.equal(result.failed.length, 2, 'a non-script and an outside path are failures')
  assert.equal(result.needCompile.length, 1, 'a deleted script is cold')
  assert.match(result.needCompile[0].reason, /file was deleted/)
})

test('classifyHotEdit reports a comment-only file as hot with no method body', () => {
  const result = classifyHotEdit(PROJECT, ['Assets/Scripts/OnlyComments.cs'])
  assert.equal(result.hot.length, 0)
  assert.equal(result.files[0].state, 'hot')
  assert.equal(result.files[0].method_count, 0)
  assert.match(formatHotReload({ ...result, dryRun: true }), /no method bodies to patch/)
})

test('classifyHotEdit flags a script that has not been imported yet', () => {
  const result = classifyHotEdit(PROJECT, ['Assets/Scripts/Broken.cs'])
  assert.equal(result.needCompile.length, 1)
  assert.match(result.needCompile[0].reason, /no \.meta yet/)
})

// ── apply / probe / dispose (payload protocol) ─────────────────────────────

test('applyHotPatch drives the payload\'s hot_patch_loaded', async () => {
  await withEditor(
    async ({ requests, client }) => {
      const result = await applyHotPatch(client, {
        patchId: 'patch-1',
        assemblyB64: 'AAECAwQ=',
        methods: [toDto(hotMethod())],
        domainGeneration: 'gen-1',
        sourcePath: 'Assets/Scripts/Player.cs',
      })
      const request = requests.find((item) => item.type === 'hot_patch_loaded')
      assert.ok(request, 'the apply went to the payload, not to a locally registered message')
      const body = JSON.parse(request.message)
      assert.equal(body.patch_id, 'patch-1')
      assert.equal(body.assembly_b64, 'AAECAwQ=')
      assert.equal(body.domain_generation, 'gen-1')
      assert.equal(body.methods.length, 1)
      // param_type_names is what the payload resolves the original method with.
      assert.deepEqual(body.methods[0].param_type_names, [])
      assert.equal(body.methods[0].source_path, 'Assets/Scripts/Player.cs')

      assert.equal(result.applied, 1)
      assert.equal(result.detourEngine, 'detour')
      assert.deepEqual(result.inlinedMethodKeys, [])
    },
    { onMessage: payloadAnswers() },
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

test('applyHotPatch surfaces a rolled-back batch as the payload words it', async () => {
  await withEditor(
    async ({ client }) => {
      await assert.rejects(
        () => applyHotPatch(client, { patchId: 'p', assemblyB64: 'AA==', methods: [toDto(hotMethod())] }),
        /hot patch apply failed \(rolled back\): original method not found/,
      )
    },
    {
      onMessage: (request, _helpers, socket) => {
        if (request.type !== 'hot_patch_loaded') return undefined
        return refuse(socket, request, 'hot patch apply failed (rolled back): original method not found')
      },
    },
  )
})

test('probeDetourEngine reports the payload self-test', async () => {
  await withEditor(
    async ({ client }) => {
      const probe = await probeDetourEngine(client)
      assert.equal(probe.detourOk, true)
      assert.equal(probe.detourEngine, 'detour')
      assert.equal(probe.codeOptimization, 'debug')
      assert.equal(probe.domainReloadOnPlay, true)
    },
    { onMessage: payloadAnswers() },
  )
})

test('methodKey and detourKey follow the payload ledger keys', () => {
  assert.equal(methodKey(hotMethod()), 'Game.Player|Update||i')
  assert.equal(methodKey(hotMethod({ is_static: true, param_type_names: ['System.Int32'] })), 'Game.Player|Update|System.Int32|s')
  assert.equal(detourKey(hotMethod({ original_assembly: 'Assembly-CSharp' })), 'Game.Player|Update||i|Assembly-CSharp')
  assert.equal(detourKey(hotMethod()), 'Game.Player|Update||i|')
})

test('hotReloadStatus answers from the ledger and the payload generation', async () => {
  await withEditor(
    async ({ client }) => {
      const status = await hotReloadStatus(client)
      assert.equal(status.domainGeneration, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
      assert.deepEqual(status.patchedMethods, [])
      assert.equal(status.detours, 0)
    },
    { onMessage: payloadAnswers() },
  )
})

test('disposeHotPatches sends a bare target string, not JSON', async () => {
  const seen = []
  await withEditor(
    async ({ requests, client }) => {
      assert.deepEqual(await disposeHotPatches(client, { patchId: 'patch-1' }), { disposed: 2 })
      assert.deepEqual(await disposeHotPatches(client), { disposed: 5 })
      assert.deepEqual(seen, ['patch-1', 'all'])
      const dispose = requests.filter((item) => item.type === 'hot_patch_dispose')
      assert.equal(dispose.length, 2)
    },
    {
      onMessage: (request, _helpers, socket) => {
        if (request.type !== 'hot_patch_dispose') return undefined
        seen.push(request.message)
        return answer(socket, request, `disposed:${request.message === 'all' ? 5 : 2}`, false)
      },
    },
  )
})

// ── hotReload orchestration ─────────────────────────────────────────────────

test('a dry run classifies locally and never connects', async () => {
  // No broker is started: a dry run must answer from disk alone.
  const result = await hotReload(
    { projectRoot: PROJECT, pipe: 'no-such-pipe' },
    { paths: ['Assets/Scripts/Player.cs'], dryRun: true },
  )
  assert.equal(result.hot.length, 1)
  assert.equal(result.dryRun, true)
  assert.equal(result.files[0].state, 'hot')
})

test('hotReload normalizes project-relative paths before classifying', async () => {
  const result = await hotReload(TARGET, { paths: ['Assets/Scripts/Player.cs', '/etc/passwd'], dryRun: true })
  // normalizeChangedPaths drops anything that is not an Assets/ or Packages/ asset.
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0].path, 'Assets/Scripts/Player.cs')
})

test('hotReload skips a file the editor has no baseline for', async () => {
  // Classification is local, but applying a patch has to reproduce the text the
  // running domain compiled; with no baseline the edit is left to a recompile.
  await withEditor(async () => {
    const result = await hotReload(TARGET, { paths: ['Assets/Scripts/Player.cs'] })
    assert.equal(result.dryRun, false)
    assert.deepEqual(result.patches, [])
    assert.deepEqual(result.applied, [])
    assert.equal(result.skipped.length, 1)
    assert.match(result.skipped[0].reason, /no baseline for this file/)
  }, { onMessage: payloadAnswers() })
})

test('hotReload refuses to patch when the payload detour engine is broken', async () => {
  const requests = []
  await withEditor(
    async () => {
      const result = await hotReload(TARGET, { paths: ['Assets/Scripts/Player.cs'] })
      assert.match(result.patchError, /detour engine is not usable/)
      assert.deepEqual(result.patches, [])
      assert.match(formatHotReload(result), /not patched: the editor's detour engine is not usable/)
    },
    {
      onMessage: (request, _helpers, socket) => {
        requests.push(request.type)
        if (request.type !== 'hot_reload_probe') return undefined
        return answer(socket, request, { detour_ok: false, error: 'probe replacement did not take' })
      },
    },
  )
  // The probe runs before anything is compiled or sent: no patch message at all.
  assert.deepEqual(requests.filter((type) => type.startsWith('hot_')), ['hot_reload_probe'])
})

test('formatHotReload renders hot, needs-compile and failed rows', () => {
  const text = formatHotReload({
    hot: [hotMethod()],
    needCompile: [{ path: 'Assets/Scripts/Enemy.cs', reason: 'field layout changed' }],
    failed: [{ path: 'Assets/Broken.txt', error: 'not a C# source file' }],
    details: [],
    dryRun: false,
  })
  assert.match(text, /hot: Assets\/Scripts\/Player\.cs \(1 method\)/)
  assert.match(text, /· Game\.Player\|Update\|\|i/)
  assert.match(text, /needs compile: Assets\/Scripts\/Enemy\.cs — field layout changed/)
  assert.match(text, /failed: Assets\/Broken\.txt — not a C# source file/)
  assert.match(text, /1 file hot-patchable, 1 needs a compile, 1 could not be read/)
  // No patch was applied, so the rendering must say so rather than imply the
  // method is live.
  assert.match(text, /No method bodies were patched/)
  assert.match(text, /unity_recompile \(mode "auto"/)
})

test('formatHotReload reports a patch that could not be compiled', () => {
  const text = formatHotReload({
    hot: [hotMethod()],
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
    hot: [hotMethod()],
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
  const text = formatHotReload({ hot: [hotMethod()], needCompile: [], failed: [], dryRun: true })
  assert.match(text, /Dry run: nothing was patched\./)
  assert.doesNotMatch(text, /patched: \d+ method/)
})

test('formatHotReload handles an empty classification', () => {
  assert.match(formatHotReload({ hot: [], needCompile: [], failed: [] }), /nothing to classify/)
})

test('formatHotReload reports a hot file that has no detourable method body', () => {
  const text = formatHotReload({
    hot: [],
    needCompile: [],
    failed: [],
    files: [{ path: 'Assets/Scripts/OnlyComments.cs', state: 'hot', reason: 'no detour target found in this file', method_count: 0 }],
    dryRun: false,
  })
  assert.match(text, /hot: Assets\/Scripts\/OnlyComments\.cs \(no method bodies to patch\)/)
  assert.match(text, /1 file hot-patchable, 0 need a compile, 0 could not be read/)
  assert.match(text, /no method bodies to detour/)
  assert.doesNotMatch(text, /nothing to classify/)
})

test('formatHotReload refuses to claim nothing was classified when files were reported', () => {
  const text = formatHotReload({ hot: [], needCompile: [], failed: [], files: [] })
  assert.match(text, /no file states/)
  assert.doesNotMatch(text, /no edited scripts were given/)
})

// ── recompile modes ─────────────────────────────────────────────────────────

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
  // Player.cs only changes a method body, so the local classifier is enough and
  // no compile is requested.
  await withEditor(
    async ({ requests }) => {
      const result = await runRecompile(TARGET, { mode: 'auto', paths: ['Assets/Scripts/Player.cs'] })
      assert.equal(result.mode, 'hot')
      assert.equal(result.status, 'hot')
      assert.equal(result.classification.hot.length, 1)
      assert.equal(requests.filter((item) => item.type === 'request_recompile').length, 0, 'no compile was requested')
    },
  )
})

test('runRecompile mode "auto" treats a hot file with no method body as hot', async () => {
  await withEditor(
    async ({ requests }) => {
      const result = await runRecompile(TARGET, { mode: 'auto', paths: ['Assets/Scripts/OnlyComments.cs'] })
      assert.equal(result.mode, 'hot')
      assert.equal(result.status, 'hot')
      assert.equal(requests.filter((item) => item.type === 'request_recompile').length, 0)
    },
  )
})

test('runRecompile mode "auto" compiles when an edit needs it', async () => {
  // Enemy.cs declares a field, which is metadata: a real compile is required.
  await withEditor(
    async ({ requests }) => {
      const result = await runRecompile(TARGET, { mode: 'auto', paths: ['Assets/Scripts/Enemy.cs'] })
      assert.equal(result.mode, 'compile')
      assert.equal(result.status, 'ok')
      assert.equal(result.classification.needCompile.length, 1)
      assert.equal(requests.filter((item) => item.type === 'request_recompile').length, 1)
    },
    { onMessage: answeredCompile() },
  )
})

test('scriptReloadPayload carries the recompile request shape', () => {
  const body = JSON.parse(scriptReloadPayload({ paths: ['Assets/A.cs'], reason: 'why', operationId: 'op-1' }))
  assert.deepEqual(body, { schema: 1, paths: ['Assets/A.cs'], reason: 'why', operationId: 'op-1' })
})

/** The fake broker's own compile register, but with the start acknowledged. */
function answeredCompile() {
  return (request, _helpers, socket) => {
    if (request.type !== 'request_recompile') return undefined
    socket.write(JSON.stringify({ type: 'response', reply_to: request.id, ok: true, message: 'recompile_started' }) + '\n')
    return true
  }
}