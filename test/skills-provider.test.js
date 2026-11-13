// The in-memory provider that exposes the bundled Unity domain skills.
//
// Two things are worth proving here, because both are easy to get subtly wrong:
// the frontmatter parse (which is the only thing standing between the shipped
// Markdown and the model's catalog) and the workspace gate (which is why a
// non-Unity conversation never pays for these five skills).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { DOMAIN_SKILLS } from '../src/skills/catalog.js'
import {
  PROVIDER_NAME,
  SKILL_RANK,
  __resetSkillProviderCacheForTest,
  createDomainSkillProvider,
  parseSkillDocument,
  skillDocument,
  workspaceHasUnityProject,
} from '../src/skills/provider.js'

/** A directory tree removed after the test, with an optional Unity project in it. */
function workspace(t, { unity = false, nested = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'locus-skill-provider-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const project = nested ? join(root, 'game') : root
  if (unity) {
    mkdirSync(join(project, 'Assets'), { recursive: true })
    mkdirSync(join(project, 'ProjectSettings'), { recursive: true })
  }
  return { root, project }
}

test('the frontmatter parse reads the shipped name and description', () => {
  const parsed = parseSkillDocument(
    ['---', 'name: demo-skill', 'description: >-', '  First line', '  second line.', 'metadata:', '  portedFrom: locus', '---', '', 'Body text.'].join('\n'),
  )
  assert.equal(parsed.name, 'demo-skill')
  // Folded block: lines join with one space, no trailing marker.
  assert.equal(parsed.description, 'First line second line.')
  assert.equal(parsed.content, 'Body text.')
})

test('a document without frontmatter still yields its body', () => {
  const parsed = parseSkillDocument('# Title\n\nText.')
  assert.equal(parsed.name, '')
  assert.equal(parsed.description, '')
  assert.equal(parsed.content, '# Title\n\nText.')
})

test('an unterminated block is treated as the body, not as a broken skill', () => {
  const parsed = parseSkillDocument('---\nname: x\n\nBody.')
  assert.equal(parsed.name, '')
  assert.equal(parsed.content.startsWith('---'), true)
})

test('every shipped document parses into a usable catalog entry', () => {
  for (const skill of DOMAIN_SKILLS) {
    const document = skillDocument(skill.id)
    assert.equal(document.name, skill.id, `${skill.id} declares its own id as the skill name`)
    assert.ok(document.description.length > 20, `${skill.id} has a routing description`)
    assert.equal(document.description.startsWith('>-'), false, `${skill.id} keeps no block marker`)
    assert.doesNotMatch(document.content, /^---/, `${skill.id} body excludes the frontmatter`)
    assert.match(document.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `${skill.id} is a valid kebab-case skill name`)
  }
})

test('the catalog lists all five skills in a workspace holding a Unity project', async (t) => {
  __resetSkillProviderCacheForTest()
  const { root, project } = workspace(t, { unity: true, nested: true })
  const provider = createDomainSkillProvider()

  assert.equal(workspaceHasUnityProject(root), true, 'a project one level down still counts')
  assert.equal(workspaceHasUnityProject(project), true, 'the project itself counts')

  const candidates = await provider.list({ cwd: root })
  assert.equal(candidates.length, DOMAIN_SKILLS.length)
  assert.deepEqual(
    candidates.map((entry) => entry.name).sort(),
    DOMAIN_SKILLS.map((skill) => skill.id).sort(),
  )
  for (const candidate of candidates) {
    assert.equal(candidate.provider, PROVIDER_NAME)
    assert.equal(candidate.source, 'runtime')
    assert.equal(candidate.rank, SKILL_RANK)
    assert.equal(candidate.invocation.modelInvocable, true)
    assert.equal(candidate.invocation.userInvocable, true)
    assert.ok(candidate.description.length > 20)
    assert.equal(candidate.path, undefined, 'an in-memory skill has no file path')
  }
})

test('a workspace without a Unity project contributes nothing', async (t) => {
  __resetSkillProviderCacheForTest()
  const { root } = workspace(t)
  mkdirSync(join(root, 'docs'), { recursive: true })
  const provider = createDomainSkillProvider()

  assert.equal(workspaceHasUnityProject(root), false)
  assert.deepEqual(await provider.list({ cwd: root }), [])
  // No cwd at all is the same answer: there is nothing to be relevant to.
  assert.deepEqual(await provider.list({}), [])
})

test('only the switched-on skills are listed and loadable', async (t) => {
  __resetSkillProviderCacheForTest()
  const { root } = workspace(t, { unity: true })
  const provider = createDomainSkillProvider({ enabled: { debugger: true, 'ui-toolkit': true } })

  const candidates = await provider.list({ cwd: root })
  assert.deepEqual(
    candidates.map((entry) => entry.name).sort(),
    ['debugger', 'ui-toolkit'],
    'a switched-off skill never reaches the model',
  )
  assert.equal(await provider.get({ locator: 'view' }, { cwd: root }), undefined, 'and it cannot be loaded either')
  const loaded = await provider.get({ locator: 'debugger' }, { cwd: root })
  assert.ok(loaded)
  assert.equal(loaded.name, 'debugger')
})

test('loading a candidate returns the instruction body', async (t) => {
  __resetSkillProviderCacheForTest()
  const { root } = workspace(t, { unity: true })
  const provider = createDomainSkillProvider()
  const [listable] = await provider.list({ cwd: root })
  assert.ok(listable, 'a candidate to load')

  const definition = await provider.get(listable, { cwd: root })
  assert.ok(definition)
  assert.equal(definition.name, listable.name)
  assert.equal(definition.provider, PROVIDER_NAME)
  assert.ok(definition.content.length > 1000, 'the whole document body is returned')
  assert.doesNotMatch(definition.content, /^---/)

  assert.equal(await provider.get({ locator: 'no-such-skill' }, {}), undefined)
})
