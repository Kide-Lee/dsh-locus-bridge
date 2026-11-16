// The offline-docs skill provider: one skill, present only when docs exist.
//
// What is worth proving here:
//   * the gate — an un-imported project must produce a *complete empty
//     observation*, because the model's catalog then looks exactly as it did
//     before this provider existed (no dangling entry, no error surfaced);
//   * the round trip — the catalog entry must carry enough for `get()` to find
//     the same project again without cross-call mutable state;
//   * the shape parity with src/skills/provider.js, because DSH treats every
//     provider in the `dsh-locus-bridge` namespace identically.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { crc32, deflateRawSync } from 'node:zlib'

import {
  OFFLINE_DOCS_MISSING_REASON,
  OFFLINE_DOCS_SKILL_NAME,
  PROVIDER_NAME,
  SKILL_RANK,
  __resetOfflineDocsSkillCacheForTest,
  createOfflineDocsSkillProvider,
  findDocsProject,
  lookupDocs,
} from '../src/docs/skill-provider.js'
import { DOCS_ROOT_NAME, docsRoot, docsStatus, importDocs } from '../src/docs/unity-docs.js'

// ---------------------------------------------------------------------------
// Fixtures (no network: the zip is built here and fetch is injected)
// ---------------------------------------------------------------------------

/** Minimal zip writer — the same shape src/docs/unity-docs.js parses. */
function makeZip(entries) {
  const parts = []
  const central = []
  let offset = 0
  for (const [name, content] of entries) {
    const data = Buffer.from(content, 'utf8')
    const deflated = deflateRawSync(data)
    const nameBytes = Buffer.from(name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc32(data) >>> 0, 14)
    local.writeUInt32LE(deflated.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    parts.push(local, nameBytes, deflated)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0x0800, 8)
    header.writeUInt16LE(8, 10)
    header.writeUInt32LE(crc32(data) >>> 0, 16)
    header.writeUInt32LE(deflated.length, 20)
    header.writeUInt32LE(data.length, 24)
    header.writeUInt16LE(nameBytes.length, 28)
    header.writeUInt32LE(offset, 42)
    central.push(header, nameBytes)
    offset += 30 + nameBytes.length + deflated.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directory, end])
}

function page(title, description, body) {
  return [
    '<!DOCTYPE html><html><head>',
    `<meta name="description" content="${description}">`,
    `<title>${title} - Unity Manual</title></head><body>`,
    '<div id="content-wrap"><div class="content-block"><div class="content">',
    '<div class="breadcrumbs"><ul><li>Manual</li></ul></div>',
    `<h1>${title}</h1>${body}`,
    '<div id="_content"></div></div></div></div>',
    '<div class="footer-wrapper">Copyright</div></body></html>',
  ].join('\n')
}

const ZIP = makeZip([
  ['Manual/Rigidbody2D.html', page('Rigidbody2D', 'Physics body for 2D.', '<p>Rigidbody2D applies forces.</p>')],
  ['Manual/ExecutionOrder.html', page('Execution Order', 'Script order.', '<p>Awake runs first.</p>')],
])

/** A Unity project directory with a ProjectVersion.txt and optional docs. */
function project(t, { version = '2022.3.47f1', imported = false, docs = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'locus-docs-skill-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'Assets'), { recursive: true })
  mkdirSync(join(root, 'ProjectSettings'), { recursive: true })
  if (version !== null) {
    writeFileSync(join(root, 'ProjectSettings', 'ProjectVersion.txt'), `m_EditorVersion: ${version}\n`)
  }
  if (imported) importSync(root, docs === true ? ZIP : docs)
  return root
}

/** Import synchronously enough for fixture setup: importDocs is async, so the
 * caller awaits a shared promise chain instead of duplicating the zip parsing. */
const pending = []
function importSync(root, zip) {
  pending.push({ root, zip })
}

async function flushImports() {
  for (const { root, zip } of pending.splice(0)) {
    const fetchImpl = async (url) => {
      if (String(url).includes('OfflineDocumentation.html')) {
        return new Response('<a href="https://storage.googleapis.com/localized_docs/zh-cn/2022.3/UnityDocumentation.zip">z</a>', { status: 200 })
      }
      return new Response(zip, { status: 200 })
    }
    const result = await importDocs(root, { fetchImpl })
    assert.equal(result.state, 'imported', `fixture import failed: ${JSON.stringify(result)}`)
  }
}

/** Import docs into `root` and forget any cached status from earlier tests. */
async function withDocs(t, options) {
  __resetOfflineDocsSkillCacheForTest()
  const root = project(t, options)
  await flushImports()
  __resetOfflineDocsSkillCacheForTest()
  return root
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

test('a project without imported docs yields an empty catalog', async (t) => {
  __resetOfflineDocsSkillCacheForTest()
  const root = project(t, { imported: false })
  await flushImports()
  __resetOfflineDocsSkillCacheForTest()

  const provider = createOfflineDocsSkillProvider()
  assert.deepEqual(await provider.list({ cwd: root }), [])
})

test('no cwd at all is an empty catalog, not a throw', async () => {
  __resetOfflineDocsSkillCacheForTest()
  const provider = createOfflineDocsSkillProvider()
  assert.deepEqual(await provider.list(undefined), [])
  assert.deepEqual(await provider.list({}), [])
  assert.deepEqual(await provider.list({ cwd: '' }), [])
  assert.deepEqual(await provider.list({ cwd: 42 }), [])
})

test('the settings switch disables the provider regardless of docs', async (t) => {
  const root = await withDocs(t, { imported: true })
  const provider = createOfflineDocsSkillProvider({ enabled: false })
  assert.deepEqual(await provider.list({ cwd: root }), [])
  assert.equal(await provider.get({ locator: OFFLINE_DOCS_SKILL_NAME, projectRoot: root }), undefined)
})

test('enabled: true behaves exactly like the default', async (t) => {
  const root = await withDocs(t, { imported: true })
  const on = createOfflineDocsSkillProvider({ enabled: true })
  const auto = createOfflineDocsSkillProvider()
  assert.deepEqual(await on.list({ cwd: root }), await auto.list({ cwd: root }))
})

// ---------------------------------------------------------------------------
// The catalog entry
// ---------------------------------------------------------------------------

test('an imported project lists exactly one skill, shaped like the domain skills', async (t) => {
  const root = await withDocs(t, { imported: true })
  const entries = await createOfflineDocsSkillProvider().list({ cwd: root })
  assert.equal(entries.length, 1)
  const [entry] = entries

  assert.equal(entry.name, OFFLINE_DOCS_SKILL_NAME)
  assert.equal(entry.provider, PROVIDER_NAME)
  assert.equal(entry.rank, SKILL_RANK)
  assert.equal(entry.source, 'runtime')
  assert.equal(entry.locator, OFFLINE_DOCS_SKILL_NAME)
  assert.deepEqual(entry.invocation, { modelInvocable: true, userInvocable: true })
  // The description must carry what changes per project: version, locale, size.
  assert.match(entry.description, /2022\.3/)
  assert.match(entry.description, /2 pages/)
  assert.match(entry.description, /Chinese/)
  assert.match(entry.description, /unity_offline_docs/)
})

test('the English locale says so in the description', async (t) => {
  const root = await withDocs(t, { imported: true })
  const fetchImpl = async (url) => {
    if (String(url).includes('OfflineDocumentation.html')) {
      return new Response('<a href="https://storage.googleapis.com/docscloudstorage/2022.3/UnityDocumentation.zip">z</a>', { status: 200 })
    }
    return new Response(ZIP, { status: 200 })
  }
  assert.equal((await importDocs(root, { fetchImpl, locale: 'en', force: true })).state, 'imported')
  __resetOfflineDocsSkillCacheForTest()
  const [entry] = await createOfflineDocsSkillProvider().list({ cwd: root })
  assert.match(entry.description, /English/)
})

test('a deep cwd finds the project by walking up', async (t) => {
  const root = await withDocs(t, { imported: true })
  const deep = join(root, 'Assets', 'Scripts', 'Player')
  mkdirSync(deep, { recursive: true })
  const entries = await createOfflineDocsSkillProvider().list({ cwd: deep })
  assert.equal(entries.length, 1)
  // `get()` must still be able to reopen it from the entry alone.
  const skill = await createOfflineDocsSkillProvider().get(entries[0])
  assert.equal(skill.name, OFFLINE_DOCS_SKILL_NAME)
})

test('the entry carries the project root so get() needs no hidden state', async (t) => {
  const root = await withDocs(t, { imported: true })
  const [entry] = await createOfflineDocsSkillProvider().list({ cwd: root })
  // The root survives JSON, which is what a candidate travels through.
  const roundTripped = JSON.parse(JSON.stringify(entry))
  const skill = await createOfflineDocsSkillProvider().get(roundTripped)
  assert.equal(typeof skill.content, 'string')
  assert.match(skill.content, /Unity 2022\.3/)
})

test('the newest project wins when a parent also has docs', async (t) => {
  const outer = await withDocs(t, { imported: true })
  const inner = join(outer, 'nested-game')
  mkdirSync(join(inner, 'ProjectSettings'), { recursive: true })
  writeFileSync(join(inner, 'ProjectSettings', 'ProjectVersion.txt'), 'm_EditorVersion: 6000.3.2f1\n')
  const fetchImpl = async (url) => {
    if (String(url).includes('OfflineDocumentation.html')) {
      return new Response('<a href="https://storage.googleapis.com/localized_docs/zh-cn/6000.3/UnityDocumentation.zip">z</a>', { status: 200 })
    }
    return new Response(ZIP, { status: 200 })
  }
  assert.equal((await importDocs(inner, { fetchImpl })).state, 'imported')
  __resetOfflineDocsSkillCacheForTest()

  const found = findDocsProject(join(inner, 'Assets'))
  assert.equal(found.projectRoot, inner)
  assert.equal(found.status.version, '6000.3')
})

// ---------------------------------------------------------------------------
// get()
// ---------------------------------------------------------------------------

test('get() returns content, invocation and an opaque resource base', async (t) => {
  const root = await withDocs(t, { imported: true })
  const provider = createOfflineDocsSkillProvider()
  const [entry] = await provider.list({ cwd: root })
  const skill = await provider.get(entry)

  assert.equal(skill.name, OFFLINE_DOCS_SKILL_NAME)
  assert.equal(skill.provider, PROVIDER_NAME)
  assert.equal(skill.source, 'runtime')
  assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true })
  assert.equal(skill.resourceBase.kind, 'opaque')
  // No filesystem path is exposed as a resource base: page reads go through the
  // tool, which re-checks containment on every call.
  assert.equal('root' in skill.resourceBase, false)

  // Frontmatter is what DSH parses back into name/description.
  assert.match(skill.content, /^---\nname: unity-offline-docs$/m)
  assert.match(skill.content, /^description: .*Unity 2022\.3/m)
  // The body teaches the search → read workflow, and warns about the download.
  assert.match(skill.content, /action: "search"/)
  assert.match(skill.content, /action: "read"/)
  assert.match(skill.content, /350 MB/)
  // The local docs root is mentioned as information, not as an instruction to
  // read files directly.
  assert.equal(skill.content.includes(docsRoot(root)), true)
})

test('get() refuses unknown locators and missing candidates', async (t) => {
  const root = await withDocs(t, { imported: true })
  const provider = createOfflineDocsSkillProvider()
  assert.equal(await provider.get(undefined), undefined)
  assert.equal(await provider.get({}), undefined)
  assert.equal(await provider.get({ locator: 'unity-domain-skill' }), undefined)
  assert.equal(await provider.get({ locator: OFFLINE_DOCS_SKILL_NAME }), undefined)
  assert.equal(await provider.get({ locator: OFFLINE_DOCS_SKILL_NAME, projectRoot: '' }), undefined)
  // A project root that never had docs is refused too, even with a valid locator.
  const withoutDocs = project(t, { imported: false })
  assert.equal(await provider.get({ locator: OFFLINE_DOCS_SKILL_NAME, projectRoot: withoutDocs }), undefined)
  // And the positive control: the imported project does answer.
  assert.equal(typeof (await provider.get({ locator: OFFLINE_DOCS_SKILL_NAME, projectRoot: root })).content, 'string')
})

test('get() after the docs disappear returns undefined', async (t) => {
  const root = await withDocs(t, { imported: true })
  const provider = createOfflineDocsSkillProvider()
  const [entry] = await provider.list({ cwd: root })
  rmSync(docsRoot(root), { recursive: true, force: true })
  __resetOfflineDocsSkillCacheForTest()
  assert.equal(await provider.get(entry), undefined)
})

// ---------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------

test('the status cache expires so a fresh import shows up', async (t) => {
  __resetOfflineDocsSkillCacheForTest()
  const root = project(t, { imported: false })
  await flushImports()
  __resetOfflineDocsSkillCacheForTest()

  let now = 1_000_000
  const provider = createOfflineDocsSkillProvider({ now: () => now })
  assert.deepEqual(await provider.list({ cwd: root }), [])

  // Import while the provider is running.
  const fetchImpl = async (url) => {
    if (String(url).includes('OfflineDocumentation.html')) {
      return new Response('<a href="https://storage.googleapis.com/localized_docs/zh-cn/2022.3/UnityDocumentation.zip">z</a>', { status: 200 })
    }
    return new Response(ZIP, { status: 200 })
  }
  assert.equal((await importDocs(root, { fetchImpl })).state, 'imported')

  // Still cached as "not imported".
  assert.deepEqual(await provider.list({ cwd: root }), [])
  // Past the TTL it appears, without any explicit invalidation.
  now += 31_000
  assert.equal((await provider.list({ cwd: root })).length, 1)
})

// ---------------------------------------------------------------------------
// lookupDocs: the convenience path the tool layer uses
// ---------------------------------------------------------------------------

test('lookupDocs reports a reason when nothing is imported', async (t) => {
  __resetOfflineDocsSkillCacheForTest()
  const root = project(t, { imported: false })
  await flushImports()
  __resetOfflineDocsSkillCacheForTest()
  const result = lookupDocs(root, { query: 'Rigidbody2D' })
  assert.equal(result.imported, false)
  assert.equal(result.reason, OFFLINE_DOCS_MISSING_REASON)
  assert.deepEqual(result.results, [])
})

test('lookupDocs returns status, page count and hits when imported', async (t) => {
  const root = await withDocs(t, { imported: true })
  const result = lookupDocs(root, { query: 'Rigidbody2D', limit: 5 })
  assert.equal(result.imported, true)
  assert.equal(result.status.version, '2022.3')
  assert.equal(result.pages >= 1, true)
  assert.equal(result.results.length >= 1, true)
  assert.equal(result.results[0].path.includes('Rigidbody2D'), true)
})

test('the docs root and the status agree on where the docs live', async (t) => {
  const root = await withDocs(t, { imported: true })
  assert.equal(docsRoot(root), join(root, 'Library', 'Locus', DOCS_ROOT_NAME))
  assert.equal(docsStatus(root).imported, true)
  // A stray Library/Locus directory without docs is still not imported.
  const other = project(t, { imported: false })
  mkdirSync(join(other, 'Library', 'Locus'), { recursive: true })
  assert.equal(docsStatus(other).imported, false)
  assert.equal(dirname(docsRoot(other)), join(other, 'Library', 'Locus'))
})