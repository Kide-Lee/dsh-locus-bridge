// Locus tool definitions for DSH.
//
// This module has no dependency on @deepseek-ai/dsh-tools: the definitions are
// plain objects (`parameters` as implicit JSON-Schema property maps) and
// `src/index.js` registers them. Parameter objects stay inside DSH's supported
// JSON Schema subset (type/oneOf/properties/required/additionalProperties/
// items/enum/const + description/title/default/examples); Locus-only
// constraints (ranges, path rules) are enforced when the tool executes.
//
// Tool set:
//   unity_status        connection + editor state
//   unity_execute       arbitrary C# snippet (the escape hatch)
//   unity_play_mode     Play/Edit mode convergence
//   unity_console_log   Console entries
//   unity_recompile     compile + domain reload + convergence
//   unity_asset         serialized asset read / revision-guarded edit / reload
//   unity_scene         scene object search / read / atomic set

import { randomUUID } from 'node:crypto'
import { resolveProjectRoot, normalizeCode, blockedMs } from './args.js'
import {
  activeEditOwner,
  describeTarget,
  getClient,
  openEditSession,
  shutdownPool,
  withClient,
} from './client-pool.js'
import { buildApplyRequest, readAsset, reloadAssets } from './asset-api.js'
import { findCodeUsages, findReferences } from './asset-graph.js'
import { buildCaptureRequest, captureContent, captureViewport, commitImage, assertImageCapableRoute, formatCapture, readablePath } from './capture.js'
import { consoleLogMessage, formatConsoleLog } from './console.js'
import {
  UNITY_EXECUTE_CANCELLED,
  assertRequestedStatus,
  executeSnippet,
  longBlockNote,
  readEditorStatus,
} from './execute.js'
import { formatStatus } from './format.js'
import { LocusError } from './locus-client.js'
import { playModeMessage, setPlayMode } from './play-mode.js'
import { formatSetup, inspectSetup } from './setup.js'
import { clampExecuteTimeout, EDITOR_STATUS_DISCONNECTED, EXECUTE_IDLE_LIMIT_MS } from './protocol.js'
import { beginUndoCheckpoint, endUndoCheckpoint, recordWrite } from './undo.js'
import { recompile, readReloadState, assertRecompileableStatus } from './recompile.js'
import { formatSceneTree, parseTree, readRequest, searchRequest, searchSceneObjects } from './scene.js'
import {
  BATCH_LIMIT,
  batchBody,
  batchUndoBody,
  batchUndoToken,
  componentSearchBody,
  validateBatch,
  validateComponentSearch,
} from './scene-batch.js'
import { sceneSetExecution, validateSetArgs } from './scene-set.js'
import {
  UNITY_TEST_CANCELLED,
  formatTestList,
  formatTestRun,
  listTests,
  RESULT_DETAILS,
  runTests,
  TEST_MODES,
} from './test-runner.js'

const PROJECT_PATH = {
  type: 'string',
  description:
    'Unity project root (the folder containing Assets/ and ProjectSettings/). Relative paths resolve from the ' +
    'Session working directory. Omit it when the working directory is the Unity project, or when exactly one ' +
    'Unity project sits within three levels below it; pass it explicitly when several exist or you mean another one.',
}

const CONNECTION_DESCRIPTION =
  'Requires a running Unity Editor with the Locus package, the native broker library (locus_unity_native.dll on ' +
  'Windows, liblocus_unity_native.so on Linux/macOS), and the native bridge enabled ' +
  '(Library/Locus/NativeBridge.enabled or LOCUS_UNITY_NATIVE_BRIDGE=1).'

/** Plain JSON parameter map (the shape `defineTool` consumes). */
export function parameterSpecs(definition) {
  return JSON.parse(JSON.stringify(definition.parameters ?? {}))
}

function publish(text, exec) {
  if (exec && text) exec.publish?.(text)
}

/**
 * The Host context, set once by `apply()`. Tool bodies run outside `apply`, so
 * a tool that needs a Host service at call time (the capture tool asks
 * `attachments` to carry its image) reads it from here — the same closure
 * `read_image` builds by capturing its own `ctx`.
 */
let host = null

/** Remember the Host context. Exported for `src/index.js` only. */
export function attachHost(ctx) {
  host = ctx
}

/** Surface a LocusError as a plain Error so DSH renders it as a tool error. */
function asToolError(error) {
  if (error instanceof LocusError) return new Error(error.message)
  return error
}

function targetFor(args, exec) {
  return describeTarget({ projectRoot: resolveProjectRoot(args.project_path, exec) })
}

function failure(message) {
  return { output: `Error: ${message}`, cancelled: false, maxMainThreadBlockedMs: 0 }
}

/**
 * Failure shape for tools whose output schema is `{text, ...}`.
 *
 * `failure()` above belongs to `unity_execute`, whose schema declares
 * `output`/`cancelled`/`maxMainThreadBlockedMs`. Returning it from any other tool
 * is rejected by the registry ("value.output is not a declared property") and
 * the real error is replaced by a schema complaint.
 */
function textFailure(message) {
  return { text: `Error: ${message}` }
}

// ─── unity_status ───────────────────────────────────────────────────────────

const unityStatus = {
  name: 'unity_status',
  description:
    'Check the Locus connection to the Unity Editor and report its state (editing / playing / playing_paused, ' +
    `open scenes, broker capabilities, domain generation / convergence serial). ${CONNECTION_DESCRIPTION}`,
  parameters: {
    project_path: PROJECT_PATH,
    pipe: {
      type: 'string',
      description: 'Explicit Locus broker pipe name (overrides the project-derived or marker-file pipe).',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        connected: { type: 'boolean' },
        status: { type: 'string' },
        scenes: { type: 'array', items: { type: 'string' } },
        pipe: { type: 'string' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) {
    const projectRoot = resolveProjectRoot(args.project_path, exec)
    const target = describeTarget({ projectRoot, pipe: args.pipe })
    if (!target.pipe) {
      return statusResult(target, false, 'disconnected', [], null, 'no pipe resolved')
    }
    try {
      const client = await getClient(target)
      const state = await readEditorStatus(client)
      const capabilities = client.capabilities
      let reloadState = null
      if (state.connected) reloadState = await readReloadState(target).catch(() => null)
      const text = formatStatus({ ...state, pipe: target.pipe, projectRoot, capabilities, reloadState })
      return statusResult(target, state.connected, state.status, state.scenes, capabilities, state.error, text)
    } catch (error) {
      // A failed connection is exactly when the project's own state matters:
      // report it unprompted instead of making the caller ask again.
      const text = await withDiagnosis(
        formatStatus({ connected: false, status: 'disconnected', pipe: target.pipe, projectRoot, error: error.message }),
        projectRoot,
        exec,
      )
      return statusResult(target, false, 'disconnected', [], [], error.message, text)
    }
  },
}

function statusResult(target, connected, status, scenes, capabilities, error, text) {
  return {
    text: text ?? formatStatus({ connected, status, scenes, pipe: target.pipe, capabilities, error }),
    connected,
    status,
    scenes: scenes ?? [],
    pipe: target.pipe ?? '',
  }
}

/**
 * Append a project diagnosis to a failed connection, without repeating what the
 * caller already sees. An empty diagnosis means the project is fine and the
 * editor is simply not running.
 */
async function withDiagnosis(text, projectRoot, exec) {
  let diagnosis
  try {
    diagnosis = formatSetup(inspectSetup(projectRoot))
  } catch {
    return text
  }
  if (!diagnosis) return text
  publish(diagnosis, exec)
  return `${text}\n\n${diagnosis}`
}

// ─── unity_execute ──────────────────────────────────────────────────────────

const unityExecute = {
  name: 'unity_execute',
  description:
    'Compile and execute a C# method body on the Unity Editor main thread. UnityEngine, UnityEditor, project/package ' +
    'types, and the Locus snippet API are available.\n\n' +
    'Return results with print(obj) or printJson(obj) (LocusJson is available); a single trailing expression is also ' +
    'printed. Your code is the body of an async method, so use top-level `await` directly — `await Task.Delay(50)`, ' +
    '`await ctx.WaitSeconds(0.1)`. Do not call `ExecuteAsync(...)` yourself: the bridge already wraps this body in it, ' +
    'and a nested `ExecuteAsync(async (ctx, ct) => …)` call fails with CS7036. Use ctx.WaitFrame()/WaitFrames/' +
    'WaitSeconds to yield between frames. Nested functions are not ' +
    'at the top level: call them with ().\n\n' +
    `Timing: code between awaits holds Unity's main thread and freezes the Editor until it returns or awaits. Locus ` +
    `stops a snippet after ${EXECUTE_IDLE_LIMIT_MS / 1000}s with no print/printJson/ctx.Progress output, including ` +
    'inside one long await; split long work into chunks that print or call ctx.Progress, and long waits into shorter ' +
    'ctx.WaitSeconds loops. `timeout` bounds the whole call (1000..3600000 ms, default 600000).\n\n' +
    'Do NOT create or change .cs files from a snippet (a domain reload would kill it) — write the files with the ' +
    'write/edit tools and call unity_recompile. Prefer unity_asset/unity_scene for ordinary asset and scene edits. ' +
    'Read-only calls may run in recording mode (readonly: true); writes should leave readonly false.\n\n' +
    `request_editor_status must match the live editor state; use unity_play_mode to change modes. ${CONNECTION_DESCRIPTION}`,
  parameters: {
    project_path: PROJECT_PATH,
    code: {
      type: 'string',
      description:
        'C# code to compile and execute, written as the body of a static method. Use print(obj), printJson(obj) to ' +
        'return results.',
      required: true,
    },
    readonly: {
      type: 'boolean',
      description:
        'Whether the code only observes state. Use true only when it does not change Unity objects, assets, scenes, ' +
        'project settings, editor state, or files.',
    },
    request_editor_status: {
      type: 'string',
      enum: ['editing', 'playing', 'playing_paused'],
      description: 'Required Unity Editor status before running. Must match the live status.',
      required: true,
    },
    timeout: {
      type: 'integer',
      description: 'Total run budget in milliseconds, clamped to 1000..3600000 (default 600000).',
      default: 600000,
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        output: { type: 'string' },
        cancelled: { type: 'boolean' },
        maxMainThreadBlockedMs: { type: 'integer' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.output }],
  },
  async execute(args, exec) {
    const projectRoot = resolveProjectRoot(args.project_path, exec)
    const target = describeTarget({ projectRoot })
    let code
    try {
      code = normalizeCode(args.code)
    } catch (error) {
      return failure(error.message)
    }
    const requested = args.request_editor_status
    const timeoutMs = clampExecuteTimeout(args.timeout)
    try {
      const client = await getClient(target)
      const state = await readEditorStatus(client)
      if (!state.connected) return failure(`Unity Editor not connected${state.error ? `: ${state.error}` : ''}.`)
      assertRequestedStatus(requested, state.status)

      const owner = `dsh-${process.pid}-${randomUUID()}`
      const session = args.readonly === true ? null : await openEditSession(target, owner)
      try {
        let lastPublished = 0
        const { output, progress } = await executeSnippet(client, {
          code,
          executionId: randomUUID(),
          timeoutMs,
          signal: exec.signal,
          onProgress: (snapshot) => {
            const blocked = blockedMs(snapshot)
            if (blocked >= 5_000 && blocked - lastPublished >= 5_000) {
              lastPublished = blocked
              publish(`Unity main thread blocked ${(blocked / 1000).toFixed(1)}s`, exec)
            } else if (snapshot?.title || snapshot?.info) {
              publish(String(snapshot.info || snapshot.title), exec)
            }
          },
        })
        const trimmed = (output ?? '').trim()
        let text = trimmed.length > 0 ? trimmed : 'Code executed successfully (no output).'
        const note = longBlockNote(blockedMs(progress))
        if (note) text += `\n\n${note}`
        return { output: text, cancelled: false, maxMainThreadBlockedMs: blockedMs(progress) }
      } finally {
        await session?.release()
      }
    } catch (error) {
      if (error?.message === UNITY_EXECUTE_CANCELLED || exec.signal?.aborted) {
        return { output: 'Execution cancelled by the caller; Unity snippet stopped.', cancelled: true, maxMainThreadBlockedMs: 0 }
      }
      return failure(asToolError(error).message)
    }
  },
}

// ─── unity_play_mode ────────────────────────────────────────────────────────

const unityPlayMode = {
  name: 'unity_play_mode',
  description:
    'Set the connected Unity Editor to Play Mode or Edit Mode and wait until that mode is reached. ' +
    '`play` starts Play Mode from Edit Mode and resumes the Editor when Play Mode is paused; `edit` stops Play Mode ' +
    `(including paused). Calling it while Unity already matches the requested mode succeeds without changes. ${CONNECTION_DESCRIPTION}`,
  parameters: {
    project_path: PROJECT_PATH,
    mode: {
      type: 'string',
      enum: ['play', 'edit'],
      description: 'Target mode: `play` starts or resumes Play Mode; `edit` stops Play Mode and returns to Edit Mode.',
      required: true,
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        status: { type: 'string' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) {
    const target = targetFor(args, exec)
    try {
      // Play Mode reloads the domain, so the connection dies mid-flight: hand
      // the flow a reconnect instead of treating that as a hard failure.
      const result = await withClient(target, (client) =>
        setPlayMode(client, args.mode, { signal: exec.signal, reconnect: () => getClient(target) }),
      )
      return { text: playModeMessage(result), status: result.status }
    } catch (error) {
      throw asToolError(error)
    }
  },
}

// ─── unity_console_log ──────────────────────────────────────────────────────

const unityConsoleLog = {
  name: 'unity_console_log',
  description:
    'Read recent Unity Console entries without asking the user to copy logs. Entries are chronological, duplicates ' +
    'are merged with a count, and the message is truncated to the newest entries. `level` and `levels` combine with OR ' +
    `semantics; omit both for all levels. ${CONNECTION_DESCRIPTION}`,
  parameters: {
    project_path: PROJECT_PATH,
    level: {
      type: 'string',
      enum: ['error', 'warn', 'info'],
      description: 'Optional single Unity Console level to return.',
    },
    levels: {
      type: 'array',
      items: { type: 'string', enum: ['error', 'warn', 'info'] },
      description: 'Optional Unity Console levels to return (OR semantics), e.g. ["warn", "error"].',
    },
    limit: {
      type: 'integer',
      description: 'Maximum number of merged entries to return (1..200, default 50).',
      default: 50,
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) {
    const { message } = consoleLogMessage({ level: args.level, levels: args.levels, limit: args.limit })
    const target = targetFor(args, exec)
    try {
      const envelope = await withClient(target, (client) =>
        client.call('unity_get_console_log', message, { timeoutMs: 30_000 }),
      )
      return { text: formatConsoleLog(envelope.message) }
    } catch (error) {
      throw asToolError(error)
    }
  },
}

// ─── unity_recompile ────────────────────────────────────────────────────────

/**
 * The claim `unity_recompile` requires, mirroring upstream
 * `UNITY_EDITOR_STATUS_SCHEMA`. `disconnected` is a legal claim (the caller may
 * legitimately believe the editor is gone) but cannot run a recompile.
 */
const RECOMPILE_STATUS_SCHEMA = ['disconnected', 'editing', 'playing', 'playing_paused']

const unityRecompile = {
  name: 'unity_recompile',
  description:
    'Apply pending project C# changes through compilation and domain reload, and wait for the result. Use it after ' +
    'editing .cs files (or .asmdef / serialization-affecting changes), before compiling tests or relying on new ' +
    'runtime behaviour. Requires Edit Mode. The connection drops during the reload and is re-established ' +
    'automatically; this can take 10-60 seconds.\n\n' +
    'The result `status` is one of: `ok` (compiled and reloaded), `not_needed` (assemblies already up to date), ' +
    '`superseded` (another compilation, e.g. the user\'s Ctrl+R, owns the result register) or `error` (compile ' +
    'diagnostics in `diagnostics`). `sync.mode` selects the asset import performed before compiling: `none`, ' +
    '`targeted` (only `sync.paths`) or `full` (project refresh). ' +
    CONNECTION_DESCRIPTION,
  parameters: {
    project_path: PROJECT_PATH,
    editor_status: {
      type: 'string',
      enum: [...RECOMPILE_STATUS_SCHEMA],
      description:
        'Latest canonical Unity Editor status from the session announcement or a newer tool result. Pass it ' +
        'exactly; the call requires the live editor to be editing, and a claim that disagrees with the actual ' +
        'state fails before compiling.',
      required: true,
    },
    sync: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: {
          type: 'string',
          enum: ['none', 'targeted', 'full'],
          description: 'Asset sync before compiling (default `none`).',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Changed project-relative asset paths for `targeted` sync (Assets/ or Packages/).',
        },
      },
    },
    reason: {
      type: 'string',
      description: 'Free-form reason logged in the Unity Console (optional).',
    },
    timeout: {
      type: 'integer',
      description: 'Maximum seconds to wait for convergence after the compile starts (default 300).',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        status: { type: 'string' },
        operationId: { type: 'string' },
        elapsedMs: { type: 'integer' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) {
    const target = targetFor(args, exec)
    const sync = args.sync && typeof args.sync === 'object' ? args.sync : {}
    const timeout = Number.isInteger(args.timeout) ? Math.min(Math.max(args.timeout, 30), 3600) : 300
    // Mirrors upstream `unity_recompile` (`tool/builtins/unity.rs`): the claimed
    // status is required, must be one of the four canonical values, and must
    // agree with the live editor before anything is compiled.
    const claimed = typeof args.editor_status === 'string' ? args.editor_status.trim() : ''
    if (!claimed) {
      throw new Error(
        'Missing required parameter: editor_status. Pass the latest Unity Editor status ' +
          `(${RECOMPILE_STATUS_SCHEMA.join(' | ')}) from the session announcement or a newer tool result.`,
      )
    }
    // Upstream `UNITY_EDITOR_STATUS_SCHEMA`: the four canonical values, including
    // `disconnected`, which is legal to claim but cannot run a recompile.
    if (!RECOMPILE_STATUS_SCHEMA.includes(claimed)) {
      throw new Error(
        `Invalid editor_status: "${claimed}". Allowed values: ${RECOMPILE_STATUS_SCHEMA.join(' | ')}.`,
      )
    }
    try {
      const client = await getClient(target)
      const state = await readEditorStatus(client)
      if (!state.connected) throw new Error(`Unity Editor not connected${state.error ? `: ${state.error}` : ''}.`)
      if (claimed !== state.status) {
        throw new Error(
          `editor_status mismatch: you claimed "${claimed}", but the actual editor status is "${state.status}". ` +
            'Re-read the current editor state with unity_status and try again.',
        )
      }
      if (claimed === EDITOR_STATUS_DISCONNECTED) {
        throw new Error(
          'Unity Editor status is "disconnected". `unity_recompile` is unavailable until the Editor reconnects.',
        )
      }
      assertRecompileableStatus(state.status)
      const result = await recompile(target, {
        syncMode: sync.mode ?? 'none',
        paths: sync.paths ?? [],
        reason: args.reason ?? '',
        signal: exec.signal,
        onPhase: (phase) => publish(phase, exec),
        convergeTimeoutMs: timeout * 1000,
      })
      const lines = []
      if (result.status === 'error') {
        lines.push('Unity recompile failed. Compiler diagnostics:')
        lines.push(result.message)
      } else if (result.status === 'ok') {
        lines.push('Unity recompile converged: assemblies compiled and the domain reloaded.')
      } else if (result.status === 'not_needed') {
        lines.push('Unity recompile: no assemblies needed rebuilding; no domain reload was required.')
      } else {
        lines.push(
          `Unity recompile: superseded by another compilation (${result.message}); ` +
            'call unity_status (or unity_recompile again) to confirm the editor is idle before relying on new code.',
        )
      }
      if (result.adopted) lines.push(`Adopted an in-flight compile (operation ${result.operationId}).`)
      lines.push(`Operation: ${result.operationId} (${(result.elapsedMs / 1000).toFixed(1)}s)`)
      return {
        text: lines.join('\n'),
        status: result.status,
        operationId: result.operationId,
        elapsedMs: result.elapsedMs,
      }
    } catch (error) {
      throw asToolError(error)
    }
  },
}

// ─── unity_asset ────────────────────────────────────────────────────────────

const ASSET_ACTIONS = ['read', 'apply', 'undo', 'reload']

const unityAsset = {
  name: 'unity_asset',
  description:
    'Read and edit an Asset file (.asset, .mat, .prefab, .controller, .anim, …) through Unity\'s serialized object ' +
    'API with Locus\' revision guard.\n\n' +
    '`read`: returns `{revision, path, objects:[{object_id, class_id, root_type, fields:[{property_path, kind, value}]}], ' +
    'capabilities, fields}`. Use a field\'s `property_path` (for example `m_Name` or `values.Array.data[0]`; managed ' +
    'references use `/references/RefIds/@rid=<id>/data/...`) and its object\'s `object_id` in an edit.\n\n' +
    '`apply`: pass the same `path` and the `snapshot` from the read, plus `edits` = array of ' +
    '`{operation:{op:"set"|"array_insert"|"array_remove"|"array_move"|"array_resize", object_id, property_path, ' +
    'value, index, to_index, size}}`, plus optional `expected_revision`. Values are plain JSON (string/number/bool/' +
    'array); object references are `"fileID:<id> <guid>"` or `{fileID, guid}`. A changed file is a ' +
    '`revision_conflict` and nothing is written. The batch is atomic, saved to disk and re-imported; call ' +
    'unity_asset action "undo" with the returned `undo` token to restore the previous revision while the file is ' +
    'unchanged. Compound fields (Vector3/Color/quaternions) are not supported here — use unity_scene set or ' +
    'unity_execute.\n\n' +
    '`undo`: restores the file revisions recorded by the previous `apply` (only while they still match).\n\n' +
    '`reload`: re-imports files written outside the editor (content updates, merges) and reloads clean open scenes; ' +
    'assets with unsaved in-memory edits are reported as stale, never overwritten. ' +
    CONNECTION_DESCRIPTION,
  parameters: {
    project_path: PROJECT_PATH,
    action: {
      type: 'string',
      enum: ASSET_ACTIONS,
      description: 'One of: read, apply, undo, reload.',
      required: true,
    },
    path: {
      type: 'string',
      description: 'Project-relative asset path inside Assets/ (required for read/apply).',
    },
    paths: {
      type: 'array',
      items: { type: 'string' },
      description: 'Paths for `reload` (Assets/ or Packages/).',
    },
    snapshot: {
      type: 'object',
      additionalProperties: true,
      description: 'The full object returned by `action: "read"` (required for apply).',
    },
    expected_revision: {
      type: 'string',
      description: 'Revision to require for every applied file (default: the read snapshot\'s revision).',
    },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          path: { type: 'string', description: 'Asset path (defaults to the read path).' },
          expected_revision: { type: 'string' },
          operation: {
            type: 'object',
            additionalProperties: true,
            properties: {
              op: { type: 'string', enum: ['set', 'array_insert', 'array_remove', 'array_move', 'array_resize'] },
              object_id: { type: 'string' },
              property_path: { type: 'string' },
              value: {
                // Deprecated compatibility key: `dump-tools` treats this schema as
                // implicit-JSON and skips the type it stands for.
                type: 'json',
                description:
                  'New value for this Locus call: plain JSON scalar for set, JSON array for array values, or {fileID, guid} for references.',
              },
              index: { type: 'integer' },
              to_index: { type: 'integer' },
              size: { type: 'integer' },
            },
          },
        },
      },
      description: 'Edits for `apply`. Each names an object and a property path with a `set` or array operation.',
    },
    undo: {
      type: 'object',
      additionalProperties: true,
      description: 'The `undo` token returned by `apply` (required for `action: "undo"`).',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        revision: { type: 'string' },
        // `read` hands back the snapshot `apply` requires, and `apply` hands
        // back the token `action: "undo"` requires; both must stay declared.
        snapshot: { type: 'object', additionalProperties: true },
        undo: { type: 'object', additionalProperties: true },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) {
    const target = targetFor(args, exec)
    const action = String(args.action ?? '')
    try {
      if (action === 'read') {
        const snapshot = await readAsset(target, args.path)
        // `apply` is documented to take this snapshot (it carries the revision
        // guard), so return it instead of dropping it: the caller would otherwise
        // have to re-read and could never build a guarded edit.
        return { text: formatAssetSnapshot(snapshot), revision: snapshot.revision, snapshot }
      }
      if (action === 'apply') {
        const owner = activeEditOwner(target.pipe) ?? `dsh-${process.pid}-${randomUUID()}`
        const result = await withBarriers(exec, owner, target, () => applyAssetEdit(target, args, owner), 'unity_asset')
        // The undo token is the documented way to revert; return it as data so a
        // caller can pass it straight back to `action: "undo"`.
        return { text: formatAssetApply(result), revision: '', undo: result.undo }
      }
      if (action === 'undo') {
        const undo = args.undo && typeof args.undo === 'object' ? args.undo : null
        if (!undo || !Array.isArray(undo.files) || undo.files.length === 0) {
          throw new Error('action "undo" requires the `undo` token an apply returned.')
        }
        const owner = activeEditOwner(target.pipe) ?? `dsh-${process.pid}-${randomUUID()}`
        const result = await withBarriers(exec, owner, target, () => undoAssetEdit(target, undo, owner), 'unity_asset:undo')
        return { text: result, revision: '' }
      }
      if (action === 'reload') {
        const result = await reloadAssets(target, args.paths ?? [], null)
        const lines = ['Asset reload:', `imported: ${(result.imported ?? []).join(', ') || '<none>'}`]
        if ((result.reloaded_scenes ?? []).length) lines.push(`reloaded scenes: ${result.reloaded_scenes.join(', ')}`)
        if ((result.stale ?? []).length) lines.push(`stale (unsaved, left untouched): ${result.stale.join(', ')}`)
        if ((result.pending_refresh ?? []).length) lines.push(`absent on disk: ${result.pending_refresh.join(', ')}`)
        return { text: lines.join('\n'), revision: '' }
      }
      throw new Error(`action must be one of ${ASSET_ACTIONS.join(', ')}.`)
    } catch (error) {
      throw asToolError(error)
    }
  },
}

/**
 * Run one write inside an undo checkpoint: the previous state is read before
 * the write so `undo` can verify it, and the checkpoint is marked for undo once
 * a later asset/scene write supersedes it.
 */
async function withBarriers(exec, owner, target, run, tool) {
  await beginUndoCheckpoint(owner, target)
  try {
    const result = await run()
    if (tool) recordWrite(owner, tool, result)
    return result
  } finally {
    await endUndoCheckpoint(owner, target)
  }
}

async function applyAssetEdit(target, args, owner) {
  const snapshot = args.snapshot
  if (!snapshot || typeof snapshot !== 'object') throw new Error('action "apply" requires the `snapshot` a read returned.')
  const request = buildApplyRequest({ snapshot, edits: args.edits })
  if (args.expected_revision) for (const entry of request.entries) entry.expected_revision = args.expected_revision
  // Record the pre-edit values so `action: "undo"` can invert them.
  const undoFiles = []
  for (const entry of request.entries) {
    const current = entry.path === snapshot.path || !snapshot.path ? snapshot : await readAsset(target, entry.path)
    if (current.revision !== entry.expected_revision) {
      throw new Error(
        `${entry.path} changed since the snapshot (revision ${current.revision} != ${entry.expected_revision}); re-read it.`,
      )
    }
    undoFiles.push({ path: entry.path, operations: recordOperations(current, entry.operations) })
  }
  const session = await openEditSession(target, owner)
  try {
    const envelope = await withClient(
      target,
      (client) => client.call('asset_api', JSON.stringify(request), { timeoutMs: 180_000 }),
      { exclusive: true },
    )
    const result = JSON.parse(envelope.message || '{}')
    return {
      applied: result.applied !== false,
      persisted: result.persisted !== false,
      transaction_id: result.transaction_id ?? null,
      timings: result.timings ?? null,
      files: request.entries.map((entry) => ({
        path: entry.path,
        expected_revision: entry.expected_revision,
        operations: entry.operations.length,
      })),
      undo: { kind: 'asset', transaction_id: result.transaction_id ?? null, files: undoFiles },
    }
  } finally {
    await session.release()
  }
}

/** For each wire operation, remember the current value (and array size) from the read. */
export function recordOperations(snapshot, operations) {
  // The read lists fields both at the top level and inside each object; index
  // both so an edit's property path resolves to the value it replaces.
  const index = new Map()
  for (const field of snapshot.fields ?? []) index.set(field.property_path, field)
  for (const object of snapshot.objects ?? []) for (const field of object.fields ?? []) index.set(field.property_path, field)
  return operations.map((wire) => {
    const field = index.get(wire.property_path)
    const record = { wire }
    if (wire.op === 'set' || wire.op === 'array_remove') {
      record.before = field ? JSON.stringify(field.value) : 'null'
    }
    if (wire.op === 'array_resize' || wire.op === 'array_remove') {
      record.beforeSize = Array.isArray(field?.value) ? field.value.length : field?.arraySize ?? -1
    }
    return record
  })
}

/**
 * Reverse one asset apply: every recorded operation is inverted and sent back
 * as another revision-guarded batch (set → old value, insert ↔ remove, move
 * i↔j, resize → previous size). Refuses when a file no longer matches.
 */
async function undoAssetEdit(target, undo, owner) {
  const files = Array.isArray(undo.files) ? undo.files : []
  const entries = []
  for (const file of files) {
    const current = await readAsset(target, file.path)
    const inverted = invertOperations(file.operations)
    if (inverted.length === 0) continue
    entries.push({ path: file.path, expected_revision: current.revision, operations: inverted })
  }
  if (entries.length === 0) throw new Error('Nothing to undo: no scalar or array operations were recorded.')
  const session = await openEditSession(target, owner)
  try {
    const envelope = await withClient(
      target,
      (client) =>
        client.call('asset_api', JSON.stringify({ action: 'apply_batch', persist: 'disk', entries }), {
          timeoutMs: 180_000,
        }),
      { exclusive: true },
    )
    const result = JSON.parse(envelope.message || '{}')
    const total = entries.reduce((sum, entry) => sum + entry.operations.length, 0)
    const lines = [`Undid ${total} operation(s) across ${entries.length} file(s).`]
    for (const entry of entries) lines.push(`- ${entry.path} (revision ${entry.expected_revision})`)
    if (result.transaction_id) lines.push(`Transaction: ${result.transaction_id}`)
    return lines.join('\n')
  } finally {
    await session.release()
  }
}

/** Invert asset-api operations using the values the read recorded before the write. */
export function invertOperations(operations) {
  const out = []
  for (const record of operations ?? []) {
    const wire = record.wire ?? {}
    const base = { object_id: wire.object_id, property_path: wire.property_path }
    switch (wire.op) {
      case 'set':
        out.push({ op: 'set', ...base, value_json: record.before })
        break
      case 'array_insert':
        out.push({ op: 'array_remove', ...base, index: wire.index })
        break
      case 'array_remove':
        out.push({ op: 'array_insert', ...base, index: wire.index, value_json: record.before })
        break
      case 'array_move':
        out.push({ op: 'array_move', ...base, index: wire.to_index, to_index: wire.index })
        break
      case 'array_resize':
        out.push({ op: 'array_resize', ...base, size: record.beforeSize })
        break
      default:
        break
    }
  }
  return out
}

function formatAssetSnapshot(snapshot) {
  const objects = Array.isArray(snapshot.objects) ? snapshot.objects : []
  const fields = Array.isArray(snapshot.fields) ? snapshot.fields : []
  const lines = [`Asset: ${snapshot.path ?? ''}`, `Revision: ${snapshot.revision}`, `Objects: ${objects.length}`]
  for (const object of objects) {
    lines.push(`- object_id ${object.object_id} (${object.root_type ?? object.class_id})`)
  }
  const limit = 200
  for (const [index, field] of fields.entries()) {
    if (index >= limit) {
      lines.push(`… (${fields.length - limit} more fields; filter by property path prefix when editing)`)
      break
    }
    lines.push(`  ${field.property_path} [${field.kind ?? '?'}] = ${shortJson(field.value)}`)
  }
  if (Array.isArray(snapshot.diagnostics) && snapshot.diagnostics.length) {
    lines.push(`Diagnostics: ${snapshot.diagnostics.length}`)
  }
  return lines.join('\n')
}

function formatAssetApply(result) {
  const lines = [
    `Applied ${result.files.reduce((sum, file) => sum + file.operations, 0)} operation(s) to ` +
      `${result.files.length} asset file(s)${result.persisted ? ' (saved to disk)' : ''}.`,
  ]
  if (result.transaction_id) lines.push(`Transaction: ${result.transaction_id}`)
  for (const file of result.files) lines.push(`- ${file.path} (revision ${file.expected_revision})`)
  if (result.timings) {
    const writeMs = result.timings.writeMs
    const importMs = result.timings.importMs
    if (typeof writeMs === 'number' || typeof importMs === 'number') {
      lines.push(`Timings: write ${Math.round(writeMs ?? 0)}ms, import ${Math.round(importMs ?? 0)}ms`)
    }
  }
  lines.push(`Undo token (action "undo", only while unmodified): ${JSON.stringify(result.undo)}`)
  return lines.join('\n')
}

function shortJson(value) {
  const text = JSON.stringify(value)
  if (text === undefined) return 'null'
  return text.length > 120 ? `${text.slice(0, 117)}…` : text
}

// ─── unity_test ─────────────────────────────────────────────────────────────

const TEST_ACTIONS = ['list', 'run']

const TEST_FILTER_PARAMETERS = {
  mode: {
    type: 'string',
    enum: TEST_MODES,
    description: 'Unity Test mode. `edit|play` covers both modes in one request; omit it for the framework default.',
  },
  assemblies: {
    type: 'array',
    items: { type: 'string' },
    description: 'Test assembly names without the .dll extension.',
  },
  tests: {
    type: 'array',
    items: { type: 'string' },
    description: 'Exact full test names.',
  },
  groups: {
    type: 'array',
    items: { type: 'string' },
    description:
      'Regular expressions matching full test names, fixtures, or namespaces. Prefix with ! to exclude; anchor ' +
      'with ^...$ for one exact fixture or test.',
  },
  categories: {
    type: 'array',
    items: { type: 'string' },
    description: 'NUnit category names. Prefix with ! to exclude, for example !SceneCombatE2E.',
  },
  max_results: {
    type: 'integer',
    description: 'Maximum test cases `list` returns (1..5000, default 500). The answer reports the full matched count.',
  },
}

const unityTest = {
  name: 'unity_test',
  description:
    "Discover and run the project's official Unity Test Framework tests through the Editor, and wait for structured " +
    'results. NUnit lifecycle, UnityTest coroutines, parameterized cases, skips and domain reload recovery are handled ' +
    'by Unity itself.\n\n' +
    '`list` discovers test cases; `run` executes them and returns passed/failed/skipped counts plus the failed ' +
    "results' messages and stack traces. After changing or hot-reloading test code, call unity_recompile first.\n\n" +
    'Filter fields combine with AND, values inside one field with OR; omit what you do not need. Runs start from Edit ' +
    'Mode and Unity drives any Play Mode transition itself. A timeout or cancellation stops the run through Unity, so ' +
    'a lost caller never leaves a run holding the editor.\n\n' +
    `Requires com.unity.test-framework 1.4.0 or newer in the project. ${CONNECTION_DESCRIPTION}`,
  parameters: {
    project_path: PROJECT_PATH,
    action: {
      type: 'string',
      enum: TEST_ACTIONS,
      description: '`list` discovers test cases; `run` executes them and waits for the results.',
      required: true,
    },
    ...TEST_FILTER_PARAMETERS,
    result_detail: {
      type: 'string',
      enum: RESULT_DETAILS,
      description:
        'Detail reported by `run`: `summary` counts only, `failures` adds failure messages and stack traces ' +
        '(default), `all` includes every leaf result.',
      default: 'failures',
    },
    timeout: {
      type: 'integer',
      description: 'Budget in milliseconds for a whole `run`, clamped to 1000..3600000 (default 600000).',
      default: 600000,
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        status: { type: 'string' },
        total: { type: 'integer' },
        passed: { type: 'integer' },
        failed: { type: 'integer' },
        skipped: { type: 'integer' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) {
    const target = targetFor(args, exec)
    const action = String(args.action ?? '')
    const filter = {
      mode: args.mode,
      assemblies: args.assemblies,
      tests: args.tests,
      groups: args.groups,
      categories: args.categories,
    }
    try {
      const client = await getClient(target)
      if (action === 'list') {
        const list = await listTests(client, { ...filter, maxResults: args.max_results })
        return { text: formatTestList(list), status: 'listed', total: list.matched, passed: 0, failed: 0, skipped: 0 }
      }
      if (action === 'run') {
        const timeoutMs = clampExecuteTimeout(args.timeout)
        let lastPublish = 0
        const snapshot = await runTests(
          client,
          { ...filter, maxResults: args.max_results, resultDetail: args.result_detail },
          {
            signal: exec.signal,
            timeoutMs,
            onUpdate: (update) => {
              const now = Date.now()
              if (now - lastPublish < 2_000) return
              lastPublish = now
              const progress = `Unity Test ${update.status}: ${update.passed} passed, ${update.failed} failed of ` +
                `${update.total}` + (update.currentTest ? ` — ${update.currentTest}` : '')
              publish(progress, exec)
            },
          },
        )
        return {
          text: formatTestRun(snapshot, { resultDetail: args.result_detail ?? 'failures' }),
          status: snapshot.status,
          total: snapshot.total,
          passed: snapshot.passed,
          failed: snapshot.failed,
          skipped: snapshot.skipped,
        }
      }
      throw new Error(`action must be one of ${TEST_ACTIONS.join(', ')}.`)
    } catch (error) {
      // A cancelled run carries the last snapshot: report the results it did
      // reach instead of discarding them behind the cancellation message.
      if (error?.message === UNITY_TEST_CANCELLED || exec.signal?.aborted) {
        const snapshot = error.snapshot
        const text = snapshot
          ? `Unity Test run cancelled.\n${formatTestRun(snapshot)}`
          : 'Unity Test run cancelled.'
        return { text, status: 'cancelled', total: snapshot?.total ?? 0, passed: snapshot?.passed ?? 0, failed: snapshot?.failed ?? 0, skipped: snapshot?.skipped ?? 0 }
      }
      throw asToolError(error)
    }
  },
}

// ─── unity_asset_graph ──────────────────────────────────────────────────────

const GRAPH_ACTIONS = ['references', 'dependencies', 'usages']

const unityAssetGraph = {
  name: 'unity_asset_graph',
  description:
    'Follow the reference graph between the assets of the connected Unity project, and find where a C# script is used.\n\n' +
    '`references`: whether the scene or prefab in `file_path` points at `path` — it reads the GUID from the target ' +
    "asset's .meta and searches for it. `dependencies`: the GUIDs `path` itself stores, i.e. what it points at.\n\n" +
    '`usages`: where a .cs script (`path`) is attached and, with `member`, the serialized fields of those components ' +
    'that carry that name. Check this together with code references before renaming, moving or deleting a type or a ' +
    'serialized field: zero code references alone does not prove nothing serializes it.\n\n' +
    'The bridge reads one .unity or .prefab through Unity\'s own serialization at a time, so `file_path` names the ' +
    'scene or prefab to search inside; there is no project-wide scan. Results therefore cover serialized data in that ' +
    'one file — not binary assets, custom serialization, presets, or references built from strings at runtime. ' +
    CONNECTION_DESCRIPTION,
  parameters: {
    project_path: PROJECT_PATH,
    action: {
      type: 'string',
      enum: GRAPH_ACTIONS,
      description: '`references`, `dependencies`, or `usages`.',
      required: true,
    },
    path: {
      type: 'string',
      description:
        'Project-relative or absolute path of the asset being referenced, or the .cs script for `usages` ' +
        '(Assets/Prefabs/Player.prefab, Assets/Materials/Red.mat, Assets/Scripts/PlayerController.cs).',
    },
    file_path: {
      type: 'string',
      description:
        'The .unity or .prefab to search inside (Assets/Scenes/Main.unity). Required for `references` and `usages`, ' +
        'which have no project-wide scan; for `dependencies` it defaults to `path`.',
    },
    member: {
      type: 'string',
      description:
        'For `usages`: a method or serialized-field name declared in that script (for example TakeDamage or maxHealth). ' +
        'Omit to list the attach points instead.',
    },
    limit: {
      type: 'integer',
      description: 'Maximum entries to return (1..500, default 100).',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        guid: { type: 'string' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) {
    const projectRoot = resolveProjectRoot(args.project_path, exec)
    const target = describeTarget({ projectRoot })
    const action = String(args.action ?? '')
    if (!String(args.path ?? '').trim()) throw new Error('path is required (the asset to inspect).')
    try {
      if (action === 'usages') {
        const result = await findCodeUsages(target, projectRoot, {
          filePath: args.path,
          member: args.member,
          limit: args.limit,
          scenePath: args.file_path,
        })
        // `findCodeUsages` already renders the heading and the counts from the
        // scan answer; adding another heading here duplicated it and buried the
        // results.
        return { text: result.results, guid: result.guid }
      }
      if (action === 'references' || action === 'dependencies') {
        const result = await findReferences(target, projectRoot, {
          assetPath: args.path,
          direction: action,
          filePath: args.file_path,
          limit: args.limit,
        })
        return { text: result.results, guid: result.guid ?? '' }
      }
      throw new Error(`action must be one of ${GRAPH_ACTIONS.join(', ')}.`)
    } catch (error) {
      throw asToolError(error)
    }
  },
}

// ─── unity_capture ──────────────────────────────────────────────────────────

const unityCapture = {
  name: 'unity_capture',
  description:
    'Capture a PNG of the connected Unity Editor and see it. Use it to inspect the real visual state of the Game view, ' +
    'the Scene view, or a specific Editor window.\n\n' +
    'The capture area is resolved by Unity; never pass screen coordinates. `game` captures the visible Game viewport ' +
    'without its toolbar, `scene` the last active Scene viewport, and `editor_window` a whole Editor window — name it ' +
    'with `window_title` (a window title, C# type name, or full type name); without it the focused window is used.\n\n' +
    'The captured image is attached to this result, so you see the pixels directly in one call — no second read. The ' +
    'text summary names the PNG on disk in case you want the file itself. This requires an image-capable model; a ' +
    'text-only route refuses the call instead of spending tokens on an image it cannot inspect. ' +
    '`max_long_edge` resizes after the capture (default 1280, 0 keeps the source size). ' +
    CONNECTION_DESCRIPTION,
  parameters: {
    project_path: PROJECT_PATH,
    request_editor_status: {
      type: 'string',
      enum: ['editing', 'playing', 'playing_paused'],
      description: 'Required Unity Editor status before capturing. Must match the live status.',
      required: true,
    },
    target: {
      type: 'string',
      enum: ['game', 'scene', 'editor_window'],
      description: 'Unity viewport or Editor window to capture.',
      required: true,
    },
    window_title: {
      type: 'string',
      description: 'Optional title or type-name match for `target: "editor_window"`.',
    },
    max_long_edge: {
      type: 'integer',
      description: 'Maximum output width or height in pixels after capture (0..8192, default 1280; 0 keeps the source size).',
      default: 1280,
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        path: { type: 'string' },
        // The durable image the result carries; `render` turns it into the
        // ImageBlock the same way `read_image` does.
        image: { type: 'object', additionalProperties: true },
      },
    },
    render: (_args, value) => captureContent(value.text, value.image),
  },
  async execute(args, exec) {
    const projectRoot = resolveProjectRoot(args.project_path, exec)
    const target = describeTarget({ projectRoot })
    let request
    try {
      request = buildCaptureRequest({
        target: args.target,
        window_title: args.window_title,
        max_long_edge: args.max_long_edge,
      })
    } catch (error) {
      return textFailure(error.message)
    }
    try {
      const client = await getClient(target)
      const state = await readEditorStatus(client)
      if (!state.connected) return textFailure(`Unity Editor not connected${state.error ? `: ${state.error}` : ''}.`)
      assertRequestedStatus(args.request_editor_status, state.status)
      const captured = await captureViewport(target, request, { signal: exec.signal })
      const resolved = readablePath(projectRoot, captured)

      // Attach the pixels to this same result. The capability check runs
      // BEFORE the attachment is committed, so a text-only route fails fast
      // instead of storing an image it will never be allowed to read.
      const attachments = host?.get?.('attachments')
      if (!attachments) {
        return {
          text:
            `${formatCapture(captured, resolved, { target: args.target })}\n` +
            'No attachment store is mounted, so the image could not be attached.',
          path: resolved.absolute,
        }
      }
      if (!resolved.exists) {
        return { text: formatCapture(captured, resolved, { target: args.target }), path: resolved.absolute }
      }
      await assertImageCapableRoute(host, exec, resolved.absolute)
      const image = await commitImage(attachments, resolved)
      return { text: formatCapture(captured, resolved, { target: args.target, attached: true }), path: resolved.absolute, image }
    } catch (error) {
      return textFailure(asToolError(error).message)
    }
  },
}

// ─── unity_scene ────────────────────────────────────────────────────────────

const SCENE_ACTIONS = ['search', 'get', 'set', 'find', 'batch', 'undo']

const unityScene = {
  name: 'unity_scene',
  description:
    'Inspect and edit objects in open Unity scenes.\n\n' +
    '`search`: find GameObjects by name/path fragment across open scenes (ranked `scene_path` + `object_path`).\n\n' +
    '`find`: list every object carrying a component type (`component_type`, for example Rigidbody or ' +
    'UnityEngine.Light), which `search` cannot do because it only matches names and paths.\n\n' +
    '`get`: read one object\'s serialized property tree (`scene_path` + `object_path`, optional max_depth / ' +
    'max_array_items) — component types and field names come from this.\n\n' +
    '`set`: atomically set one component field: resolves the object, Undo-records it, writes the ' +
    'SerializedProperty (scalars, Color "#rrggbbaa", Vector2/3 "x,y[,z]"), marks the scene dirty and saves it. ' +
    'Array fields support array_insert / array_remove / array_move / array_resize. Type names must exist in the ' +
    'loaded assemblies — call unity_recompile first after adding or renaming C# types.\n\n' +
    '`batch`: apply many field writes as one transaction — a single undo group, the previous value of every field ' +
    `captured, and each touched scene saved once at the end. Up to ${BATCH_LIMIT} writes. A write that fails is ` +
    'reported and skipped instead of aborting the rest; the answer carries an `undo` token.\n\n' +
    '`undo`: pass that token back to restore every field the batch changed (only the fields it actually changed). ' +
    CONNECTION_DESCRIPTION,
  parameters: {
    project_path: PROJECT_PATH,
    action: {
      type: 'string',
      enum: SCENE_ACTIONS,
      description: 'One of: search, get, set, find, batch, undo.',
      required: true,
    },
    query: { type: 'string', description: 'Search text: object name or path fragment (`search`).' },
    limit: { type: 'integer', description: 'Maximum search results (1..160, default 40) or `find` results (1..1000, default 200).' },
    scene_path: {
      type: 'string',
      description: 'Scene asset path, for example Assets/Scenes/Main.unity. For `find`, limits the walk to one scene.',
    },
    object_path: {
      type: 'string',
      description: 'Hierarchy path inside the scene, for example "Canvas/Button" or "Panel/Button[1]" for same-named siblings.',
    },
    max_depth: { type: 'integer', description: 'Property tree depth for `get` (1..16, default 4).' },
    max_array_items: { type: 'integer', description: 'Array items listed per array for `get` (1..1024, default 64).' },
    component_type: {
      type: 'string',
      description:
        'Component to edit for `set` (a type name such as Transform, RectTransform, or your own type), or the component ' +
        'type `find` lists objects for.',
    },
    include_inactive: {
      type: 'boolean',
      description: 'For `find`: also list components on inactive GameObjects (default false).',
    },
    component_index: { type: 'integer', description: 'Alternatively the component index on the GameObject for `set`.' },
    property_path: {
      type: 'string',
      description: 'Serialized property name for `set`, for example m_LocalPosition or m_Text.',
    },
    request_editor_status: {
      type: 'string',
      enum: ['editing', 'playing', 'playing_paused'],
      description: 'Required Unity Editor status for `set` (defaults to editing). Edits usually belong in Edit Mode.',
      default: 'editing',
    },
    operation: {
      type: 'object',
      additionalProperties: true,
      properties: {
        op: { type: 'string', enum: ['set', 'array_insert', 'array_remove', 'array_move', 'array_resize'], default: 'set' },
        value: {
          type: 'json',
          description: 'New value for this Locus call: plain JSON scalar or array, not a schema child.',
        },
        index: { type: 'integer' },
        to_index: { type: 'integer' },
        size: { type: 'integer' },
      },
      description: 'Edit operation for `set` (default: op "set" with `value`).',
    },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
        properties: {
          scene_path: { type: 'string', description: 'Scene asset path of this write.' },
          object_path: { type: 'string', description: 'Hierarchy path of the object in that scene.' },
          component_type: { type: 'string', description: 'Component type name (or full name) to write.' },
          component_index: { type: 'integer', description: 'Alternatively the component index on the object.' },
          property_path: { type: 'string', description: 'Serialized property to write, for example m_LocalPosition.' },
          value: {
            type: 'json',
            description: 'New value: JSON scalar, or a comma-joined string for compound values.',
          },
        },
      },
      description: 'Writes for `batch`. Each is one field on one component of one object.',
    },
    save: {
      type: 'boolean',
      description: 'For `batch`: save every touched scene once at the end (default true).',
    },
    undo: {
      type: 'object',
      additionalProperties: true,
      description: 'The `undo` token a `batch` returned (required for `action: "undo"`).',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        // `batch` returns the token `action: "undo"` consumes, like the one
        // `unity_asset apply` returns for asset files.
        undo: { type: 'object', additionalProperties: true },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) {
    const target = targetFor(args, exec)
    const action = String(args.action ?? '')
    try {
      if (action === 'search') {
        const results = await searchSceneObjects(target, searchRequest({ query: args.query, limit: args.limit }))
        return { text: formatSearchResults(args.query, results) }
      }
      if (action === 'get') {
        const tree = await readRequest({
          scenePath: args.scene_path,
          objectPath: args.object_path,
          maxDepth: args.max_depth,
          maxArrayItems: args.max_array_items,
        })
        const result = await withClient(target, async (client) => {
          const envelope = await client.call('property_tree_read', tree, { timeoutMs: 60_000 })
          return parseTree(envelope.message)
        })
        return { text: `${args.scene_path} :: ${args.object_path}\n${formatSceneTree(result)}` }
      }
      if (action === 'set') {
        const request = validateSetArgs({
          scene_path: args.scene_path,
          object_path: args.object_path,
          component_type: args.component_type,
          component_index: args.component_index,
          property_path: args.property_path,
          operation: args.operation,
        })
        const status = args.request_editor_status ?? 'editing'
        const client = await getClient(target)
        const state = await readEditorStatus(client)
        if (!state.connected) throw new Error(`Unity Editor not connected${state.error ? `: ${state.error}` : ''}.`)
        assertRequestedStatus(status, state.status)
        const owner = activeEditOwner(target.pipe) ?? `dsh-${process.pid}-${randomUUID()}`
        const { code, executionId } = sceneSetExecution(request)
        const session = await openEditSession(target, owner)
        try {
          const run = (live) =>
            executeSnippet(live, { code, executionId, timeoutMs: 120_000, signal: exec.signal })
          const { output } = await withBarriers(
            exec,
            owner,
            target,
            () =>
              run(client).catch(async (error) => {
                // A reload mid-edit is retried once on a fresh connection.
                if (!(error instanceof LocusError) || error.code !== undefined) throw error
                return run(await getClient(target))
              }),
            'unity_scene',
          )
          return { text: formatSceneSetResult(output) }
        } finally {
          await session.release()
        }
      }
      if (action === 'find') {
        const request = validateComponentSearch({
          component_type: args.component_type,
          include_inactive: args.include_inactive,
          limit: args.limit === undefined ? undefined : clampFindLimit(args.limit),
          scene_path: args.scene_path,
        })
        const output = await runSceneSnippet(target, exec, componentSearchBody(request), 120_000)
        return { text: formatComponentSearch(parseSnippetJson(output), request) }
      }
      if (action === 'batch') {
        const request = validateBatch({ edits: args.edits, save: args.save })
        const status = args.request_editor_status ?? 'editing'
        const client = await getClient(target)
        const state = await readEditorStatus(client)
        if (!state.connected) throw new Error(`Unity Editor not connected${state.error ? `: ${state.error}` : ''}.`)
        assertRequestedStatus(status, state.status)
        const owner = activeEditOwner(target.pipe) ?? `dsh-${process.pid}-${randomUUID()}`
        const session = await openEditSession(target, owner)
        try {
          const output = await withBarriers(
            exec,
            owner,
            target,
            () => runSceneSnippet(target, exec, batchBody(request), 180_000),
            'unity_scene',
          )
          const result = parseSnippetJson(output)
          return { text: formatBatchResult(result), undo: batchUndoToken(result) }
        } finally {
          await session.release()
        }
      }
      if (action === 'undo') {
        const token = args.undo && typeof args.undo === 'object' ? args.undo : null
        if (!token || !Array.isArray(token.writes) || token.writes.length === 0) {
          throw new Error('action "undo" requires the `undo` token a `batch` returned.')
        }
        const owner = activeEditOwner(target.pipe) ?? `dsh-${process.pid}-${randomUUID()}`
        const session = await openEditSession(target, owner)
        try {
          const output = await withBarriers(
            exec,
            owner,
            target,
            () => runSceneSnippet(target, exec, batchUndoBody({ writes: token.writes }), 180_000),
            'unity_scene',
          )
          const result = parseSnippetJson(output)
          const lines = [`Restored ${result.restored ?? 0} field(s) across ${token.writes.length} recorded write(s).`]
          if ((result.errors ?? []).length) {
            lines.push(`${result.errors.length} could not be restored:`)
            for (const line of result.errors) lines.push(`- ${line}`)
          }
          return { text: lines.join('\n') }
        } finally {
          await session.release()
        }
      }
      throw new Error(`action must be one of ${SCENE_ACTIONS.join(', ')}.`)
    } catch (error) {
      throw asToolError(error)
    }
  },
}

function clampFindLimit(limit) {
  if (!Number.isInteger(limit)) throw new Error('limit must be an integer.')
  if (limit < 1 || limit > 1000) throw new Error('limit must be in 1..1000 for `find`.')
  return limit
}

/**
 * Run one generated snippet and return its printed output. Reloads during the
 * call are retried once on a fresh connection, like the `set` path.
 */
async function runSceneSnippet(target, exec, code, timeoutMs) {
  const client = await getClient(target)
  const executionId = randomUUID()
  const run = (live) => executeSnippet(live, { code, executionId, timeoutMs, signal: exec.signal })
  const { output } = await run(client).catch(async (error) => {
    if (!(error instanceof LocusError) || error.code !== undefined) throw error
    return run(await getClient(target))
  })
  return output ?? ''
}

/** The snippet prints one JSON line; the last parsable line wins. */
function parseSnippetJson(output) {
  const lines = String(output ?? '').trim().split('\n').filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index])
    } catch {
      // keep looking for the JSON line
    }
  }
  throw new Error(`The scene snippet did not print JSON; raw output:\n${String(output ?? '').trim()}`)
}

function formatComponentSearch(result, request) {
  const objects = Array.isArray(result.objects) ? result.objects : []
  if (objects.length === 0) {
    return `No object carries ${request.componentType}${request.scenePath ? ` in ${request.scenePath}` : ''}.`
  }
  const lines = [
    `${objects.length} object(s) carry ${request.componentType}` +
      `${request.scenePath ? ` in ${request.scenePath}` : ''}${result.truncated ? ' (truncated at limit)' : ''}:`,
  ]
  for (const object of objects) {
    lines.push(
      `- ${object.scenePath} :: ${object.objectPath}` +
        `${object.active === false ? ' (inactive)' : ''} [component ${object.componentIndex}]`,
    )
  }
  return lines.join('\n')
}

function formatBatchResult(result) {
  const applied = Number(result.applied ?? 0)
  const failed = Number(result.failed ?? 0)
  const lines = [`Applied ${applied} field write(s)${failed ? `, ${failed} failed` : ''} as one transaction.`]
  if ((result.savedScenes ?? []).length) lines.push(`Saved: ${result.savedScenes.join(', ')}`)
  for (const entry of result.errors ?? []) {
    lines.push(`- failed ${entry.objectPath} ${entry.propertyPath}: ${entry.error}`)
  }
  if (applied > 0) lines.push(`Undo token (action "undo"): ${JSON.stringify(batchUndoToken(result))}`)
  return lines.join('\n')
}

function formatSearchResults(query, results) {
  if (results.length === 0) return `No scene objects matched "${query}".`
  const lines = [`${results.length} scene object(s) matched "${query}":`]
  for (const result of results) {
    lines.push(`- ${result.scenePath} :: ${result.objectPath} (score ${result.matchScore})`)
  }
  return lines.join('\n')
}

function formatSceneSetResult(output) {
  const lines = (output ?? '').trim().split('\n').filter(Boolean)
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line)
      if (parsed && parsed.ok) {
        return (
          `Set ${parsed.component}.${parsed.propertyPath} on ${parsed.objectPath} in ${parsed.scene}\n` +
          `Value: ${shortJson(parsed.value)}\nScene saved; use Ctrl+Z in Unity or unity_scene set with the old value to revert.`
        )
      }
    } catch {
      // fall through to the raw output
    }
  }
  return output?.trim() || 'Scene edit executed (no output).'
}

/** Every tool definition, in registration order. */
export const toolDefinitions = [
  unityStatus,
  unityExecute,
  unityPlayMode,
  unityConsoleLog,
  unityRecompile,
  unityTest,
  unityAsset,
  unityAssetGraph,
  unityCapture,
  unityScene,
]

export { shutdownPool, describeTarget }
