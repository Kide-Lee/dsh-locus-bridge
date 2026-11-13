// Activation memory for the executable Unity skills.
//
// The compile itself happens inside the editor, so what can be tested here is
// the part this plugin owns: a stable content hash, the per-project store, the
// difference between "active", "stale" and "the editor was closed", and the rule
// that a switched-on skill compiles itself on first use.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  activationState,
  activationStorePath,
  ensureSkillActivation,
  readActivationStore,
  recordActivation,
  skillSourceHash,
} from '../src/skills/activation.js'
import { UNITY_SKILLS } from '../src/skills/catalog.js'
import { HOME_ENV, saveSettings } from '../src/settings.js'

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'locus-skill-activation-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return { dir, env: { [HOME_ENV]: dir } }
}

/** Switch skills on in this throwaway home; all executable ids by default. */
function enable(env, ids = UNITY_SKILLS.map((skill) => skill.id)) {
  saveSettings({ skills: Object.fromEntries(ids.map((id) => [id, true])) }, env)
}

test('the two executable skills have stable, distinct source hashes', () => {
  assert.deepEqual(
    UNITY_SKILLS.map((skill) => skill.id),
    ['graphics-debugger', 'ui-toolkit'],
  )
  const first = skillSourceHash(UNITY_SKILLS[0])
  assert.equal(first, skillSourceHash(UNITY_SKILLS[0]), 'the hash is a function of the bytes')
  assert.match(first, /^[0-9a-f]{64}$/)
  assert.notEqual(first, skillSourceHash(UNITY_SKILLS[1]))
})

test('recorded activation reads back as active, and a changed hash reads as stale', (t) => {
  const { env } = home(t)
  const project = 'E:/game'
  assert.deepEqual(
    activationState(project, env).map((state) => state.state),
    ['inactive', 'inactive'],
    'a fresh store has nothing activated',
  )

  recordActivation(
    project,
    UNITY_SKILLS.map((skill) => ({
      id: skill.id,
      sourceHash: skillSourceHash(skill),
      state: 'compiled',
      assemblyId: `asm-${skill.id}`,
    })),
    env,
  )
  const states = activationState(project, env)
  assert.deepEqual(states.map((state) => state.state), ['active', 'active'])
  assert.equal(states[0].assemblyId, 'asm-graphics-debugger')

  recordActivation(project, [{ id: UNITY_SKILLS[0].id, sourceHash: 'different', state: 'compiled' }], env)
  assert.deepEqual(
    activationState(project, env).map((state) => state.state),
    ['stale', 'active'],
    'only the package whose sources changed is stale',
  )
})

test('activation state can be narrowed to the switched-on skills', (t) => {
  const { env } = home(t)
  const project = 'E:/game'
  recordActivation(project, UNITY_SKILLS.map((skill) => ({ id: skill.id, sourceHash: skillSourceHash(skill), state: 'compiled' })), env)
  assert.deepEqual(
    activationState(project, env, { ids: ['ui-toolkit'] }).map((entry) => entry.id),
    ['ui-toolkit'],
    'a disabled skill has no state worth showing',
  )
})

test('an unavailable editor never overwrites a remembered activation', (t) => {
  const { env } = home(t)
  const project = 'E:/game'
  const uiToolkit = UNITY_SKILLS.find((skill) => skill.id === 'ui-toolkit')
  recordActivation(
    project,
    [{ id: uiToolkit.id, sourceHash: skillSourceHash(uiToolkit), state: 'compiled', assemblyId: 'asm-ui' }],
    env,
  )
  // A report that says nothing about the last successful compile.
  recordActivation(project, [{ id: uiToolkit.id, sourceHash: 'whatever', state: 'unavailable' }], env)
  const state = activationState(project, env).find((entry) => entry.id === 'ui-toolkit')
  assert.equal(state.state, 'active', 'closing the editor does not un-compile an assembly')
})

test('a malformed activation document reads as an empty store', (t) => {
  const { env } = home(t)
  writeFileSync(activationStorePath(env), '{ not json', 'utf8')
  assert.deepEqual(readActivationStore(env), { version: 1, projects: {} })
  assert.deepEqual(
    activationState('E:/game', env).map((state) => state.state),
    ['inactive', 'inactive'],
  )
})

/** A stand-in for a connected editor: reload state plus the compile command. */
function fakeEditor({ generation = 'gen-1', compile } = {}) {
  const calls = []
  return {
    calls,
    async call(type, message) {
      calls.push({ type, message })
      if (type === 'get_reload_state') {
        return { ok: true, message: JSON.stringify({ domain_generation: generation }) }
      }
      if (type === 'compile_skill_package') {
        const request = JSON.parse(message)
        compile?.(request)
        return {
          ok: true,
          message: JSON.stringify({
            packageId: request.packageId,
            assemblyId: `asm-${request.packageId}`,
            cacheHit: false,
            scriptCount: request.scripts.length,
            publicTypeCount: 2,
          }),
        }
      }
      throw new Error(`unexpected ${type}`)
    },
  }
}

const COMPILED = () =>
  UNITY_SKILLS.map((skill) => ({
    id: skill.id,
    sourceHash: skillSourceHash(skill),
    state: 'compiled',
    assemblyId: `asm-${skill.id}`,
  }))

test('nothing switched on pays no round trip', async (t) => {
  const { env } = home(t)
  const editor = fakeEditor()
  const outcome = await ensureSkillActivation(editor, 'E:/never', { env })
  assert.equal(outcome.state, 'skipped')
  assert.equal(editor.calls.length, 0, 'no reload probe while every skill is off')
})

test('the first snippet compiles a switched-on skill with no prior record', async (t) => {
  const { env } = home(t)
  const project = 'E:/game'
  enable(env)
  const editor = fakeEditor({ generation: 'gen-1' })
  const outcome = await ensureSkillActivation(editor, project, { env })
  assert.equal(outcome.state, 'reactivated')
  assert.equal(editor.calls.filter((call) => call.type === 'compile_skill_package').length, 2)
  assert.deepEqual(
    activationState(project, env).map((entry) => entry.state),
    ['active', 'active'],
  )
})

test('only the switched-on packages are compiled', async (t) => {
  const { env } = home(t)
  const project = 'E:/game'
  enable(env, ['ui-toolkit'])
  const editor = fakeEditor({ generation: 'gen-1' })
  const outcome = await ensureSkillActivation(editor, project, { env })
  assert.equal(outcome.state, 'reactivated')
  const compiled = editor.calls
    .filter((call) => call.type === 'compile_skill_package')
    .map((call) => JSON.parse(call.message).packageId)
  assert.deepEqual(compiled, ['ui-toolkit'])
})

test('the same domain generation means no compile', async (t) => {
  const { env } = home(t)
  const project = 'E:/game'
  enable(env)
  recordActivation(project, COMPILED(), env, { generation: 'gen-1' })
  const editor = fakeEditor({ generation: 'gen-1' })
  const outcome = await ensureSkillActivation(editor, project, { env })
  assert.equal(outcome.state, 'unchanged')
  assert.equal(editor.calls.filter((call) => call.type === 'compile_skill_package').length, 0)
})

test('a new domain recompiles the skills without any user action', async (t) => {
  const { env } = home(t)
  const project = 'E:/game'
  enable(env)
  recordActivation(project, COMPILED(), env, { generation: 'gen-1' })
  const editor = fakeEditor({ generation: 'gen-2' })
  const outcome = await ensureSkillActivation(editor, project, { env })
  assert.equal(outcome.state, 'reactivated')
  assert.equal(outcome.generation, 'gen-2')
  assert.equal(outcome.failures, 0)
  assert.equal(editor.calls.filter((call) => call.type === 'compile_skill_package').length, 2)
  assert.equal(readActivationStore(env).projects[project].__generation, 'gen-2')
  assert.deepEqual(
    activationState(project, env).map((entry) => entry.state),
    ['active', 'active'],
  )
})

test('changed sources recompile even in the same domain', async (t) => {
  const { env } = home(t)
  const project = 'E:/game'
  enable(env)
  // A stored hash that no longer matches the bundled sources is "stale" and
  // must not wait for a reload.
  recordActivation(project, [{ id: 'ui-toolkit', sourceHash: 'old', state: 'compiled' }], env, { generation: 'gen-1' })
  const editor = fakeEditor({ generation: 'gen-1' })
  const outcome = await ensureSkillActivation(editor, project, { env })
  assert.equal(outcome.state, 'reactivated')
})

test('a failed compile is not retried on every snippet', async (t) => {
  const { env } = home(t)
  const project = 'E:/game'
  enable(env, ['ui-toolkit'])
  const uiToolkit = UNITY_SKILLS.find((skill) => skill.id === 'ui-toolkit')
  recordActivation(
    project,
    [{ id: uiToolkit.id, sourceHash: skillSourceHash(uiToolkit), state: 'error', message: 'boom' }],
    env,
    { generation: 'gen-1' },
  )
  const editor = fakeEditor({ generation: 'gen-1' })
  const outcome = await ensureSkillActivation(editor, project, { env })
  assert.equal(outcome.state, 'cooling_down', 'the cooldown absorbs the retry')
  assert.equal(editor.calls.filter((call) => call.type === 'compile_skill_package').length, 0)
})
