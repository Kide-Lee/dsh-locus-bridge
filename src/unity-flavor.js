// Unity 还是团结引擎（Tuanjie）——同一个项目目录结构，两套不同的编辑器。
//
// 团结引擎是 Unity 中国版的发行版：工程格式、`ProjectSettings/ProjectVersion.txt`
// 和编辑器安装布局都沿用 Unity，只有版本号的发布通道后缀不同（`2022.3.62t10`
// 的 `t` 而不是 `f`），可执行文件名是 `Tuanjie.exe` 而不是 `Unity.exe`。
//
// 移植自上游 Locus 的 `src-tauri/src/unity_bridge/flavor.rs`，但不包含它的运行时
// 探测部分：上游靠 Win32 窗口类名和进程映像名判断"当前运行的是哪个编辑器"，那套
// 逻辑在本插件里既用不上（本插件没有常驻的桌面进程去枚举窗口），也不该用（Linux/
// macOS 上没有 Win32）。这里只保留纯数据表加文件读取，所以每个函数都是可测的：
// 输入一个版本号或一个安装目录，输出一个结论，不碰进程。
//
// ## 为什么版本号后缀就够了
//
// 上游的 `is_tuanjie_version` 就是唯一可靠的信号：团结引擎的版本号带 `t`，Unity
// 带 `f` 或 `b`。文件名和路径都不可靠——用户可以把安装目录改名，但版本号是编辑器
// 自己写进工程的，改不动。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'

/** 两个发行版，顺序固定（Unity 在前；新增发行版只能追加）。 */
export const FLAVORS = Object.freeze(['unity', 'tuanjie'])

/**
 * 每个发行版的外在特征，逐项对应上游 `EditorFlavor` 的方法。
 *
 * `windowTitleToken` 与 `enginePdbNames` 只做数据保留：本插件不枚举窗口、也不
 * 解析 PDB，但版本识别与安装扫描之外，将来要在编辑器日志里认发行版时会用到它们，
 * 而删掉它们就等于把这个知识重新埋回上游源码里。
 */
const FLAVOR_TABLE = Object.freeze({
  unity: Object.freeze({
    flavor: 'unity',
    label: 'Unity',
    editorExeFileName: 'Unity.exe',
    processImageName: 'unity.exe',
    engineModuleDll: 'Unity.dll',
    enginePdbName: 'unity_x64.pdb',
    windowTitleToken: 'Unity',
  }),
  tuanjie: Object.freeze({
    flavor: 'tuanjie',
    label: 'Tuanjie',
    editorExeFileName: 'Tuanjie.exe',
    processImageName: 'tuanjie.exe',
    engineModuleDll: 'Tuanjie.dll',
    enginePdbName: 'Tuanjie_x64.pdb',
    windowTitleToken: 'Tuanjie',
  }),
})

/** 一个发行版的外在特征表；未知发行版回落到 unity。 */
export function flavorProfile(flavor) {
  return FLAVOR_TABLE[flavor] ?? FLAVOR_TABLE.unity
}

/**
 * 版本号是否属于团结引擎：前面是数字、最后一个字符是 `t`/`T`、后面还是数字。
 *
 * 逐字节照搬上游 `is_tuanjie_version`（含边界条件）：`2022.3.62t10` 是，
 * `2022.3.47f1` 不是，空串不是。之所以不用正则一次性写完，是为了让"数字-`t`-
 * 数字"这个形状在代码里和上游一致到可以直接对照 review。
 */
export function isTuanjieVersion(version) {
  // 上游对输入做了 trim；不 trim 的话 `'2022.3.62t10 '` 这种带尾空格的读法会
  // 落到"最后一个数字之后还有空格"的分支上，结果随文件格式而变。
  const text = String(version ?? '').trim()
  for (let index = 1; index < text.length - 1; index += 1) {
    const ch = text[index]
    if ((ch === 't' || ch === 'T') && isAsciiDigit(text[index - 1]) && isAsciiDigit(text[index + 1])) {
      return true
    }
  }
  return false
}

function isAsciiDigit(ch) {
  return ch !== undefined && ch >= '0' && ch <= '9'
}

/**
 * 读一个工程的 Unity 版本和发行版。
 *
 * 只读 `ProjectSettings/ProjectVersion.txt`（编辑器自己写的权威来源）。读不到就
 * 返回 `flavor: null`，而不是猜 unity：一个没有版本文件的目录不一定不是 Unity
 * 工程，强行给个默认值会让上层把"读不出来"和"确定是 Unity"混为一谈。
 */
export function detectFlavor(projectRoot, { readFile = readFileSync } = {}) {
  const root = String(projectRoot ?? '')
  if (!root) throw new Error('detectFlavor needs a project root.')

  const versionFile = join(root, 'ProjectSettings', 'ProjectVersion.txt')
  let text
  try {
    text = readFile(versionFile, 'utf8')
  } catch {
    return { flavor: null, version: null, versionFile }
  }

  const version = parseProjectVersion(text)
  return {
    flavor: version === null ? null : isTuanjieVersion(version) ? 'tuanjie' : 'unity',
    version,
    versionFile,
  }
}

/**
 * 从 `ProjectVersion.txt` 里取 `m_EditorVersion:`。
 *
 * 文件里还有 `m_EditorVersionWithRevision:`（带 changeset），不要它：版本号本身
 * 已经足够判断发行版，而 revision 在不同发行版之间格式相同。
 */
export function parseProjectVersion(text) {
  const match = /^\s*m_EditorVersion:\s*(\S+)\s*$/m.exec(String(text ?? ''))
  return match === null ? null : match[1]
}

/**
 * 一个发行版的编辑器可执行文件候选路径，相对于编辑器安装根目录。
 *
 * Unity Hub 的安装布局是 `<编辑根>/<Editor 或 Tuanjie>/Tuanjie.exe`；Linux/macOS
 * 没有 Hub 的固定布局（AppImage、自定义安装、Steam 版都有），所以显式返回空列表
 * ——"不知道"比编一个路径出来诚实，调用方据此跳过而不是去试一个不存在的文件。
 */
export function editorExecutableCandidates(flavor, { platform = process.platform } = {}) {
  const profile = flavorProfile(flavor)
  if (platform === 'win32') {
    return [
      join('Editor', profile.editorExeFileName),
      join(profile.label, profile.editorExeFileName),
      profile.editorExeFileName,
    ]
  }
  if (platform === 'darwin') {
    return [
      join('Unity.app', 'Contents', 'MacOS', 'Unity'),
      join(`${profile.label}.app`, 'Contents', 'MacOS', profile.label),
    ]
  }
  return []
}

/**
 * 扫描本机安装的编辑器。
 *
 * 数据来源是 Unity Hub 的 `editors.json`（Hub 记录自己装过什么）；只有 Hub 记录
 * 存在且目录里的编辑器可执行文件也在，才算"已安装"——Hub 卸载后残留的记录不算。
 * 读不到 Hub 配置时返回空列表，不抛异常：没有 Hub 的人（手动装的、CI 镜像）只是
 * 拿不到候选路径，不该让整个功能报错。
 */
export function scanInstalledEditors({ platform = process.platform, homeDir = homedir(), readFile = readFileSync, exists = existsSync } = {}) {
  const editors = []
  for (const file of hubConfigCandidates({ platform, homeDir })) {
    let parsed
    try {
      parsed = JSON.parse(readFile(file, 'utf8'))
    } catch {
      continue
    }
    collectHubEditors(parsed, { platform, exists, editors })
  }
  // 同一个编辑器可能被两个配置来源都记了一次（Windows 上既有 AppData 也有旧
  // ProgramData 路径），按路径去重后按发行版排序，输出才稳定。
  return dedupeEditors(editors)
}

function hubConfigCandidates({ platform, homeDir }) {
  const files = []
  if (platform === 'win32') {
    if (homeDir) files.push(join(homeDir, 'AppData', 'Roaming', 'UnityHub', 'editors.json'))
    files.push(join('C:', 'ProgramData', 'Unity', 'config', 'editors.json'))
  } else if (platform === 'darwin') {
    if (homeDir) files.push(join(homeDir, 'Library', 'Application Support', 'UnityHub', 'editors.json'))
  } else {
    if (homeDir) {
      files.push(join(homeDir, '.config', 'UnityHub', 'editors.json'))
      files.push(join(homeDir, '.config', 'unityhub', 'editors.json'))
    }
  }
  return files
}

function collectHubEditors(parsed, { platform, exists, editors }) {
  // Hub 的格式随版本变过：顶层有 `list` 数组，也有平铺成对象的情况。两种都收，
  // 认不出形状就直接跳过，不猜。
  const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.list) ? parsed.list : null
  if (records === null) return

  for (const record of records) {
    const version = typeof record === 'string' ? null : record?.version
    const location = typeof record === 'string' ? record : record?.location
    if (typeof location !== 'string' || location.length === 0) continue

    const resolvedVersion = typeof version === 'string' && version.length > 0 ? version : versionFromPath(location)
    const flavor = resolvedVersion === null ? null : isTuanjieVersion(resolvedVersion) ? 'tuanjie' : 'unity'
    if (flavor === null) continue

    const executable = firstExistingEditorExecutable(location, flavor, { platform, exists })
    if (executable === null) continue
    editors.push({ flavor, version: resolvedVersion, path: executable })
  }
}

function firstExistingEditorExecutable(location, flavor, { platform, exists }) {
  for (const relative of editorExecutableCandidates(flavor, { platform })) {
    const candidate = join(location, relative)
    if (exists(candidate)) return candidate
  }
  // macOS 的 .app 是目录，exe 在里面；Linux 没有固定布局，只把安装根目录报上去。
  if (platform === 'linux') return exists(location) ? location : null
  return null
}

function versionFromPath(location) {
  const match = /(\d+\.\d+\.\d+[a-z]\d+)/i.exec(basename(location))
  return match === null ? null : match[1]
}

function dedupeEditors(editors) {
  const byPath = new Map()
  for (const editor of editors) {
    if (!byPath.has(editor.path)) byPath.set(editor.path, editor)
  }
  return [...byPath.values()].sort((left, right) => {
    if (left.flavor !== right.flavor) return FLAVORS.indexOf(left.flavor) - FLAVORS.indexOf(right.flavor)
    return String(left.version).localeCompare(String(right.version), 'en', { numeric: true })
  })
}

/**
 * 从编辑器标题判断发行版（`Game - SampleScene - Windows - Unity 2022.3.47f1`）。
 *
 * 上游靠标题里的 `Editor` 加发行版词来认窗口。这里保留同样的判定，但明确标注
 * 适用性：标题只在桌面平台有意义，非 Windows 直接返回 `{supported:false}`，
 * 而不是返回一个看起来像结论的 false。调用方据此决定是否退回版本号判断。
 */
export function detectFlavorFromEditorTitle(title, { platform = process.platform } = {}) {
  if (platform !== 'win32') {
    return { supported: false, flavor: null, reason: '编辑器标题匹配只在 Windows 上可用。' }
  }
  const text = String(title ?? '')
  // 上游 `is_editor_window_title` 要求标题同时含 `Editor` 和某个发行版词；这里
  // 保留同一个判定，然后把"是编辑器窗口"细化到具体发行版。没有 `Editor` 的窗口
  // 不可能是编辑器主窗口，直接排除。
  if (!text.includes('Editor')) return { supported: true, flavor: null, reason: null }
  for (const flavor of FLAVORS) {
    if (text.includes(flavorProfile(flavor).windowTitleToken)) {
      return { supported: true, flavor, reason: null }
    }
  }
  return { supported: true, flavor: null, reason: null }
}

/** 上游 `is_editor_window_title`：标题是否像一个已知发行版的编辑器主窗口。 */
export function isEditorWindowTitle(title) {
  const text = String(title ?? '')
  return text.includes('Editor') && FLAVORS.some((flavor) => text.includes(flavorProfile(flavor).windowTitleToken))
}

/** 路径是否以某个发行版的编辑器可执行文件名结尾（两端都归一化后比较）。 */
export function pathEndsWithEditorExe(normalizedLowerPath, flavor) {
  const suffix = `\\${flavorProfile(flavor).processImageName}`
  const text = String(normalizedLowerPath ?? '').replaceAll('/', '\\').toLowerCase()
  return text.endsWith(suffix)
}

/** 工程目录里是否有编辑器写的版本文件——判断"是不是 Unity 工程"的补充信号。 */
export function hasProjectVersionFile(projectRoot, { exists = existsSync } = {}) {
  const root = String(projectRoot ?? '')
  if (!root) return false
  try {
    return exists(join(root, 'ProjectSettings', 'ProjectVersion.txt')) && statSync(join(root, 'ProjectSettings')).isDirectory()
  } catch {
    return false
  }
}

/** 目录里的子目录名；读不了就当空目录。 */
export function listDirectoryNames(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}