import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocusClient } from '../src/locus-client.js'
import { __resetPoolForTest, __setClientForTest, shutdownPool } from '../src/client-pool.js'
import { resolvePipeName } from '../src/pipe-name.js'
import { toolDefinitions } from '../src/tools.js'
import {
  buildTestFilter,
  formatTestList,
  formatTestRun,
  isTerminalStatus,
  parseTestSnapshot,
} from '../src/test-runner.js'
import { buildCaptureRequest, parseCapture } from '../src/capture.js'
import { readAssetGuid, projectRelative, assertSearchableAsset } from '../src/asset-graph.js'
import {
  batchUndoToken,
  componentSearchBody,
  validateBatch,
  validateComponentSearch,
} from '../src/scene-batch.js'
import { startFakeBroker } from './fake-broker.js'

const tools = Object.fromEntries(toolDefinitions.map((definition) => [definition.name, definition]))

const PROJECT = mkdtempSync(join(tmpdir(), 'locus-new-tools-test-'))
mkdirSync(join(PROJECT, 'Assets', 'Prefabs'), { recursive: true })
mkdirSync(join(PROJECT, 'Assets', 'Scripts'), { recursive: true })
mkdirSync(join(PROJECT, 'ProjectSettings'), { recursive: true })
process.on('exit', () => rmSync(PROJECT, { recursive: true, force: true }))

writeFileSync(
  join(PROJECT, 'Assets', 'Prefabs', 'Player.prefab'),
  '%YAML 1.1\n--- !u!1 &1\nGameObject:\n  m_Name: Player\n',
)
writeFileSync(
  join(PROJECT, 'Assets', 'Prefabs', 'Player.prefab.meta'),
  'fileFormatVersion: 2\nguid: 0123456789abcdef0123456789abcdef\ntimeCreated: 1\n',
)
writeFileSync(join(PROJECT, 'Assets', 'Scripts', 'PlayerController.cs'), 'public class PlayerController {}\n')
writeFileSync(
  join(PROJECT, 'Assets', 'Scripts', 'PlayerController.cs.meta'),
  'fileFormatVersion: 2\nguid: fedcba9876543210fedcba9876543210\ntimeCreated: 2\n',
)

function ctx(overrides = {}) {
  return {
    agent: { session: { header: { cwd: PROJECT } } },
    signal: new AbortController().signal,
    publish: () => {},
    ...overrides,
  }
}

async function withEditor(fn, { onMessage } = {}) {
  const broker = await startFakeBroker({ onMessage })
  const client = new LocusClient({ pipe: 'fake', stream: broker.stream })
  await client.connect()
  __resetPoolForTest()
  __setClientForTest(resolvePipeName({ projectRoot: PROJECT }), client)
  try {
    return await fn({ broker, client })
  } finally {
    await shutdownPool()
    __resetPoolForTest()
    await broker.close()
  }
}

// ── unity_test ──────────────────────────────────────────────────────────────

test('unity_test runs to a terminal status and renders the counts', async () => {
  await withEditor(async ({ broker }) => {
    void broker
    const result = await tools.unity_test.execute({ action: 'run' }, ctx())
    assert.equal(result.status, 'passed')
    assert.equal(result.total, 2)
    assert.equal(result.passed, 2)
    assert.match(result.text, /Unity Test run passed/)
    assert.match(result.text, /2 total, 2 passed, 0 failed/)
  })
})

test('unity_test list reports discovery and the filter reaches the wire', async () => {
  const requests = []
  await withEditor(
    async () => {
      const result = await tools.unity_test.execute(
        { action: 'list', groups: ['^Game\\.'] , categories: ['Fast'] },
        ctx(),
      )
      assert.equal(result.total, 2)
      assert.match(result.text, /Game\.Tests\.CombatTests\.Damage/)
    },
    { onMessage: (request) => {
      if (request.type === 'unity_test_list') requests.push(JSON.parse(request.message))
      return undefined
    } },
  )
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0].groups, ['^Game\\.'])
  assert.deepEqual(requests[0].categories, ['Fast'])
})

test('unity_test filter rejects an unknown mode before any call', () => {
  assert.throws(() => buildTestFilter({ mode: 'runtime' }), /mode must be one of/)
  assert.throws(() => buildTestFilter({ maxResults: 9000 }), /max_results must be an integer/)
  assert.deepEqual(buildTestFilter({ mode: 'edit', tests: ['A'], maxResults: 5 }), {
    mode: 'edit',
    tests: ['A'],
    max_results: 5,
  })
})

test('a terminal snapshot status is recognised, a running one is not', () => {
  for (const status of ['passed', 'failed', 'cancelled', 'error']) assert.equal(isTerminalStatus(status), true)
  for (const status of ['running', 'starting', '']) assert.equal(isTerminalStatus(status), false)
})

test('snapshot parsing normalises the Unity snake_case answer', () => {
  const snapshot = parseTestSnapshot(
    JSON.stringify({ run_id: 'r', status: 'passed', current_test: '', total: 1, passed: 1, duration_ms: 7 }),
  )
  assert.equal(snapshot.runId, 'r')
  assert.equal(snapshot.durationMs, 7)
  assert.deepEqual(snapshot.failures, [])
})

test('a failed run renders the failure message and stack', () => {
  const text = formatTestRun(
    {
      status: 'failed',
      mode: 'Edit',
      total: 1,
      passed: 0,
      failed: 1,
      skipped: 0,
      inconclusive: 0,
      durationMs: 12,
      error: '',
      failures: [
        {
          full_name: 'Game.Tests.CombatTests.Damage',
          result_state: 'Failed',
          duration_ms: 3,
          message: 'Expected 9 but was 8',
          stack_trace: 'at Game.Tests.CombatTests.Damage ()',
        },
      ],
      results: [],
    },
    { resultDetail: 'failures' },
  )
  assert.match(text, /\[Failed\] Game\.Tests\.CombatTests\.Damage/)
  assert.match(text, /Expected 9 but was 8/)
  assert.match(text, /at Game\.Tests\.CombatTests\.Damage/)
})

test('list formatting reports truncation and the matched count', () => {
  const text = formatTestList({ mode: 'Edit', matched: 1, truncated: true, tests: [{ full_name: 'A.B', assembly: 'T' }] })
  assert.match(text, /1 test\(s\) matched in Edit \(truncated by max_results\)/)
  assert.match(text, /- A\.B \[T\]/)
})

// ── unity_capture ───────────────────────────────────────────────────────────

test('unity_capture returns the PNG path and the text summary', async () => {
  await withEditor(async () => {
    const result = await tools.unity_capture.execute(
      { request_editor_status: 'editing', target: 'game' },
      ctx(),
    )
    assert.match(result.path, /fake\.png$/)
    assert.match(result.text, /1280x720 px, image\/png/)
    assert.match(result.text, /downscaled from 2560x1440/)
  })
})

test('capture renders the image block itself, so no second read is needed', () => {
  const image = {
    attachmentId: 'att-1',
    mediaType: 'image/png',
    bytes: 100,
    width: 4,
    height: 2,
  }
  const definition = tools.unity_capture
  const withImage = definition.output.render({}, { text: 'summary', image })
  assert.equal(withImage.length, 2)
  assert.deepEqual(withImage[0], { type: 'text', text: 'summary' })
  assert.equal(withImage[1].type, 'image')
  assert.equal(withImage[1].attachment.attachmentId, 'att-1')

  // Without a committed image (no attachment store, text-only route) the
  // result stays text-only rather than claiming an attachment it lacks.
  const withoutImage = definition.output.render({}, { text: 'summary' })
  assert.equal(withoutImage.length, 1)
  assert.equal(withoutImage[0].type, 'text')
})

test('capture request uses the camelCase payload the broker parses', () => {
  const payload = JSON.parse(buildCaptureRequest({ target: 'GAME', max_long_edge: 2048 }))
  assert.deepEqual(payload, { target: 'game', maxLongEdge: 2048 })
  assert.equal(JSON.parse(buildCaptureRequest({ target: 'scene', window_title: ' Console ' })).windowTitle, 'Console')
  assert.throws(() => buildCaptureRequest({ target: 'screen' }), /target must be one of/)
  assert.throws(() => buildCaptureRequest({ target: 'game', max_long_edge: 9000 }), /max_long_edge must be an integer/)
})

test('capture parsing falls back to the original dimensions', () => {
  const captured = parseCapture(
    JSON.stringify({ target: 'scene', title: 'S', path: 'a.png', width: 10, height: 20, originalWidth: 40, originalHeight: 80 }),
  )
  assert.equal(captured.sourceWidth, 40)
  assert.equal(captured.sourceHeight, 80)
  assert.throws(() => parseCapture('{}'), /did not report a file path/)
})

// ── unity_asset_graph ───────────────────────────────────────────────────────

test('the GUID is read from the asset .meta file', () => {
  assert.equal(readAssetGuid(PROJECT, 'Assets/Prefabs/Player.prefab'), '0123456789abcdef0123456789abcdef')
  assert.equal(projectRelative(PROJECT, 'Assets/Prefabs/Player.prefab'), 'Assets/Prefabs/Player.prefab')
})

test('an asset without a .meta explains why it has no references', () => {
  assert.throws(
    () => readAssetGuid(PROJECT, 'Assets/Scripts/Missing.cs'),
    /has no \.meta file/,
  )
})

test('only scenes and prefabs are searchable through the bridge', () => {
  assert.equal(assertSearchableAsset(PROJECT, 'Assets/Prefabs/Player.prefab'), 'Assets/Prefabs/Player.prefab')
  assert.throws(() => assertSearchableAsset(PROJECT, 'Assets/Prefabs/Player.mat'), /is not a scene or prefab/)
})

test('references compile the guid into a scene scan and report the attach points', async () => {
  const requests = []
  await withEditor(
    async () => {
      const result = await tools.unity_asset_graph.execute(
        {
          action: 'references',
          path: 'Assets/Prefabs/Player.prefab',
          file_path: 'Assets/Scenes/Main.unity',
        },
        ctx(),
      )
      assert.equal(result.guid, '0123456789abcdef0123456789abcdef')
      assert.match(result.text, /Attach points of Assets\/Prefabs\/Player\.prefab/)
      assert.match(result.text, /inside Assets\/Scenes\/Main\.unity/)
      assert.match(result.text, /Root\/Player/)
    },
    { onMessage: (request) => {
      if (request.type === 'execute_code') requests.push(request.message)
      return undefined
    } },
  )
  assert.equal(requests.length, 1)
  // The GUID and the scene scope both travel as C# string literals, because
  // `search_yaml` matches names only and never a GUID.
  assert.match(requests[0], /var targetGuid = "0123456789abcdef0123456789abcdef"/)
  assert.match(requests[0], /string sceneFilter = "Assets\/Scenes\/Main\.unity"/)
  assert.match(requests[0], /MonoScript\.FromMonoBehaviour/)
})

test('references without a file to search inside explains the missing scope', async () => {
  await assert.rejects(
    () => tools.unity_asset_graph.execute({ action: 'references', path: 'Assets/Prefabs/Player.prefab' }, ctx()),
    /references needs the scene or prefab to search inside/,
  )
})

test('usages list attach points for the script guid', async () => {
  const requests = []
  await withEditor(
    async () => {
      const result = await tools.unity_asset_graph.execute(
        {
          action: 'usages',
          path: 'Assets/Scripts/PlayerController.cs',
          file_path: 'Assets/Scenes/Main.unity',
        },
        ctx(),
      )
      assert.equal(result.guid, 'fedcba9876543210fedcba9876543210')
      assert.match(result.text, /Attach points of Assets\/Scripts\/PlayerController\.cs/)
      assert.match(result.text, /inside Assets\/Scenes\/Main\.unity/)
    },
    { onMessage: (request) => {
      if (request.type === 'execute_code') requests.push(request.message)
      return undefined
    } },
  )
  assert.equal(requests.length, 1)
  assert.match(requests[0], /var targetGuid = "fedcba9876543210fedcba9876543210"/)
  assert.match(requests[0], /var wantedMember = null/)
})

test('usages with a member name that field in the scan', async () => {
  const requests = []
  await withEditor(
    async () => {
      await tools.unity_asset_graph.execute(
        {
          action: 'usages',
          path: 'Assets/Scripts/PlayerController.cs',
          file_path: 'Assets/Scenes/Main.unity',
          member: 'maxHealth',
        },
        ctx(),
      )
    },
    { onMessage: (request) => {
      if (request.type === 'execute_code') requests.push(request.message)
      return undefined
    } },
  )
  assert.match(requests[0], /var wantedMember = "maxHealth"/)
  assert.match(requests[0], /FindProperty\("maxHealth"\)/)
})

// ── unity_scene find / batch / undo ─────────────────────────────────────────

test('find validates its component type and limit', () => {
  assert.throws(() => validateComponentSearch({}), /component_type is required/)
  assert.throws(() => validateComponentSearch({ component_type: 'Rigidbody', limit: 5000 }), /limit must be an integer/)
  assert.deepEqual(validateComponentSearch({ component_type: 'Rigidbody' }), {
    componentType: 'Rigidbody',
    includeInactive: false,
    limit: 200,
    scenePath: null,
  })
})

test('the find snippet embeds the type as a C# string literal, not source', () => {
  const body = componentSearchBody(validateComponentSearch({ component_type: 'Rigidbody" + Evil() + "' }))
  assert.match(body, /var wanted = "Rigidbody\\" \+ Evil\(\) \+ \\"/)
})

test('batch validates every write and reports the offending index', () => {
  assert.throws(() => validateBatch({ edits: [] }), /edits must be a non-empty array/)
  assert.throws(
    () => validateBatch({ edits: [{ scene_path: 'S', object_path: 'P', component_type: 'Transform', property_path: 'x' }] }),
    /edits\[0\]\.value is required/,
  )
  const request = validateBatch({
    edits: [
      {
        scene_path: 'Assets/Scenes/Main.unity',
        object_path: 'Root/Player',
        component_type: 'Transform',
        property_path: 'm_LocalPosition',
        value: '1,2,3',
      },
    ],
  })
  assert.equal(request.writes.length, 1)
  assert.equal(request.writes[0].value, '"1,2,3"')
  assert.equal(request.save, true)
})

test('an undo token carries the value each batch write replaced', () => {
  const token = batchUndoToken({
    undoGroup: 12,
    results: [
      {
        scenePath: 'Assets/Scenes/Main.unity',
        objectPath: 'Root/Player',
        component: 'Transform',
        componentIndex: 0,
        propertyPath: 'm_LocalPosition',
        before: '0,1,0',
        after: '1,2,3',
      },
    ],
  })
  assert.equal(token.kind, 'scene-batch')
  assert.equal(token.undoGroup, 12)
  assert.equal(token.writes[0].before, '0,1,0')
  assert.equal(token.writes[0].componentType, 'Transform')
})

test('unity_scene batch applies writes and returns an undo token', async () => {
  await withEditor(
    async () => {
      const result = await tools.unity_scene.execute(
        {
          action: 'batch',
          edits: [
            {
              scene_path: 'Assets/Scenes/Main.unity',
              object_path: 'Root/Player',
              component_type: 'Transform',
              property_path: 'm_LocalPosition',
              value: '1,2,3',
            },
          ],
        },
        ctx(),
      )
      assert.match(result.text, /Applied 1 field write\(s\) as one transaction/)
      assert.equal(result.undo.kind, 'scene-batch')
    },
    {
      // The batch snippet prints the transaction summary itself.
      onMessage: (request, _helpers, socket) => {
        if (request.type !== 'execute_code') return undefined
        if (!request.message.includes('Locus batch edit')) return undefined
        socket.write(
          JSON.stringify({
            type: 'response',
            reply_to: request.id,
            ok: true,
            message: JSON.stringify({
              applied: 1,
              failed: 0,
              undoGroup: 7,
              savedScenes: ['Assets/Scenes/Main.unity'],
              results: [
                {
                  scenePath: 'Assets/Scenes/Main.unity',
                  objectPath: 'Root/Player',
                  component: 'Transform',
                  componentIndex: 0,
                  propertyPath: 'm_LocalPosition',
                  before: '0,1,0',
                  after: '1,2,3',
                },
              ],
              errors: [],
            }),
          }) + '\n',
        )
        return true
      },
    },
  )
})

test('unity_scene find lists the objects carrying a component', async () => {
  await withEditor(
    async () => {
      const result = await tools.unity_scene.execute(
        { action: 'find', component_type: 'Rigidbody' },
        ctx(),
      )
      assert.match(result.text, /1 object\(s\) carry Rigidbody/)
      assert.match(result.text, /Root\/Player/)
    },
    {
      onMessage: (request, _helpers, socket) => {
        if (request.type !== 'execute_code') return undefined
        if (!request.message.includes('"component", wanted')) return undefined
        socket.write(
          JSON.stringify({
            type: 'response',
            reply_to: request.id,
            ok: true,
            message: JSON.stringify({
              component: 'Rigidbody',
              count: 1,
              truncated: false,
              objects: [
                {
                  scenePath: 'Assets/Scenes/Main.unity',
                  objectPath: 'Root/Player',
                  name: 'Player',
                  component: 'Rigidbody',
                  componentType: 'UnityEngine.Rigidbody',
                  componentIndex: 2,
                  active: true,
                },
              ],
            }),
          }) + '\n',
        )
        return true
      },
    },
  )
})

test('unity_scene undo without a token is refused', async () => {
  await assert.rejects(
    () => tools.unity_scene.execute({ action: 'undo' }, ctx()),
    /requires the `undo` token a `batch` returned/,
  )
})

test('every declared output property is allowed by its own schema', () => {
  // DSH throws ToolOutputError when a returned key is not in `output.schema`,
  // and `additionalProperties: false` turns that into a hard failure. The keys
  // below are the union over every action each tool can take, so a newly added
  // action has to declare what it returns here.
  const returns = {
    unity_status: { text: '', connected: false, status: '', scenes: [], pipe: '' },
    unity_execute: { output: '', cancelled: false, maxMainThreadBlockedMs: 0 },
    unity_play_mode: { text: '', status: '' },
    unity_console_log: { text: '' },
    unity_recompile: { text: '', status: '', operationId: '', elapsedMs: 0 },
    unity_test: { text: '', status: '', total: 0, passed: 0, failed: 0, skipped: 0 },
    // read → snapshot, apply → undo
    unity_asset: { text: '', revision: '', snapshot: {}, undo: {} },
    unity_asset_graph: { text: '', guid: '' },
    // image is present only when the attachment store accepted the capture
    unity_capture: { text: '', path: '', image: {} },
    // batch → undo
    unity_scene: { text: '', undo: { kind: 'scene-batch', writes: [] } },
  }
  for (const definition of toolDefinitions) {
    const schema = definition.output?.schema
    assert.ok(schema, `${definition.name} declares no output schema`)
    assert.equal(schema.additionalProperties, false, `${definition.name} must close its output schema`)
    const declared = Object.keys(schema.properties ?? {})
    const produced = Object.keys(returns[definition.name] ?? {})
    assert.ok(produced.length > 0, `${definition.name} is missing from this audit`)
    for (const key of produced) {
      assert.ok(declared.includes(key), `${definition.name} returns "${key}" but its schema does not declare it`)
    }
  }
})
