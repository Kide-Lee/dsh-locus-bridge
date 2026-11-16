// Unity 官方离线文档：从 zip 到 Markdown 到索引的全流程。
//
// 测试完全不碰网络——每个用例注入 `fetchImpl`，它按 URL 形状返回 `Response`。
// 夹具 zip 由 node:zlib 现场生成（`makeZip`），所以这里校验的是**真实的 zip 解析
// 路径**（中央目录、本地头、deflate-raw 解压），而不是一个被 mock 掉的替身。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { crc32, deflateRawSync } from 'node:zlib'

import {
  DOCS_ROOT_NAME,
  captureZipUrl,
  classifyDocEntry,
  cleanMarkdown,
  convertHtmlPage,
  deriveDocsVersion,
  docsRoot,
  docsStatus,
  extractMainHtml,
  extractSummary,
  extractTitle,
  importDocs,
  listDocFiles,
  normalizeLocale,
  projectUnityVersion,
  readDoc,
  resolveDocPath,
  resolveOfflineSource,
  searchDocs,
  tokenizeQuery,
} from '../src/docs/unity-docs.js'
import { htmlToMarkdown, htmlToText, decodeEntities } from '../src/docs/html-to-markdown.js'

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 一个带 ProjectVersion.txt 的临时工程，用后删除。 */
function projectFixture(t, { version = '2022.3.47f1' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'locus-unity-docs-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  if (version !== null) {
    mkdirSync(join(root, 'ProjectSettings'), { recursive: true })
    const versionFile = 'm_EditorVersion: ' + version + '\nm_EditorVersionWithRevision: ' + version + ' (abcd)\n'
    writeFileSync(join(root, 'ProjectSettings', 'ProjectVersion.txt'), versionFile)
  }
  return root
}

/**
 * 最小 zip 生成器：只写 store/deflate-raw，中央目录 + EOCD——正好是本模块读的形状。
 *
 * 刻意不从别处拷贝一个 zip 文件进仓库：二进制夹具在评审里看不见内容，而这里
 * 每个条目名与正文都一目了然。
 */
function makeZip(entries) {
  const chunks = []
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
    chunks.push(local, nameBytes, deflated)
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
  return Buffer.concat([...chunks, directory, end])
}

/** 一页与真实 Unity 文档同构的 HTML（面包屑 + 正文 + `_content` + 页脚）。 */
function unityPage({ title, description, body }) {
  return [
    '<!DOCTYPE html><html lang="zh-cn"><head>',
    '<meta name="description" content="' + description + '">',
    '<title>' + title + ' - Unity 手册</title>',
    '</head><body><div id="content-wrap" class="content-wrap opened-sidebar"><div class="content-block"><div class="content">',
    '<div class="breadcrumbs clear"><ul><li><a href="UnityManual.html">Unity User Manual 2022.3</a></li><li>Nav</li></ul></div>',
    '<div class="mb20"><div class="nextprev clear"><span class="prev"><a href="Prev.html"></a></span></div></div>',
    '<h1>' + title + '</h1>',
    body,
    '<div id="_content"></div>',
    '</div></div></div>',
    '<div class="footer-wrapper"><div class="copy">Copyright © 2022 Unity Technologies.</div></div>',
    '</body></html>',
  ].join('\n')
}

const SAMPLE_PAGES = [
  ['Manual/2D-introduction.html', unityPage({
    title: 'Introduction to 2D',
    description: 'You can use Unity to create 2D projects.',
    body: '<p>You can use Unity to create <strong>2D</strong> projects. See <a href="2Dor3D.html">2D or 3D Projects</a>.</p><h2>Physics</h2><p>Sprites collide.</p>',
  })],
  ['Manual/ExecutionOrder.html', unityPage({
    title: 'Execution Order',
    description: 'The order in which scripts run.',
    body: '<p>Awake is called before Start. FixedUpdate runs before each physics step.</p>',
  })],
  ['Manual/碰撞体.html', unityPage({
    title: '碰撞体',
    description: '碰撞体用于物理模拟。',
    body: '<p>碰撞体（Collider）定义物体的形状，用于物理碰撞检测。</p>',
  })],
  ['ScriptReference/Transform-position.html', unityPage({
    title: 'Transform.position',
    description: 'The position of the transform in world space.',
    body: '<p>The position of the transform in world space. Hover to view.</p>',
  })],
  ['Manual/OfflineDocumentation.html', unityPage({ title: 'Offline Documentation', description: 'meta', body: '<p>download</p>' })],
  ['Manual/TermsOfUse.html', unityPage({ title: 'Terms of Use', description: 'legal', body: '<p>terms</p>' })],
  ['StaticFiles/js/jquery.sidebar.min.js', 'var x = 1'],
  ['uploads/Main/Overview2D.jpg', 'binary-ish'],
]

// 注入用的假 fetch：官方页面地址返回带 zip 链接的 HTML，zip 地址返回压缩包本身。
// 第二个参数里的 pageStatus 决定官方页面返回什么，用来演「这个版本没有中文包」。
function makeFetch(zipBuffer, options = {}) {
  const pageStatus = options.pageStatus ?? (() => 200)
  const zipUrl = options.zipUrl ?? 'https://storage.googleapis.com/localized_docs/zh-cn/2022.3/UnityDocumentation.zip'
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(String(url))
    if (String(url).includes('OfflineDocumentation.html')) {
      const status = pageStatus(String(url))
      if (status < 200 || status >= 300) return new Response('nope', { status })
      const html = '<!DOCTYPE html><html><body><p>Download: <a href="' + zipUrl + '">UnityDocumentation.zip</a></p></body></html>'
      return new Response(html, { status: 200 })
    }
    return new Response(zipBuffer, { status: 200, headers: { 'content-type': 'application/zip' } })
  }
  return { fetchImpl, calls }
}

// ---------------------------------------------------------------------------
// 版本与 locale
// ---------------------------------------------------------------------------

test('the project version comes from ProjectVersion.txt, m_EditorVersion only', (t) => {
  const root = projectFixture(t, { version: '2022.3.47f1' })
  assert.equal(projectUnityVersion(root), '2022.3.47f1')
  // No ProjectVersion.txt at all is null, not a throw: a non-Unity directory is a
  // legitimate argument for a status query.
  const bare = projectFixture(t, { version: null })
  assert.equal(projectUnityVersion(bare), null)
})

test('the docs version is the major.minor pair, exactly like upstream', () => {
  assert.equal(deriveDocsVersion('2022.3.47f1'), '2022.3')
  assert.equal(deriveDocsVersion('6000.3.2f1'), '6000.3')
  assert.equal(deriveDocsVersion('2019.4'), '2019.4')
  // A single component is not a documentation version upstream either.
  assert.equal(deriveDocsVersion('6000'), null)
  assert.equal(deriveDocsVersion(''), null)
  assert.equal(deriveDocsVersion(null), null)
})

test('locale normalisation accepts the contract spelling and upstream casing', () => {
  assert.equal(normalizeLocale(undefined), 'zh-cn')
  assert.equal(normalizeLocale('en'), 'en')
  assert.equal(normalizeLocale('zh-CN'), 'zh-cn')
  assert.equal(normalizeLocale('ZH-cn'), 'zh-cn')
  assert.throws(() => normalizeLocale('ja'), /unsupported docs locale/)
})

// ---------------------------------------------------------------------------
// 路径安全
// ---------------------------------------------------------------------------

test('docsRoot lives under Library/Locus', () => {
  assert.equal(DOCS_ROOT_NAME, 'unity-docs')
  assert.equal(docsRoot('/game'), join('/game', 'Library', 'Locus', 'unity-docs'))
})

test('every doc path is resolved inside the docs root or rejected', (t) => {
  const root = projectFixture(t)
  const resolved = resolveDocPath(root, 'manual/2D-introduction.md')
  assert.equal(resolved.startsWith(docsRoot(root)), true)

  for (const bad of ['../index.json', '../../ProjectSettings/ProjectVersion.txt', '/etc/passwd', 'manual/../../escape.md', '']) {
    assert.throws(() => resolveDocPath(root, bad), /doc path/, `expected ${JSON.stringify(bad)} to be rejected`)
  }
  // A Windows drive letter must not sneak through on any platform.
  assert.throws(() => resolveDocPath(root, 'C:/windows/system32/x.md'), /doc path/)
  assert.throws(() => resolveDocPath(root, 42), /doc path/)
})

// ---------------------------------------------------------------------------
// 官方页面 → zip 地址（实网核对过的形状）
// ---------------------------------------------------------------------------

test('the zip URL is captured from the page and only from Unity hosts', () => {
  const zh = '<a href="https://storage.googleapis.com/localized_docs/zh-cn/2022.3/UnityDocumentation.zip">zip</a>'
  assert.equal(captureZipUrl(zh), 'https://storage.googleapis.com/localized_docs/zh-cn/2022.3/UnityDocumentation.zip')
  const en = '<a href="https://cloudmedia-docs.unity3d.com/docscloudstorage/en/6000.3/UnityDocumentation.zip">zip</a>'
  assert.equal(captureZipUrl(en), 'https://cloudmedia-docs.unity3d.com/docscloudstorage/en/6000.3/UnityDocumentation.zip')
  // An untrusted host is not a valid source, even with the right file name.
  assert.equal(captureZipUrl('<a href="https://evil.example.com/x/UnityDocumentation.zip">zip</a>'), null)
  assert.equal(captureZipUrl(''), null)
  assert.equal(captureZipUrl(undefined), null)
})

test('en tries the new page first and falls back to the old one', async () => {
  const tried = []
  const result = await resolveOfflineSource({
    version: '2022.3',
    locale: 'en',
    fetchImpl: async (url) => {
      tried.push(url)
      if (url.includes('/Documentation/Manual/')) return new Response('gone', { status: 404 })
      return new Response('<a href="https://storage.googleapis.com/docscloudstorage/2022.3/UnityDocumentation.zip">z</a>', { status: 200 })
    },
  })
  assert.equal(result.state, 'ok')
  assert.deepEqual(tried, [
    'https://docs.unity3d.com/2022.3/Documentation/Manual/OfflineDocumentation.html',
    'https://docs.unity3d.com/2022.3/Manual/OfflineDocumentation.html',
  ])
})

test('zh-cn has exactly one candidate page, as upstream does', async () => {
  const tried = []
  const result = await resolveOfflineSource({
    version: '2022.3',
    locale: 'zh-cn',
    fetchImpl: async (url) => {
      tried.push(url)
      return new Response('<a href="https://storage.googleapis.com/localized_docs/zh-cn/2022.3/UnityDocumentation.zip">z</a>', { status: 200 })
    },
  })
  assert.equal(result.state, 'ok')
  assert.deepEqual(tried, ['https://docs.unity3d.com/cn/2022.3/Manual/OfflineDocumentation.html'])
})

test('a missing localisation is unsupported_version, not a network error', async () => {
  // Verified against the live site: cn/6000.3 is a 404 because Unity never
  // localised that version.
  const result = await resolveOfflineSource({ version: '6000.3', locale: 'zh-cn', fetchImpl: async () => new Response('', { status: 404 }) })
  assert.equal(result.state, 'unsupported_version')
  assert.match(result.reason, /6000\.3/)
})

test('a transport failure is network_error', async () => {
  const result = await resolveOfflineSource({
    version: '2022.3',
    locale: 'zh-cn',
    fetchImpl: async () => {
      throw new Error('getaddrinfo ENOTFOUND docs.unity3d.com')
    },
  })
  assert.equal(result.state, 'network_error')
})

test('a reachable page without a trusted zip link is unsupported, not a silent success', async () => {
  const result = await resolveOfflineSource({
    version: '2022.3',
    locale: 'en',
    fetchImpl: async () => new Response('<a href="https://evil.example.com/UnityDocumentation.zip">z</a>', { status: 200 }),
  })
  assert.equal(result.state, 'unsupported_version')
})

// ---------------------------------------------------------------------------
// 包内路径分类
// ---------------------------------------------------------------------------

test('archive entries are classified into manual/ and script-reference/ Markdown paths', () => {
  assert.equal(classifyDocEntry('Manual/2D-introduction.html'), 'manual/2D-introduction.md')
  assert.equal(classifyDocEntry('ScriptReference/Transform-position.html'), 'script-reference/Transform-position.md')
  assert.equal(classifyDocEntry('ScriptReference/Transform.Transform.html'), 'script-reference/Transform.Transform.md')
  // Backslashes from a Windows-produced archive.
  assert.equal(classifyDocEntry('Manual\\TwoD.html'), 'manual/TwoD.md')
  // The upstream fixture prefix is tolerated when present.
  assert.equal(classifyDocEntry('Documentation/Zh-cn/Manual/TwoD.html'), 'manual/TwoD.md')
  assert.equal(classifyDocEntry('Documentation/En/ScriptReference/Transform.html'), 'script-reference/Transform.md')
  // Everything else in the real archive is noise or assets.
  for (const name of ['StaticFiles/js/jquery.js', 'uploads/Main/a.jpg', 'Manual/docdata/x.json', 'Manual/', '', 'Manual/OfflineDocumentation.html', 'Manual/TermsOfUse.html', 'Manual/30_search.html']) {
    assert.equal(classifyDocEntry(name), null, `expected ${JSON.stringify(name)} to be ignored`)
  }
  assert.equal(classifyDocEntry(null), null)
})

// ---------------------------------------------------------------------------
// 页面抽取与 HTML → Markdown
// ---------------------------------------------------------------------------

test('the content region is clipped before breadcrumbs and footer', () => {
  const html = unityPage({ title: 'T', description: 'd', body: '<p>Body.</p>' })
  const main = extractMainHtml(html)
  assert.equal(main.startsWith('<h1>'), true)
  assert.equal(main.includes('breadcrumbs'), false)
  assert.equal(main.includes('nextprev'), false)
  assert.equal(main.includes('footer-wrapper'), false)

  // An old-style page without `_content` falls back to the footer marker.
  const old = '<div id="content-wrap"><p>lead</p><h1>Old</h1><p>Body.</p><div class="footer-wrapper">f</div></div>'
  const oldMain = extractMainHtml(old)
  assert.equal(oldMain.includes('lead'), false)
  assert.equal(oldMain.includes('Old'), true)

  // No wrapper at all: the whole page, because a blank page is a worse answer.
  assert.equal(extractMainHtml('<p>bare</p>'), '<p>bare</p>')
})

test('title prefers h1, then <title>, then the file name', () => {
  assert.equal(extractTitle('<h1>Hello</h1><title>T</title>'), 'Hello')
  assert.equal(extractTitle('<title>Only Title</title>'), 'Only Title')
  assert.equal(extractTitle('<p>nothing</p>', 'fallback'), 'fallback')
  assert.equal(extractTitle('', undefined), '')
})

test('summary prefers the meta description, then the first paragraph', () => {
  const html = unityPage({ title: 'T', description: 'Meta description.', body: '<p>First paragraph.</p>' })
  assert.equal(extractSummary(html, '# T\n\nFirst paragraph.'), 'Meta description.')
  const withoutMeta = '<h1>T</h1><p>First paragraph.</p>'
  assert.equal(extractSummary(withoutMeta, '# T\n\nFirst paragraph.'), 'First paragraph.')
  // Long descriptions are truncated to the documented limit.
  const long = `<meta name="description" content="${'x'.repeat(400)}">`
  assert.equal(extractSummary(long, '').length <= 220, true)
  assert.equal(extractSummary('<p>no markdown</p>', ''), '')
})

test('the converter produces Markdown for the constructs Unity pages actually use', () => {
  const html = [
    '<h1>Title</h1>',
    '<p>Plain <strong>bold</strong> and <em>em</em> with a <a href="Other.html">link</a>.</p>',
    '<h2>Lists</h2><ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>',
    '<ol><li>first</li><li>second</li></ol>',
    '<pre><code>var x = 1 &lt; 2;\n  indented();</code></pre>',
    '<figure><img src="../uploads/Main/a.png" alt="A picture"><figcaption>A caption</figcaption></figure>',
    '<table><tr><th>Name</th><th>Value</th></tr><tr><td>a</td><td>b|c</td></tr></table>',
    '<p>Entities: &gt; &amp; &nbsp; &#65;.</p>',
  ].join('\n')
  const markdown = htmlToMarkdown(html)
  assert.match(markdown, /^# Title$/m)
  assert.match(markdown, /\*\*bold\*\*/)
  assert.match(markdown, /\[link\]\(Other\.html\)/)
  assert.match(markdown, /^- one$/m)
  assert.match(markdown, /^\s+- nested$/m)
  assert.match(markdown, /^1\. first$/m)
  assert.match(markdown, /^```\nvar x = 1 < 2;\n {2}indented\(\);\n```$/m)
  assert.match(markdown, /!\[A picture\]\(\.\.\/uploads\/Main\/a\.png\)/)
  assert.match(markdown, /A caption/)
  assert.match(markdown, /^\| Name \| Value \|$/m)
  assert.match(markdown, /^\| --- \| --- \|$/m)
  assert.match(markdown, /^\| a \| b\\\|c \|$/m)
  assert.match(markdown, /> & A\./)
})

test('the converter is total: malformed input degrades instead of throwing', () => {
  const nasty = [
    '',
    null,
    undefined,
    123,
    '<p>unclosed <strong>bold <div><p>nested</strong></div> <a href="x">y',
    '</p></div></span>',
    '<a href="javascript:alert(1)">bad</a>',
    '<pre>never closed',
    '<table><tr><td>cell',
    '<script>while(true){}</script><p>after</p>',
    '<p>' + 'a'.repeat(200_000),
    '<',
    '<>',
  ]
  for (const input of nasty) {
    assert.equal(typeof htmlToMarkdown(input), 'string')
  }
  assert.equal(htmlToMarkdown('<a href="javascript:alert(1)">bad</a>'), 'bad')
  assert.equal(htmlToMarkdown('<script>while(true){}</script><p>after</p>'), 'after')
  // Unterminated pre/table still emit their content.
  assert.match(htmlToMarkdown('<pre>code'), /code/)
  assert.match(htmlToMarkdown('<table><tr><td>cell'), /cell/)
  // An unterminated tag is text, not a lost page.
  assert.match(htmlToMarkdown('<p>before <span'), /before/)
})

test('navigation furniture is dropped, not turned into text', () => {
  const html = '<div class="breadcrumbs"><ul><li>Nav here</li></ul></div><p>Real.</p><div class="footer-wrapper">Footer text</div><nav>Menu</nav>'
  const markdown = htmlToMarkdown(html)
  assert.equal(markdown, 'Real.')
})

test('entities decode to one character each and unknown names survive', () => {
  assert.equal(decodeEntities('&amp; &lt; &gt; &quot; &#65; &#x42;'), '& < > " A B')
  assert.equal(decodeEntities('&unknownthing;'), '&unknownthing;')
  assert.equal(decodeEntities('no entities'), 'no entities')
})

test('htmlToText strips the Markdown it just produced', () => {
  assert.equal(htmlToText('<h1>T</h1><p>See <a href="x">the docs</a>.</p>'), 'T See the docs.')
  assert.equal(htmlToText(''), '')
})

test('cleanMarkdown removes the per-page feedback lines', () => {
  const markdown = ['# Title', '', 'Leave feedback', 'Suggest a change', '切换到手册', 'Real sentence.', '', '', 'Tail.'].join('\n')
  assert.equal(cleanMarkdown(markdown), '# Title\n\nReal sentence.\n\nTail.')
})

test('a converted page carries title, markdown and summary', () => {
  const page = convertHtmlPage(unityPage({ title: 'Introduction to 2D', description: 'Desc here.', body: '<p>Body text.</p>' }), 'fallback')
  assert.equal(page.title, 'Introduction to 2D')
  assert.match(page.markdown, /^# Introduction to 2D$/m)
  assert.match(page.markdown, /Body text\./)
  assert.equal(page.summary, 'Desc here.')
  assert.equal(page.markdown.includes('Nav'), false)
})

// ---------------------------------------------------------------------------
// 导入的端到端行为
// ---------------------------------------------------------------------------

test('importDocs writes Markdown + index and reports what it did', async (t) => {
  const root = projectFixture(t)
  const zip = makeZip(SAMPLE_PAGES)
  const { fetchImpl, calls } = makeFetch(zip)
  const result = await importDocs(root, { fetchImpl })

  assert.equal(result.state, 'imported')
  assert.equal(result.version, '2022.3')
  assert.equal(result.files, 4)
  assert.equal(result.bytes, zip.length)
  assert.equal(result.locale, 'zh-cn')
  // The page was fetched once and the archive once; nothing else touched the network.
  assert.equal(calls.length, 2)

  const status = docsStatus(root)
  assert.deepEqual({ ...status, updatedAt: typeof status.updatedAt }, {
    imported: true,
    version: '2022.3',
    locale: 'zh-cn',
    files: 4,
    updatedAt: 'string',
  })

  const files = listDocFiles(root)
  assert.equal(files.length, 4)
  assert.equal(files.includes('manual/2D-introduction.md'), true)
  assert.equal(files.includes('manual/碰撞体.md'), true)
  assert.equal(files.includes('script-reference/Transform-position.md'), true)

  // The index sits inside the docs root and records the source.
  const index = JSON.parse(readFileSync(join(docsRoot(root), 'index.json'), 'utf8'))
  assert.equal(index.sourceUrl, 'https://storage.googleapis.com/localized_docs/zh-cn/2022.3/UnityDocumentation.zip')
  assert.equal(index.projectVersion, '2022.3.47f1')
  assert.equal(index.pages.length, 4)

  // No staging directory is left behind next to the docs root.
  assert.equal(listDocFiles(root).length, 4)
  assert.throws(() => statSync(join(root, 'Library', 'Locus', '.unity-docs-importing')))
  assert.throws(() => statSync(join(root, 'Library', 'Locus', '.unity-docs-previous')))
})

test('importDocs is idempotent: a second run is up_to_date and offline', async (t) => {
  const root = projectFixture(t)
  const zip = makeZip(SAMPLE_PAGES)
  const first = makeFetch(zip)
  assert.equal((await importDocs(root, { fetchImpl: first.fetchImpl })).state, 'imported')

  const second = makeFetch(zip)
  const result = await importDocs(root, { fetchImpl: second.fetchImpl })
  assert.equal(result.state, 'up_to_date')
  assert.equal(result.files, 4)
  assert.deepEqual(second.calls, [], 'an up-to-date import must not touch the network')

  // force re-downloads.
  const forced = makeFetch(zip)
  assert.equal((await importDocs(root, { fetchImpl: forced.fetchImpl, force: true })).state, 'imported')
  assert.equal(forced.calls.length, 2)
})

test('a missing localisation surfaces as unsupported_version and writes nothing', async (t) => {
  const root = projectFixture(t, { version: '6000.3.2f1' })
  const { fetchImpl } = makeFetch(makeZip(SAMPLE_PAGES), { pageStatus: () => 404 })
  const result = await importDocs(root, { fetchImpl })
  assert.equal(result.state, 'unsupported_version')
  assert.equal(result.version, '6000.3')
  assert.equal(docsStatus(root).imported, false)
})

test('a download failure surfaces as network_error and keeps the old docs', async (t) => {
  const root = projectFixture(t)
  const zip = makeZip(SAMPLE_PAGES)
  assert.equal((await importDocs(root, { fetchImpl: makeFetch(zip).fetchImpl })).state, 'imported')

  const broken = async (url) => {
    if (String(url).includes('OfflineDocumentation')) {
      return new Response('<a href="https://storage.googleapis.com/localized_docs/zh-cn/2022.3/UnityDocumentation.zip">z</a>', { status: 200 })
    }
    return new Response('boom', { status: 503 })
  }
  // force so the up-to-date short circuit does not hide the download path.
  const result = await importDocs(root, { fetchImpl: broken, force: true })
  assert.equal(result.state, 'network_error')
  assert.match(result.reason, /503/)
  // The previously imported docs are untouched.
  assert.equal(docsStatus(root).imported, true)
  assert.equal(searchDocs(root, { query: 'Execution Order' }).length > 0, true)
})

test('a corrupt archive is network_error, not a crash', async (t) => {
  const root = projectFixture(t)
  const { fetchImpl } = makeFetch(Buffer.from('this is not a zip at all'))
  const result = await importDocs(root, { fetchImpl })
  assert.equal(result.state, 'network_error')
  assert.match(result.reason, /zip/)
  assert.equal(docsStatus(root).imported, false)
})

test('without a Unity version there is nothing to import', async (t) => {
  const root = projectFixture(t, { version: null })
  const { fetchImpl, calls } = makeFetch(makeZip(SAMPLE_PAGES))
  const result = await importDocs(root, { fetchImpl })
  assert.equal(result.state, 'unsupported_version')
  assert.equal(result.version, null)
  assert.deepEqual(calls, [])
})

test('an explicit version overrides the project file', async (t) => {
  const root = projectFixture(t, { version: '2022.3.47f1' })
  const { fetchImpl, calls } = makeFetch(makeZip(SAMPLE_PAGES))
  const result = await importDocs(root, { fetchImpl, version: '6000.3' })
  assert.equal(result.version, '6000.3')
  // The candidate page is built from the derived version, not from the project file.
  assert.equal(calls[0], 'https://docs.unity3d.com/cn/6000.3/Manual/OfflineDocumentation.html')
  assert.equal(result.locale, 'zh-cn')
  // `en` in the same project reaches the new-style English page first.
  const english = makeFetch(makeZip(SAMPLE_PAGES))
  const enResult = await importDocs(root, { fetchImpl: english.fetchImpl, locale: 'en', version: '6000.3', force: true })
  assert.equal(enResult.state, 'imported')
  assert.equal(enResult.locale, 'en')
  assert.equal(english.calls[0], 'https://docs.unity3d.com/6000.3/Documentation/Manual/OfflineDocumentation.html')
})

test('an aborted signal stops the import', async (t) => {
  const root = projectFixture(t)
  const controller = new AbortController()
  controller.abort()
  const { fetchImpl } = makeFetch(makeZip(SAMPLE_PAGES))
  const result = await importDocs(root, { fetchImpl, signal: controller.signal })
  assert.equal(result.state, 'network_error')
  assert.match(result.reason, /abort/)
  assert.equal(docsStatus(root).imported, false)
})

test('zip entries that are not documents are skipped, and none is written outside the root', async (t) => {
  const root = projectFixture(t)
  const zip = makeZip([
    ...SAMPLE_PAGES,
    ['Manual/../../escape.html', unityPage({ title: 'Escape', description: 'x', body: '<p>escape</p>' })],
    ['uploads/Main/pic.png', 'png'],
  ])
  const result = await importDocs(root, { fetchImpl: makeFetch(zip).fetchImpl })
  assert.equal(result.state, 'imported')
  // The `..` entry is dropped by classification, so it never even becomes a page.
  assert.equal(result.files, 4)
  // Nothing appeared outside the docs root.
  const outside = join(root, 'Library', 'escape.md')
  assert.throws(() => statSync(outside))
  for (const file of listDocFiles(root)) {
    assert.equal(file.includes('..'), false)
    assert.equal(resolveDocPath(root, file).startsWith(docsRoot(root)), true)
  }
})

// ---------------------------------------------------------------------------
// 检索与读取
// ---------------------------------------------------------------------------

/** Import the sample pages into a fresh project and hand back the root. */
async function importedProject(t, entries = SAMPLE_PAGES) {
  const root = projectFixture(t)
  const result = await importDocs(root, { fetchImpl: makeFetch(makeZip(entries)).fetchImpl })
  assert.equal(result.state, 'imported')
  return root
}

test('tokenizeQuery splits Latin on words and Chinese on bigrams', () => {
  assert.deepEqual(tokenizeQuery('Rigidbody2D'), ['rigidbody2d'])
  assert.deepEqual(tokenizeQuery('Box Collider'), ['box', 'collider'])
  assert.deepEqual(tokenizeQuery('碰撞体'), ['碰撞', '撞体'])
  assert.deepEqual(tokenizeQuery('碰撞'), ['碰撞'])
  assert.deepEqual(tokenizeQuery('碰'), ['碰'])
  assert.deepEqual(tokenizeQuery(''), [])
  // A single Latin letter matches almost every page, so it is not a term.
  assert.deepEqual(tokenizeQuery('a a 3'), [])
})

test('searchDocs ranks a title hit above a body hit', async (t) => {
  const root = await importedProject(t)
  const hits = searchDocs(root, { query: 'Transform' })
  assert.equal(hits.length > 0, true)
  assert.equal(hits[0].path, 'script-reference/Transform-position.md')
  assert.equal(typeof hits[0].snippet, 'string')
  assert.equal(hits[0].snippet.length > 0, true)
  assert.equal(typeof hits[0].score, 'number')
})

test('searchDocs respects the limit and returns nothing for an empty query', async (t) => {
  const root = await importedProject(t)
  assert.equal(searchDocs(root, { query: 'Unity', limit: 1 }).length, 1)
  assert.deepEqual(searchDocs(root, { query: '' }), [])
  assert.deepEqual(searchDocs(root, { query: '   ' }), [])
  assert.deepEqual(searchDocs(root, { query: 'qqzzyxxnotpresent' }), [])
})

test('searchDocs finds Chinese text from a Chinese page', async (t) => {
  const root = await importedProject(t)
  const hits = searchDocs(root, { query: '碰撞' })
  assert.equal(hits.length > 0, true)
})

test('searchDocs on a project with no docs is an empty list, not a throw', (t) => {
  const root = projectFixture(t)
  assert.deepEqual(searchDocs(root, { query: 'anything' }), [])
})

test('readDoc returns the Markdown and its title', async (t) => {
  const root = await importedProject(t)
  const doc = readDoc(root, { path: 'manual/2D-introduction.md' })
  assert.equal(doc.path, 'manual/2D-introduction.md')
  assert.equal(doc.title, 'Introduction to 2D')
  assert.match(doc.markdown, /^# Introduction to 2D$/m)

  // A bare name is completed with the manual/ prefix, because that is how the
  // archive spells it and users copy archive names.
  assert.equal(readDoc(root, { path: 'ExecutionOrder.md' }).title, 'Execution Order')

  // The script reference page round-trips too.
  assert.equal(readDoc(root, { path: 'script-reference/Transform-position.md' }).title, 'Transform.position')
})

test('readDoc refuses traversal and unknown pages', async (t) => {
  const root = await importedProject(t)
  assert.throws(() => readDoc(root, { path: '../../ProjectSettings/ProjectVersion.txt' }), /doc path/)
  assert.throws(() => readDoc(root, { path: '/etc/passwd' }), /doc path/)
  assert.throws(() => readDoc(root, { path: 'manual/does-not-exist.md' }), /document not found/)
})

test('docsStatus on a fresh project reports not imported', (t) => {
  const root = projectFixture(t)
  assert.deepEqual(docsStatus(root), { imported: false, version: null, locale: null, files: 0, updatedAt: null })
})
test('an index without its directory is reported as not imported', async (t) => {
  const root = await importedProject(t)
  assert.equal(docsStatus(root).imported, true)
  rmSync(docsRoot(root), { recursive: true, force: true })
  // The index file went with the directory; the point is that status alone
  // decides, and it never throws.
  assert.equal(docsStatus(root).imported, false)
  assert.deepEqual(searchDocs(root, { query: 'Transform' }), [])
})
