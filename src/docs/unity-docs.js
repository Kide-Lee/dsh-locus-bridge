// Unity 官方离线文档（offline docs）的导入、检索与读取。
//
// 本模块是上游 `Locus/src-tauri/src/unity_docs.rs`（5690 行）的流程移植：只保留
// 「版本 → 官方页面 → zip → 每页 Markdown → 索引」这条主线，不搬上游的 tantivy /
// SQLite / embedding 知识库机器。检索用最朴素的子串 + 词频打分，因为离线文档
// 体量（三万页、约 350 MB）用这种方案已经够快，而多一套索引就多一份状态要维护。
//
// ## 为什么要「懒解析 zip」而不是先解压
//
// 上游把整包解压到临时目录再逐页转换，于是需要一份完整的 350 MB 副本；我们改成
// 只下载一次、边解压边转换、只把 Markdown 落盘（约 80 MB）。这样：
//   * 不需要把压缩包写到工程里（沙箱与磁盘都省）；
//   * zip 里 ../ 之类的相对路径根本没有机会被当成文件路径使用——它只是解压流的
//     索引名，我们据此推导目标 `.md` 路径，推导结果仍然要过 `resolveInside`；
//   * 转换失败只影响一页，不会让整次导入作废。
//
// ## 已核实的官方地址与压缩包布局（2026-11 实网核对一次）
//
// 上游 `offline_source_candidates` 给出的候选页，实测结果如下（GET，跟随跳转）：
//
//   en,    6000.3：https://docs.unity3d.com/6000.3/Documentation/Manual/OfflineDocumentation.html
//                 → 200（跳到 docs.unity.com/en-us/engine/6000.3/manual/offline-documentation）
//                 → 页内 URL 为 https://cloudmedia-docs.unity3d.com/docscloudstorage/en/6000.3/UnityDocumentation.zip
//   en,    2022.3：https://docs.unity3d.com/2022.3/Documentation/Manual/OfflineDocumentation.html
//                 → 200 → https://storage.googleapis.com/docscloudstorage/2022.3/UnityDocumentation.zip
//   zh-cn, 2022.3：https://docs.unity3d.com/cn/2022.3/Manual/OfflineDocumentation.html
//                 → 200 → https://storage.googleapis.com/localized_docs/zh-cn/2022.3/UnityDocumentation.zip
//   zh-cn, 6000.3：上面两种写法都是 404；https://docs.unity3d.com/cn/current/Manual/OfflineDocumentation.html
//                 虽然 200，但页内给的是 *英文* 包（.../docscloudstorage/en/2023.2/...）。
//
// 结论写在代码里：中文包只在 Unity 做过本地化的版本上存在，`current` 不能当兜底，
// 因为兜底会下载一包英文却标成 zh-cn。所以 404 → `unsupported_version`，如实上报。
//
// 压缩包（zh-cn/2022.3，content-length 348831539 ≈ 348.8 MB，支持 Range）的中央目录
// 实测 29946 个条目，顶层是 **扁平** 的：
//
//   Manual/*.html            ScriptReference/*.html
//   StaticFiles/**           uploads/**
//   Manual/docdata           ScriptReference/docdata
//
// 也就是说真实包里 **没有** `Documentation{En,Zh-cn}/` 这一层——那层只出现在上游的测试
// 夹具里。因此本模块对开头的 `Documentation/<任意>` 组件做「容忍」处理：有就剥掉，没有
// 也照常工作。真实页面 `Manual/2D-introduction.html` 约 20 KB，正文被包在
// `<div id="content-wrap" …>` 里，到 `<div id="_content">`（或 `footer-wrapper`）结束，
// 真正的 `h1` 之前还有面包屑和上一页/下一页翻页条——所以抽取时要先切片、再从第一个
// `<h1>` 起算，否则每一页都会带着导航文字。

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'

import { htmlToMarkdown, htmlToText } from './html-to-markdown.js'

/** docs 根目录名；它在 `<工程>/Library/Locus/` 下。 */
export const DOCS_ROOT_NAME = 'unity-docs'

/** 索引文件名：检索与 `docsStatus` 都只读它，不扫磁盘。 */
const INDEX_FILE = 'index.json'

/** 导入过程中的临时目录名（与文档根平级）；完成后整棵替换，中断则保留旧版本。 */
const STAGING_DIR = `.${DOCS_ROOT_NAME}-importing`

/**
 * 上游的版本推导只取 `2022.3`，因为文档站按主次版本发布：
 * `2022.3.47f1` → `2022.3`。只有一段（如 `6000`）不构成合法文档版本。
 */
const VERSION_PATTERN = /^\d+(?:\.\d+)+/

/**
 * 候选页面按上游 `offline_source_candidates` 的顺序排列。顺序有意义：英文的
 * `Documentation/Manual/` 新式地址优先，旧式 `Manual/` 次之；中文只有旧式一种。
 */
const OFFLINE_PAGES = {
  en: [
    (v) => `https://docs.unity3d.com/${v}/Documentation/Manual/OfflineDocumentation.html`,
    (v) => `https://docs.unity3d.com/${v}/Manual/OfflineDocumentation.html`,
  ],
  'zh-cn': [
    (v) => `https://docs.unity3d.com/cn/${v}/Manual/OfflineDocumentation.html`,
  ],
}

/**
 * 只认 Unity 自己的下载域。上游同样用正则限定这两个 host，因为页面内容可能被
 * 改写（跳转、CDN 变更），而「把任意 URL 当压缩包下载」正是这类流程最容易出的洞。
 */
const ZIP_URL_PATTERN = /https:\/\/(?:storage\.googleapis\.com|cloudmedia-docs\.unity3d\.com)\/[^"'()\s<>]+UnityDocumentation\.zip/

/** 每页收录的摘要长度上限，与上游 `extract_summary` 的 220 字一致。 */
const SUMMARY_LIMIT = 220

/** 缩写用的行内噪声，Unity 的中英文页都有；保留它们只会污染摘要。 */
const NOISE_LINES = [
  'Leave feedback',
  'Suggest a change',
  'Switch to Manual',
  'Switch to Scripting API',
  '切换到手册',
  '切换到脚本 API',
  '切换到脚本API',
]

/** 只处理这两种扩展名；其余（图片、字体、docdata）在包里占大头，全都要跳过。 */
const DOC_EXTENSION = /\.html?$/i

// ---------------------------------------------------------------------------
// 路径与工程信息
// ---------------------------------------------------------------------------

/**
 * 文档根目录：`<工程>/Library/Locus/unity-docs`。
 *
 * 放在 `Library/` 里是有意的——那是 Unity 自己的缓存目录，删掉不会影响工程，
 * 也不会被 git 看见（`Library/` 在 Unity 的 .gitignore 里）。
 */
export function docsRoot(projectRoot) {
  return join(String(projectRoot), 'Library', 'Locus', DOCS_ROOT_NAME)
}

/**
 * 把文档内的相对路径解析到文档根目录内，越界即抛错。
 *
 * 这是本模块唯一允许把外部字符串变成文件路径的地方：索引里记的 `path`、
 * 模型传来的 `path` 参数都从这里过一遍。`..`、绝对路径、盘符、以及规范化后
 * 跳出根目录的组合一律拒绝。
 */
export function resolveDocPath(projectRoot, docPath) {
  if (typeof docPath !== 'string' || docPath.trim() === '') throw new Error('doc path is required')
  if (isAbsolute(docPath) || /^[A-Za-z]:/.test(docPath)) throw new Error(`doc path must be relative: ${docPath}`)
  const root = resolve(docsRoot(projectRoot))
  const target = resolve(root, normalize(docPath))
  if (target !== root && !target.startsWith(root + sep)) throw new Error(`doc path escapes the docs root: ${docPath}`)
  return target
}

/** 读 ProjectVersion.txt 的 `m_EditorVersion`；与上游 `read_project_unity_version` 等价。 */
export function projectUnityVersion(projectRoot) {
  const file = join(String(projectRoot), 'ProjectSettings', 'ProjectVersion.txt')
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return null
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.toLowerCase().startsWith('m_editorversion:')) {
      const value = trimmed.slice('m_editorversion:'.length).trim()
      if (value) return value
    }
  }
  return null
}

/** `2022.3.47f1` → `2022.3`；版本无法推导时返回 null。 */
export function deriveDocsVersion(projectVersion) {
  if (typeof projectVersion !== 'string') return null
  const match = VERSION_PATTERN.exec(projectVersion.trim())
  if (!match) return null
  const parts = match[0].split('.')
  if (parts.length < 2) return null
  return `${Number(parts[0])}.${Number(parts[1])}`
}

/** 归一化 locale：契约里是小写 `zh-cn`，也接受上游写法 `zh-CN`。 */
export function normalizeLocale(locale) {
  if (locale === undefined || locale === null || locale === '') return 'zh-cn'
  const value = String(locale).trim().toLowerCase()
  if (value === 'en' || value === 'zh-cn') return value
  throw new Error(`unsupported docs locale: ${locale} (expected 'en' or 'zh-cn')`)
}

// ---------------------------------------------------------------------------
// 网络：官方页面 → zip 地址
// ---------------------------------------------------------------------------

/**
 * 抓一个文本 URL。
 *
 * `fetchImpl` 可注入是为了测试不碰网络；返回 `{ ok, status, text, headers }`。
 * 网络层异常（DNS、断线、超时）被归一成 `{ ok:false, status:0 }`，让调用方用
 * 同一个分支处理「页面不存在」和「网络不可用」，但仍然能区分（status 0 vs 404）。
 */
async function fetchText(url, { fetchImpl, signal } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available')
  try {
    const response = await fetchImpl(url, { signal, redirect: 'follow' })
    const status = Number(response?.status ?? 0)
    const ok = status >= 200 && status < 300
    const text = ok ? await response.text() : ''
    return { ok, status, text }
  } catch {
    return { ok: false, status: 0, text: '' }
  }
}

/**
 * 从 OfflineDocumentation 页面里捞出 zip 地址。
 *
 * 上游是正则扫描；这里相同，只是把「页面里出现了不受信 host」的情况也当成失败，
 * 而不是退而求其次。
 */
export function captureZipUrl(pageHtml) {
  const match = ZIP_URL_PATTERN.exec(String(pageHtml ?? ''))
  return match ? match[0] : null
}

/**
 * 依次尝试候选页面，返回 `{state:'ok'|'unsupported_version'|'network_error', zipUrl?, pageUrl?}`。
 *
 * 区分两种失败很重要：页面 404 说明这个版本没有中文/离线文档（`unsupported_version`，
 * 用户换 locale 或换 Unity 版本即可）；而连不上说明是网络问题，重试有意义。
 */
export async function resolveOfflineSource({ version, locale, fetchImpl, signal } = {}) {
  const candidates = OFFLINE_PAGES[locale]
  if (!candidates) return { state: 'unsupported_version', reason: `unsupported locale: ${locale}` }
  const pages = candidates.map((build) => build(version))
  let sawNetworkError = false
  for (const pageUrl of pages) {
    if (signal?.aborted) return { state: 'network_error', reason: 'aborted' }
    const page = await fetchText(pageUrl, { fetchImpl, signal })
    if (!page.ok) {
      if (page.status === 0) sawNetworkError = true
      continue
    }
    const zipUrl = captureZipUrl(page.text)
    if (zipUrl) return { state: 'ok', pageUrl, zipUrl }
    // 页面存在但没有 zip 链接：换下一个候选，都不行再判定。
  }
  return sawNetworkError
    ? { state: 'network_error', reason: `cannot reach ${pages[0]}` }
    : { state: 'unsupported_version', reason: `no offline documentation archive for ${version} (${locale})`, tried: pages }
}

// ---------------------------------------------------------------------------
// zip：只读中央目录，按需解压需要的条目
// ---------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50
const SIG_EOCD64 = 0x06064b50

/**
 * 读 EOCD 与（必要时）中央目录。
 *
 * 为了让内存里只留一份 350 MB 的 buffer，调用方传入整个压缩包；这里只做偏移计算。
 * ZIP64 记录在 4 GB 以上的包里才出现（Unity 文档包不会到），但遇到就报错而不是
 * 悄悄算错偏移。
 */
function readCentralDirectory(buffer) {
  if (buffer.length < 22) throw new Error('archive too small to be a zip')
  let eocd = -1
  const floor = Math.max(0, buffer.length - 22 - 0xffff)
  for (let at = buffer.length - 22; at >= floor; at -= 1) {
    if (buffer.readUInt32LE(at) === SIG_EOCD) {
      eocd = at
      break
    }
  }
  if (eocd < 0) throw new Error('zip end-of-central-directory record not found')
  if (buffer.readUInt32LE(eocd) === SIG_EOCD64) throw new Error('zip64 archives are not supported')
  const entries = buffer.readUInt16LE(eocd + 10)
  const size = buffer.readUInt32LE(eocd + 12)
  const offset = buffer.readUInt32LE(eocd + 16)
  if (offset + size > buffer.length) throw new Error('zip central directory is truncated')
  const list = []
  let at = offset
  for (let i = 0; i < entries; i += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== SIG_CENTRAL) throw new Error('zip central directory entry is malformed')
    const flags = buffer.readUInt16LE(at + 8)
    const method = buffer.readUInt16LE(at + 10)
    const compressed = buffer.readUInt32LE(at + 20)
    const nameLength = buffer.readUInt16LE(at + 28)
    const extraLength = buffer.readUInt16LE(at + 30)
    const commentLength = buffer.readUInt16LE(at + 32)
    const localOffset = buffer.readUInt32LE(at + 42)
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength)
    list.push({ name, flags, method, compressed, localOffset })
    at += 46 + nameLength + extraLength + commentLength
  }
  return list
}

/**
 * 解压单个条目。
 *
 * 支持 store(0) 与 deflate(8)——Unity 的文档包用 deflate；其余方法（bzip2、lzma）
 * 在这个包上不会出现，遇到就跳过该条目而不是让整次导入失败。
 */
async function readEntry(buffer, entry) {
  const at = entry.localOffset
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== SIG_LOCAL) throw new Error(`zip local header missing for ${entry.name}`)
  const nameLength = buffer.readUInt16LE(at + 26)
  const extraLength = buffer.readUInt16LE(at + 28)
  const start = at + 30 + nameLength + extraLength
  const end = start + entry.compressed
  if (end > buffer.length) throw new Error(`zip entry is truncated: ${entry.name}`)
  const data = buffer.subarray(start, end)
  if (entry.method === 0) return data
  if (entry.method !== 8) throw new Error(`unsupported zip compression method ${entry.method} for ${entry.name}`)
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return Buffer.from(await new Response(stream).arrayBuffer())
}

/**
 * 把包内路径变成文档内的相对路径（正斜杠，已去掉 `Documentation/<x>/` 前缀）。
 *
 * 返回 null 表示「不是我们关心的页」。上游的 `classify_html_doc_path` 还负责把
 * ScriptReference 按类型分组到子目录；我们保留它的分组思路但更简单：手册页放到
 * `manual/`，脚本参考页放到 `script-reference/`，页面本身平铺——检索是按标题与
 * 正文打分，不依赖目录层级，而平铺能让 zip 里的名字与磁盘上的路径一一对应，
 * 排查时肉眼可对。
 */
export function classifyDocEntry(rawName) {
  if (typeof rawName !== 'string') return null
  let name = rawName.replace(/\\/g, '/').replace(/^\/+/, '')
  // 真实包是扁平的；上游夹具里多一层 `Documentation/<En|Zh-cn>/`，有就剥掉。
  const prefixed = /^Documentation\/[^/]+\/(.+)$/i.exec(name)
  if (prefixed) name = prefixed[1]
  if (name === '' || name.endsWith('/')) return null
  if (!DOC_EXTENSION.test(name)) return null
  const base = name.slice(name.lastIndexOf('/') + 1).toLowerCase()
  // 这三页是元信息/搜索页，收进来只会让检索噪音变大。
  if (base === 'offlinedocumentation.html' || base === 'termsofuse.html' || base === '30_search.html') return null
  const lower = name.toLowerCase()
  let target
  if (lower.startsWith('manual/')) target = `manual/${name.slice('manual/'.length)}`
  else if (lower.startsWith('scriptreference/')) target = `script-reference/${name.slice('scriptreference/'.length)}`
  else return null
  target = target.replace(DOC_EXTENSION, '.md')
  // 再兜一次底：即使上面的规则被奇怪的包内路径绕过，`..` 也不能出现在结果里。
  if (target.split('/').some((part) => part === '.' || part === '..' || part === '')) return null
  return target
}

// ---------------------------------------------------------------------------
// 页面：HTML → {title, markdown, summary}
// ---------------------------------------------------------------------------

/**
 * 从整页 HTML 里切出正文。
 *
 * 顺序照抄实测到的真实结构：`<div id="content-wrap">` 开始，`<div id="_content">`
 * （新式页）或 `footer-wrapper`（老式页）结束；随后从第一个 `<h1>` 起算，丢掉
 * 面包屑与翻页条。找不到这些标记时退化为整页——宁可多一点噪声，也不要给出
 * 空白页然后让调用方以为文档坏了。
 */
export function extractMainHtml(html) {
  const source = String(html ?? '')
  const start = source.search(/<div[^>]*id=["']content-wrap["']/i)
  const body = start < 0 ? source : source.slice(start)
  const stop = body.search(/<div[^>]*id=["']_content["']/i)
  const clip = stop >= 0 ? stop : body.search(/<div[^>]*class=["'][^"']*footer-wrapper/i)
  let main = clip > 0 ? body.slice(0, clip) : body
  const heading = main.search(/<h1[\s>]/i)
  if (heading > 0) main = main.slice(heading)
  return main
}

/** 页面的人类可读标题：`<h1>` 优先，`<title>` 退后，最后取文件名。 */
export function extractTitle(html, fallback) {
  const source = String(html ?? '')
  for (const pattern of [/<h1[^>]*>([\s\S]*?)<\/h1>/i, /<title[^>]*>([\s\S]*?)<\/title>/i]) {
    const match = pattern.exec(source)
    if (match) {
      const text = htmlToText(match[1]).trim()
      if (text) return text
    }
  }
  return typeof fallback === 'string' && fallback ? fallback : ''
}

/**
 * 页面摘要：`<meta name="description">` 优先，其次第一段，最后第一行非标题正文。
 *
 * 与上游 `extract_summary` 同序，只把截断长度统一成 220。
 */
export function extractSummary(html, markdown) {
  const source = String(html ?? '')
  const meta = /<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*>/i.exec(source)
    ?? /<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*>/i.exec(source)
  if (meta) {
    const text = htmlToText(meta[1]).trim()
    if (text) return truncate(text, SUMMARY_LIMIT)
  }
  const text = String(markdown ?? '')
  const paragraph = /\n\n([^#\n][^\n]*)/.exec(text)
  if (paragraph) return truncate(paragraph[1].trim(), SUMMARY_LIMIT)
  const line = text.split('\n').find((candidate) => candidate.trim() !== '' && !candidate.startsWith('#'))
  return line ? truncate(line.trim(), SUMMARY_LIMIT) : ''
}

function truncate(text, limit) {
  const value = String(text).replace(/\s+/g, ' ').trim()
  if (value.length <= limit) return value
  return `${value.slice(0, limit - 1).trimEnd()}…`
}

/**
 * 去掉 Unity 每页都带的反馈/切换语言等噪声行。
 *
 * 上游 `clean_markdown` 做同一件事。这些行会以整句出现在片段里，看起来像正文，
 * 所以按整行精确匹配删除，而不是模糊替换。
 */
export function cleanMarkdown(markdown) {
  return String(markdown ?? '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim().replace(/^[-*+]\s+/, '')
      if (trimmed === '') return true
      return !NOISE_LINES.some((noise) => trimmed === noise || trimmed.startsWith(`${noise} `))
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 一页 HTML → `{title, markdown, summary}`；从不抛错（转换器自己吞异常）。 */
export function convertHtmlPage(html, fallbackTitle) {
  const main = extractMainHtml(html)
  const markdown = cleanMarkdown(htmlToMarkdown(main))
  const title = extractTitle(main, fallbackTitle) || fallbackTitle
  return { title, markdown, summary: extractSummary(html, markdown) }
}

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

/** 索引文件结构：`{version, locale, projectVersion, sourceUrl, updatedAt, files, pages:[…]}`。 */
function indexPath(projectRoot) {
  return join(docsRoot(projectRoot), INDEX_FILE)
}

function readIndexFile(projectRoot) {
  try {
    const parsed = JSON.parse(readFileSync(indexPath(projectRoot), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    if (!Array.isArray(parsed.pages)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * 下载整包（一次性读完）。
 *
 * 这是**用户主动触发**的功能（contracts §0.4），不是自动下载；超时与取消完全交给
 * 调用方传进来的 `signal`。整包读完再解析的理由见文件头：我们需要随机读中央目录与
 * 几千个条目的本地头，逐块流式解析会让状态机复杂得多，而 350 MB 对内存不是问题。
 */
async function downloadArchive(url, { fetchImpl, signal, onProgress = () => {} } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available')
  const response = await fetchImpl(url, { signal, redirect: 'follow' })
  const status = Number(response?.status ?? 0)
  if (!(status >= 200 && status < 300)) throw new Error(`archive download failed with HTTP ${status}`)
  const total = Number(response?.headers?.get?.('content-length') ?? 0) || 0
  const body = response?.body
  // 有流就读流报进度；没有流（测试里的假 fetch、部分 HTTP/1.0 代理）退回一次性读完，
  // 只是少了进度，不影响结果。
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks = []
    let downloaded = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      chunks.push(chunk)
      downloaded += chunk.length
      onProgress({ downloaded, total })
    }
    return Buffer.concat(chunks, downloaded)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  // 不知道 Content-Length 时 total 留 0：进度文字会只说「已下载 X MB」。
  onProgress({ downloaded: bytes.length, total })
  return bytes
}

/**
 * 导入官方文档。
 *
 * 两种短路：
 *   * `up_to_date`——索引里已有同名版本+locale，且文件还在，不重新下载；
 *   * `unsupported_version`——官方没有该版本（典型：中文包只覆盖部分版本）。
 *
 * 其余情况走「下载 → 逐个条目转换 → 写 Markdown + 索引」。写到临时目录
 * `.importing`，成功后整体替换，所以导入中断不会留下半个索引。
 */
export async function importDocs(projectRoot, { locale, version, signal, fetchImpl, force = false, onProgress = () => {} } = {}) {
  const resolvedLocale = normalizeLocale(locale)
  const projectVersion = projectUnityVersion(projectRoot)
  const docsVersion = version === undefined || version === null || version === ''
    ? deriveDocsVersion(projectVersion)
    : deriveDocsVersion(String(version)) ?? String(version)
  if (!docsVersion) {
    return {
      state: 'unsupported_version',
      version: null,
      reason: 'ProjectSettings/ProjectVersion.txt does not name a Unity version',
    }
  }
  // 导入开始前清掉上一次的取消标记，否则一次误点取消会让之后每次导入立刻停。
  try {
    rmSync(cancelPath(projectRoot), { force: true })
  } catch {
    // 没有标记文件是正常情况。
  }
  const existing = readIndexFile(projectRoot)
  if (!force && existing && existing.version === docsVersion && existing.locale === resolvedLocale) {
    const complete = existing.pages.every((page) => existsSync(safeJoin(projectRoot, page.path)))
    if (complete) {
      return {
        state: 'up_to_date',
        version: docsVersion,
        locale: resolvedLocale,
        files: existing.files,
        bytes: existing.bytes ?? 0,
      }
    }
  }
  const source = await resolveOfflineSource({ version: docsVersion, locale: resolvedLocale, fetchImpl, signal })
  if (source.state !== 'ok') {
    return {
      state: source.state,
      version: docsVersion,
      locale: resolvedLocale,
      reason: source.reason,
      ...(source.tried ? { tried: source.tried } : {}),
    }
  }
  if (signal?.aborted) return { state: 'cancelled', version: docsVersion, locale: resolvedLocale, reason: 'aborted' }

  const tick = (event) => {
    writeProgress(projectRoot, event)
    onProgress(event)
  }
  const cancelled = () => signal?.aborted === true || existsSync(cancelPath(projectRoot))
  tick({ phase: 'resolving', version: docsVersion, locale: resolvedLocale, url: source.zipUrl, downloaded: 0, total: 0 })
  let archive
  try {
    archive = await downloadArchive(source.zipUrl, {
      fetchImpl,
      signal,
      onProgress: (event) => tick({ phase: 'downloading', version: docsVersion, locale: resolvedLocale, url: source.zipUrl, ...event }),
    })
  } catch (error) {
    if (cancelled()) return { state: 'cancelled', version: docsVersion, locale: resolvedLocale, reason: 'aborted' }
    return { state: 'network_error', version: docsVersion, locale: resolvedLocale, reason: messageOf(error) }
  }
  if (cancelled()) return { state: 'cancelled', version: docsVersion, locale: resolvedLocale, reason: 'aborted' }

  const root = docsRoot(projectRoot)
  // staging 与 root 平级而不是在 root 里面：替换时要能 rename 目录，并且万一失败，
  // 旧索引仍然是一个完整的目录。
  const staging = join(dirname(root), `.${DOCS_ROOT_NAME}-importing`)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  try {
    let entries
    try {
      entries = readCentralDirectory(archive)
    } catch (error) {
      return { state: 'network_error', version: docsVersion, locale: resolvedLocale, reason: `archive is not a readable zip: ${messageOf(error)}` }
    }
    const pages = []
    let files = 0
    let skipped = 0
    let visited = 0
    // 每 200 个条目报一次进度：转换近三万个页面要几分钟，调用方需要能显示进度，
    // 也需要在这里响应取消。
    const reportEvery = 200
    tick({ phase: 'converting', version: docsVersion, locale: resolvedLocale, converted: 0, total: entries.length, downloaded: archive.length })
    for (const entry of entries) {
      if (cancelled()) {
        return { state: 'cancelled', version: docsVersion, locale: resolvedLocale, reason: 'aborted' }
      }
      visited += 1
      if (visited % reportEvery === 0) {
        tick({ phase: 'converting', version: docsVersion, locale: resolvedLocale, converted: files, total: entries.length, downloaded: archive.length })
      }
      const target = classifyDocEntry(entry.name)
      if (!target) continue
      let html
      try {
        html = (await readEntry(archive, entry)).toString('utf8')
      } catch {
        skipped += 1
        continue
      }
      const fallback = entry.name.slice(entry.name.lastIndexOf('/') + 1).replace(DOC_EXTENSION, '')
      let page
      try {
        page = convertHtmlPage(html, fallback)
      } catch {
        skipped += 1
        continue
      }
      if (!page.markdown.trim()) {
        skipped += 1
        continue
      }
      // Unity's own pages start with an <h1> that the converter keeps, so
      // `# <title>` alone makes every page open with its title twice. Strip the
      // leading heading only when it demotes to the same title: a page whose
      // first heading is a subsection keeps it, and a different first heading is
      // real content rather than a duplicate.
      page = { ...page, markdown: stripRepeatedTitle(page.markdown, page.title) }
      const output = resolveInside(staging, target)
      mkdirSync(dirname(output), { recursive: true })
      writeFileSync(output, `# ${page.title}\n\n${page.markdown}\n`, 'utf8')
      pages.push({ path: target, title: page.title, summary: page.summary, bytes: Buffer.byteLength(page.markdown) })
      files += 1
    }
    if (files === 0) {
      return { state: 'network_error', version: docsVersion, locale: resolvedLocale, reason: 'archive contained no documentation pages' }
    }
    pages.sort((a, b) => a.path.localeCompare(b.path))
    const index = {
      version: docsVersion,
      locale: resolvedLocale,
      projectVersion,
      sourceUrl: source.zipUrl,
      sourcePage: source.pageUrl,
      updatedAt: new Date().toISOString(),
      files,
      skipped,
      bytes: archive.length,
      pages,
    }
    writeFileSync(join(staging, INDEX_FILE), `${JSON.stringify(index)}\n`, 'utf8')
    // 替换：先把旧目录挪到 `.previous`，再把 staging 就位，最后删掉旧的。两步 rename
    // 让「磁盘上没有索引」的中间态尽可能短；真要在两步之间失败，下一次导入会发现
    // 没有索引并重新下载，而不是把半份数据当成功。
    const previous = join(dirname(root), `.${DOCS_ROOT_NAME}-previous`)
    rmSync(previous, { recursive: true, force: true })
    if (existsSync(root)) renameSync(root, previous)
    renameSync(staging, root)
    rmSync(previous, { recursive: true, force: true })
    clearProgress(projectRoot)
    return { state: 'imported', version: docsVersion, locale: resolvedLocale, files, bytes: archive.length, skipped }
  } finally {
    // 成功时 staging 已被 rename 走；失败/中断时在这里清掉半成品，旧索引不受影响。
    rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * Drop the leading `# <title>` line when it repeats the page title.
 *
 * Returns the markdown unchanged when the first heading differs, so this only
 * ever removes a duplicate. Any other heading level counts as content.
 */
function stripRepeatedTitle(markdown, title) {
  const lines = markdown.split('\n')
  let index = 0
  while (index < lines.length && lines[index].trim() === '') index += 1
  if (index >= lines.length) return markdown
  const first = lines[index].trim()
  if (!first.startsWith('# ')) return markdown
  const heading = first.slice(2).replace(/\s+#+$/, '').trim()
  const normalise = (text) => text.replace(/\s+/g, ' ').trim().toLowerCase()
  if (normalise(heading) !== normalise(title)) return markdown
  lines.splice(index, 1)
  while (index < lines.length && lines[index].trim() === '') lines.splice(index, 1)
  return lines.join('\n')
}

/** 进行中的导入标记。
 *
 * 导入是用户主动触发的长任务（350 MB + 近三万个页面，几分钟）。DSH 的工具调用不会
 * 永久占着会话，所以「状态」必须能在下一次调用里读到：进度写进
 * `Library/Locus/unity-docs.progress.json`，导入结束时删掉。取消则通过
 * `<project>/Library/Locus/unity-docs.cancel` 这个标记文件跨调用传递——标记文件存在
 * 时，正在跑的导入在下一次循环里停下（`importDocs` 的 `signal` 之外的第二条路，
 * 因为取消发生在另一次工具调用里，拿不到第一次调用的 AbortSignal）。
 */
export const DOCS_PROGRESS_FILE = 'unity-docs.progress.json'
export const DOCS_CANCEL_FILE = 'unity-docs.cancel'

function progressPath(projectRoot) {
  return join(docsRoot(projectRoot), DOCS_PROGRESS_FILE)
}

function cancelPath(projectRoot) {
  return join(docsRoot(projectRoot), DOCS_CANCEL_FILE)
}

function writeProgress(projectRoot, event) {
  try {
    mkdirSync(docsRoot(projectRoot), { recursive: true })
    const previous = readProgressFile(projectRoot) ?? {}
    const merged = { ...previous, ...event, updatedAt: new Date().toISOString() }
    // 进度文件只该描述「正在发生什么」：保留 startedAt，丢弃上一阶段的大字段。
    if (event.phase === 'downloading' && !merged.startedAt) merged.startedAt = merged.updatedAt
    writeFileSync(progressPath(projectRoot), `${JSON.stringify(merged)}\n`, 'utf8')
  } catch {
    // 进度是附带信息，写不进去不能打断导入本身。
  }
}

function readProgressFile(projectRoot) {
  try {
    const parsed = JSON.parse(readFileSync(progressPath(projectRoot), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function clearProgress(projectRoot) {
  for (const target of [progressPath(projectRoot), cancelPath(projectRoot)]) {
    try {
      rmSync(target, { force: true })
    } catch {
      // 删不掉也只会让状态里多一条陈旧的进度，不影响数据。
    }
  }
}

/** 当前是否有导入在进行（以及它的进度）。 */
export function docsImportState(projectRoot) {
  const progress = readProgressFile(projectRoot)
  if (!progress) return { running: false, cancelRequested: false, progress: null }
  // 没有进程在跑时进度文件是陈旧的（例如进程被强杀）：把它如实报出来，但标成 stale，
  // 让调用方知道「导入正在跑」这个结论只在文件新鲜时成立。
  //
  // 取消文件在场时永远不算「在跑」：导入每个检查点都会看它，看到就立刻返回
  // cancelled，所以「刚下完、正在转换」这个阶段剩下的唯一一件事就是退出。继续
  // 声称 importing 会让界面永远停在一根不会再动的进度条上。
  let stale = false
  try {
    const age = Date.now() - Number(progress.updatedAt ? Date.parse(progress.updatedAt) : 0)
    stale = !Number.isFinite(age) || age > 10 * 60 * 1000
  } catch {
    stale = true
  }
  const cancelRequested = existsSync(cancelPath(projectRoot))
  return { running: !stale && !cancelRequested, cancelRequested, progress, stale }
}

/** 请求取消正在进行的导入；下一次工具调用时生效。 */
export function requestDocsCancel(projectRoot) {
  mkdirSync(docsRoot(projectRoot), { recursive: true })
  writeFileSync(cancelPath(projectRoot), new Date().toISOString(), 'utf8')
  return { cancelRequested: true, file: cancelPath(projectRoot) }
}

/**
 * 删除已导入的文档。
 *
 * 与导入一样是显式动作：删掉 Markdown 与索引，`Library/Locus` 其余内容不动。返回删除
 * 的页数，便于调用方确认自己删掉的是哪一份（版本、语言）。
 */
export function deleteDocs(projectRoot) {
  const status = docsStatus(projectRoot)
  const root = docsRoot(projectRoot)
  rmSync(root, { recursive: true, force: true })
  return { deleted: status.imported, version: status.version ?? null, locale: status.locale ?? null, files: status.files ?? 0, root }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** `resolveInside(root, relative)`：把相对路径落到 root 内，越界抛错。 */
function resolveInside(root, relativePath) {
  const base = resolve(root)
  const target = resolve(base, relativePath)
  if (target !== base && !target.startsWith(base + sep)) throw new Error(`path escapes the docs root: ${relativePath}`)
  return target
}

function safeJoin(projectRoot, docPath) {
  try {
    return resolveDocPath(projectRoot, docPath)
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// 状态 / 检索 / 读取
// ---------------------------------------------------------------------------

/**
 * 文档状态。
 *
 * 只读 `index.json`：已导入但没有索引（例如被手工删过）如实报 `imported:false`，
 * 因为检索确实用不了。
 */
export function docsStatus(projectRoot) {
  const index = readIndexFile(projectRoot)
  // 索引完好但目录被删（手工清理、盘满）也算未导入：检索会命中一堆读不到的文件。
  if (!index || !existsSync(docsRoot(projectRoot))) {
    return { imported: false, version: null, locale: null, files: 0, updatedAt: null }
  }
  return {
    imported: true,
    version: index.version ?? null,
    locale: index.locale ?? null,
    files: typeof index.files === 'number' ? index.files : index.pages.length,
    updatedAt: index.updatedAt ?? null,
  }
}

/**
 * 进度文字：调用方在 status 里看到的「正在下载 41%」就是这里生成的。
 *
 * 百分比只在知道总字节时给出；中文包与英文包的 Content-Length 都可靠，但没有时
 * 宁可只报已下载量，也不编一个分母。
 */
export function formatDocsProgress(progress) {
  if (!progress) return null
  const phase = String(progress.phase ?? '')
  if (phase === 'converting') {
    const done = Number(progress.converted ?? 0)
    const total = Number(progress.total ?? 0)
    const percent = total > 0 ? Math.floor((done / total) * 100) : null
    return `converting ${done}/${total} page(s)${percent === null ? '' : ` (${percent}%)`}`
  }
  if (phase === 'downloading') {
    const downloaded = Number(progress.downloaded ?? 0)
    const total = Number(progress.total ?? 0)
    const mb = (downloaded / (1024 * 1024)).toFixed(1)
    const percent = total > 0 ? Math.floor((downloaded / total) * 100) : null
    return percent === null ? `downloaded ${mb} MB` : `downloaded ${mb} MB of ${(total / (1024 * 1024)).toFixed(1)} MB (${percent}%)`
  }
  if (phase === 'resolving') return 'resolving the documentation package'
  return null
}

/**
 * 词项切分：英文按词、中文按二元组。
 *
 * 只取长度 ≥ 2 的项：单字母/单数字（`a`、`3`）在任何一页里都出现，拿它打分等于
 * 随机排序。单个汉字则是真词（「碰」），保留。
 */
export function tokenizeQuery(query) {
  const text = String(query ?? '').toLowerCase()
  const terms = []
  for (const match of text.matchAll(/[a-z0-9_]+|[\u3400-\u4dbf\u4e00-\u9fff]+/g)) {
    const chunk = match[0]
    if (/^[\u3400-\u4dbf\u4e00-\u9fff]+$/.test(chunk)) {
      // 中文没有空格，按二元组切分；单字查询仍然可用。
      if (chunk.length === 1) terms.push(chunk)
      else for (let i = 0; i + 1 < chunk.length; i += 1) terms.push(chunk.slice(i, i + 2))
    } else if (chunk.length >= 2) {
      terms.push(chunk)
    }
  }
  return [...new Set(terms)]
}

/** 标题命中权重高于正文：问「Rigidbody」时用户要的是那一页，不是提到它的十页。 */
const TITLE_WEIGHT = 6
const SUMMARY_WEIGHT = 2
const BODY_WEIGHT = 1

/** 在片段里取第一次命中的位置，前后各留一点上下文。 */
function makeSnippet(text, terms, limit = 160) {
  const lower = text.toLowerCase()
  let at = -1
  for (const term of terms) {
    const found = lower.indexOf(term)
    if (found >= 0 && (at < 0 || found < at)) at = found
  }
  if (at < 0) return truncate(text, limit)
  const start = Math.max(0, at - Math.floor(limit / 3))
  const slice = text.slice(start, start + limit).replace(/\s+/g, ' ').trim()
  return start > 0 ? `…${slice}` : slice
}

/**
 * 检索离线文档。
 *
 * 打分 = Σ 词项 (标题命中×6 + 摘要命中×2 + 正文命中×1) + 整串子串命中奖励。
 * 之所以还要加整串奖励：查 `Box Collider` 时，命中完整短语的页面必须排在使用
 * 两个词分头出现的页面之前，否则词频统计会把长页面顶上来。
 */
export function searchDocs(projectRoot, { query, limit } = {}) {
  const index = readIndexFile(projectRoot)
  if (!index) return []
  const raw = String(query ?? '').trim()
  if (raw === '') return []
  const terms = tokenizeQuery(raw)
  if (terms.length === 0) return []
  const phrase = raw.toLowerCase()
  const capped = Math.max(1, Math.min(Number(limit) || 20, 100))
  const hits = []
  for (const page of index.pages) {
    const title = String(page.title ?? '')
    const summary = String(page.summary ?? '')
    let body = ''
    try {
      body = readFileSync(safeJoin(projectRoot, page.path), 'utf8')
    } catch {
      body = ''
    }
    const haystackTitle = title.toLowerCase()
    const haystackSummary = summary.toLowerCase()
    const haystackBody = body.toLowerCase()
    let score = 0
    let matched = 0
    for (const term of terms) {
      let termScore = 0
      if (haystackTitle.includes(term)) termScore += TITLE_WEIGHT
      if (haystackSummary.includes(term)) termScore += SUMMARY_WEIGHT
      if (haystackBody.includes(term)) termScore += BODY_WEIGHT
      if (termScore > 0) matched += 1
      score += termScore
    }
    if (score === 0) continue
    // 命中全部词项优先，避免「只命中一个泛词」的长页挤掉真正的目标页。
    if (matched === terms.length) score += 4
    if (haystackTitle.includes(phrase)) score += 10
    hits.push({
      path: page.path,
      title,
      snippet: makeSnippet(body || summary || title, terms.length ? terms : [phrase]),
      score,
    })
  }
  // 分数相同时按路径排序，保证同一个查询两次调用给出同样的顺序。
  const list = hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  return list.slice(0, capped)
}

/**
 * 读一页 Markdown。
 *
 * `path` 是 `searchDocs` 返回的 `path`；也接受补上 `manual/` 前缀的写法（用户多半
 * 会照着 zip 里的名字写）。两条路都要过 `resolveDocPath`。
 */
export function readDoc(projectRoot, { path } = {}) {
  const failures = []
  const candidates = [path, join('manual', String(path ?? ''))]
  for (const candidate of candidates) {
    let target
    try {
      target = resolveDocPath(projectRoot, candidate)
    } catch (error) {
      failures.push(messageOf(error))
      continue
    }
    try {
      const markdown = readFileSync(target, 'utf8')
      const docPath = relative(resolve(docsRoot(projectRoot)), target).split(sep).join('/')
      const index = readIndexFile(projectRoot)
      const entry = index?.pages.find((page) => page.path === docPath)
      const heading = /^#\s+(.+)$/m.exec(markdown)
      return { path: docPath, title: entry?.title ?? heading?.[1]?.trim() ?? '', markdown }
    } catch (error) {
      failures.push(messageOf(error))
    }
  }
  throw new Error(`document not found: ${path}${failures.length ? ` (${failures[0]})` : ''}`)
}

/** 索引里的页面数量，供工具输出使用（避免调用方自己读 index.json）。 */
export function docsPageCount(projectRoot) {
  const index = readIndexFile(projectRoot)
  return index ? index.pages.length : 0
}

/**
 * 列出磁盘上实际存在的 Markdown 相对路径。
 *
 * 只给测试与排查用：正常的读取路径是索引，扫盘在 3 万文件时要几百毫秒。
 */
export function listDocFiles(projectRoot) {
  const root = resolve(docsRoot(projectRoot))
  const found = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith('.md')) found.push(relative(root, full).split(sep).join('/'))
    }
  }
  walk(root)
  return found.sort()
}

/** 已导入时返回 `{imported:true, …stats}`，否则 `{imported:false, reason}`；供工具层用。 */
export function docsAvailability(projectRoot) {
  const status = docsStatus(projectRoot)
  if (!status.imported) return { imported: false, reason: 'Unity 官方离线文档尚未导入（运行 action=import）' }
  let mtime = null
  try {
    mtime = statSync(docsRoot(projectRoot)).mtime.toISOString()
  } catch {
    // 目录在两次调用之间被删掉：状态如实降级，不让工具层因为一次 stat 抛错。
    return { imported: false, reason: 'Unity 官方离线文档目录不存在（重新运行 action=import）' }
  }
  return { imported: true, ...status, root: docsRoot(projectRoot), mtime }
}

export { INDEX_FILE as DOCS_INDEX_FILE, STAGING_DIR as DOCS_STAGING_DIR }

// 供工具层在「导入被取消」时判断状态：`AbortError` 是调用方取消，不是网络故障。
export function isAbortError(error) {
  return error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message))
}
