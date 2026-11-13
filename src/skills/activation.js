// Compiling and remembering the executable half of the two Unity skills.
//
// The Unity bridge shipped in `payload/locus_unity` already knows how to compile
// a skill's C# (`compile_skill_package`) and keeps the resulting assembly active
// so a later `unity_execute` can reference it (`using Locus.Skills;`). What the
// bridge does not know is *which* sources a package has — that is the desktop
// client's job, and this module is this plugin's replacement for it.
//
// Activation is deliberately separate from writing the Markdown: the editor may
// be closed, and a settings page that failed to write documentation because no
// editor was running would be worse than one that writes the docs and reports
// the capability as inactive.
//
// The editor keeps skill assemblies in a static registry that a domain reload
// clears (`get_reload_state`'s `domain_generation` names the new domain). So the
// remembered state is not "the assembly is live now"; it is "this project was
// compiled at generation X". `ensureSkillActivation` compares the live
// generation before a snippet runs and recompiles transparently when it moved,
// which is what makes an editor restart or a recompile self-healing.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { withClient, describeTarget } from '../client-pool.js'
import { probeEndpointDetailed } from '../endpoint.js'
import { bridgeHome } from '../settings.js'
import { UNITY_SKILLS, readUnitySkillSources } from './catalog.js'

/** Per-user activation memory: which package was compiled for which project. */
const STORE_FILE = 'skill-activation.json'
const STORE_VERSION = 1

/** Compilation runs inside the editor; a large package can take minutes. */
export const COMPILE_TIMEOUT_MS = 180_000

/** How long a failed compile is remembered before a snippet retries it. */
export const RETRY_COOLDOWN_MS = 60_000

/** `domain_generation` is read before every snippet that may use the skills. */
const RELOAD_STATE_TIMEOUT_MS = 10_000

/** skill id → hash. The bundled sources only change with a plugin upgrade. */
const sourceHashCache = new Map()

/** Stable content hash for one package: file order and bytes, nothing else. */
export function skillSourceHash(skill) {
  const cached = sourceHashCache.get(skill.id)
  if (cached !== undefined) return cached
  const digest = createHash('sha256')
  digest.update(`locus-skill:${skill.id}\n`)
  for (const entry of readUnitySkillSources(skill)) {
    digest.update(`${entry.path}\n`)
    digest.update(entry.source)
    digest.update('\n')
  }
  const hash = digest.digest('hex')
  sourceHashCache.set(skill.id, hash)
  return hash
}

/** Absolute path of the activation document (beside `settings.json`). */
export function activationStorePath(env = process.env) {
  return join(bridgeHome(env), STORE_FILE)
}

function emptyStore() {
  return { version: STORE_VERSION, projects: {} }
}

/**
 * Read the activation document.
 *
 * A missing, malformed or partially written file reads as "nothing activated":
 * this is a cache of a fact the editor can be asked for again, so refusing to
 * render the page over it would be the wrong failure.
 */
export function readActivationStore(env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(activationStorePath(env), 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.projects && typeof parsed.projects === 'object') {
      return { version: STORE_VERSION, projects: parsed.projects }
    }
  } catch {
    // Missing or unreadable; the empty store is the honest answer.
  }
  return emptyStore()
}

function writeActivationStore(store, env = process.env) {
  const path = activationStorePath(env)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

/**
 * Remember the outcome of one activation run for one project.
 *
 * An error is stored too: without it the page would keep claiming the package
 * is active after the editor rejected it. `generation` is the domain the
 * compile happened in, so a later snippet can tell whether the editor still
 * holds those assemblies.
 */
export function recordActivation(projectRoot, results, env = process.env, { generation = '' } = {}) {
  const store = readActivationStore(env)
  const key = String(projectRoot)
  const entry = { ...(store.projects[key] ?? {}) }
  for (const result of results) {
    // "unavailable" says nothing about the last successful compile, so it must
    // not overwrite it: closing the editor does not un-compile an assembly.
    if (result.state === 'unavailable') continue
    entry[result.id] =
      result.state === 'error'
        ? { state: 'error', sourceHash: result.sourceHash, message: result.message ?? '', at: Date.now() }
        : {
            state: result.state,
            sourceHash: result.sourceHash,
            assemblyId: result.assemblyId ?? null,
            at: Date.now(),
          }
  }
  entry.__generation = generation
  entry.__lastAttempt = Date.now()
  store.projects[key] = entry
  writeActivationStore(store, env)
  return entry
}

/**
 * The activation state of every executable skill for one project.
 *
 * `stale` means the bundled sources changed since the last compile, so the
 * assembly the editor holds no longer matches what this plugin ships.
 */
export function activationState(projectRoot, env = process.env) {
  const stored = readActivationStore(env).projects[String(projectRoot)] ?? {}
  return UNITY_SKILLS.map((skill) => {
    const entry = stored[skill.id]
    const currentHash = skillSourceHash(skill)
    if (!entry) return { id: skill.id, state: 'inactive' }
    if (entry.sourceHash !== currentHash) {
      return { id: skill.id, state: 'stale', at: entry.at ?? null }
    }
    if (entry.state === 'error') {
      return { id: skill.id, state: 'error', at: entry.at ?? null, message: entry.message ?? '' }
    }
    return { id: skill.id, state: 'active', assemblyId: entry.assemblyId ?? null, at: entry.at ?? null }
  })
}

function parseJsonMessage(message) {
  try {
    const parsed = JSON.parse(String(message ?? ''))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** `get_reload_state`'s per-domain generation, or '' when it cannot be read. */
export async function readDomainGeneration(client) {
  try {
    const envelope = await client.call('get_reload_state', '', { timeoutMs: RELOAD_STATE_TIMEOUT_MS })
    const payload = parseJsonMessage(envelope.message)
    return typeof payload.domain_generation === 'string' ? payload.domain_generation : ''
  } catch {
    return ''
  }
}

/**
 * Compile (or re-activate from the editor's cache) every executable skill.
 *
 * Each package is independent: one failure never cancels the others, because a
 * RenderDoc compile error must not cost the UI Toolkit assembly.
 */
async function compileWithClient(client, { timeoutMs = COMPILE_TIMEOUT_MS } = {}) {
  const generation = await readDomainGeneration(client)
  const packages = []
  for (const skill of UNITY_SKILLS) {
    const sourceHash = skillSourceHash(skill)
    const scripts = readUnitySkillSources(skill)
    try {
      const envelope = await client.call(
        'compile_skill_package',
        JSON.stringify({ packageId: skill.id, sourceHash, scripts }),
        { timeoutMs },
      )
      const payload = parseJsonMessage(envelope.message)
      packages.push({
        id: skill.id,
        sourceHash,
        state: payload.cacheHit === true ? 'cached' : 'compiled',
        assemblyId: payload.assemblyId ?? null,
        assemblyPath: payload.assemblyPath ?? null,
        scriptCount: Number.isInteger(payload.scriptCount) ? payload.scriptCount : scripts.length,
        typeCount: Number.isInteger(payload.publicTypeCount) ? payload.publicTypeCount : 0,
      })
    } catch (error) {
      packages.push({ id: skill.id, sourceHash, state: 'error', message: String(error?.message ?? error) })
    }
  }
  return { generation, packages }
}

/**
 * Compile every executable skill through a freshly opened connection.
 *
 * Used by the settings page. A closed editor is a state to report, not a
 * failure: `probeEndpointDetailed` answers in at most two seconds, whereas the
 * pool's reconnect budget would hold the request for over a minute.
 */
export async function activateSkillPackages(projectRoot, { timeoutMs = COMPILE_TIMEOUT_MS } = {}) {
  const target = describeTarget({ projectRoot })
  if (!target.pipe) {
    return {
      generation: '',
      packages: UNITY_SKILLS.map((skill) => ({
        id: skill.id,
        sourceHash: skillSourceHash(skill),
        state: 'unavailable',
        message: 'The project has no broker endpoint.',
      })),
    }
  }
  const probe = await probeEndpointDetailed(target.pipe, { timeoutMs: 2000 })
  if (!probe.listening) {
    return {
      generation: '',
      packages: UNITY_SKILLS.map((skill) => ({
        id: skill.id,
        sourceHash: skillSourceHash(skill),
        state: 'unavailable',
        message: 'The Unity editor is not connected; open the project and activate again.',
      })),
    }
  }
  return await withClient({ projectRoot }, (client) => compileWithClient(client, { timeoutMs }))
}

/**
 * Make sure the installed skills are compiled in the editor's *current* domain.
 *
 * Called before a C# snippet runs. It does nothing until the settings page has
 * activated the skills once for this project: a project that never used them
 * must not pay a `get_reload_state` round trip per snippet. Once it has, the
 * check is one cheap request, and a compile only happens when the domain
 * generation changed (editor restart, domain reload) or the sources changed.
 *
 * A failed compile is retried at most once a minute, so a package that cannot
 * build in this editor does not turn every snippet into a compile attempt.
 *
 * @returns `{ state: 'skipped' | 'unchanged' | 'reactivated' | 'cooling_down', ... }`
 */
export async function ensureSkillActivation(client, projectRoot, { env = process.env, timeoutMs = COMPILE_TIMEOUT_MS } = {}) {
  const stored = readActivationStore(env).projects[String(projectRoot)]
  if (!stored) return { state: 'skipped' }

  const states = activationState(projectRoot, env)
  const stale = states.some((entry) => entry.state === 'stale')
  const failed = states.some((entry) => entry.state === 'error')
  const knownGeneration = typeof stored.__generation === 'string' ? stored.__generation : ''
  const lastAttempt = Number(stored.__lastAttempt) || 0
  const generation = await readDomainGeneration(client)
  // An unreadable generation is not evidence of a reload; the cheap path is to
  // leave the current state alone rather than recompile on every snippet.
  const generationChanged = generation !== '' && knownGeneration !== generation

  if (!generationChanged && !stale) {
    if (failed && Date.now() - lastAttempt >= RETRY_COOLDOWN_MS) {
      // Fall through: retry a failed compile after the cooldown.
    } else {
      return { state: 'unchanged', generation }
    }
  }

  const outcome = await compileWithClient(client, { timeoutMs })
  const recorded = recordActivation(projectRoot, outcome.packages, env, {
    generation: outcome.generation || generation,
  })
  return {
    state: 'reactivated',
    generation: recorded.__generation,
    packages: outcome.packages,
    failures: outcome.packages.filter((entry) => entry.state === 'error').length,
  }
}