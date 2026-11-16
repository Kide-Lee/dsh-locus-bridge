// `unity_hot_reload`: patch edited method bodies into the running editor without
// a compile, and report honestly when an edit is structural instead.
//
// Wire flow (contracts.md §2.1, editor side in
// packages/unity-bridge/Editor/HotReload/):
//   1. `dsh_hot_reload_classify {paths, patch_id}` → which files are
//      hot-patchable (`hot[]`, with per-method identities), which need a real
//      compile (`needCompile[]`), which failed to read (`failed[]`).
//   2. `dsh_hot_reload_apply {patch_id, assembly_b64, methods, domain_generation}`
//      → the editor detours each method with MonoMod and reports the count.
//   3. `dsh_hot_reload_status {}` → the editor's own detour ledger.
//   4. `dsh_hot_reload_dispose {patch_id}` → detach one patch (or all of them).
//
// The editor keeps its OWN detour registry and never sends the payload's
// `hot_patch_loaded`: that message belongs to the desktop client, which accounts
// for live patches in its own ledger and would be corrupted by entries it did
// not create. See DshHotReloadRegistry.cs for the full reasoning.
//
// `unity_hot_reload` itself is the *classification* half only: the bridge does
// not compile patch assemblies (that is the Locus compile server's job, driven
// by the desktop app), so the tool reports per-file hot/compile verdicts plus
// the method identities a caller would need, and `unity_recompile` remains the
// way to actually converge an edit that needs a compile.

import { getClient } from './client-pool.js'
import { isTransientBrokerError, normalizeChangedPaths } from './recompile.js'

/**
 * Values `unity_recompile` accepts for its `mode` argument. `auto` tries hot
 * reload first and only compiles when the classification says it must;
 * `compile` is the classic request_recompile; `scripts` asks Unity to reimport
 * changed scripts and compile without a full asset sync.
 */
export const HOT_RELOAD_MODES = Object.freeze(['auto', 'compile', 'scripts'])

/** Default broker timeout for the four editor messages (§2.2). */
const HOT_RELOAD_TIMEOUT_MS = 60_000

const CLASSIFY_MESSAGE = 'dsh_hot_reload_classify'
const APPLY_MESSAGE = 'dsh_hot_reload_apply'
const STATUS_MESSAGE = 'dsh_hot_reload_status'
const DISPOSE_MESSAGE = 'dsh_hot_reload_dispose'

/** File states the tool layer renders. */
const STATE_HOT = 'hot'
const STATE_NEED_COMPILE = 'need-compile'
const STATE_FAILED = 'failed'

/**
 * Whether a failure is worth one more attempt after the editor settles.
 *
 * Two shapes mean "the editor is between domains": a broker rejection naming
 * one of the three transient codes, and a transport loss while the reload tore
 * the connection down (extension handlers die with the old domain and the new
 * one registers them again — §2.2 allows exactly one retry). The broker codes
 * come from the recompile module's exact-match predicate instead of a second
 * hand-maintained list; a transport loss is a `LocusClient` rejection with no
 * broker code (`code === undefined`), which `getClient` reconnects for.
 */
function isTransient(error) {
  if (isTransientBrokerError(error?.code) || isTransientBrokerError(error?.message)) return true
  return error?.name === 'LocusError' && (error.code === undefined || error.code === null)
}

/**
 * Send one extension message and decode its JSON answer.
 *
 * Extension handlers answer `{ok:true, message:<json>}` on success and
 * `{ok:false, error:<text>}` on failure (LocusBridge.HandleExtensionMessageAsync),
 * but the body may also be `{"error": …}` written by the handler itself — both
 * are surfaced as the same thrown Error so callers never see a half-parsed
 * result.
 *
 * @param {object} client   LocusClient
 * @param {string} type     extension message type
 * @param {object} payload  request body (serialized to JSON)
 * @returns {Promise<object>}
 */
async function send(client, type, payload) {
  const envelope = await client.request(type, JSON.stringify(payload ?? {}), { timeoutMs: HOT_RELOAD_TIMEOUT_MS })
  if (!envelope?.ok) throw new Error(String(envelope?.error ?? `${type} was refused`))
  const raw = String(envelope.message ?? '').trim()
  if (!raw) return {}
  let body
  try {
    body = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${type} returned invalid JSON: ${error.message}`)
  }
  if (!body || typeof body !== 'object') throw new Error(`${type} returned ${typeof body}, expected an object`)
  if (body.error) throw new Error(String(body.error))
  return body
}

/** Classify edited paths without touching any loaded assembly. */
export async function classifyHotEdit(client, { paths } = {}) {
  const list = Array.isArray(paths) ? paths.map((value) => String(value ?? '').trim()).filter(Boolean) : []
  if (list.length === 0) throw new Error('unity_hot_reload needs at least one Assets/ or Packages/ path')
  const body = await send(client, CLASSIFY_MESSAGE, { paths: list, patch_id: randomPatchId() })
  return normalizeClassification(body)
}

/** Load a patch assembly in the editor and detour every listed method. */
export async function applyHotPatch(client, { patchId, assemblyB64, methods, domainGeneration } = {}) {
  if (!patchId) throw new Error('applyHotPatch requires a patchId')
  if (!assemblyB64) throw new Error('applyHotPatch requires the patch assembly bytes')
  const body = await send(client, APPLY_MESSAGE, {
    patch_id: patchId,
    assembly_b64: assemblyB64,
    methods: Array.isArray(methods) ? methods : [],
    ...(domainGeneration ? { domain_generation: domainGeneration } : {}),
  })
  return {
    applied: Number(body.applied ?? 0),
    skipped: Array.isArray(body.skipped) ? body.skipped : [],
    detourEngine: body.detour_engine ?? null,
    domainGeneration: body.domain_generation ?? null,
  }
}

/** The editor's own detour ledger. */
export async function hotReloadStatus(client) {
  const body = await send(client, STATUS_MESSAGE, {})
  return {
    detours: Number(body.detours ?? 0),
    patchedMethods: Array.isArray(body.patched_methods) ? body.patched_methods : [],
    lastError: body.last_error ?? null,
    domainGeneration: body.domain_generation ?? null,
    entries: Array.isArray(body.entries) ? body.entries : [],
  }
}

/** Detach one patch (`patchId`), or every patch when it is omitted. */
export async function disposeHotPatches(client, { patchId } = {}) {
  const body = await send(client, DISPOSE_MESSAGE, patchId ? { patch_id: patchId } : {})
  return { disposed: Number(body.disposed ?? 0) }
}

/**
 * Classify the given paths against the connected editor.
 *
 * Retries once across a domain reload: the extension message handlers die with
 * the old domain and are re-registered by the new one, so a transient refusal
 * is expected exactly once and never means the classification failed.
 *
 * @param {{projectRoot?: string, pipe?: string}} target
 * @param {{paths?: string[], dryRun?: boolean, signal?: AbortSignal, onPhase?: Function}} options
 * @returns {Promise<{hot: object[], needCompile: object[], failed: object[], details: object[],
 *   supported: boolean, reason: string|null, projectRoot: string|undefined}>}
 */
export async function hotReload(target, options = {}) {
  const { paths = [], dryRun = false, signal, onPhase = () => {} } = options
  if (signal?.aborted) throw new Error('cancelled')

  onPhase('Classifying edited scripts')
  const client = await getClient(target)
  // Paths are normalized the same way a recompile normalizes them, so the
  // editor only ever sees `Assets/…` / `Packages/…`. Doing it here (and not
  // only in the caller) keeps classify/apply/dry-run consistent.
  const normalized = normalizeChangedPaths(paths, target?.projectRoot)
  let classified
  try {
    classified = await classifyHotEdit(client, { paths: normalized.length > 0 ? normalized : paths })
  } catch (error) {
    if (!isTransient(error)) throw error
    onPhase('Editor reloading; retrying the classification')
    const retried = await getClient(target)
    classified = await classifyHotEdit(retried, { paths: normalized.length > 0 ? normalized : paths })
  }

  if (signal?.aborted) throw new Error('cancelled')

  return {
    ...classified,
    details: buildDetails(classified),
    dryRun: Boolean(dryRun),
    projectRoot: target?.projectRoot,
  }
}

/**
 * Human-readable rendering of {@link hotReload}'s result.
 *
 * The wording matters: a caller must be able to tell "these edits are live"
 * from "these edits cannot be live without a compile" without reading JSON.
 */
export function formatHotReload(result) {
  const hot = result?.hot ?? []
  const needCompile = result?.needCompile ?? []
  const failed = result?.failed ?? []
  const lines = []

  const hotPaths = new Set(hot.map((entry) => entry.path).filter(Boolean))
  for (const path of hotPaths) {
    const methods = hot.filter((entry) => entry.path === path)
    lines.push(`hot: ${path}${methods.length > 0 ? ` (${methods.length} method${methods.length === 1 ? '' : 's'})` : ' (no method bodies to patch)'}`)
    for (const method of methods) lines.push(`  · ${method.method_key ?? describeMethod(method)}`)
  }
  for (const entry of needCompile) {
    lines.push(`needs compile: ${entry.path}${entry.reason ? ` — ${entry.reason}` : ''}`)
  }
  for (const entry of failed) {
    lines.push(`failed: ${entry.path}${entry.error ? ` — ${entry.error}` : ''}`)
  }

  if (lines.length === 0) lines.push('nothing to classify: no edited scripts were given')

  const summary =
    `${hotPaths.size} file${hotPaths.size === 1 ? '' : 's'} hot-patchable, ` +
    `${needCompile.length} need${needCompile.length === 1 ? 's' : ''} a compile, ` +
    `${failed.length} could not be read`
  lines.push('', summary)

  if (result?.dryRun) {
    lines.push('Dry run: nothing was patched.')
  } else if (hot.length > 0) {
    // The bridge classifies and can apply a patch assembly, but compiling that
    // assembly is the desktop compile server's job: saying "applied" here would
    // be a lie.
    lines.push(
      'Classification only: this bridge does not compile patch assemblies, so no method bodies were detoured.',
    )
  }
  if (needCompile.length > 0) {
    lines.push('Run unity_recompile (mode "auto" re-checks, mode "compile" forces it) for the files that need a compile.')
  }
  for (const entry of failed) {
    if (/no \.meta yet|still importing/i.test(String(entry.error ?? ''))) {
      lines.push('Some assets are still importing; retry once the import finishes.')
      break
    }
  }
  return lines.join('\n')
}

function describeMethod(method) {
  if (!method) return ''
  const type = method.declaring_type ?? '?'
  const name = method.name === '.ctor' ? type.split('.').pop() : method.name
  const params = Array.isArray(method.param_type_names) ? method.param_type_names.join(', ') : ''
  return `${type}.${name}(${params})${method.is_static ? ' [static]' : ''}`
}

/** Flatten the three buckets into the `details[]` rows the tool returns. */
function buildDetails(classified) {
  const details = []
  for (const entry of classified.hot) {
    details.push({
      path: entry.path,
      method: entry.method_key ?? describeMethod(entry),
      state: STATE_HOT,
    })
  }
  for (const entry of classified.needCompile) {
    details.push({ path: entry.path, state: STATE_NEED_COMPILE, ...(entry.reason ? { reason: entry.reason } : {}) })
  }
  for (const entry of classified.failed) {
    details.push({ path: entry.path, state: STATE_FAILED, ...(entry.error ? { reason: entry.error } : {}) })
  }
  return details
}

function normalizeClassification(body) {
  const hot = Array.isArray(body.hot) ? body.hot.map(normalizeHotMethod).filter(Boolean) : []
  const needCompile = Array.isArray(body.needCompile)
    ? body.needCompile.map((entry) => ({ path: String(entry?.path ?? ''), reason: String(entry?.reason ?? '') }))
    : []
  const failed = Array.isArray(body.failed)
    ? body.failed.map((entry) => ({ path: String(entry?.path ?? ''), error: String(entry?.error ?? '') }))
    : []
  return {
    hot,
    needCompile,
    failed,
    supported: body.supported !== false,
    reason: body.reason ?? null,
  }
}

function normalizeHotMethod(entry) {
  if (!entry) return null
  // The editor names the file `source_path` (HotPatchMethodDto in the payload
  // uses the same spelling); an object that carries neither cannot be placed.
  const file = entry.path ?? entry.source_path ?? ''
  if (file === '') return null
  return {
    path: String(file),
    method_key: entry.method_key ?? null,
    declaring_type: entry.declaring_type ?? null,
    name: entry.name ?? null,
    param_type_names: Array.isArray(entry.param_type_names) ? entry.param_type_names : [],
    param_type_sigs: Array.isArray(entry.param_type_sigs) ? entry.param_type_sigs : [],
    is_static: Boolean(entry.is_static),
    is_ctor: Boolean(entry.is_ctor),
  }
}

let patchCounter = 0
function randomPatchId() {
  patchCounter += 1
  return `dsh-hot-${Date.now().toString(36)}-${patchCounter}`
}