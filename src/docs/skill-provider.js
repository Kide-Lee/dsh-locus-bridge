// 把「已导入的 Unity 官方离线文档」暴露成一个 DSH skill。
//
// 为什么是 skill 而不是又一个工具：模型需要知道「这份工程对应的 Unity 版本有离线
// 文档可以参考」，这件事发生在*收集目录*的时候；而真正取内容发生在读文档的时候。
// skill 契约（`list()` 给目录、`get()` 给正文）正好就是这两步，于是模型不需要被
// 额外告知去查表——只要目录里有它，模型就会在遇到 Unity API 问题时想到它。
//
// 与 `src/skills/provider.js` 的区别只在数据来源：
//
//   * 那边是随插件发布的五个 Markdown 文件，跟着包走、永远可用；
//   * 这边是**用户主动导入**到 `<工程>/Library/Locus/unity-docs/` 的官方文档，
//     每台机器、每个工程都可能没有。所以 `list()` 的第一件事是问 `docsStatus`
//     是否已导入：没导入就返回 `[]`（一个完整的空观测），模型看到的目录跟没有
//     这个 provider 时完全一样。
//
// 目录里只放一条 skill，而不是按文档页各放一条：三万页会让目录爆炸，也会让
// 命名空间被 `transform-position` 这类名字占满。真正的入口是 `locator` 告诉模型
// 「用 unity_offline_docs 工具检索」，正文里给出足够的上手信息（本地路径、
// action 用法），不把整份文档塞进 prompt。

import { dirname, resolve } from 'node:path'

import { docsPageCount, docsRoot, docsStatus, searchDocs } from './unity-docs.js'

/** 与 `src/skills/provider.js` 同一个注册表命名空间，DSH 侧看到的是一个 provider。 */
export const PROVIDER_NAME = 'dsh-locus-bridge'

/** 与内置领域技能同档（runtime 250）：项目内的同名技能仍然可以覆盖它。 */
export const SKILL_RANK = 250

/** 这个 provider 唯一暴露的 skill 名。 */
export const OFFLINE_DOCS_SKILL_NAME = 'unity-offline-docs'

/** 未导入时给工具层复用的一句话。 */
export const OFFLINE_DOCS_MISSING_REASON = 'Unity 官方离线文档尚未导入，先运行 unity_offline_docs action="import"。'

/**
 * `list()` 在每次收集目录时都会跑，而 `docsStatus` 要读一次 `index.json`
 * （3 万页的话几十毫秒）。缓存 30 秒：导入完成是用户可见的少数事件，等半分钟
 * 才出现在目录里可以接受，而让每次目录收集都读盘的代价不可接受。
 */
const STATUS_CACHE_MS = 30_000

/** `cwd → {at, status}`；测试用 `__resetOfflineDocsSkillCacheForTest` 清空。 */
const statusCache = new Map()

/** Drop every cached status (tests only: a fixture imports docs between calls). */
export function __resetOfflineDocsSkillCacheForTest() {
  statusCache.clear()
}

/**
 * 工程根 → 文档状态，带缓存。
 *
 * 失败一律按「未导入」处理：读不到 `index.json` 就是不能用，不需要区分「没导入」
 * 和「导入坏了」——对模型来说两者都是「没有文档可查」。
 */
function cachedStatus(projectRoot, { now = Date.now() } = {}) {
  const key = resolve(String(projectRoot))
  const hit = statusCache.get(key)
  if (hit !== undefined && now - hit.at < STATUS_CACHE_MS) return hit.status
  let status
  try {
    status = docsStatus(key)
  } catch {
    status = { imported: false, version: null, locale: null, files: 0, updatedAt: null }
  }
  statusCache.set(key, { at: now, status })
  return status
}

/**
 * 从 cwd 往上找**最近的**、已导入文档的 Unity 工程。
 *
 * 「最近的」是刻意的：会话可能开在 `Assets/Scripts/` 里，也可能开在工程的父目录；
 * 往上走并把第一个命中的工程当作答案，跟 `src/args.js` 里工程解析的方向一致。
 * 走到文件系统根就停，最多看 16 层，避免在符号链接环里打转。
 */
export function findDocsProject(cwd, { now = Date.now() } = {}) {
  if (typeof cwd !== 'string' || cwd.trim() === '') return null
  let current = resolve(cwd)
  for (let depth = 0; depth < 16; depth += 1) {
    const status = cachedStatus(current, { now })
    if (status.imported) return { projectRoot: current, status }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

/**
 * 目录条目。
 *
 * `description` 是模型唯一会读到的一行，必须同时说清两件事：**是什么**（离线、
 * 哪个版本）与**怎么用**（检索而不是猜）。长度压在一句话内。
 */
function candidateFor(status) {
  const version = status.version ?? 'unknown'
  const locale = status.locale === 'en' ? 'English' : 'Chinese'
  const pages = typeof status.files === 'number' ? status.files : 0
  return {
    name: OFFLINE_DOCS_SKILL_NAME,
    description: `Search ${pages} pages of the Unity ${version} official offline documentation (${locale}) with the unity_offline_docs tool before answering Unity API questions.`,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'runtime',
    provider: PROVIDER_NAME,
    rank: SKILL_RANK,
    locator: OFFLINE_DOCS_SKILL_NAME,
  }
}

/**
 * skill 正文。
 *
 * 正文是给模型的操作说明而不是文档本身：告诉它文档在哪、怎么检索、以及**不要**
 * 把整页读进上下文。路径用相对工程的写法，同一个工程换到别的机器上时正文仍然成立。
 */
function skillContent(status, projectRoot) {
  const version = status.version ?? 'unknown'
  const locale = status.locale === 'zh-cn' ? 'zh-cn（中文）' : 'en（English）'
  const files = typeof status.files === 'number' ? status.files : 0
  const updated = status.updatedAt ? `，导入于 ${status.updatedAt}` : ''
  return [
    '---',
    `name: ${OFFLINE_DOCS_SKILL_NAME}`,
    `description: Unity ${version} 官方离线手册（${locale}，${files} 页）已导入本工程，可用 unity_offline_docs 检索。`,
    '---',
    '',
    `# Unity ${version} 官方离线文档`,
    '',
    `本工程已导入 Unity ${version} 的官方离线文档（${locale}，共 ${files} 页${updated}），`,
    `存放在 \`${docsRoot(projectRoot)}\` 下，每页是一份 Markdown。`,
    '',
    '## 什么时候用它',
    '',
    '- 用户问到某个 Unity 组件、属性、方法的含义或用法，而当前工程里没有对应源码可读；',
    '- 需要确认某个 API 在当前 Unity 版本里存在、签名如何、行为怎样；',
    '- 需要写脚本要用到不熟悉的 `UnityEngine` / `UnityEditor` 类型。',
    '',
    '## 怎么用',
    '',
    '用 `unity_offline_docs` 工具，按这个顺序：',
    '',
    '1. `action: "search"`，`query` 用英文类名或中文关键词（例如 `Rigidbody2D`、`碰撞`）。',
    '   一次给 2–3 个候选词比给一整句自然语言更容易命中。',
    '2. 看返回的 `title` 与 `snippet` 选一页，`action: "read"` + `path` 读全文。',
    '3. 只读摘要能回答的问题不要读全文——一页正文可能上千 tokens。',
    '',
    '`action: "status"` 可以确认已导入的版本与页数；`action: "import"` 只在文档缺失或',
    '换 Unity 版本后才需要，它会下载约 350 MB，不要顺手调用。',
    '',
    '## 注意',
    '',
    '- 离线文档对应的是**工程当前**的 Unity 版本；升级编辑器后需要重新导入。',
    '- 文档里的示例代码是片段，不要假设仓库里存在同名文件。',
    '- 引用时给出页面标题，而不是本地路径——路径对本机以外的人没有意义。',
    '',
  ].join('\n')
}

/**
 * 创建 provider。
 *
 * `enabled` 是设置文档里的总开关：`false` 时无论文档是否导入都不登记，`null`
 * 表示「按文档状态决定」（测试与没有设置文档的调用方用这个）。
 *
 * `get()` 用 candidate 里带的 `projectRoot` 精确回访——`list()` 已经在条目里放好
 * 了它，所以这里不需要「记住最近见过的工程」这种跨调用的可变状态。
 */
export function createOfflineDocsSkillProvider({ enabled = null, now = Date.now } = {}) {
  const clock = () => now()
  return {
    name: PROVIDER_NAME,
    async list(options) {
      if (enabled === false) return []
      const found = findDocsProject(options?.cwd, { now: clock() })
      if (!found) return []
      const entry = candidateFor(found.status)
      // locator 保持稳定（它就是 skill 名），工程根放在旁边，供 get() 回访。
      return [{ ...entry, projectRoot: found.projectRoot }]
    },
    async get(candidate) {
      if (enabled === false) return undefined
      const locator = typeof candidate?.locator === 'string' ? candidate.locator : ''
      if (locator !== OFFLINE_DOCS_SKILL_NAME) return undefined
      const projectRoot = typeof candidate?.projectRoot === 'string' ? candidate.projectRoot : ''
      if (projectRoot === '') return undefined
      const status = cachedStatus(projectRoot, { now: clock() })
      if (!status.imported) return undefined
      const entry = candidateFor(status)
      return {
        name: entry.name,
        description: entry.description,
        invocation: entry.invocation,
        source: entry.source,
        provider: entry.provider,
        content: skillContent(status, projectRoot),
        // 文档是磁盘上的文件树，但按路径取正文由 `unity_offline_docs` 工具负责；
        // provider 不暴露一个可能被越界访问的资源根。
        resourceBase: {
          kind: 'opaque',
          description: 'Use the unity_offline_docs tool (action "read") to retrieve a page; paths are resolved inside Library/Locus/unity-docs.',
        },
      }
    },
  }
}

/** 工具层用的便捷函数：一次调用同时拿到状态与检索结果，免得它自己拼两条路径。 */
export function lookupDocs(projectRoot, { query, limit } = {}) {
  const status = cachedStatus(projectRoot)
  if (!status.imported) return { imported: false, reason: OFFLINE_DOCS_MISSING_REASON, results: [] }
  const results = searchDocs(projectRoot, { query, limit })
  return { imported: true, status, pages: docsPageCount(projectRoot), results }
}