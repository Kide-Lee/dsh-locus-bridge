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
// The patch assembly itself is built by the bundled .NET compile service
// (`src/csharp/sidecar.js` → `compile/hotPatch`), which re-emits each changed
// method body under a `__DshPatch_<Type>` type. That is what makes a full hot
// reload possible without the desktop compile server: the editor only has to
// detour the methods the patch names.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { getClient } from './client-pool.js'
import { SidecarError, SidecarUnavailable, hotDiff, hotPatch } from './csharp/sidecar.js'
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

/** Last text seen per absolute path, used as the "before" side of a hot diff. */
const revisionCache = new Map()

/** Asks the companion package for the text the running domain compiled. */
const COMPILED_TEXT_MESSAGE = 'dsh_hot_reload_compiled_text'

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

  const result = {
    ...classified,
    details: buildDetails(classified),
    dryRun: Boolean(dryRun),
    projectRoot: target?.projectRoot,
    patches: [],
    patchError: null,
  }

  if (dryRun || (result.hot?.length ?? 0) === 0) return result

  // Classification only says what *could* be patched. Turning that into live
  // code needs a patch assembly, and an answered `done`.
  onPhase('Compiling patch assemblies')
  try {
    const patched = await compileAndApplyPatches(target, client, result, { signal, onPhase })
    result.patches = patched.patches
    result.applied = patched.applied
    result.skipped = patched.skipped
  } catch (error) {
    if (error instanceof SidecarUnavailable || error instanceof SidecarError) {
      // No .NET / no build / a compile service that will not start: this is a
      // missing capability, not a failed patch. Report it, keep the
      // classification, and let the caller fall back to a recompile.
      result.patchError = `${error.code ? `[${error.code}] ` : ''}${error.message}`
    } else if (isTransient(error)) {
      result.patchError = `the editor reloaded while the patch was being applied: ${error.message}`
    } else {
      throw error
    }
  }
  return result
}

/**
 * Compile one patch assembly per edited file and detour the methods each one
 * names.
 *
 * Per file, not per batch: two files that both change the same type still
 * produce two patch assemblies, and the editor tracks each one by its own
 * `patch_id`, so disposing one edit does not detach the other.
 */
async function compileAndApplyPatches(target, client, classified, { signal = null, onPhase = () => {} } = {}) {
  const projectRoot = target?.projectRoot
  if (!projectRoot) throw new SidecarError('hot reload needs a project root to compile against.', { code: 'invalid_params' })

  const byPath = new Map()
  for (const entry of classified.hot) {
    if (!entry?.path) continue
    const list = byPath.get(entry.path) ?? []
    list.push(entry)
    byPath.set(entry.path, list)
  }

  // The classification carries both revisions: the editor reports what it last
  // compiled (`text`) and what the file says now (`updated_text`). Without the
  // pair there is nothing to diff, and "patch the file onto itself" would be a
  // no-op that reports success — so a file without both revisions is skipped
  // and left to a real recompile.
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
    const answer = await applyHotPatch(client, {
      patchId,
      assemblyB64: compiled.assemblyB64,
      methods: compiled.methods.map(toApplyMethod),
      domainGeneration: classified.domainGeneration ?? null,
    })
    patches.push({ id: patchId, path, methods: compiled.methods.length, applied: answer.applied, skipped: answer.skipped.length })
    appliedMethods.push(...compiled.methods.map((method) => ({
      patchId,
      path,
      method: describeMethod(method),
    })))
    for (const entry of answer.skipped) skipped.push({ path, reason: describeSkippedPatch(entry) })
  }
  return { patches, applied: appliedMethods, skipped }
}

/**
 * The `{path, oldText, newText}` triple for the compile service, from one
 * classified entry.
 *
 * The editor names its own snapshot `text` and the on-disk revision
 * `updated_text`; either may be missing when the message did not carry text at
 * all (classification still works then, patching does not).
 */
async function asRevisionPair(entries, client, projectRoot, path) {
  // The editor reports which methods changed, not the two source revisions.
  //
  // The "after" side is the file on disk: the text the user just saved, and the
  // text the patch has to reproduce. The "before" side is asked of the editor
  // first (its compiled copy), then of the revision cache. The file itself is
  // never used as its own "before" side: that diff is empty by construction, and
  // reporting "patched" for it would be a lie. When neither source has the
  // previous text the edit is skipped and left to a real recompile.
  const after = readEditorRevision(projectRoot, path)
  if (after === null) return null
  const entry = entries[0] ?? null
  // No `fromEditor` here on purpose: the companion package answers with the text
  // it last *saw on disk*, not the text the running domain compiled. Using it as
  // the "before" side would diff the file against its current self — the exact
  // empty patch this function exists to prevent. What the running domain really
  // compiled is the previous look at the file, which is what the cache holds.
  const before = typeof entry?.text === 'string' ? entry.text : cachedRevision(projectRoot, path, after)
  if (before === null || before === after) return null
  // The cache only knows what *some* earlier command saw. The editor's method
  // identities carry the interesting half of that fact: the editor re-reads and
  // re-classifies a file when it is re-imported, so an unchanged identity set
  // means the file has not been compiled since the cache was written — a
  // same-shaped body edit. A changed identity set is weaker evidence (the editor
  // re-classified a new import), but it still refuses the one case that would be
  // actively wrong: patching from a baseline older than the running domain.
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
 * The editor's compiled copy of a file, if it exposes one.
 *
 * Nothing is invented here: when the companion package does not answer this
 * request (or answers with nothing usable) the caller falls back to the
 * revision cache, and a cache miss leaves the edit to `unity_recompile`.
 */
async function readCompiledText(client, projectRoot, path) {
  try {
    const body = await send(client, COMPILED_TEXT_MESSAGE, { path })
    const text = typeof body?.text === 'string' ? body.text : null
    if (text === null || text.length === 0) return null
    return text
  } catch {
    return null
  }
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

/** The editor's revision of one file, or null when it cannot be read. */
function readEditorRevision(projectRoot, path) {
  try {
    return readFileSync(join(projectRoot ?? '', path), 'utf8')
  } catch {
    return null
  }
}

/** Why the editor refused to detour one method. */
function describeSkippedPatch(entry) {
  if (typeof entry === 'string') return entry
  const name = entry?.method ?? entry?.name ?? '?'
  return `${name}: ${entry?.reason ?? entry?.error ?? 'refused by the editor'}`
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

/**
 * One compiled method → the shape the editor's `dsh_hot_reload_apply` reads.
 *
 * The compile service answers in camelCase (`declaringType`), the editor's
 * message DTO is snake_case with `param_type_sigs`. Sending the camelCase object
 * straight through made every field undefined on the editor side, which it then
 * reported as "type  is not loaded in this domain".
 */
function toApplyMethod(method) {
  return {
    declaring_type: method.declaringType ?? '',
    patch_declaring_type: method.patchDeclaringType ?? '',
    name: method.name ?? '',
    is_static: Boolean(method.isStatic),
    is_ctor: Boolean(method.isCtor),
    original_assembly: method.originalAssembly ?? null,
    param_type_sigs: Array.isArray(method.paramTypeSigs) ? method.paramTypeSigs : [],
  }
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