// The bundled Unity domain skills, served from memory instead of from disk.
//
// The five documents under `src/skills/<id>/SKILL.md` are the domain knowledge
// this plugin ships. They are *not* copied into the user's workspace: a skill
// file written into `.dsh/skills` becomes a project asset the user has to
// maintain, never follows a plugin upgrade once edited, and survives the plugin
// being uninstalled. This module instead registers one DSH skill provider
// (`ctx.skills.registerProvider`) whose catalog is the package itself, so the
// switch in Settings is the only state that exists.
//
// Two things make this provider different from `ctx.skills.register()`:
//
//   * it is registered for every workspace, so it must decide *per lookup*
//     whether these skills apply at all. `list()` receives the Session's cwd and
//     answers with nothing unless that directory holds a Unity project — a
//     complete, empty observation, which `dsh-tool-skill` renders as no catalog
//     at all. A non-Unity conversation therefore pays no prompt cost.
//   * `rank` sits in the runtime tier (250): a same-named skill the user later
//     puts in `<project>/.dsh/skills` (rank 100) or `~/.dsh/skills` (rank 400)
//     wins or loses exactly as DSH's documented priority says, without this
//     provider having to know about it.
//
// The request order is fixed by the catalog: nothing is written, nothing is
// watched, and no file path ever enters the model-facing summary.
//
// Two more rules come from the documents themselves:
//
//   * a document whose instructions only work in a connected Editor
//     (`requiresUnity`) is not offered to the *model* while the unity feature is
//     off, because the model would be told to call a tool that is not there. It
//     stays `userInvocable`, since the human can still ask for it by name.
//   * a document that advertises a capability this plugin does not ship
//     (`capabilities`) gets that caveat appended to its description, so the model
//     reads "RenderDoc is unavailable" *before* choosing the skill rather than
//     after the first failed call.

import { resolve } from 'node:path'

import { findUnityProjects, isUnityProject } from '../args.js'
import { DOMAIN_SKILLS, readDomainSkill } from './catalog.js'

/**
 * A capability a document describes but this plugin cannot perform.
 *
 * The graphics-debugger document teaches both the Frame Debugger and RenderDoc;
 * only the Frame Debugger half ships, so the caveat names the working
 * alternative instead of leaving the model to discover it by failing.
 */
const MISSING_CAPABILITIES = Object.freeze({
  renderDoc: 'RenderDoc capture is not available here; only the Frame Debugger works.',
})

/** Provider name in the DSH skill registry; also the `provider` of each skill. */
export const PROVIDER_NAME = 'dsh-locus-bridge'

/** Same tier as a runtime registration: below project files, above user ones. */
export const SKILL_RANK = 250

/**
 * How long a workspace's "is this a Unity project" answer is reused.
 *
 * `list()` runs on every catalog collection, and the answer costs a bounded
 * directory walk (`findUnityProjects`, three levels, generated directories
 * skipped). The registry caches completed catalogs per cwd, so this TTL only
 * covers a burst of collections; a project created after that is picked up on
 * the next collection, which is the same latency the filesystem provider has.
 */
export const WORKSPACE_CACHE_MS = 30_000

const documentCache = new Map()
const workspaceCache = new Map()

/**
 * Split a SKILL.md into its frontmatter fields and its instruction body.
 *
 * Only the two fields the registry validates are read (`name`, `description`);
 * everything else in the block is ignored rather than parsed, because this file
 * is a hand-written document, not a configuration format. Block scalars are
 * supported in the two shapes the shipped documents use (`>-` folded, `|-`
 * literal); a folded value is joined with single spaces, which is correct for
 * the single-paragraph descriptions here.
 */
export function parseSkillDocument(text) {
  const source = String(text ?? '').replaceAll('\r\n', '\n')
  const lines = source.split('\n')
  if (lines[0]?.trim() !== '---') return { name: '', description: '', content: source.trim() }
  let close = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      close = index
      break
    }
  }
  // An unterminated block is not frontmatter: treat the whole file as the body,
  // so a malformed document still delivers its text instead of nothing.
  if (close < 0) return { name: '', description: '', content: source.trim() }
  const fields = readFrontmatterFields(lines.slice(1, close))
  return {
    name: fields.name ?? '',
    description: fields.description ?? '',
    content: lines.slice(close + 1).join('\n').trim(),
  }
}

/** One skill's parsed document, cached: the packed Markdown cannot change at runtime. */
export function skillDocument(id) {
  const cached = documentCache.get(id)
  if (cached !== undefined) return cached
  const document = parseSkillDocument(readDomainSkill(id))
  documentCache.set(id, document)
  return document
}

/**
 * Whether `dir` (or a directory below it) is a Unity project.
 *
 * The same downward-only rule every other project lookup in this plugin uses
 * (`src/args.js`): a workspace whose project sits in a subdirectory counts, a
 * project beside the workspace does not.
 */
export function workspaceHasUnityProject(dir, { now = Date.now() } = {}) {
  if (typeof dir !== 'string' || dir.trim() === '') return false
  const key = resolve(dir)
  const cached = workspaceCache.get(key)
  if (cached !== undefined && now - cached.at < WORKSPACE_CACHE_MS) return cached.value
  let value = false
  try {
    value = isUnityProject(key) || findUnityProjects(key).length > 0
  } catch {
    // An unreadable directory is "no project here", not a provider failure.
    value = false
  }
  workspaceCache.set(key, { at: now, value })
  return value
}

/** Drop the caches (tests only: a fixture creates projects between calls). */
export function __resetSkillProviderCacheForTest() {
  documentCache.clear()
  workspaceCache.clear()
}

/**
 * One skill's catalog entry.
 *
 * `name` and `description` come from the document, so the model-facing catalog
 * says exactly what the shipped file says. The fallbacks exist for a document
 * that lost its frontmatter: the registry rejects an empty description, and a
 * skill silently missing from the catalog would be harder to diagnose than one
 * advertised with its short hint.
 */
function candidateFor(skill, { modelInvocable = true } = {}) {
  const document = skillDocument(skill.id)
  return {
    name: document.name || skill.id,
    description: describe(skill, document),
    invocation: { modelInvocable, userInvocable: true },
    source: 'runtime',
    provider: PROVIDER_NAME,
    rank: SKILL_RANK,
    locator: skill.id,
  }
}

/**
 * The catalog description: the document's own `description`, plus a caveat for
 * every capability this plugin does not ship.
 *
 * The caveat is appended rather than substituted so the document stays the only
 * source of truth about what the skill is *for*.
 */
export function describe(skill, document) {
  const base = document.description || skill.hint
  const missing = Object.entries(skill.capabilities ?? {})
    .filter(([name, available]) => available === false && MISSING_CAPABILITIES[name])
    .map(([name]) => MISSING_CAPABILITIES[name])
  return missing.length === 0 ? base : `${base}\n\n${missing.join(' ')}`
}

/**
 * The provider `ctx.skills.registerProvider` borrows.
 *
 * `enabled` is the per-skill switch map from the settings document. Omitted (or
 * `null`) means "every shipped skill": that is what tests and a caller with no
 * settings document want. The map is read once when the provider is created —
 * changing a switch re-registers the provider, so a stale copy cannot survive a
 * settings write.
 *
 * `control` is the `SkillProviderControl` DSH hands the factory
 * (`ctx.skills.registerProvider((control) => …)`). Its `invalidate()` is called
 * by the plugin after a settings write so DSH drops the catalogs it already
 * built; its `signal` aborts when the registration is replaced, after which this
 * provider must answer with nothing. Both are optional, so tests and callers
 * that bypass the registry still work.
 *
 * `features` is a thunk returning the effective feature flags (`unity` turns the
 * Unity-dependent skills on for the model). Omitted means "everything on", which
 * is what a standalone caller gets.
 *
 * Both methods are async because the provider contract returns promises; the
 * work itself is a cache hit after the first lookup in a workspace.
 */
export function createDomainSkillProvider({ enabled = null, control = null, features = null } = {}) {
  const wanted = (skill) => enabled === null || enabled[skill.id] === true
  const unityFeatureOn = () => (typeof features === 'function' ? features()?.unity !== false : true)
  const modelCanUse = (skill) => skill.requiresUnity !== true || unityFeatureOn()
  return {
    name: PROVIDER_NAME,
    async list(options) {
      const cwd = typeof options?.cwd === 'string' ? options.cwd : ''
      if (!workspaceHasUnityProject(cwd)) return []
      // A registration that has been dropped (`control.signal` aborted) must not
      // answer: its skills would be served for a provider DSH already replaced.
      if (control?.signal?.aborted === true) return []
      const candidates = []
      for (const skill of DOMAIN_SKILLS) {
        if (!wanted(skill)) continue
        try {
          candidates.push(candidateFor(skill, { modelInvocable: modelCanUse(skill) }))
        } catch {
          // One unreadable document must not hide the other four.
        }
      }
      return candidates
    },
    async get(candidate) {
      const id = typeof candidate?.locator === 'string' ? candidate.locator : ''
      const skill = DOMAIN_SKILLS.find((entry) => entry.id === id)
      if (!skill || !wanted(skill)) return undefined
      const document = skillDocument(skill.id)
      return {
        name: document.name || skill.id,
        description: describe(skill, document),
        invocation: { modelInvocable: modelCanUse(skill), userInvocable: true },
        source: 'runtime',
        provider: PROVIDER_NAME,
        content: document.content,
        // The documents reference Unity APIs, not files beside them, so there is
        // no resource tree to resolve: say so instead of implying one exists.
        resourceBase: {
          kind: 'opaque',
          description: 'Bundled with the dsh-locus-bridge plugin; there are no additional resource files.',
        },
      }
    },
  }
}

/**
 * Tell DSH that a completed catalog is stale.
 *
 * Wrapped because `invalidate` is only guaranteed by the registry; a caller that
 * built the provider directly (`createDomainSkillProvider()` in a test) has no
 * control object and that must not throw.
 */
export function invalidateSkillCatalog(control) {
  if (typeof control?.invalidate === 'function') control.invalidate()
}

/** Read the `key: value` lines of one frontmatter block. */
function readFrontmatterFields(lines) {
  const fields = {}
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Za-z0-9_-]+):(?:[ \t]*(.*))?$/.exec(lines[index])
    if (!match) continue
    const key = match[1]
    const raw = (match[2] ?? '').trim()
    const block = /^[>|][+-]?$/.exec(raw)
    if (block === null) {
      fields[key] = unquote(raw)
      continue
    }
    // A block scalar: every following line that is indented (or blank) belongs
    // to the value. The first line back at column zero ends it.
    const collected = []
    let cursor = index + 1
    for (; cursor < lines.length; cursor += 1) {
      const line = lines[cursor]
      if (line.trim() === '') {
        collected.push('')
        continue
      }
      if (!/^[ \t]/.test(line)) break
      collected.push(line.trim())
    }
    index = cursor - 1
    fields[key] =
      block[0].startsWith('>')
        ? collected.filter((line) => line !== '').join(' ').trim()
        : collected.join('\n').trim()
  }
  return fields
}

/** Strip one pair of matching quotes from a scalar. */
function unquote(value) {
  const text = String(value ?? '')
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'") && text[text.length - 1] === text[0]) {
    return text.slice(1, -1)
  }
  return text
}
