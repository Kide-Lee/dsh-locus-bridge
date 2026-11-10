import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocusClient } from '../src/locus-client.js'
import { __resetPoolForTest, __setClientForTest, shutdownPool } from '../src/client-pool.js'
import { resolvePipeName } from '../src/pipe-name.js'
import { toolDefinitions } from '../src/tools.js'
import { sceneSetCode } from '../src/scene-set.js'
import { startFakeBroker } from './fake-broker.js'

const tools = Object.fromEntries(toolDefinitions.map((definition) => [definition.name, definition]))

// Project resolution validates `Assets/` + `ProjectSettings/`, so the fixture is
// a real tree rather than a string that happens to look like a path.
const PROJECT = mkdtempSync(join(tmpdir(), 'locus-workflow-test-'))
mkdirSync(join(PROJECT, 'Assets'), { recursive: true })
mkdirSync(join(PROJECT, 'ProjectSettings'), { recursive: true })
process.on('exit', () => rmSync(PROJECT, { recursive: true, force: true }))

function ctx(overrides = {}) {
  return {
    agent: { session: { header: { cwd: PROJECT } } },
    signal: new AbortController().signal,
    publish: () => {},
    ...overrides,
  }
}

async function withEditor(fn, options = {}) {
  const reconnect = { dropped: false }
  let broker
  // Fallback editor behaviour for the default tests: acknowledge a recompile and
  // simulate exactly one domain reload (the fake broker answers the rest).
  const defaultOnMessage = (request, _helpers, socket) => {
    if (request.type !== 'request_recompile') return undefined
    socket.write(JSON.stringify({ type: 'response', reply_to: request.id, ok: true, message: 'recompile_started' }) + '\n')
    if (!reconnect.dropped) {
      reconnect.dropped = true
      setTimeout(() => {
        socket.destroy()
        broker.acceptAfterDrop()
      }, 5)
    }
    return true
  }
  const onMessage = options.onMessage || defaultOnMessage
  broker = await startFakeBroker({ onMessage })
  const client = new LocusClient({ pipe: 'fake', stream: broker.stream })
  await client.connect()
  __resetPoolForTest()
  __setClientForTest(resolvePipeName({ projectRoot: PROJECT }), client)
  try {
    return await fn({ broker, client, reconnect })
  } finally {
    await shutdownPool()
    __resetPoolForTest()
    await broker.close()
  }
}

/** Message log of everything the fake broker received. */
function recorder(requests) {
  // Record the request and let the fake broker answer it (its built-ins cover
  // status, capabilities, assets, scenes and the recompile register).
  return (request) => {
    requests.push(request)
    return undefined
  }
}

test('unity_recompile waits across a dropped connection and converges', async () => {
  const requests = []
  await withEditor(
    async ({ broker }) => {
      const result = await tools.unity_recompile.execute(
        {
          editor_status: 'editing',
          reason: 'test',
          sync: { mode: 'targeted', paths: ['Assets/Scripts/Player.cs'] },
        },
        ctx(),
      )
      assert.equal(result.status, 'ok')
      assert.match(result.text, /compiled and the domain reloaded/)
      const request = requests.find((item) => item.type === 'request_recompile')
      const body = JSON.parse(request.message)
      assert.equal(body.schema, 1)
      assert.equal(body.syncMode, 'targeted')
      assert.deepEqual(body.paths, ['Assets/Scripts/Player.cs'])
      const polls = requests.filter((item) => item.type === 'get_compile_result')
      assert.ok(polls.length >= 1, 'polled the compile result on a fresh connection')
      assert.equal(polls[polls.length - 1].message, body.operationId)
      assert.equal(broker.clientCount, 1, 'the client reconnected exactly once')
    },
    { onMessage: recorder(requests) },
  )
})

function adoptingBroker(requests) {
  // An in-flight compile already owns the result register.
  return (request, _helpers, socket) => {
    requests.push(request)
    if (request.type === 'request_recompile') {
      socket.write(
        JSON.stringify({
          type: 'response',
          reply_to: request.id,
          ok: false,
          error: 'recompile_in_progress; operation_id=op-existing; Unity 重编译请求正在进行中。',
        }) + '\n',
      )
      return true
    }
    if (request.type === 'get_compile_result') {
      socket.write(JSON.stringify({ type: 'response', reply_to: request.id, ok: true, message: 'ok' }) + '\n')
      return true
    }
    return undefined
  }
}

test('unity_recompile adopts an in-flight compile and polls its operation id', async () => {
  const requests = []
  await withEditor(
    async () => {
      const result = await tools.unity_recompile.execute({ editor_status: 'editing' }, ctx())
      assert.equal(result.status, 'ok')
      assert.match(result.text, /Adopted an in-flight compile \(operation op-existing\)/)
      const polls = requests.filter((item) => item.type === 'get_compile_result')
      assert.equal(polls.at(-1).message, 'op-existing')
    },
    { onMessage: adoptingBroker(requests) },
  )
})

test('unity_recompile surfaces compile errors as diagnostics', async () => {
  await withEditor(
    async () => {
      const result = await tools.unity_recompile.execute({ editor_status: 'editing' }, ctx())
      assert.equal(result.status, 'error')
      assert.match(result.text, /CS1002: ; expected/)
    },
    {
      onMessage: (request, _helpers, socket) => {
        if (request.type === 'request_recompile') {
          socket.write(JSON.stringify({ type: 'response', reply_to: request.id, ok: true, message: 'recompile_started' }) + '\n')
          return true
        }
        if (request.type !== 'get_compile_result') return undefined
        socket.write(
          JSON.stringify({ type: 'response', reply_to: request.id, ok: false, error: 'CS1002: ; expected' }) + '\n',
        )
        return true
      },
    },
  )
})

test('unity_recompile refuses while Unity plays', async () => {
  await withEditor(
    async () => {
      // The claim must agree with the live editor first, so claim `playing`:
      // the refusal then comes from the Edit-Mode requirement, not a mismatch.
      await assert.rejects(
        tools.unity_recompile.execute({ editor_status: 'playing' }, ctx()),
        /Recompilation requires Edit Mode/,
      )
    },
    {
      onMessage: (request, _helpers, socket) => {
        if (request.type !== 'status') return undefined
        socket.write(
          JSON.stringify({ type: 'response', reply_to: request.id, ok: true, message: 'playing|Assets/S.unity' }) + '\n',
        )
        return true
      },
    },
  )
})

test('unity_recompile rejects a stale editor_status argument', async () => {
  await withEditor(async () => {
    await assert.rejects(
      tools.unity_recompile.execute({ editor_status: 'playing' }, ctx()),
      /editor_status mismatch: you claimed "playing", but the actual editor status is "editing"/,
    )
  })
})

test('unity_asset read renders the snapshot and revision', async () => {
  await withEditor(
    async () => {
      const result = await tools.unity_asset.execute({ action: 'read', path: 'Assets/Config/Balance.asset' }, ctx())
      assert.equal(result.revision, 'live:revision-1')
      // `apply` is documented to take this snapshot; returning it is what makes
      // a revision-guarded edit possible without a second read.
      assert.equal(result.snapshot?.revision, 'live:revision-1')
      assert.equal(result.snapshot?.objects?.[0]?.object_id, '11400000')
      assert.match(result.text, /object_id 11400000 \(MySO\)/)
      assert.match(result.text, /m_Name \[string\] = "Balance"/)
    },
    {
      onMessage: (request, _helpers, socket) => {
        if (request.type !== 'asset_api') return undefined
        const body = JSON.parse(request.message)
        assert.equal(body.action, 'read')
        socket.write(
          JSON.stringify({
            type: 'response',
            reply_to: request.id,
            ok: true,
            message: JSON.stringify({
              revision: 'live:revision-1',
              path: 'Assets/Config/Balance.asset',
              objects: [{ object_id: '11400000', class_id: 114, root_type: 'MySO', fields: [] }],
              fields: [
                { property_path: 'm_Name', kind: 'string', value: 'Balance' },
                { property_path: 'maxHealth', kind: 'integer', value: 100 },
              ],
              diagnostics: [],
            }),
          }) + '\n',
        )
        return true
      },
    },
  )
})

test('unity_asset apply sends a revision-guarded batch in one edit session', async () => {
  const seen = []
  const snapshot = {
    revision: 'live:revision-1',
    path: 'Assets/Config/Balance.asset',
    objects: [
      {
        object_id: '11400000',
        class_id: 114,
        root_type: 'MySO',
        fields: [{ property_path: 'maxHealth', kind: 'integer', value: 100 }],
      },
    ],
    fields: [{ property_path: 'maxHealth', kind: 'integer', value: 100 }],
  }
  await withEditor(
    async () => {
      const result = await tools.unity_asset.execute(
        {
          action: 'apply',
          path: snapshot.path,
          snapshot,
          edits: [
            { operation: { op: 'set', object_id: '11400000', property_path: 'maxHealth', value: 120 } },
            { operation: { op: 'array_remove', object_id: '11400000', property_path: 'values.Array', index: 1 } },
          ],
        },
        ctx(),
      )
      assert.match(result.text, /Applied 2 operations?\(s\) to 1 asset file\(s\)/)
      assert.match(result.text, /Undo token/)
      // The token must come back as data: `action: "undo"` takes exactly this
      // object, and scraping it out of the rendered text is not the contract.
      assert.equal(result.undo?.kind, 'asset')
      assert.equal(result.undo?.files?.length, 1)
      const order = seen.map((item) => item.type)
      assert.ok(order.indexOf('begin_edit_session') < order.indexOf('asset_api'))
      assert.ok(order.indexOf('end_edit_session') > order.indexOf('asset_api'))
    },
    {
      onMessage: (request) => {
        if (['begin_edit_session', 'asset_api', 'end_edit_session'].includes(request.type)) seen.push(request)
        return undefined
      },
      onResponse: undefined,
    },
  )
})

test('unity_asset apply refuses a changed revision before sending', async () => {
  const sent = []
  await withEditor(
    async () => {
      await assert.rejects(
        tools.unity_asset.execute(
          {
            action: 'apply',
            snapshot: { revision: 'live:old', path: 'Assets/Config/Balance.asset', objects: [], fields: [] },
            expected_revision: 'live:new',
            edits: [{ operation: { op: 'set', object_id: '1', property_path: 'm_Name', value: 'x' } }],
          },
          ctx(),
        ),
        /changed since the snapshot/,
      )
    },
    {
      onMessage: (request, _helpers, socket) => {
        if (request.type !== 'asset_api') return undefined
        sent.push(JSON.parse(request.message))
        socket.write(
          JSON.stringify({
            type: 'response',
            reply_to: request.id,
            ok: true,
            message: JSON.stringify({ revision: 'live:new', path: 'Assets/Config/Balance.asset', objects: [], fields: [] }),
          }) + '\n',
        )
        return true
      },
    },
  )
  assert.ok(sent.every((body) => body.action === 'read'), 'no apply was sent')
})

test('unity_asset undo inverts the recorded operations', async () => {
  const batches = []
  const snapshot = {
    revision: 'live:revision-1',
    path: 'Assets/Config/Balance.asset',
    objects: [],
    fields: [
      { property_path: 'maxHealth', kind: 'integer', value: 100 },
      { property_path: 'npcIds.Array', kind: 'array', value: ['a', 'b', 'c'] },
    ],
  }
  // A read returns deep, detached JSON (as over the wire); the fake mutates
  // its own copy after an apply.
  const readSnapshot = () => JSON.parse(JSON.stringify(snapshot))
  await withEditor(
    async () => {
      const apply = await tools.unity_asset.execute(
        {
          action: 'apply',
          snapshot,
          edits: [
            { operation: { op: 'set', object_id: '1', property_path: 'maxHealth', value: 150 } },
            { operation: { op: 'array_remove', object_id: '1', property_path: 'npcIds.Array', index: 1 } },
          ],
        },
        ctx(),
      )
      const token = JSON.parse(/Undo token .*: (\{.*\})/.exec(apply.text)[1])
      const undo = await tools.unity_asset.execute({ action: 'undo', undo: token }, ctx())
      assert.match(undo.text, /Undid 2 operation\(s\)/)
      const invert = batches.at(-1).entries[0].operations
      assert.deepEqual(invert[0], { op: 'set', object_id: '1', property_path: 'maxHealth', value_json: '100' })
      assert.equal(invert[1].op, 'array_insert')
      assert.equal(invert[1].index, 1)
      // The whole previous array is restored (the asset API has no splice).
      assert.equal(invert[1].value_json, '["a","b","c"]')
    },
    {
      onMessage: (request, _helpers, socket) => {
        if (request.type !== 'asset_api') return undefined
        const body = JSON.parse(request.message)
        if (body.action === 'apply_batch') {
          batches.push(body)
          snapshot.revision = `live:after-${batches.length}`
          snapshot.fields = [
            { property_path: 'maxHealth', kind: 'integer', value: 150 },
            { property_path: 'npcIds.Array', kind: 'array', value: ['a', 'c'] },
          ]
          socket.write(
            JSON.stringify({
              type: 'response',
              reply_to: request.id,
              ok: true,
              message: JSON.stringify({ applied: true, persisted: true, transaction_id: 'tx-1' }),
            }) + '\n',
          )
        } else {
          socket.write(
            JSON.stringify({ type: 'response', reply_to: request.id, ok: true, message: JSON.stringify(readSnapshot()) }) + '\n',
          )
        }
        return true
      },
    },
  )
})

test('unity_scene search / get / set run through the bridge', async () => {
  const requests = []
  await withEditor(
    async () => {
      const search = await tools.unity_scene.execute({ action: 'search', query: 'Player' }, ctx())
      assert.match(search.text, /1 scene object\(s\) matched "Player"/)
      assert.match(search.text, /Assets\/Scenes\/Main\.unity :: Root\/Player/)

      const get = await tools.unity_scene.execute(
        { action: 'get', scene_path: 'Assets/Scenes/Main.unity', object_path: 'Root/Player' },
        ctx(),
      )
      assert.match(get.text, /Local Position \(Vector3\)/)
      assert.match(get.text, /Text \(string\) = "Hello"/)

      const set = await tools.unity_scene.execute(
        {
          action: 'set',
          scene_path: 'Assets/Scenes/Main.unity',
          object_path: 'Root/Player',
          component_type: 'Transform',
          property_path: 'm_LocalPosition',
          operation: { op: 'set', value: '0,1,0' },
        },
        ctx(),
      )
      assert.match(set.text, /Set Transform\.m_LocalPosition on Root\/Player in Assets\/Scenes\/Main\.unity/)
      const execute = requests.find((item) => item.type === 'execute_code')
      assert.ok(execute, 'the scene set ran as an execute_code snippet')
      assert.match(execute.message, /\/\/__LOCUS_EXECUTION_ID__:/)
      assert.match(execute.message, /"Root\/Player"/)
    },
    { onMessage: recorder(requests) },
  )
})

test('unity_scene validates its arguments before touching the editor', async () => {
  await withEditor(async () => {
    await assert.rejects(tools.unity_scene.execute({ action: 'search' }, ctx()), /query is required/)
    await assert.rejects(tools.unity_scene.execute({ action: 'get', scene_path: 'x' }, ctx()), /object_path is required/)
    await assert.rejects(
      tools.unity_scene.execute(
        { action: 'set', scene_path: 'Assets/S.unity', object_path: 'A', component_type: 'Transform', property_path: 'm_X', operation: { op: 'nope' } },
        ctx(),
      ),
      /not supported/,
    )
    await assert.rejects(tools.unity_scene.execute({ action: 'delete' }, ctx()), /action must be one of search, get, set/)
  })
})

test('unity_status reports the reload state of a connected editor', async () => {
  await withEditor(async () => {
    const result = await tools.unity_status.execute({}, ctx())
    assert.match(result.text, /Reload state: converged serial 3/)
  })
})

test('scene set passes a string value through as plain text, not JSON', () => {
  // `WriteValue` reads scalars with Convert.*, so a JSON-quoted string stored
  // the quotes in the scene ("Hello World" with literal quotation marks).
  const body = sceneSetCode({
    scenePath: 'Assets/S.unity',
    objectPath: 'A',
    componentType: 'TextMesh',
    propertyPath: 'm_Text',
    op: 'set',
    value: 'Hello World',
  })
  const raw = /var raw = (.+);/.exec(body)
  assert.ok(raw, 'the snippet binds the encoded value to `raw`')
  // The C# literal must evaluate to the bare text.
  assert.equal(JSON.parse(raw[1]), 'Hello World')

  // A number keeps a form Convert.ToInt64/ToSingle accepts unchanged.
  const numeric = sceneSetCode({
    scenePath: 'Assets/S.unity',
    objectPath: 'A',
    componentType: 'Camera',
    propertyPath: 'm_ClearFlags',
    op: 'set',
    value: 2,
  })
  assert.equal(JSON.parse(/var raw = (.+);/.exec(numeric)[1]), '2')
})

test('unity_recompile requires editor_status and validates its enum', async () => {
  // Upstream `unity_recompile` (tool/builtins/unity.rs) makes the claim required
  // and restricted to the four canonical values, so a caller never reaches Unity
  // without having stated what it believes the editor state to be.
  await withEditor(async () => {
    await assert.rejects(
      tools.unity_recompile.execute({}, ctx()),
      /Missing required parameter: editor_status\..*disconnected \| editing \| playing \| playing_paused/s,
    )
    await assert.rejects(
      tools.unity_recompile.execute({ editor_status: 'safe_mode' }, ctx()),
      /Invalid editor_status: "safe_mode"\. Allowed values: disconnected \| editing \| playing \| playing_paused/,
    )
    // An empty string is "missing", not "invalid": that is what a model emits
    // when it has no status to report.
    await assert.rejects(tools.unity_recompile.execute({ editor_status: '   ' }, ctx()), /Missing required parameter/)
  })
})

test('unity_recompile refuses a disconnected claim after the live check', async () => {
  // Upstream compares the claim with the live status BEFORE rejecting
  // `disconnected`, so an editor that is actually up but was claimed down reads
  // as a mismatch rather than as "the editor is gone".
  await withEditor(async () => {
    await assert.rejects(
      tools.unity_recompile.execute({ editor_status: 'disconnected' }, ctx()),
      /editor_status mismatch: you claimed "disconnected", but the actual editor status is "editing"/,
    )
  })
})

test('unity_recompile advertises editor_status as a required four-value enum', () => {
  const spec = tools.unity_recompile.parameters.editor_status
  assert.deepEqual(spec.enum, ['disconnected', 'editing', 'playing', 'playing_paused'])
  assert.equal(spec.required, true)
})

test('a recompile start-ack timeout reconciles the persisted state instead of failing', async () => {
  // Observed live: `request_recompile` is queued behind the very compile it asks
  // for (or an AssetDatabase refresh), so the reply can time out while a compile
  // is genuinely running. Upstream `request_recompile_and_wait_for_start` gives
  // up after 90s and returns `Unconfirmed`, then reconciles through
  // `get_compile_result`; reporting a hard failure here threw away real work.
  const { recompile } = await import('../src/recompile.js')
  const requests = []
  await withEditor(
    async ({ client }) => {
      const result = await recompile(
        { projectRoot: PROJECT },
        {
          signal: new AbortController().signal,
          startTimeoutMs: 300,
          convergeTimeoutMs: 10_000,
        },
      )
      assert.equal(result.status, 'ok')
      assert.ok(
        requests.some((item) => item.type === 'get_compile_result'),
        'fell back to polling the persisted compile result',
      )
    },
    {
      onMessage: (request, _helpers, socket) => {
        if (request.type === 'status') {
          socket.write(JSON.stringify({ type: 'response', reply_to: request.id, ok: true, message: 'editing|Assets/Scenes/Level.unity' }) + '\n')
          return true
        }
        if (request.type === 'get_compile_result') {
          requests.push(request)
          socket.write(JSON.stringify({ type: 'response', reply_to: request.id, ok: true, message: 'ok' }) + '\n')
          return true
        }
        if (request.type === 'request_recompile') {
          requests.push(request)
          // Never answer: the start acknowledgement times out.
          return true
        }
        return undefined
      },
    },
  )
})

test('the converge loop honours its budget even when reconnects keep failing', async () => {
  // Live: a finished compile kept the loop alive for ~287s because one
  // iteration could spend ~76s inside getClient (5 attempts x 15s timeout) with
  // the deadline only checked between iterations. The budget must bound each
  // reconnect, not just the loop condition.
  const { recompile } = await import('../src/recompile.js')
  const started = Date.now()
  await assert.rejects(
    recompile(
      { projectRoot: PROJECT, pipe: join(PROJECT, 'Library', 'Locus', 'no-such.sock') },
      { convergeTimeoutMs: 1_500, startTimeoutMs: 500 },
    ),
    /not connected|timed out|did not converge/i,
  )
  const elapsed = Date.now() - started
  assert.ok(elapsed < 20_000, `must give up near its budget, took ${elapsed}ms`)
})
