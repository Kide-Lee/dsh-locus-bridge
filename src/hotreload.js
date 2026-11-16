// `unity_hot_reload`: classify edited method bodies and patch them into the
// running editor without a compile.
//
// Flow — the split Locus itself uses (compile outside the Editor, apply inside
// the payload):
//   1. classification runs in the plugin process (`src/hotreload-classify.js`):
//      it reads the scripts from disk and decides which files/methods can be
//      detoured, which need a real compile, and which were unreadable;
//   2. the patch assembly is built by the bundled .NET compile service
//      (`src/csharp/sidecar.js` → `compile/hotPatch`);
//   3. `hot_patch_loaded {patch_id, assembly_b64, methods, domain_generation}`
//      → the PAYLOAD loads the assembly and detours each method with MonoMod;
//   4. `hot_patch_dispose <patch_id|all>` → the payload detaches those detours;
//   5. `hot_reload_probe` → the payload's own detour self-test, run before every
//      apply batch so a broken engine costs no round trip.
//
// All three messages are the payload's own (`LocusBridge.cs` dispatch cases),
// so the apply path is byte-for-byte the one the Locus desktop client drives.
// The detour ledger lives in this process, exactly as it lives in the desktop's
// `src-tauri/src/unity_hotreload/` — the payload keeps `_hotMethodDetours`
// private and offers no query message for it.
//
// The patch assembly itself is built by the bundled .NET compile service
// (`src/csharp/sidecar.js` → `compile/hotPatch`), which re-emits each changed
// method body under a `__DshPatch_<Type>` type. That is what makes a full hot
// reload possible without the desktop compile server: the editor only has to
// detour the methods the patch names.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { getClient } from './client-pool.js'
import { BROKER_ERRORS } from './protocol.js'
import { SidecarError, SidecarUnavailable, hotDiff, hotPatch } from './csharp/sidecar.js'
import { classifyHotPaths } from './hotreload-classify.js'
import { normalizeChangedPaths } from './recompile.js'

/**
 * Values `unity_recompile` accepts for its `mode` argument. `auto` tries hot
 * reload first and only compiles when the classification says it must;
 * `compile` is the classic request_recompile; `scripts` asks Unity to reimport
 * changed scripts and compile without a full asset sync.
 */
export const HOT_RELOAD_MODES = Object.freeze(['auto', 'compile', 'scripts'])

/** Default broker timeout for the patch messages. */
const HOT_RELOAD_TIMEOUT_MS = 60_000

/** The payload's own hot-patch entry points (LocusBridge.cs dispatch cases). */
const APPLY_MESSAGE = 'hot_patch_loaded'
const DISPOSE_MESSAGE = 'hot_patch_dispose'
const PROBE_MESSAGE = 'hot_reload_probe'
const RELOAD_STATE_MESSAGE = 'get_reload_state'

/** `get_reload_state` answers while the main thread is idle; a reload can stall it. */
const RELOAD_STATE_TIMEOUT_MS = 10_000

/**
 * Why the payload refuses to apply a patch it did not compile against the
 * running domain (LocusBridge.HotReload.cs, the `domain_generation` guard).
 * Matched on text because the refusal arrives as a plain `ok:false` error.
 */
const STALE_DOMAIN_ERROR = /compiled for a previous domain generation/i

/** Last text seen per absolute path, used as the "before" side of a hot diff. */
const revisionCache = new Map()

/**
 * The live detour ledger, per project pipe: patch id → the methods it holds.
 *
 * The payload publishes no ledger query, so this process is the ledger — the
 * same arrangement the desktop client has. `domainGeneration` is the payload
 * generation the entries were applied in; every entry belongs to the running
 * domain only (detours die with it), so a different generation empties the
 * ledger instead of pretending stale detours are still live.
 *
 * @type {Map<string, {domainGeneration: string|null, lastError: string|null, entries: object[]}>}
 */
const ledger = new Map()

/** File states the tool layer renders. */
const STATE_HOT = 'hot'
const STATE_NEED_COMPILE = 'need-compile'
const STATE_FAILED = 'failed'

/**
 * Whether a failure is worth one more attempt after the editor settles.
 *
 * Two shapes mean "the editor is between domains": a broker rejection naming
 * one of the three transient codes, and a transport loss while the reload tore
 * the connection down (the payload's managed executor is gone during the reload
 * — §2.2 allows exactly one retry). The codes are matched exactly, the way
 * upstream `is_transient_broker_error` does, so a real refusal is never retried.
 */
const TRANSIENT_CODES = new Set([
  BROKER_ERRORS.MANAGED_RELOADING,
  BROKER_ERRORS.MANAGED_NOT_READY,
  BROKER_ERRORS.RELOAD_INTERRUPTED,
])

function isTransient(error) {
  const code = String(error?.code ?? '').trim()
  if (TRANSIENT_CODES.has(code) || TRANSIENT_CODES.has(String(error?.message ?? '').trim())) return true
  return error?.name === 'LocusError' && (error.code === undefined || error.code === null)
}

/**
 * The payload's per-domain generation (`get_reload_state`).
 *
 * Its own copy on purpose: `src/skills/activation.js` has one, but routing a
 * hot reload through the skills module would make an unrelated capability a
 * prerequisite. Either way the value is the payload's, not a locally minted
 * GUID — the payload compares it against `_compileDomainGeneration` and refuses
 * a patch that predates the reload.
 */
async function readDomainGeneration(client) {
  try {
    const envelope = await client.call(RELOAD_STATE_MESSAGE, '', { timeoutMs: RELOAD_STATE_TIMEOUT_MS })
    const payload = JSON.parse(String(envelope?.message ?? '') || '{}')
    return typeof payload?.domain_generation === 'string' ? payload.domain_generation : ''
  } catch {
    return ''
  }
}

/**
 * One participant of the patch ledger.
 *
 * The payload keys its own registry by `MethodKey` (declaring type, name,
 * parameter names, static flag) plus the original assembly, and "patched
 * again" means *replaced*, not stacked. The Node ledger repeats the same key
 * and the same replace rule, so `hotReloadStatus` reports what the payload
 * actually holds. The comment in LocusBridge.HotReload.cs calls MethodKey
 * "byte-identical with the Rust unity_method_key"; a view must not invent a
 * different spelling.
 */
export function methodKey(method) {
  const names = Array.isArray(method?.param_type_names) ? method.param_type_names : []
  return `${method?.declaring_type ?? ''}|${method?.name ?? ''}|${names.join(',')}${method?.is_static ? '|s' : '|i'}`
}

/** `MethodKey` plus the original assembly: two assemblies may declare one name. */
export function detourKey(method) {
  return `${methodKey(method)}|${method?.original_assembly ?? ''}`
}

/** The ledger for one pipe, created on first use. */
function ledgerFor(key) {
  let entry = ledger.get(key)
  if (!entry) {
    entry = { domainGeneration: null, lastError: null, entries: [] }
    ledger.set(key, entry)
  }
  return entry
}

/**
 * Drop the ledger when it belongs to an earlier payload domain.
 *
 * Detours are live objects inside one AppDomain: a reload unmounts all of them
 * and the payload does not try to clean up (`OnBeforeAssemblyReload` only stops
 * the bridge). Reporting the old entries after that would claim methods are
 * patched when they are back to their compiled bodies.
 *
 * @param {{domainGeneration: string|null, lastError: string|null, entries: object[]}} current
 * @param {string|''} generation  the payload's current generation, '' when unreadable
 */
function syncLedgerDomain(current, generation) {
  const next = typeof generation === 'string' && generation.length > 0 ? generation : null
  if (current.domainGeneration !== null && next !== null && current.domainGeneration !== next) {
    current.entries = []
    current.lastError = null
  }
  current.domainGeneration = next
  return current
}

/**
 * Send one payload message and decode its body.
 *
 * The hot-patch handlers answer inside the standard envelope
 * (`{ok:true, message:<text>}` / `{ok:false, error:<text>}`,
 * `LocusBridge.HandleMessageAsync`), but the body is not uniform: the probe and
 * `hot_patch_loaded` answer JSON, `hot_patch_dispose` answers `disposed:<n>`.
 * JSON bodies that carry their own `error` are surfaced as thrown Errors so a
 * caller never sees a half-parsed result.
 *
 * @param {object} client   LocusClient
 * @param {string} type     payload message type
 * @param {string} payload  request body, already serialized
 * @returns {Promise<object>}
 */
async function send(client, type, payload) {
  const envelope = await client.request(type, payload ?? '', { timeoutMs: HOT_RELOAD_TIMEOUT_MS })
  if (!envelope?.ok) throw new Error(String(envelope?.error ?? `${type} was refused`))
  const raw = String(envelope.message ?? '').trim()
  if (!raw) return {}
  if (!raw.startsWith('{') && !raw.startsWith('[')) return { text: raw }
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

/**
 * The payload's detour self-test (`hot_reload_probe`).
 *
 * It detours a pair of `[MethodImpl(NoInlining)]` probe methods, checks the
 * replacement took and that disposing restores the original, and answers
 * `{detour_ok, detour_engine, code_optimization, domain_reload_on_play, error}`.
 * The desktop runs it before patching for the same reason: a failed detour
 * engine is a fact to report before a 60-second patch timeout, not after.
 *
 * @returns {Promise<{detourOk: boolean, detourEngine: string|null, codeOptimization: string|null,
 *   domainReloadOnPlay: boolean|null, error: string|null}>}
 */
export async function probeDetourEngine(client) {
  let body
  try {
    body = await send(client, PROBE_MESSAGE, '')
  } catch (error) {
    // The probe reports a failed self-test in its `error` field, but a handler
    // that cannot even answer (engine load failure) comes back as `ok:false`.
    // Either way it is a verdict about the engine, not a transport problem.
    return { detourOk: false, detourEngine: null, codeOptimization: null, domainReloadOnPlay: null, error: String(error?.message ?? error) }
  }
  return {
    detourOk: body.detour_ok === true,
    detourEngine: body.detour_engine ?? null,
    codeOptimization: body.code_optimization ?? null,
    domainReloadOnPlay: typeof body.domain_reload_on_play === 'boolean' ? body.domain_reload_on_play : null,
    error: body.error ?? null,
  }
}

/**
 * Classify edited paths locally.
 *
 * The file-level rules run in this process, so a dry run needs no Editor at
 * all: classification only has to apply the patch.
 *
 * @param projectRoot - the Unity project root the paths are relative to.
 * @param paths - project-relative scripts (Assets/ or Packages/).
 * @returns `{hot, needCompile, failed, files, supported, reason}`.
 */
export function classifyHotEdit(projectRoot, paths) {
  const list = (Array.isArray(paths) ? paths : []).map((value) => String(value ?? '').trim()).filter(Boolean)
  if (list.length === 0) throw new Error('unity_hot_reload needs at least one Assets/ or Packages/ path')
  return classifyHotPaths(projectRoot, list)
}

/**
 * Load a patch assembly in the payload and detour every listed method.
 *
 * Request shape is the payload's `HotPatchLoadedRequest`
 * (LocusBridge.HotReload.cs): snake_case fields, `param_type_names` required
 * for overload resolution, `domain_generation` refusing a patch compiled
 * before a reload. The answer is `HotPatchLoadedResponse`; the whole batch is
 * atomic, so `applied` is either every method or an error was thrown
 * ("hot patch apply failed (rolled back): …").
 *
 * @param {object} client  LocusClient
 * @param {{patchId: string, assemblyB64: string, methods: object[], domainGeneration?: string|null,
 *   sourcePath?: string|null}} request  methods already in HotPatchMethodDto shape
 */
export async function applyHotPatch(client, { patchId, assemblyB64, methods, domainGeneration, sourcePath } = {}) {
  if (!patchId) throw new Error('applyHotPatch requires a patchId')
  if (!assemblyB64) throw new Error('applyHotPatch requires the patch assembly bytes')
  const list = Array.isArray(methods) ? methods : []
  let body
  try {
    body = await send(
      client,
      APPLY_MESSAGE,
      JSON.stringify({
        patch_id: patchId,
        assembly_b64: assemblyB64,
        ...(domainGeneration ? { domain_generation: domainGeneration } : {}),
        methods: sourcePath ? list.map((method) => ({ ...method, source_path: method.source_path ?? sourcePath })) : list,
      }),
    )
  } catch (error) {
    if (STALE_DOMAIN_ERROR.test(String(error?.message ?? ''))) {
      // The patch was compiled against a domain that has since reloaded. The
      // ledger belongs to that domain too, so drop it before reporting.
      const current = ledgerFor(client.pipe ?? '')
      current.entries = []
      current.lastError = null
    }
    throw error
  }
  return {
    patchId: body.patch_id ?? patchId,
    applied: Number(body.method_count ?? 0),
    detourEngine: body.detour_engine ?? null,
    inlinedMethodKeys: Array.isArray(body.inlined_method_keys) ? body.inlined_method_keys.map(String) : [],
    inlinedSources: Array.isArray(body.inlined_sources) ? body.inlined_sources.map(String) : [],
    pumpedCount: Number(body.pumped_count ?? 0),
    pumpFailedCount: Number(body.pump_failed_count ?? 0),
  }
}

/**
 * Record one applied batch in the ledger.
 *
 * Same replacement rule as the payload: a method patched again keeps only the
 * newest detour, so its key moves to the new patch id instead of appearing
 * twice.
 */
function recordBatch(key, { patchId, path, methods, detourEngine, domainGeneration }) {
  const current = ledgerFor(key)
  if (domainGeneration && current.domainGeneration !== domainGeneration) syncLedgerDomain(current, domainGeneration)
  const incoming = methods.map((method) => ({
    method_key: methodKey(method),
    detour_key: detourKey(method),
    patch_id: patchId,
    engine: detourEngine,
    declaring_type: method.declaring_type ?? '',
    name: method.name ?? '',
    assembly: method.original_assembly ?? '',
    path: path ?? null,
  }))
  const keys = new Set(incoming.map((entry) => entry.detour_key))
  current.entries = current.entries.filter((entry) => !keys.has(entry.detour_key)).concat(incoming)
  current.lastError = null
  return current
}

/** Forget a batch that failed: it never landed. */
function forgetBatch(key, patchId) {
  const current = ledgerFor(key)
  current.entries = current.entries.filter((entry) => entry.patch_id !== patchId)
}

/**
 * The live detour ledger for one project pipe.
 *
 * `client` adds the payload's half: its domain generation. A ledger recorded in
 * a different generation is dropped, because the payload reloaded and every
 * detour died with the old AppDomain. Passing no client answers from this
 * process alone, which is what a status call does when the Editor is gone.
 *
 * @param {object|null} client  LocusClient
 * @returns {Promise<{detours: number, patchedMethods: string[], lastError: string|null,
 *   domainGeneration: string|null, entries: object[]}>}
 */
export async function hotReloadStatus(client = null) {
  const key = client?.pipe ?? ''
  const generation = client ? await readDomainGeneration(client) : ''
  const current = syncLedgerDomain(ledgerFor(key), generation)
  return {
    detours: current.entries.length,
    patchedMethods: [...new Set(current.entries.map((entry) => entry.method_key))],
    lastError: current.lastError,
    domainGeneration: current.domainGeneration,
    entries: current.entries.map((entry) => ({ ...entry })),
  }
}

/** Detach one patch (`patchId`), or every patch when it is omitted. */
export async function disposeHotPatches(client, { patchId } = {}) {
  // The payload takes the target as a bare string, not as JSON:
  // "" or "all" detaches everything, anything else is matched against
  // `patch_id` exactly. The answer is the text `disposed:<n>`.
  const envelope = await send(client, DISPOSE_MESSAGE, patchId ? String(patchId) : 'all')
  const disposed = Number(/disposed:\s*(\d+)/.exec(String(envelope.text ?? ''))?.[1] ?? 0)
  const current = ledgerFor(client?.pipe ?? '')
  current.entries = patchId ? current.entries.filter((entry) => entry.patch_id !== patchId) : []
  current.lastError = null
  return { disposed }
}

/**
 * Classify the given paths against the connected editor.
 *
 * Retries once across a domain reload: the payload's managed executor is gone
 * while the domain reloads, so a transient refusal is expected exactly once and
 * never means the classification failed.
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
  // Paths are normalized the same way a recompile normalizes them, so the
  // classifier and the patch request agree on `Assets/…` / `Packages/…`.
  const normalized = normalizeChangedPaths(paths, target?.projectRoot)
  const classified = classifyHotEdit(target?.projectRoot, normalized.length > 0 ? normalized : paths)

  if (signal?.aborted) throw new Error('cancelled')

  const result = {
    ...classified,
    details: buildDetails(classified),
    dryRun: Boolean(dryRun),
    projectRoot: target?.projectRoot,
    patches: [],
    patchError: null,
  }

  // A dry run, or an edit with nothing detourable, never touches the Editor.
  if (dryRun || (result.hot?.length ?? 0) === 0) return result

  const client = await getClient(target)

  // Classification only says what *could* be patched. Turning that into live
  // code needs the payload's detour engine, a patch assembly and an answered
  // `hot_patch_loaded`.
  onPhase('Checking the editor detour engine')
  try {
    const patched = await compileAndApplyPatches(target, client, result, { signal, onPhase })
    result.patches = patched.patches
    result.applied = patched.applied
    result.skipped = patched.skipped
    result.probe = patched.probe
  } catch (error) {
    if (error instanceof SidecarUnavailable || error instanceof SidecarError) {
      // No .NET / no build / a compile service that will not start: this is a
      // missing capability, not a failed patch. Report it, keep the
      // classification, and let the caller fall back to a recompile.
      result.patchError = `${error.code ? `[${error.code}] ` : ''}${error.message}`
    } else if (error instanceof ProbeRefused) {
      result.patchError = error.message
    } else if (isTransient(error)) {
      result.patchError = `the editor reloaded while the patch was being applied: ${error.message}`
    } else {
      throw error
    }
  }
  return result
}

/** A refused detour engine: the payload cannot detour here at all. */
class ProbeRefused extends Error {
  constructor(message, { probe = null } = {}) {
    super(message)
    this.name = 'ProbeRefused'
    this.probe = probe
  }
}

/**
 * Retry one payload round trip once when the editor is between domains.
 *
 * `hot_patch_loaded` is idempotent enough to retry: a refused request never
 * detoured anything, and a lost answer is answered by the ledger probe in
 * `applyHotPatch`'s caller. Kept local so the compiler errors above stay
 * untouched.
 */
async function withRetry(signal, action) {
  try {
    return await action()
  } catch (error) {
    if (signal?.aborted || !isTransient(error)) throw error
    return await action()
  }
}

/**
 * Compile one patch assembly per edited file and detour the methods each one
 * names.
 *
 * Per file, not per batch: two files that both change the same type still
 * produce two patch assemblies, and each is tracked by its own `patch_id`, so
 * disposing one edit does not detach the other.
 */
async function compileAndApplyPatches(target, client, classified, { signal = null, onPhase = () => {} } = {}) {
  const projectRoot = target?.projectRoot
  if (!projectRoot) throw new SidecarError('hot reload needs a project root to compile against.', { code: 'invalid_params' })
  const ledgerKey = client?.pipe ?? ''

  // The payload refuses a patch compiled before a reload with
  // "compiled for a previous domain generation". Ask first: it is one cheap
  // round trip and it makes the failure say which reload cost the patch.
  const domainGeneration = await withRetry(signal, () => readDomainGeneration(client))
  const probe = await withRetry(signal, () => probeDetourEngine(client))
  if (!probe.detourOk) {
    throw new ProbeRefused(
      `the editor's detour engine is not usable in this domain${probe.error ? `: ${probe.error}` : ''}`,
      { probe },
    )
  }

  const byPath = new Map()
  for (const entry of classified.hot) {
    if (!entry?.path) continue
    const list = byPath.get(entry.path) ?? []
    list.push(entry)
    byPath.set(entry.path, list)
  }

  // The classification carries the current text and the cache carries what the
  // domain was compiled from. Without the pair there is nothing to diff, and
  // "patch the file onto itself" would be a no-op that reports success — so a
  // file without both revisions is skipped and left to a real recompile.
  const patches = []
  const appliedMethods = []
  const skipped = []
  let sequence = 0
  for (const [path, entries] of byPath) {
    if (signal?.aborted) throw new Error('cancelled')
    const pair = await asRevisionPair(entries, client, projectRoot, path)
    if (pair === null) {
      skipped.push({ path, reason: 'the editor has no baseline for this file (it did not compile it in this domain), so a patch would be built on a guess' })
      continue
    }
    sequence += 1
    const patchId = `dsh-hot-${Date.now().toString(36)}-${sequence}`
    onPhase(`Compiling ${path}`)

    const diff = await hotDiff(projectRoot, [pair])
    const fileDiff = diff.files[0]
    if (!fileDiff || !fileDiff.hot) {
      skipped.push({ path, reason: fileDiff?.reason ?? 'the compile service did not consider this edit hot' })
      continue
    }
    const compiled = await hotPatch(projectRoot, [pair])
    if (!compiled.ok || compiled.assemblyB64 === null) {
      skipped.push({ path, reason: compiled.error ?? 'the patch assembly did not compile' })
      continue
    }
    const methods = compiled.methods.map(toApplyMethod)
    let answer
    try {
      answer = await withRetry(signal, () => applyHotPatch(client, {
        patchId,
        assemblyB64: compiled.assemblyB64,
        methods,
        domainGeneration,
        sourcePath: path,
      }))
    } catch (error) {
      forgetBatch(ledgerKey, patchId)
      // The payload applies a batch atomically: a failure here means nothing
      // from this file is live, so the file is skipped rather than counted.
      if (isTransient(error)) throw error
      // One file failing is a per-file skip, not a lost editor: the rest of the
      // batch still has a domain to land in.
      skipped.push({ path, reason: stripPatchPrefix(error?.message ?? String(error)) })
      continue
    }
    recordBatch(ledgerKey, {
      patchId,
      path,
      methods: methods.map((method) => ({ ...method })),
      detourEngine: answer.detourEngine,
      domainGeneration,
    })
    patches.push({ id: patchId, path, methods: methods.length, applied: answer.applied, skipped: 0 })
    appliedMethods.push(...methods.map((method) => ({ patchId, path, method: describeMethod(method) })))
  }
  return { patches, applied: appliedMethods, skipped, probe }
}

/**
 * The payload prefixes a rolled-back batch with this; the rows that follow are
 * the actual reason, so the prefix is noise in a per-file report.
 */
function stripPatchPrefix(message) {
  return String(message).replace(/^hot patch apply failed \(rolled back\):\s*/i, '')
}

/**
 * The `{path, oldText, newText}` triple for the compile service, from one
 * classified entry.
 *
 * The "after" side is the file on disk: the text the user just saved, and the
 * text the patch has to reproduce. The "before" side is the text the running
 * domain was compiled from, which this process remembers (the classifier reads
 * the same file, so it cannot supply the older revision). The file itself is
 * never used as its own "before" side: that diff is empty by construction, and
 * reporting "patched" for it would be a lie. When the cache has no baseline the
 * edit is skipped and left to a real recompile.
 */
async function asRevisionPair(entries, client, projectRoot, path) {
  const after = readEditorRevision(projectRoot, path)
  if (after === null) return null
  const entry = entries[0] ?? null
  const before = cachedRevision(projectRoot, path, after)
  if (before === null || before === after) return null
  // The cache only knows what *some* earlier command saw. The editor's method
  // identities carry the interesting half of that fact: an unchanged identity
  // set means the file has not been recompiled since the cache was written.
  // A changed identity set is weaker evidence, but it still refuses the one
  // case that would be actively wrong: patching from a baseline older than the
  // running domain.
  if (identityChanged(entries)) return null
  return { path: join(projectRoot ?? '', path), oldText: before, newText: after }
}

/**
 * Whether the editor re-classified this file since the baseline in the cache.
 *
 * The cache records the text every classification saw. A repeated classification
 * of an unchanged file yields an identical identity set; a re-imported (and
 * therefore recompiled) file yields a different one. Equal sets therefore mean
 * "the cached text is still what the domain compiled", which is the only
 * baseline a patch may be built from.
 */
function identityChanged(entries) {
  if (!Array.isArray(entries) || entries.length < 2) return false
  const key = (entry) => String(entry?.method_key ?? `${entry?.declaring_type ?? ''}|${entry?.name ?? ''}`)
  const first = new Set(entries.map(key))
  return !entries.every((entry) => first.has(key(entry)))
}

/**
 * The last text this process saw for a path *before* the current one.
 *
 * The editor answers with method identities, not revisions, so the "old" side
 * of a hot diff has to come from somewhere. `revisionCache` holds what the file
 * said the last time a command looked at it — which is what the domain was
 * compiled from, as long as nobody edited between commands. A changed method
 * identity already came from the editor, so a stale cache can only make the diff
 * *more* conservative (a same-shaped method body swap it cannot see), never
 * claim a hot patch for an edit that is really cold.
 */
function cachedRevision(projectRoot, path, current) {
  if (current === null) return null
  const key = join(projectRoot ?? '', path)
  const previous = revisionCache.get(key)
  revisionCache.set(key, current)
  return previous ?? null
}

/** The file's current text, or null when it cannot be read. */
function readEditorRevision(projectRoot, path) {
  try {
    return readFileSync(join(projectRoot ?? '', path), 'utf8')
  } catch {
    return null
  }
}

/** Why the payload refused to detour one method (kept for log-shaped rows). */
export function describeSkippedPatch(entry) {
  if (typeof entry === 'string') return entry
  const name = entry?.method ?? entry?.name ?? '?'
  return `${name}: ${entry?.reason ?? entry?.error ?? 'refused by the editor'}`
}

/**
 * Human-readable rendering of {@link hotReload}'s result.
 *
 * The wording matters: a caller must be able to tell "these edits are live"
 * from "these edits cannot be live without a compile" without reading JSON.
 * `files` is the per-file view; `hot[]` only carries detourable methods, so a
 * file the editor judged hot without a method body appears only in `files`.
 */
export function formatHotReload(result) {
  const hot = result?.hot ?? []
  const needCompile = result?.needCompile ?? []
  const failed = result?.failed ?? []
  const files = Array.isArray(result?.files) ? result.files : null
  const lines = []

  const hotFiles = files === null
    ? [...new Set(hot.map((entry) => entry.path).filter(Boolean))].map((path) => ({
        path,
        methodCount: hot.filter((entry) => entry.path === path).length,
      }))
    : files
        .filter((file) => file.state === 'hot')
        .map((file) => ({ path: file.path, methodCount: file.method_count ?? 0 }))

  for (const file of hotFiles) {
    const methods = hot.filter((entry) => entry.path === file.path)
    const count = file.methodCount ?? methods.length
    lines.push(
      `hot: ${file.path}` +
        (count > 0
          ? ` (${count} method${count === 1 ? '' : 's'})`
          : ' (no method bodies to patch)'),
    )
    for (const method of methods) lines.push(`  · ${method.method_key ?? describeMethod(method)}`)
  }
  const needCompileRows = files === null
    ? needCompile
    : files
        .filter((file) => file.state === 'need-compile')
        .map((file) => ({ path: file.path, reason: file.reason }))
  const failedRows = files === null
    ? failed
    : files
        .filter((file) => file.state === 'failed')
        .map((file) => ({ path: file.path, error: file.reason }))
  for (const entry of needCompileRows) {
    lines.push(`needs compile: ${entry.path}${entry.reason ? ` — ${entry.reason}` : ''}`)
  }
  for (const entry of failedRows) {
    lines.push(`failed: ${entry.path}${entry.error ? ` — ${entry.error}` : ''}`)
  }

  if (lines.length === 0) {
    lines.push(
      files !== null
        ? 'nothing to classify: the Editor returned no file states for these paths'
        : 'nothing to classify: no edited scripts were given',
    )
  }

  const summary =
    `${hotFiles.length} file${hotFiles.length === 1 ? '' : 's'} hot-patchable, ` +
    `${needCompileRows.length} need${needCompileRows.length === 1 ? 's' : ''} a compile, ` +
    `${failedRows.length} could not be read`
  lines.push('', summary)

  const applied = result?.applied ?? []
  const patches = result?.patches ?? []
  if (result?.dryRun) {
    lines.push('Dry run: nothing was patched.')
  } else if (result?.patchError) {
    lines.push(`not patched: ${result.patchError}`)
    lines.push('Nothing was detoured; run unity_recompile to converge the edit instead.')
  } else if (applied.length > 0) {
    lines.push(`patched: ${applied.length} method${applied.length === 1 ? '' : 's'} in ${patches.length} patch assembl${patches.length === 1 ? 'y' : 'ies'}.`)
    for (const entry of patches) lines.push(`  · ${entry.path} — ${entry.applied}/${entry.methods} method(s), patch ${entry.id}`)
    if ((result?.skipped?.length ?? 0) > 0) {
      for (const entry of result.skipped) lines.push(`  skipped ${entry.path}: ${entry.reason}`)
    }
    // Release builds inline method bodies, and an inlined call site keeps calling
    // the compiled copy even after the detour is live. Say so instead of leaving
    // a stale call path where the user cannot see it.
    const inlined = Array.isArray(result?.inlinedMethodKeys) ? result.inlinedMethodKeys : []
    if (inlined.length > 0) {
      lines.push(`  ${inlined.length} method(s) are inlined in this Release build; their call sites still run the compiled body until a compile: ${inlined.join(', ')}`)
    }
  } else if (hot.length > 0) {
    if ((result?.skipped?.length ?? 0) > 0) {
      lines.push('No method bodies were patched:')
      for (const entry of result.skipped) lines.push(`  skipped ${entry.path}: ${entry.reason}`)
      // The reason names the missing half of the diff, not a bug in the edit, so
      // point at the command that does not need it.
      lines.push('Run unity_recompile to converge the edit instead.')
    } else {
      lines.push('No method bodies were patched; run unity_recompile if needed.')
    }
  } else if (hotFiles.length > 0) {
    // 文件判热但没有任何可 detour 的方法：这不是「没给文件」，如实说明。
    lines.push('These files have no method bodies to detour; no compile is needed for them.')
  }
  if (needCompileRows.length > 0) {
    lines.push('Run unity_recompile (mode "auto" re-checks, mode "compile" forces it) for the files that need a compile.')
  }
  for (const entry of failedRows) {
    if (/no \.meta yet|still importing/i.test(String(entry.error ?? ''))) {
      lines.push('Some assets are still importing; retry once the import finishes.')
      break
    }
  }
  return lines.join('\n')
}

/**
 * One compiled method → the payload's `HotPatchMethodDto`
 * (LocusBridge.HotReload.cs).
 *
 * The compile service answers in camelCase (`declaringType`), the payload's DTO
 * is snake_case. `param_type_names` is load-bearing, not decorative: the
 * payload resolves the original method by name and parameter names, and a DTO
 * without them resolves to nothing and reports "original method not found in
 * the loaded assemblies". `param_type_sigs` is optional refinement for
 * ambiguous overloads.
 */
function toApplyMethod(method) {
  const names = Array.isArray(method.paramTypeNames) ? method.paramTypeNames.map(String) : []
  return {
    declaring_type: method.declaringType ?? '',
    patch_declaring_type: method.patchDeclaringType ?? '',
    name: method.name ?? '',
    param_type_names: names,
    param_type_sigs: Array.isArray(method.paramTypeSigs) ? method.paramTypeSigs.map(String) : names,
    is_static: Boolean(method.isStatic),
    is_ctor: Boolean(method.isCtor),
    original_assembly: method.originalAssembly ?? null,
  }
}

function describeMethod(method) {
  if (!method) return ''
  const type = method.declaring_type ?? '?'
  const name = method.name === '.ctor' ? type.split('.').pop() : method.name
  const params = Array.isArray(method.param_type_names) ? method.param_type_names.join(', ') : ''
  return `${type}.${name}(${params})${method.is_static ? ' [static]' : ''}`
}

/** Flatten the classification into the `details[]` rows callers report. */
function buildDetails(classified) {
  const details = []
  if (Array.isArray(classified.files) && classified.files.length > 0) {
    for (const file of classified.files) {
      const state =
        file.state === 'need-compile' ? STATE_NEED_COMPILE : file.state === 'failed' ? STATE_FAILED : STATE_HOT
      details.push({
        path: file.path,
        state,
        methodCount: file.method_count,
        ...(file.reason ? { reason: file.reason } : {}),
      })
    }
    return details
  }
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