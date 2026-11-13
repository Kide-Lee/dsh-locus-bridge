// The Unity domain skills this plugin serves to DSH's skill registry.
//
// These are the upstream Locus knowledge documents that carry domain facts DSH
// has no equivalent for: Unity PlayerLoop/Tick debugging, profiler sampling,
// graphics diagnostics, UI Toolkit devtools, and the Locus View SDK. The
// documents that only duplicate DSH's own preset/skill/plugin surface
// (`ask-locus`, `create-agent`, `create-skill`, `plugin`, `dream`, `grill`,
// `connect-software`, `merge`, `review-context`) are deliberately not shipped.
//
// Bodies are verbatim from Locus except for the DSH frontmatter (`name` and
// `description`), which `src/skills/provider.js` reads to build the catalog
// summaries the model sees. Two of the skills also carry their Unity C#
// capability sources (`unity.files`): those are compiled inside the connected
// editor with the bridge's own `compile_skill_package` command and are what
// makes `using Locus.Skills;` available to `unity_execute`. The remaining
// executable assets (the Python RenderDoc helpers and the Locus frontend
// runtime) are not shipped — see NOTICE.
//
// Nothing here is written to the user's workspace: the provider serves these
// bodies from the installed package, so a skill follows the plugin version
// instead of becoming a file the user has to maintain.
//
// See NOTICE for the upstream revision and licence of the copied text.

import { readFileSync } from 'node:fs'

/** Every skill this plugin can install, in the order the settings page lists them. */
export const DOMAIN_SKILLS = Object.freeze([
  Object.freeze({
    id: 'debugger',
    title: 'Unity Debugger',
    hint: 'PlayerLoop/Tick positioning, cross-frame conditions, paused inspection, native thread stacks.',
    upstream: 'knowledge/skill/debugger.md',
  }),
  Object.freeze({
    id: 'profiler',
    title: 'Unity Profiler',
    hint: 'Bounded CPU/GPU/memory/GC samples, baseline comparison, marker call paths, memory snapshots.',
    upstream: 'knowledge/skill/profiler.md',
  }),
  Object.freeze({
    id: 'graphics-debugger',
    title: 'Unity Graphics Debugger',
    hint: 'Frame Debugger events and render targets, RenderDoc capture/replay, passes, buffers, pipeline state.',
    upstream: 'skills/graphics-debugger/SKILL.md',
    unity: Object.freeze({
      // Package id used by `compile_skill_package`; the sources declare
      // `namespace Locus.Skills`, so one assembly per skill keeps them isolated.
      files: Object.freeze([
        'unity/Editor/FrameDebuggerApi.cs',
        'unity/Editor/RenderDocCapture.cs',
      ]),
      entryTypes: Object.freeze(['FrameDebuggerApi', 'RenderDocCaptureApi']),
      // RenderDoc needs the Python helpers and an installed RenderDoc; only the
      // Frame Debugger half is self-contained after activation.
      partial: 'RenderDoc capture also needs the Python helpers and RenderDoc itself, which this plugin does not ship.',
    }),
  }),
  Object.freeze({
    id: 'ui-toolkit',
    title: 'UI Toolkit DevTools',
    hint: 'Unity 6.3+ UI Toolkit layout, style and interaction debugging in the Editor and Play Mode.',
    upstream: 'skills/ui-toolkit/SKILL.md',
    unity: Object.freeze({
      files: Object.freeze([
        'unity/Editor/UIToolkitApi.cs',
        'unity/Editor/UIToolkitDevTools.cs',
      ]),
      entryTypes: Object.freeze(['UIToolkitApi']),
    }),
  }),
  Object.freeze({
    id: 'view',
    title: 'Locus View',
    hint: 'Build Locus View panels: Vue UI, inspector, table, board and graph editors.',
    upstream: 'skills/view/SKILL.md',
  }),
])

/** The skills that carry executable Unity sources. */
export const UNITY_SKILLS = Object.freeze(DOMAIN_SKILLS.filter((skill) => skill.unity !== undefined))

/**
 * One skill's Markdown, exactly as the provider serves it.
 *
 * Read from the package instead of being duplicated in this module: the shipped
 * text is what the model receives, so there is one source of truth and no
 * chance of a stale inline copy.
 */
export function readDomainSkill(id) {
  const skill = DOMAIN_SKILLS.find((entry) => entry.id === id)
  if (!skill) throw new Error(`Unknown domain skill: ${id}`)
  return readFileSync(new URL(`./${id}/SKILL.md`, import.meta.url), 'utf8')
}

/** One skill's Unity C# sources, in the order `compile_skill_package` receives them. */
export function readUnitySkillSources(skill) {
  return (skill.unity?.files ?? []).map((path) => ({
    path,
    source: readFileSync(new URL(`./${skill.id}/${path}`, import.meta.url), 'utf8'),
  }))
}