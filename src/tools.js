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
//   unity_run_states    C# state machine driven across Editor frames
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
import { consoleLogMessage, formatConsoleLog, formatEditorLog, readEditorLogEntries } from './console.js'
import { formatAssetSearch, searchAssets } from './asset-db.js'
import { editYamlText, queryDocument, readYamlFile, readYamlText, renderNode, searchYamlFiles } from './yaml-lite.js'
import { LockTimeout, acquireLock, lockStatus, releaseLock } from './editor-lock.js'
import { editorHealth, enableBackgroundHook, explainUnresponsive } from './health.js'
import { formatHotReload, hotReload } from './hotreload.js'
import {
  DOCS_ROOT_NAME,
  deleteDocs,
  docsImportState,
  docsStatus,
  formatDocsProgress,
  importDocs,
  readDoc,
  requestDocsCancel,
  searchDocs,
} from './docs/unity-docs.js'
import { detectFlavor } from './unity-flavor.js'
import { formatOverrides, liveSource, readLiveOverrides } from './live-source.js'
import { compileSnippet, ensureSidecar, sidecarStatus } from './csharp/sidecar.js'
import {
  UNITY_EXECUTE_CANCELLED,
  assertRequestedStatus,
  executeSnippet,
  longBlockNote,
  readEditorStatus,
} from './execute.js'
import { formatStatus } from './format.js'
import { readSettings } from './settings.js'
import { jobLabel, parseAsyncMode, startBackground } from './background.js'
import {
  RUN_STATES_REQUEST_TIMEOUT_MS,
  buildRunStatesRequest,
  rewriteRunStatesOutput,
} from './run-states.js'
import { LocusError } from './locus-client.js'
import { playModeMessage, setPlayMode } from './play-mode.js'
import { formatSetup, inspectSetup } from './setup.js'
import {
  clampExecuteTimeout,
  EDITOR_STATUS_DISCONNECTED,
  EDITOR_STATUSES,
  EXECUTE_IDLE_LIMIT_MS,
  NON_PUBLIC_ACCESS_LIMITATION,
  resolveNonPublicAccess,
} from './protocol.js'
import { beginUndoCheckpoint, endUndoCheckpoint, recordWrite } from './undo.js'
import {
  assertRecompileableStatus,
  formatClassification,
  readReloadState,
  runRecompile,
} from './recompile.js'
import { ensureSkillActivation } from './skills/activation.js'
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
/**
 * The broker's `unity_asset` gate is an EXTENSION WHITELIST, not a format probe
 * (`LocusBridge.AssetApi.cs::ValidateAssetApiPath`): nine extensions, and
 * anything else is rejected with "unsupported_capability: asset serialization
 * format .ext". Verified live on a Force Text project where a plain-YAML
 * `.physicsMaterial2D` is still refused. The message names the wrong cause, so
 * restate it with the real rule.
 */
const ASSET_EXTENSIONS = [
  '.asset',
  '.mat',
  '.prefab',
  '.unity',
  '.controller',
  '.anim',
  '.overrideController',
  '.playable',
  '.mask',
]

export function explainAssetBlocker(message) {
  const text = String(message ?? '')
  const match = /unsupported_capability: asset serialization format (\S+)/i.exec(text)
  if (!match) return text
  const extension = match[1]
  return (
    `${text} — this is an extension whitelist, not a serialization-format limit: the bridge reads and writes only ` +
    `${ASSET_EXTENSIONS.join(', ')}. ${extension} assets are refused even when the project is Force Text and the ` +
    'file is plain YAML. Use unity_execute (AssetDatabase / SerializedObject) for that asset type.'
  )
}

/**
 * Gate a writing `unity_asset` action on the live editor status.
 *
 * `apply` and `undo` save asset files and re-import them, which is as much a
 * write as `unity_scene set`; declaring the status makes the call state the
 * editor state its write assumes instead of saving under whichever mode happens
 * to be live. `read` and `reload` stay gated by nothing, exactly as before.
 */
async function assertWriteStatus(target, requested, action) {
  const client = await getClient(target)
  const state = await readEditorStatus(client)
  if (!state.connected) throw new Error(`Unity Editor not connected${state.error ? `: ${state.error}` : ''}.`)
  if (typeof requested !== 'string' || requested.trim().length === 0) {
    throw new Error(
      `action "${action}" writes asset files, so request_editor_status is required ` +
        `(one of ${EDITOR_STATUSES.join(', ')}; currently "${state.status}").`,
    )
  }
  assertRequestedStatus(requested, state.status)
}

/**
 * Read upstream's `enable_non_public_access` argument for a `unity_execute`
 * snippet.
 *
 * Upstream implements the feature in its compile server: the snippet assembly
 * is emitted with `MetadataImportOptions.All` plus an `IgnoresAccessChecksTo`
 * allow-list (`NonPublicAccessProbeMode::SkipVerification`). This bridge
 * compiles snippets with the editor's own Roslyn, which has no such hook, so
 * the argument cannot unlock anything. It is still validated (a non-boolean is
 * a caller error, and the global Hot Reload & Compile switch wins) and the
 * limitation is reported alongside the result instead of being silently
 * pretended; the snippet itself is sent exactly as written.
 *
 * @param code - normalized snippet source.
 * @param value - raw `enable_non_public_access` argument.
 * @returns `{ code, limitation }` where `limitation` is a note to surface when
 *   the feature was asked for, or `null` when it was not.
 */
function applyNonPublicAccess(code, value) {
  let enabled
  try {
    enabled = resolveNonPublicAccess(value, { globalEnabled: globalNonPublicAccessEnabled() })
  } catch (error) {
    throw new Error(error.message, { cause: error })
  }
  return { code, limitation: enabled ? NON_PUBLIC_ACCESS_LIMITATION : null }
}

/**
 * The global half of `enable_non_public_access`, read at call time so the
 * settings page takes effect without a restart. A malformed settings file keeps
 * the default (on) here: `readSettings` already reports it, and failing a
 * snippet because a different preference was edited would be the wrong error.
 */
function globalNonPublicAccessEnabled() {
  try {
    return readSettings().preferences.nonPublicAccess !== false
  } catch {
    return true
  }
}

function asToolError(error) {
  if (error instanceof LocusError) return new Error(explainAssetBlocker(error.message))
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
    'open scenes, broker capabilities, domain generation / convergence serial), the editor edition (Unity or 团结引擎 / ' +
    'Tuanjie) read from ProjectVersion.txt, and — when the broker supports the state probe — whether the editor is ' +
    `actually responsive and what it is doing. ${CONNECTION_DESCRIPTION}`,
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
        // Empty string / false mean "not determined", which keeps every output
        // field a single scalar type: the authored schema language only allows
        // unions through `oneOf`, and a nullable scalar is not worth that.
        flavor: { type: 'string', description: 'unity, tuanjie, or empty when ProjectVersion.txt is unreadable.' },
        version: { type: 'string' },
        responsive: { type: 'boolean', description: 'False when the broker has no state probe or the editor is stuck.' },
        phase: { type: 'string' },
        diagnosis: { type: 'string' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) {
    const projectRoot = resolveProjectRoot(args.project_path, exec)
    const target = describeTarget({ projectRoot, pipe: args.pipe })
    // ProjectVersion.txt is on disk, so the edition is known even when no editor
    // is running — which is exactly when "is this a Tuanjie project" gets asked.
    const edition = detectFlavor(projectRoot)
    if (!target.pipe) {
      return statusResult(target, false, 'disconnected', [], null, 'no pipe resolved', null, edition, null)
    }
    try {
      const client = await getClient(target)
      const state = await readEditorStatus(client)
      const capabilities = client.capabilities
      let reloadState = null
      if (state.connected) reloadState = await readReloadState(target).catch(() => null)
      const health = state.connected ? await readHealth(target) : null
      const text = formatStatus({
        ...state,
        pipe: target.pipe,
        projectRoot,
        capabilities,
        reloadState,
        flavor: edition.flavor,
        version: edition.version,
        health,
      })
      return statusResult(target, state.connected, state.status, state.scenes, capabilities, state.error, text, edition, health)
    } catch (error) {
      // A failed connection is exactly when the project's own state matters:
      // report it unprompted instead of making the caller ask again.
      const text = await withDiagnosis(
        formatStatus({
          connected: false,
          status: 'disconnected',
          pipe: target.pipe,
          projectRoot,
          error: error.message,
          flavor: edition.flavor,
          version: edition.version,
        }),
        projectRoot,
        exec,
      )
      return statusResult(target, false, 'disconnected', [], [], error.message, text, edition, null)
    }
  },
}

/**
 * Editor health, or null when the broker predates the probe.
 *
 * `unity_status` must keep working against an older broker/payload, so an
 * unsupported probe degrades to "no opinion" instead of failing the status call.
 */
async function readHealth(target) {
  try {
    const health = await editorHealth(target)
    return health?.supported === false ? null : health
  } catch {
    return null
  }
}

function statusResult(target, connected, status, scenes, capabilities, error, text, edition = null, health = null) {
  return {
    text:
      text ??
      formatStatus({
        connected,
        status,
        scenes,
        pipe: target.pipe,
        capabilities,
        error,
        flavor: edition?.flavor ?? '',
        version: edition?.version ?? '',
        health,
      }),
    connected,
    status,
    scenes: scenes ?? [],
    pipe: target.pipe ?? '',
    flavor: edition?.flavor ?? '',
    version: edition?.version ?? '',
    responsive: health?.responsive ?? false,
    ...(health?.phase ? { phase: health.phase } : {}),
    ...(health?.diagnosis ? { diagnosis: health.diagnosis } : {}),
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

/**
 * 编译检查的编辑器外回退：走插件自带的 .NET 编译服务（tools/dsh-finish/Compiler）。
 *
 * 只在设置里打开 `compileSidecar` 时才用，且只在编辑器那条路不可用时才用——它回答
 * 的是"这段代码能不能编译、错在哪几行"，不会执行，也不认识 UnityEngine 之外的
 * 编辑器状态。`ok: false` 是正常的编译失败（返回诊断），不是异常。
 */
async function sidecarDiagnosis(projectRoot, code, { usings = null, references = null } = {}) {
  if (readSettings().preferences.compileSidecar !== true) return null
  let status
  try {
    status = await sidecarStatus(projectRoot)
  } catch {
    return null
  }
  if (!status.available) return null
  try {
    const result = await compileSnippet(projectRoot, { code, usings, references, mode: 'unity' })
    return { status, result }
  } catch (error) {
    return { status, error: error?.message ?? String(error) }
  }
}

/** 把编译服务的诊断渲染成给人看的一段话。 */
function formatSidecarDiagnosis(diagnosis) {
  if (!diagnosis) return ''
  const header = `Compile check (off-editor, Roslyn ${diagnosis.status?.dotnetVersion ?? 'sidecar'}):`
  if (diagnosis.error) return `${header}\n  the compile sidecar failed: ${diagnosis.error}`
  const result = diagnosis.result ?? {}
  const diagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : []
  if (result.ok && diagnostics.length === 0) return `${header}\n  the snippet compiles cleanly.`
  const lines = diagnostics.slice(0, 20).map((item) => {
    const where = item.line ? ` (line ${item.line}, column ${item.column})` : ''
    return `  ${item.severity} ${item.id}${where}: ${item.message}`
  })
  if (diagnostics.length > lines.length) lines.push(`  … ${diagnostics.length - lines.length} more`)
  const verdict = result.ok ? 'compiles with warnings' : 'does not compile'
  return `${header}\n  the snippet ${verdict}${lines.length > 0 ? ':' : '.'}${lines.length > 0 ? `\n${lines.join('\n')}` : ''}`
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
    'at the top level: call them with (). Use `return null;` for an early return — a bare `return;` is ' +
    'CS0126 because the body returns Task<object>.\n\n' +
    `Timing: code between awaits holds Unity's main thread and freezes the Editor until it returns or awaits. Locus ` +
    `stops a snippet after ${EXECUTE_IDLE_LIMIT_MS / 1000}s with no print/printJson/ctx.Progress output, including ` +
    'inside one long await; split long work into chunks that print or call ctx.Progress, and long waits into shorter ' +
    'ctx.WaitSeconds loops. `timeout` bounds the whole call (1000..3600000 ms, default 600000).\n\n' +
    'Do NOT create or change .cs files from a snippet (a domain reload would kill it) — write the files with the ' +
    'write/edit tools and call unity_recompile. Prefer unity_asset/unity_scene for ordinary asset and scene edits. ' +
    '`readonly` states what the snippet will do and must be decided on every call: true only observes state and ' +
    'runs without the bridge edit session; anything that changes Unity state, assets or files must say false. ' +
    'Declaring readonly: true for a snippet that writes is a misdeclaration nothing downstream can detect.\n\n' +
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
        'project settings, editor state, project files, or other filesystem content. Temporary objects (an ' +
        'instantiated prefab, a temporary Camera or Canvas) count as writes even when nothing is saved. Read-only ' +
        'calls skip the bridge edit session, so they do not hold off asset imports while they run; writes must ' +
        'leave readonly false.',
      required: true,
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
    enable_non_public_access: {
      type: 'boolean',
      default: true,
      description:
        'Allow this call to directly access private and internal types, APIs, and fields without reflection. ' +
        'Defaults to true and is also governed by the global Hot Reload & Compile setting. This bridge compiles ' +
        'snippets inside the Unity Editor with in-process Roslyn, which cannot emit the IgnoresAccessChecksTo ' +
        'allow-list a private/internal reference needs: leaving it at the default reports exactly what is ' +
        'unavailable, while false asserts the snippet stays on public members.',
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
    const mode = parseAsyncMode(args.async)
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

    let snippet
    try {
      snippet = applyNonPublicAccess(code, args.enable_non_public_access)
    } catch (error) {
      return failure(error.message)
    }
    // The snippet is compiled by the editor's own Roslyn, so the private-access
    // half of `enable_non_public_access` cannot be honoured; say so next to the
    // result instead of letting the caller assume it worked.
    const withAccessNote = (text) => (snippet.limitation ? `${text}\n\n${snippet.limitation}` : text)

    const run = async (runExec) => {
      try {
        const client = await getClient(target)
        const state = await readEditorStatus(client)
        if (!state.connected) return failure(`Unity Editor not connected${state.error ? `: ${state.error}` : ''}.`)
        assertRequestedStatus(requested, state.status)

        // A domain reload (or an editor restart) clears the editor's skill-assembly
        // registry, and a project that just switched a skill on has nothing
        // compiled yet. `ensureSkillActivation` compiles the switched-on packages
        // here: the first snippet pays for it, later ones do one cheap request.
        await ensureSkillActivation(client, projectRoot).catch(() => {})

        const owner = `dsh-${process.pid}-${randomUUID()}`
        const session = args.readonly === true ? null : await openEditSession(target, owner)
        try {
          let lastPublished = 0
          const { output, progress } = await executeSnippet(client, {
            code: snippet.code,
            executionId: randomUUID(),
            timeoutMs,
            signal: runExec.signal,
            onProgress: (snapshot) => {
              const blocked = blockedMs(snapshot)
              if (blocked >= 5_000 && blocked - lastPublished >= 5_000) {
                lastPublished = blocked
                publish(`Unity main thread blocked ${(blocked / 1000).toFixed(1)}s`, runExec)
              } else if (snapshot?.title || snapshot?.info) {
                publish(String(snapshot.info || snapshot.title), runExec)
              }
            },
          })
          const trimmed = (output ?? '').trim()
          let text = trimmed.length > 0 ? trimmed : 'Code executed successfully (no output).'
          const note = longBlockNote(blockedMs(progress))
          if (note) text += `\n\n${note}`
          return { output: withAccessNote(text), cancelled: false, maxMainThreadBlockedMs: blockedMs(progress) }
        } finally {
          await session?.release()
        }
      } catch (error) {
        if (error?.message === UNITY_EXECUTE_CANCELLED || runExec.signal?.aborted) {
          return { output: 'Execution cancelled by the caller; Unity snippet stopped.', cancelled: true, maxMainThreadBlockedMs: 0 }
        }
        const message = asToolError(error).message
        // The snippet did not run, so the question the caller still has is
        // "was it my code?": answer it off-editor when the user opted into the
        // compile sidecar, instead of leaving them to ask again.
        const diagnosis = await sidecarDiagnosis(projectRoot, code)
        return failure(diagnosis ? `${message}\n\n${formatSidecarDiagnosis(diagnosis)}` : message)
      }
    }

    if (mode === 'sync') return run(exec)

    const started = startBackground({
      jobs: host?.get?.('jobs'),
      exec,
      kind: 'unity_execute',
      label: jobLabel('unity_execute', projectRoot),
      mode,
      run,
      render: (value) => value?.output ?? '',
      isFailure: (value) => typeof value?.output === 'string' && value.output.startsWith('Error: '),
    })
    return { output: started.text, cancelled: false, maxMainThreadBlockedMs: 0 }
  },
}

// ─── unity_run_states ───────────────────────────────────────────────────────

const unityRunStates = {
  name: 'unity_run_states',
  description:
    'Run a C# state machine across Unity Editor frames for runtime debugging or inspection.\n\n' +
    'request_editor_status selects the required state; the live editor must already match it (use ' +
    'unity_play_mode first). Runs have no idle-output watchdog (unlike unity_execute), but the native ' +
    "broker's 10-minute request deadline still applies, so keep long observations shorter than that. " +
    'Only one run_states session can run at a time; a second call fails until the first finishes.\n\n' +
    "Each state has variables created once per run and shared by that state's start/update/end. start runs " +
    'on entry, update once per awake frame, and end before leaving. Returning from update already yields a ' +
    'frame. Keep main-thread snippets short; avoid blocking waits and polling loops.\n\n' +
    'Context:\n' +
    '- ctx.Print(value) records findings. ctx.Done(message) or Done() succeeds; ctx.Fail(message) fails.\n' +
    '- ctx.Goto(name) changes state. ctx.Sleep(frames) ends the tick and skips that many future update ' +
    'ticks; use it for intentional throttling.\n' +
    '- ctx.Global<T>(key, initialValue) returns a shared handle with Value; initialization happens only ' +
    'for a missing key. The key-only overload uses default(T). SetGlobal/GetGlobal<T>/HasGlobal/' +
    'RemoveGlobal manage shared values; Set/Get<T>/Has/Remove are aliases.\n' +
    '- ctx.PromptUser(token, message) and ClearPrompt(token) show/clear non-blocking hints; verify user ' +
    'actions through Unity state.\n' +
    '- StateName, TotalFrames, ElapsedFramesInState, TotalSeconds, and ElapsedSecondsInState expose timing.\n' +
    '- ctx.Profiler provides metric discovery, bounded CPU/GPU/memory/subsystem sampling, baseline comparison, ' +
    'frame hierarchy reads and memory snapshots; see the profiler skill for capture details.\n\n' +
    'Print output up to 100000 estimated tokens is returned inline. Larger output up to 1000000 estimated tokens ' +
    'is saved under Library/Locus/RunStates and reported as result_file; larger output is not saved. ' +
    'Private/internal access needs the Locus compile server, so this bridge uses the editor\'s in-process ' +
    `Roslyn compiler: enable_non_public_access is accepted for schema compatibility but only false is supported. ` +
    `${CONNECTION_DESCRIPTION}`,
  parameters: {
    project_path: PROJECT_PATH,
    request_editor_status: {
      type: 'string',
      enum: ['editing', 'playing', 'playing_paused'],
      description: 'Required Unity Editor state; must match the live status before the run starts.',
      required: true,
    },
    initial_state: {
      type: 'string',
      description: 'Name of the first state to enter.',
      required: true,
    },
    states: {
      type: 'array',
      description: 'One or more C# states. Names must be unique; initial_state must name one of them.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: {
            type: 'string',
            description: 'Unique state name.',
          },
          variables: {
            type: 'string',
            description:
              "Optional C# local declarations shared by this state's start, update, and end snippets. " +
              'Other states cannot read these locals. This snippet has no ctx parameter.',
          },
          start: {
            type: 'string',
            description: 'Optional C# code executed when entering this state.',
          },
          update: {
            type: 'string',
            description: 'C# code executed every Unity frame while this state is awake.',
          },
          end: {
            type: 'string',
            description: 'Optional C# code executed before leaving this state or finishing.',
          },
        },
      },
      required: true,
    },
    // Upstream's schema gives run_states the same default-true switch as
    // unity_execute, but the switch only works on the compile-server path and
    // this bridge compiles every state body inside the editor. Rather than
    // accept a `true` that would be ignored, the schema only admits `false`:
    // the model has to make the same statement upstream makes it make, and the
    // executor rejects a hand-written `true` with the reason.
    enable_non_public_access: {
      oneOf: [
        {
          type: 'boolean',
          const: false,
          description:
            'State bodies may only touch public members. Required here: this bridge compiles state bodies inside ' +
            'the Unity Editor, so private/internal access is unavailable for runs.',
        },
        {
          type: 'boolean',
          const: true,
          description:
            'Unsupported by this bridge: state bodies are compiled inside the Unity Editor, so there is no ' +
            'compile server to relax internal member checks.',
        },
      ],
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
    const projectRoot = resolveProjectRoot(args.project_path, exec)
    const target = describeTarget({ projectRoot })
    let payload
    try {
      payload = buildRunStatesRequest(args)
    } catch (error) {
      return textFailure(error.message)
    }

    try {
      const client = await getClient(target)
      const state = await readEditorStatus(client)
      if (!state.connected) {
        return textFailure(`Unity Editor not connected${state.error ? `: ${state.error}` : ''}.`)
      }
      assertRequestedStatus(payload.request_editor_status, state.status)

      // `ctx.Profiler` lives in the skill assemblies, exactly as it does for
      // unity_execute; compile them on first use rather than failing the run.
      await ensureSkillActivation(client, projectRoot).catch(() => {})

      // Upstream does not wrap run_states in an edit session: this is an
      // observation harness, and holding DisallowAutoRefresh for a long run
      // would stall asset imports for its whole duration.
      const envelope = await client.request('run_states', JSON.stringify(payload), {
        timeoutMs: RUN_STATES_REQUEST_TIMEOUT_MS,
      })
      const body = (envelope.ok ? envelope.message : envelope.error) ?? ''
      let text
      try {
        text = await rewriteRunStatesOutput(projectRoot, body)
      } catch (error) {
        return textFailure(error.message)
      }
      if (!envelope.ok) return textFailure(text)
      return { text }
    } catch (error) {
      return textFailure(asToolError(error).message)
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
    'semantics; omit both for all levels.\n\n' +
    '`source` picks where the entries come from: `console` (default) asks the running Editor through the broker; ' +
    '`editorLog` reads the tail of `Editor.log` from disk instead, which is the only way to see why an Editor never ' +
    `finished starting (a crashed compile, a stuck import, Safe Mode). ${CONNECTION_DESCRIPTION}`,
  parameters: {
    project_path: PROJECT_PATH,
    source: {
      type: 'string',
      enum: ['console', 'editorLog'],
      default: 'console',
      description:
        '`console` (default) reads the live Editor Console through the broker; `editorLog` reads the Editor.log tail ' +
        'from disk and works with the Editor closed or unresponsive.',
    },
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
    const source = args.source ?? 'console'
    if (source !== 'console' && source !== 'editorLog') {
      return textFailure(`Invalid source '${source}'. Allowed values: console, editorLog.`)
    }
    if (source === 'editorLog') {
      // Editor.log is a file, so this path needs no Editor at all: it is the
      // fallback for exactly the cases where the broker cannot answer.
      const projectRoot = resolveProjectRoot(args.project_path, exec)
      const levels = args.levels ?? (args.level === undefined ? undefined : [args.level])
      const result = await readEditorLogEntries(projectRoot, { levels, limit: args.limit })
      return { text: formatEditorLog(result) }
    }
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
    '`targeted` (only `sync.paths`) or `full` (project refresh).\n\n' +
    '`mode` chooses how the edit reaches the domain: `compile` (default) is the full request_recompile above; ' +
    '`scripts` asks Unity to reimport changed scripts and compile on its next delay call — faster, but it only ' +
    'reports that the reload was requested, not that it converged; `auto` first asks unity_hot_reload whether the ' +
    'edited paths are hot-patchable and stays in "hot" state (status `hot`, no compile) when every one of them is, ' +
    'falling through to `compile` otherwise. ' +
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
    mode: {
      type: 'string',
      enum: ['auto', 'compile', 'scripts'],
      default: 'compile',
      description:
        'How the edit reaches the domain (default `compile`): `auto` tries hot reload first and only compiles when a ' +
        'change needs it; `scripts` requests a script-only reload through `request_script_reload` without waiting for ' +
        'a compile verdict.',
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
      // A compile that is already running answers `managed_reloading` for a
      // moment. Waiting that out keeps "run recompile again straight after the
      // last one" from failing on a transient state; anything genuinely down
      // still reports disconnected once the window expires.
      const state = await readEditorStatus(client, { waitForReloadMs: 10_000 })
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
      const result = await runRecompile(target, {
        mode: args.mode ?? 'compile',
        syncMode: sync.mode ?? 'none',
        paths: sync.paths ?? [],
        reason: args.reason ?? '',
        signal: exec.signal,
        onPhase: (phase) => publish(phase, exec),
        convergeTimeoutMs: timeout * 1000,
      })
      // `mode: 'scripts'` is fire-and-forget: there is no compile register to
      // poll, so reporting "converged" would claim a result nobody measured.
      // `status` is Unity's own `reload_requested` acknowledgement, forwarded verbatim.
      if (result.mode === 'scripts') {
        return {
          text:
            `Unity script reload requested (${(result.elapsedMs / 1000).toFixed(1)}s). ` +
            'Unity reimports the changed scripts and compiles on its next delay call; use unity_status (or ' +
            'unity_recompile with mode "compile") to confirm the editor is idle before relying on new code.',
          status: 'reload_requested',
          operationId: result.operationId ?? '',
          elapsedMs: result.elapsedMs,
        }
      }
      if (result.status === 'hot') {
        const detail = formatClassification(result.classification, result.classificationError)
        return {
          text:
            'No compile was needed: every edited path is hot-patchable.\n' +
            (detail ? `${detail}\n` : '') +
            'Apply the edit with unity_hot_reload once a patch assembly exists, or rerun with mode "compile" to force a rebuild.',
          status: 'hot',
          operationId: '',
          elapsedMs: result.elapsedMs ?? 0,
        }
      }
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
      const detail = formatClassification(result.classification, result.classificationError)
      if (detail) lines.push(`Hot reload check:\n${detail}`)
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
    'array); compound structs (Vector3, Color, Quaternion, Rect, Bounds) are JSON objects that must carry exactly ' +
    'the serialized members; object references are `"fileID:<id> <guid>"` or `{fileID, guid}`. A changed file is a ' +
    '`revision_conflict` and nothing is written. The batch is atomic, saved to disk and re-imported; call ' +
    'unity_asset action "undo" with the returned `undo` token to restore the previous revision while the file is ' +
    'unchanged.\n\n' +
    '`undo`: restores the file revisions recorded by the previous `apply` (only while they still match).\n\n' +
    '`reload`: re-imports files written outside the editor (content updates, merges) and reloads clean open scenes; ' +
    'assets with unsaved in-memory edits are reported as stale, never overwritten. ' +
    CONNECTION_DESCRIPTION,
  parameters: {
    project_path: PROJECT_PATH,
    action: {
      type: 'string',
      enum: ASSET_ACTIONS,
      description:
        'One of: read, apply, undo, reload. `read` only observes. `apply` and `undo` are WRITES: they save asset ' +
        'files to disk and re-import them, so they must be given `request_editor_status` and say what the write ' +
        'does (`operation`). `reload` writes nothing itself but re-imports files that already changed on disk.',
      required: true,
    },
    request_editor_status: {
      type: 'string',
      enum: ['editing', 'playing', 'playing_paused'],
      description:
        'Required Unity Editor status for the writing actions (`apply`, `undo`); must match the live status. ' +
        'Ignored by `read` and `reload`. Asset edits normally belong in Edit Mode: an asset saved while the editor ' +
        'is playing is re-imported under a camera that may not expect it.',
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
        await assertWriteStatus(target, args.request_editor_status, 'apply')
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
        await assertWriteStatus(target, args.request_editor_status, 'undo')
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
    '`list` only observes. `run` is a WRITE-like action: it executes arbitrary project test code, and that code can ' +
    'create objects, write files or change assets and scenes (Unity may also enter Play Mode for PlayMode tests), so ' +
    'it can change the project the same way unity_execute can. Run it when you mean to execute code, not merely to ' +
    'inspect what tests exist.\n\n' +
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
    const action = String(args.action ?? '')
    if (action !== 'list' && action !== 'run') {
      throw new Error(`action must be one of ${TEST_ACTIONS.join(', ')}.`)
    }
    const mode = parseAsyncMode(args.async)
    if (mode !== 'sync' && action !== 'run') {
      throw new Error('async is only supported for action "run".')
    }
    const filter = {
      mode: args.mode,
      assemblies: args.assemblies,
      tests: args.tests,
      groups: args.groups,
      categories: args.categories,
    }

    const run = async (runExec) => {
      const target = targetFor(args, runExec)
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
              signal: runExec.signal,
              timeoutMs,
              onUpdate: (update) => {
                const now = Date.now()
                if (now - lastPublish < 2_000) return
                lastPublish = now
                const progress = `Unity Test ${update.status}: ${update.passed} passed, ${update.failed} failed of ` +
                  `${update.total}` + (update.currentTest ? ` — ${update.currentTest}` : '')
                publish(progress, runExec)
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
      } catch (error) {
        // A cancelled run carries the last snapshot: report the results it did
        // reach instead of discarding them behind the cancellation message.
        if (error?.message === UNITY_TEST_CANCELLED || runExec.signal?.aborted) {
          const snapshot = error.snapshot
          const text = snapshot
            ? `Unity Test run cancelled.\n${formatTestRun(snapshot)}`
            : 'Unity Test run cancelled.'
          return { text, status: 'cancelled', total: snapshot?.total ?? 0, passed: snapshot?.passed ?? 0, failed: snapshot?.failed ?? 0, skipped: snapshot?.skipped ?? 0 }
        }
        throw asToolError(error)
      }
    }

    if (mode === 'sync') return run(exec)

    const started = startBackground({
      jobs: host?.get?.('jobs'),
      exec,
      kind: 'unity_test',
      label: jobLabel('unity_test', action),
      mode,
      run,
      render: (value) => value?.text ?? '',
    })
    return { text: started.text, status: 'background', total: 0, passed: 0, failed: 0, skipped: 0 }
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
        source: { type: 'string' },
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
        return { text: result.results, guid: result.guid, source: result.source }
      }
      if (action === 'references' || action === 'dependencies') {
        const result = await findReferences(target, projectRoot, {
          assetPath: args.path,
          direction: action,
          filePath: args.file_path,
          limit: args.limit,
        })
        return { text: result.results, guid: result.guid ?? '', source: result.source }
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
      description:
        'One of: search, get, set, find, batch, undo. `search`, `get` and `find` only observe. `set`, `batch` and ' +
        '`undo` are WRITES: they change scene objects, save the scene and are Undo-recorded, so they must be given ' +
        '`request_editor_status` and the editor must already be in that state.',
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
      description:
        'Required Unity Editor status for the writing actions (`set`, `batch`, `undo`); must match the live status. ' +
        'Defaults to editing because scene edits usually belong in Edit Mode, but the call still has to say which ' +
        'state it is writing in. Ignored by `search`, `get` and `find`.',
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
        // Restoring fields saves the scene exactly like the `batch` it reverts,
        // so it is gated the same way instead of writing under any live mode.
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

// ─── unity_hot_reload ───────────────────────────────────────────────────────

const unityHotReload = {
  name: 'unity_hot_reload',
  description:
    'Apply edited script files to the running Editor without a compile and domain reload, by hot-patching their method ' +
    'bodies. Works in Edit Mode and Play Mode, and typically lands in one to three seconds.\n\n' +
    'A file reported as "hot" changed only method/constructor/accessor bodies. Those edits are compiled into a patch ' +
    'assembly by the bundled .NET sidecar compiler and detoured into the running domain; the report says whether each ' +
    'patch was applied, skipped, or failed, and why. A file reported as "needs compile" changed something structural ' +
    '(record/interface/enum, a field declaration, a field-like event, an assembly definition) and must go through ' +
    'unity_recompile, whose mode "auto" makes that choice for you.\n\n' +
    'A patch needs a baseline: the text the loaded assembly was compiled from. The Editor supplies it for files it ' +
    'compiled in this domain, so a file that was never part of this domain is skipped rather than patched on a guess. ' +
    'Patches last until the next domain reload, are replaced (not stacked) when the same method is patched again, and ' +
    'are dropped when the domain reloads; run unity_recompile after a burst of edits to make them permanent.\n\n' +
    'Requires the .NET sidecar compiler; without it the result explains why nothing was patched. The Editor must be ' +
    'connected: the classification reads files from disk, the apply step needs the Editor.\n\n' +
    CONNECTION_DESCRIPTION,
  parameters: {
    project_path: PROJECT_PATH,
    paths: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Project-relative script paths (for example Assets/Scripts/Player.cs). Defaults to every .cs file modified since ' +
        'the last compile result when the Editor is connected.',
    },
    dry_run: {
      type: 'boolean',
      default: false,
      description: 'Classify only. Default false: the classification API is read-only either way, but dry_run labels the result.',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        hot: { type: 'array', items: { type: 'object', additionalProperties: true } },
        needCompile: { type: 'array', items: { type: 'object', additionalProperties: true } },
        failed: { type: 'array', items: { type: 'object', additionalProperties: true } },
        supported: { type: 'boolean' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) {
    const target = targetFor(args, exec)
    const result = await hotReload(target, {
      paths: Array.isArray(args.paths) ? args.paths : [],
      dryRun: args.dry_run === true,
      signal: exec?.signal,
      onPhase: (phase) => publish(phase, exec),
    })
    return {
      text: formatHotReload(result),
      hot: result.hot ?? [],
      needCompile: result.needCompile ?? [],
      failed: result.failed ?? [],
      supported: result.supported === true,
    }
  },
}

// ─── unity_asset_search ─────────────────────────────────────────────────────

const unityAssetSearch = {
  name: 'unity_asset_search',
  description:
    'Search the project-wide asset index built from .meta files (GUIDs, asset types, paths) without going through the ' +
    'Editor, so it answers with the Editor closed.\n\n' +
    'Filters combine: type (scene/prefab/material/animation/controller/script/texture/audio/shader/model/genericAsset…), ' +
    'name (substring of the file name), under (a project-relative folder), guid (exactly 32 hex). Also reports broken ' +
    'assets: files with no .meta and duplicate GUIDs.\n\n' +
    'The index is the SQLite database Library/Locus/asset-index.db and refreshes incrementally; pass rescan to rebuild it.',
  parameters: {
    project_path: PROJECT_PATH,
    type: {
      type: 'string',
      description: 'Asset type filter, for example scene, prefab, material, script, texture.',
    },
    name: {
      type: 'string',
      description: 'Substring of the file name, case-insensitive. Include the extension when you mean a format.',
    },
    under: {
      type: 'string',
      description: 'Project-relative folder to search inside, for example Assets/Prefabs.',
    },
    guid: {
      type: 'string',
      description: 'Exact 32-hex asset GUID (as stored in the .meta).',
    },
    limit: {
      type: 'integer',
      default: 20,
      description: 'Maximum entries to list.',
    },
    rescan: {
      type: 'boolean',
      default: false,
      description: 'Rebuild the index from scratch before searching.',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        total: { type: 'integer' },
        partial: { type: 'boolean' },
        assets: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) {
    const projectRoot = resolveProjectRoot(args.project_path, exec)
    const result = await searchAssets(projectRoot, {
      type: args.type,
      name: args.name,
      under: args.under,
      guid: args.guid,
      limit: args.limit,
      rescan: args.rescan === true,
    })
    return {
      text: formatAssetSearch(result),
      total: result.total,
      partial: result.partial === true,
      assets: result.assets,
    }
  },
}

// ─── unity_yaml_read / unity_yaml_search ────────────────────────────────────

const unityYamlRead = {
  name: 'unity_yaml_read',
  description:
    "Read one Unity serialized asset (.unity, .prefab, .asset, .mat, .anim, .controller, …) through a Unity-dialect " +
    'YAML reader, without the Editor.\n\n' +
    'Every document keeps its `--- !u!<classId> &<fileId>` identity, so you can name one object by fileID, by class ' +
    'name (MonoBehaviour), or by `!u!114`. Values are rendered to a configurable depth; the file is never rewritten ' +
    'unless you edit it.\n\n' +
    'Prefer this over reading the raw file: it tells you which document a field belongs to and hides the parts that are ' +
    'just serialization noise.',
  parameters: {
    project_path: PROJECT_PATH,
    path: {
      type: 'string',
      description: 'Project-relative asset path, for example Assets/Prefabs/Player.prefab.',
    },
    object: {
      type: 'string',
      description: 'Which document to show: a fileID ("114" or "-234567"), a class name ("MonoBehaviour"), or "!u!114".',
    },
    depth: {
      type: 'integer',
      default: 2,
      description: 'Nesting depth to render.',
    },
    max_items: {
      type: 'integer',
      default: 20,
      description: 'Maximum list items to render per sequence.',
    },
    source: {
      type: 'string',
      enum: ['auto', 'disk', 'live'],
      default: 'auto',
      description:
        'auto reads the live Editor when it is running and falls back to disk; disk reads only the file; ' +
        'live requires the Editor and fails instead of falling back.',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        path: { type: 'string' },
        source: { type: 'string' },
        total: { type: 'integer' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) {
    const projectRoot = resolveProjectRoot(args.project_path, exec)
    const mode = args.source ?? 'auto'
    const live = await resolveLiveSource(mode, projectRoot, args.path, { depth: args.depth, exec })
    const result = readYamlText(projectRoot, {
      path: args.path,
      object: args.object,
      depth: args.depth,
      maxItems: args.max_items,
      live: live.bundle,
    })
    const notes = []
    if (live.failure !== null) {
      if (mode === 'live') return { text: `Error: ${live.failure}`, path: result.path, source: 'disk', total: result.total }
      // Falling back silently would let a stale value pass as the live one.
      notes.push(`(${live.failure}; showing the file on disk instead)`)
    }
    const text = notes.length === 0 ? result.text : `${result.text}\n\n${notes.join('\n')}`
    return { text, path: result.path, source: result.source, total: result.total }
  },
}

/**
 * Ask the Editor for the live snapshot when the caller allows it.
 *
 * `auto` never fails: a missing Editor, an old companion package, or a slow
 * domain reload all degrade to the disk answer plus one explanatory line.
 */
async function resolveLiveSource(mode, projectRoot, path, { depth, exec }) {
  if (mode === 'disk') return { bundle: null, failure: null }
  // No file scope means "search everything", and the Editor answers for one
  // asset at a time — there is no live project-wide read to ask for.
  if (mode !== 'live' && (path === undefined || path === null || String(path).trim() === '')) {
    return { bundle: null, failure: null }
  }
  let client = null
  try {
    client = await getClient(describeTarget({ projectRoot }))
  } catch (error) {
    return { bundle: null, failure: `live values are unavailable: ${String(error?.code ?? error?.message ?? error)}` }
  }
  const { live, reason } = await liveSource(client, projectRoot, path, { depth })
  if (live === null) return { bundle: null, failure: `live values are unavailable: ${reason}` }
  return { bundle: live, failure: null }
}

const unityYamlSearch = {
  name: 'unity_yaml_search',
  description:
    'Search Unity serialized YAML for a value — across one file, a folder, or the whole project.\n\n' +
    'Pointing scope at one asset reads its values from the running Editor by default, so an edit that has not been ' +
    'saved yet is searched too; anything wider is read from disk.\n\n' +
    'Matches are found in field values and object names, so this answers "which prefabs set speed to 12", "where is ' +
    'this GUID referenced", and "which documents mention Player". Use match_fields to restrict the search to particular ' +
    'keys (for example "m_Name" or "speed,m_MethodName").\n\n' +
    'query may be a plain substring or `re:<pattern>`.',
  parameters: {
    project_path: PROJECT_PATH,
    query: {
      type: 'string',
      description: 'Substring to find, or `re:<regular expression>`.',
    },
    scope: {
      type: 'string',
      description: 'Project-relative file or folder to search. Defaults to the whole project.',
    },
    match_fields: {
      type: 'string',
      description: 'Comma-separated field names to restrict the match to, for example "m_Name,m_Script".',
    },
    limit: {
      type: 'integer',
      default: 50,
      description: 'Maximum matches to return.',
    },
    source: {
      type: 'string',
      enum: ['auto', 'disk', 'live'],
      default: 'auto',
      description:
        'Where the values come from. auto uses the running Editor for the file scope when it is connected; disk reads ' +
        'only the files; live requires the Editor and fails instead of falling back. A whole-project search is always ' +
        'disk, because a live answer only exists for one file at a time.',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        matches: { type: 'array', items: { type: 'object', additionalProperties: true } },
        scanned: { type: 'integer' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) {
    const projectRoot = resolveProjectRoot(args.project_path, exec)
    const query = String(args.query ?? '')
    if (query.trim() === '') return { text: 'Error: query is required.', matches: [], scanned: 0 }
    const { bundle, failure } = await resolveLiveSource(args.source ?? 'auto', projectRoot, args.scope, { exec })
    const result = searchYamlFiles(projectRoot, {
      query,
      scope: args.scope,
      limit: args.limit,
      matchFields: args.match_fields,
      live: bundle,
    })
    // Same contract as unity_yaml_read: a fallback is stated, never silent.
    const text = failure === null ? result.text : `${result.text}\n(${failure}; searched the files on disk instead)`
    return { text, matches: result.matches ?? [], scanned: result.scanned ?? 0 }
  },
}

const unityPrefabOverrides = {
  name: 'unity_prefab_overrides',
  description:
    'List what one prefab instance changed relative to its prefab — as Unity itself resolved it, not as the file spells it.\n\n' +
    'The answer is the override table (path, value, and the prefab\'s own value next to it), which is what "did ' +
    'someone tweak this object in the scene" really asks. Requires the Editor: the override set is computed by Unity ' +
    'and cannot be reconstructed from an unsaved file.',
  parameters: {
    project_path: PROJECT_PATH,
    path: { type: 'string', description: 'Project-relative path of the prefab or scene, for example Assets/Prefabs/Enemy.prefab.' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        path: { type: 'string' },
        total: { type: 'integer' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) {
    const projectRoot = resolveProjectRoot(args.project_path, exec)
    const path = String(args.path ?? '').trim()
    if (path === '') return { text: 'Error: path is required.', path: '', total: 0 }
    // The override table only exists in the Editor, so an unreachable Editor is
    // the whole answer — say that instead of the raw connection diagnostic.
    let client
    try {
      client = await getClient(describeTarget({ projectRoot }))
    } catch (error) {
      return { text: `Error: prefab overrides need a running Unity Editor (${String(error?.code ?? error?.message ?? error)}).`, path, total: 0 }
    }
    const result = await readLiveOverrides(client, projectRoot, path)
    if (!result.ok) return { text: `Error: ${result.reason}`, path, total: 0 }
    return { text: formatOverrides(result), path: result.path, total: result.overrides.length }
  },
}

/**
 * Lock holders are `string | string[] | null` in the lock module: several owners
 * may share the lock, and nobody holding it is reported as null. The tool output
 * declares one string, so join a list and render "nobody" as empty.
 */
function asHolder(holder) {
  if (Array.isArray(holder)) return holder.join(', ')
  return holder ?? ''
}

// ─── unity_lock / unity_release ─────────────────────────────────────────────

const unityLock = {
  name: 'unity_lock',
  description:
    'Take the cooperative per-project editing lock that transient Unity Editor state needs: Play/Pause/Edit switches, ' +
    'recompiles and domain reloads, active scene and Prefab Stage changes, Selection and window focus.\n\n' +
    'The lock lives in Library/Locus/dsh-editor.lock, is stamped with the owner, and is shared by every session ' +
    'pointed at the same project — including sessions in other processes. A lock left behind by a process that no ' +
    'longer exists is detected as stale and broken automatically, so a crash never wedges the project.\n\n' +
    'mode "wait" blocks up to timeout_seconds; mode "try" returns immediately with the current holder. Re-taking a lock ' +
    'you already hold is a no-op. Release it with unity_release or action "status" to inspect it. This lock does not ' +
    'replace request_editor_status: it coordinates sessions, it does not change the Editor mode.',
  parameters: {
    project_path: PROJECT_PATH,
    action: {
      type: 'string',
      enum: ['acquire', 'release', 'status'],
      default: 'acquire',
      description: 'acquire (default), release, or status.',
    },
    owner: {
      type: 'string',
      description: 'Name of this session. Required for acquire and release; re-using it makes the call idempotent.',
    },
    mode: {
      type: 'string',
      enum: ['wait', 'try'],
      default: 'wait',
      description: 'wait blocks up to timeout_seconds; try fails immediately when somebody else holds it.',
    },
    timeout_seconds: {
      type: 'integer',
      default: 300,
      description: 'How long mode "wait" blocks before reporting LockTimeout.',
    },
    reason: {
      type: 'string',
      description: 'Short note recorded in the lock file, so a peer waiting on it knows what is happening.',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        action: { type: 'string' },
        held: { type: 'boolean' },
        acquired: { type: 'boolean' },
        holder: { type: 'string', description: 'Owner holding the lock, empty when nobody does.' },
        path: { type: 'string' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) {
    const projectRoot = resolveProjectRoot(args.project_path, exec)
    const action = args.action ?? 'acquire'
    if (action === 'status') {
      const status = await lockStatus(projectRoot)
      const text = status.held
        ? `Lock held by ${status.holder}${status.reason ? ` (${status.reason})` : ''} since ${new Date(status.acquiredAt ?? Date.now()).toISOString()}` +
          `${status.stale ? ', stale (its process is gone; the next acquire breaks it)' : ''}.\nFile: ${status.path}`
        : `No editing lock is held on this project.\nFile: ${status.path}`
      return { text, action, held: status.held, acquired: false, holder: asHolder(status.holder), path: status.path }
    }
    if (action === 'release') {
      const released = await releaseLock(projectRoot, { owner: args.owner })
      const text = released.released
        ? `Released the editing lock held by ${args.owner}.`
        : `Did not release: ${released.reason ?? `the lock is held by ${released.holder}`}.`
      return {
        text,
        action,
        held: released.released !== true && released.holder !== null,
        acquired: false,
        holder: asHolder(released.holder),
        path: '',
      }
    }
    if (action !== 'acquire') {
      return { text: `Error: action must be acquire, release or status; got '${action}'.`, action: String(action), held: false, acquired: false, holder: '', path: '' }
    }
    try {
      const result = await acquireLock(projectRoot, {
        owner: args.owner,
        mode: args.mode,
        timeoutSeconds: args.timeout_seconds,
        reason: args.reason,
      })
      const text = result.acquired
        ? `Lock acquired by ${result.holder}${result.waitedMs > 0 ? ` after ${Math.round(result.waitedMs / 1000)}s` : ''}. ` +
          'Release it with unity_release when the transient Editor state change is done.'
        : `Lock is held by ${result.holder}${result.holder === null ? '' : ''}; use mode "wait" to block for it.`
      return { text, action, held: result.acquired, acquired: result.acquired, holder: asHolder(result.holder), path: '' }
    } catch (error) {
      if (error instanceof LockTimeout) {
        return { text: `Error: ${error.message}`, action, held: false, acquired: false, holder: asHolder(error.holder), path: '' }
      }
      throw error
    }
  },
}

const unityRelease = {
  name: 'unity_release',
  description:
    'Release the cooperative per-project editing lock for this project. Only the owner that took the lock may release ' +
    'it: releasing a peer\'s lock is refused, because a session that could silently unlock another one would make the ' +
    'lock worthless.\n\n' +
    'This is a convenience alias for `unity_lock action="release"`.',
  parameters: {
    project_path: PROJECT_PATH,
    owner: {
      type: 'string',
      description: 'Owner name that took the lock (the same string passed to unity_lock).',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        released: { type: 'boolean' },
        holder: { type: 'string', description: 'Owner holding the lock, empty when nobody does.' },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) {
    const projectRoot = resolveProjectRoot(args.project_path, exec)
    const released = await releaseLock(projectRoot, { owner: args.owner })
    const text = released.released
      ? `Released the editing lock held by ${args.owner}.`
      : `Did not release: ${released.reason ?? `the lock is held by ${released.holder}`}.`
    return { text, released: released.released === true, holder: asHolder(released.holder) }
  },
}

// ─── unity_offline_docs ─────────────────────────────────────────────────────

/**
 * `globalThis.fetch`, or undefined on a runtime that has none.
 *
 * Returned rather than assumed so the docs importer reports a network problem
 * as a state instead of throwing through the tool boundary.
 */
function defaultFetch() {
  return typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : undefined
}

const unityOfflineDocs = {
  name: 'unity_offline_docs',
  description:
    "Unity's own offline documentation for this project's editor version, imported once from Unity's documentation " +
    'server and stored in Library/Locus/unity-docs, then searched locally.\n\n' +
    'action "import" downloads the version-matched offline package (Chinese by default, locale "en" for English), ' +
    'converts it to Markdown and indexes it. action "status" reports which version is imported and, while an import ' +
    'runs, how far it has got. action "search" finds pages by term. action "read" returns one page. action "cancel" ' +
    'stops an import that is running in another call, and action "delete" removes the imported documentation.\n\n' +
    'Use this instead of guessing at Unity API behaviour: the pages are the same ones Unity ships with the Editor, so ' +
    'they match the version the project actually compiles against.\n\n' +
    'The download is several hundred megabytes and needs network access; import reports network_error instead of ' +
    'failing when it is unavailable, and nothing is ever downloaded implicitly.',
  parameters: {
    project_path: PROJECT_PATH,
    action: {
      type: 'string',
      enum: ['status', 'import', 'search', 'read', 'cancel', 'delete'],
      default: 'status',
      description:
        'status (default), import, search, read, cancel (stop an import that is running in another call), or delete ' +
        '(remove the imported documentation).',
    },
    query: {
      type: 'string',
      description: 'Search terms for action "search".',
    },
    path: {
      type: 'string',
      description: 'Doc page path from a search result, for action "read" (for example Manual/class-Rigidbody.html).',
    },
    locale: {
      type: 'string',
      enum: ['zh-cn', 'en'],
      default: 'zh-cn',
      description: 'Documentation language to import.',
    },
    version: {
      type: 'string',
      description: 'Editor version to import, for example 2022.3 or 6000.0. Defaults to ProjectVersion.txt.',
    },
    limit: {
      type: 'integer',
      default: 20,
      description: 'Maximum search results.',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string' },
        action: { type: 'string' },
        imported: { type: 'boolean' },
        state: { type: 'string' },
        version: { type: 'string' },
        results: { type: 'array', items: { type: 'object', additionalProperties: true } },
      },
    },
    render: (_args, value) => [{ type: 'text', text: value.text }],
  },
  async execute(args, exec) {
    const projectRoot = resolveProjectRoot(args.project_path, exec)
    const action = args.action ?? 'status'
    const status = docsStatus(projectRoot)
    if (action === 'status') {
      const running = docsImportState(projectRoot)
      const progress = formatDocsProgress(running.progress)
      const lines = status.imported
        ? [
            `Unity offline docs: imported (Unity ${status.version}${status.locale ? `, ${status.locale}` : ''}), ${status.files} page(s).`,
            `Location: ${DOCS_ROOT_NAME} under ${projectRoot}/Library/Locus`,
          ]
        : [
            'Unity offline docs: not imported.',
            'Run unity_offline_docs action "import" once; it downloads the package matching ProjectVersion.txt and indexes it.',
          ]
      // An import in flight is the single most useful thing status can report:
      // it explains why the docs are still absent on the second call.
      // A cancel that is still on disk means either an import that is winding
      // down or one whose process already died mid-flight; both read as "not
      // running", which is the honest answer to "are the docs coming?".
      if (running.running && progress !== null) lines.push(`Import in progress: ${progress}.`)
      else if (running.cancelRequested) lines.push(`A cancel stopped the import${progress !== null ? ` during ${progress}` : ''}; the docs are not being imported.`)
      else if (running.progress && progress !== null) lines.push(`Last import stopped during: ${progress} (no import is running now).`)
      if (running.cancelRequested && running.running) lines.push('A cancel has been requested; the running import stops at its next checkpoint.')
      if (status.imported) lines.push('Search it with action "search", read a page with action "read", remove it with "delete".')
      return {
        text: lines.join('\n'),
        action,
        imported: status.imported === true,
        state: running.running ? 'importing' : status.imported ? 'imported' : 'absent',
        version: status.version ?? '',
        results: [],
      }
    }
    if (action === 'cancel') {
      const running = docsImportState(projectRoot)
      const result = requestDocsCancel(projectRoot)
      const text = running.running && formatDocsProgress(running.progress) !== null
        ? `Cancel requested: ${formatDocsProgress(running.progress)}. The running import stops at its next checkpoint and leaves the existing index untouched.`
        : 'Cancel requested, but no import looks like it is running (nothing has reported progress in the last ten minutes).'
      return { text, action, imported: status.imported === true, state: result.cancelRequested ? 'cancel_requested' : 'absent', version: status.version ?? '', results: [] }
    }
    if (action === 'delete') {
      const removed = deleteDocs(projectRoot)
      const text = removed.deleted
        ? `Deleted the imported Unity ${removed.version}${removed.locale ? ` (${removed.locale})` : ''} documentation: ${removed.files} page(s) removed from ${DOCS_ROOT_NAME}.`
        : 'Nothing was imported, so there was nothing to delete.'
      return { text, action, imported: false, state: 'absent', version: '', results: [] }
    }
    if (action === 'import') {
      publish('Downloading and indexing the Unity offline documentation', exec)
      const result = await importDocs(projectRoot, {
        locale: args.locale,
        version: args.version,
        signal: exec?.signal,
        // Node ships fetch globally from 18 on, but naming it explicitly keeps
        // the dependency visible: the import is the only networked tool here,
        // so a missing global has to read as "no network stack", not as a
        // mysterious "no fetch implementation available" from three files down.
        fetchImpl: defaultFetch(),
        onProgress: (event) => {
          const progress = formatDocsProgress(event)
          if (progress !== null) publish(`Unity offline docs: ${progress}`, exec)
        },
      })
      const lines = []
      if (result.state === 'imported') {
        lines.push(`Imported Unity ${result.version} documentation (${result.locale ?? args.locale ?? 'zh-cn'}): ${result.files} page(s), ${Math.round((result.bytes ?? 0) / (1024 * 1024))} MB.`)
        lines.push('Search it with unity_offline_docs action "search".')
      } else if (result.state === 'up_to_date') {
        lines.push(`Unity ${result.version} documentation is already imported (${result.files} page(s)).`)
      } else if (result.state === 'cancelled') {
        lines.push('The import was cancelled; the existing index (if any) is untouched.')
      } else if (result.state === 'unsupported_version') {
        lines.push(
          `Unity ${result.version ?? args.version ?? '(unknown)'} has no offline documentation package. ` +
            'Unity only publishes them for released versions; check ProjectVersion.txt.',
        )
      } else {
        lines.push(`Could not import the documentation: ${result.reason ?? 'the documentation server was unreachable'}.`)
        lines.push('Nothing was changed; the existing index (if any) is untouched. Retry when the network is available.')
      }
      return { text: lines.join('\n'), action, imported: result.state === 'imported' || result.state === 'up_to_date', state: result.state, version: result.version ?? '', results: [] }
    }
    if (action === 'search') {
      const query = String(args.query ?? '').trim()
      if (query === '') return { text: 'Error: query is required for action "search".', action, imported: status.imported === true, state: status.imported ? 'imported' : 'absent', version: status.version ?? '', results: [] }
      if (!status.imported) {
        return {
          text: 'Unity offline docs are not imported, so there is nothing to search. Run unity_offline_docs action "import" first.',
          action,
          imported: false,
          state: 'absent',
          version: '',
          results: [],
        }
      }
      const results = searchDocs(projectRoot, { query, limit: args.limit })
      const lines = results.length === 0 ? [`No documentation page matched "${query}".`] : [`${results.length} page(s) matched "${query}":`]
      for (const result of results) lines.push(`- ${result.path} — ${result.title}${result.snippet ? `\n    ${result.snippet}` : ''}`)
      return { text: lines.join('\n'), action, imported: true, state: 'imported', version: status.version ?? '', results }
    }
    if (action === 'read') {
      if (!status.imported) {
        return { text: 'Unity offline docs are not imported. Run unity_offline_docs action "import" first.', action, imported: false, state: 'absent', version: '', results: [] }
      }
      const page = readDoc(projectRoot, { path: args.path })
      const text = `# ${page.title} (${page.path})\n\n${page.markdown}`
      return { text, action, imported: true, state: 'imported', version: status.version ?? '', results: [] }
    }
    return { text: `Error: action must be status, import, search, read, cancel or delete; got '${action}'.`, action: String(action), imported: false, state: 'error', version: '', results: [] }
  },
}

/** Every tool definition, in registration order. */
export const toolDefinitions = [
  unityStatus,
  unityExecute,
  unityRunStates,
  unityPlayMode,
  unityConsoleLog,
  unityRecompile,
  unityTest,
  unityAsset,
  unityAssetGraph,
  unityCapture,
  unityScene,
  unityHotReload,
  unityAssetSearch,
  unityYamlRead,
  unityYamlSearch,
  unityPrefabOverrides,
  unityLock,
  unityRelease,
  unityOfflineDocs,
]

export { shutdownPool, describeTarget }
