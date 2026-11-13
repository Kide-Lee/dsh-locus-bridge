// The editor half of the two executable skills: compiling them into the
// connected project and keeping them alive across domain reloads.
//
// The Unity bridge shipped in `payload/locus_unity` already knows how to compile
// a skill's C# (`compile_skill_package`) and keeps the resulting assembly active
// so a later `unity_execute` can reference it (`using Locus.Skills;`). What the
// bridge does not know is *which* sources a package has — that is the desktop
// client's job, and this module is this plugin's replacement for it.
//
// Activation is implicit: the first `unity_execute` in a project whose skill
// switch is on compiles the enabled packages before the snippet runs. There is
// no button and no route, so a project never depends on the settings page being
// open at the right moment.
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

import { bridgeHome, readSettings } from '../settings.js'
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
 * The activation state of the executable skills for one project.
 *
 * `stale` means the bundled sources changed since the last compile, so the
 * assembly the editor holds no longer matches what this plugin ships.
 *
 * `ids` narrows the report to the skills that are switched on: a disabled skill
 * is never compiled, so an old record for it is not something the page should
 * present as a state.
 */
export function activationState(projectRoot, env = process.env, { ids = null } = {}) {
  const stored = readActivationStore(env).projects[String(projectRoot)] ?? {}
  const wanted = ids === null ? UNITY_SKILLS : UNITY_SKILLS.filter((skill) => ids.includes(skill.id))
  return wanted.map((skill) => {
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
async function compileWithClient(client, { timeoutMs = COMPILE_TIMEOUT_MS, skills = UNITY_SKILLS } = {}) {
  const generation = await readDomainGeneration(client)
  const packages = []
  for (const skill of skills) {
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
 * Make sure the switched-on skills are compiled in the editor's *current* domain.
 *
 * Called before a C# snippet runs, and it is where activation happens: a skill
 * whose switch is on gets compiled the first time it is needed, with no button
 * and no route of its own. After that the check is one cheap request, and a
 * compile only happens when the domain generation moved (editor restart, domain
 * reload) or the sources changed.
 *
 * A failed compile is retried at most once a minute, so a package that cannot
 * build in this editor does not turn every snippet into a compile attempt.
 *
 * @returns `{ state: 'skipped' | 'unchanged' | 'reactivated' | 'cooling_down', ... }`
 */
export async function ensureSkillActivation(client, projectRoot, { env = process.env, timeoutMs = COMPILE_TIMEOUT_MS } = {}) {
  const settings = readSettings(env)
  const wanted = UNITY_SKILLS.filter((skill) => settings.skills[skill.id] === true)
  // Nothing switched on: a snippet must not pay a `get_reload_state` round trip.
  if (wanted.length === 0) return { state: 'skipped' }

  const ids = wanted.map((skill) => skill.id)
  const stored = readActivationStore(env).projects[String(projectRoot)]
  const states = activationState(projectRoot, env, { ids })
  // Inactive means this project never compiled that skill — the case that must
  // compile by itself. Stale means the shipped sources moved since it did.
  const needsCompile = states.some((entry) => entry.state === 'inactive' || entry.state === 'stale')
  const failed = states.some((entry) => entry.state === 'error')
  const knownGeneration = typeof stored?.__generation === 'string' ? stored.__generation : ''
  const lastAttempt = Number(stored?.__lastAttempt) || 0
  const generation = await readDomainGeneration(client)
  // An unreadable generation is not evidence of a reload; the cheap path is to
  // leave the current state alone rather than recompile on every snippet.
  const generationChanged = generation !== '' && knownGeneration !== generation

  if (!generationChanged && !needsCompile) {
    if (failed && Date.now() - lastAttempt >= RETRY_COOLDOWN_MS) {
      // Fall through: retry a failed compile after the cooldown.
    } else if (failed) {
      return { state: 'cooling_down', generation }
    } else {
      return { state: 'unchanged', generation }
    }
  }

  const outcome = await compileWithClient(client, { timeoutMs, skills: wanted })
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