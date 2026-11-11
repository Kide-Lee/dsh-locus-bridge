// String-reference validation for Unity projects.
//
// Ports `Locus/src-tauri/src/tool/builtins/code_unity.rs::scan_project_refs`.
// These are references that compile fine and only fail at run time: a tag that
// is not in TagManager, a scene missing from Build Settings, a Resources path
// with no asset behind it, an Input axis that does not exist. A post-edit
// verification pass is exactly when they should surface, which is why upstream
// appends them to `code_diagnostics` file scope.
//
// Everything here reads plain text: `ProjectSettings/TagManager.asset`,
// `ProjectSettings/EditorBuildSettings.asset`,
// `ProjectSettings/InputManager.asset` and the `Resources` directory trees. No
// asset database is involved, which is what makes this portable to the bridge.
//
// Deliberately NOT ported: upstream's `[SerializeReference]` type check
// (`code_unity_managed::check_managed_reference_types`) needs the desktop
// asset_db to resolve which serialized objects point at a type. It is skipped,
// not silently approximated.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Unity's built-in tags, always available regardless of TagManager. */
const BUILTIN_TAGS = [
  'Untagged',
  'Respawn',
  'Finish',
  'EditorOnly',
  'MainCamera',
  'Player',
  'GameController',
]

const BUILTIN_LAYERS = new Map([
  [0, 'Default'],
  [1, 'TransparentFX'],
  [2, 'Ignore Raycast'],
  [4, 'Water'],
  [5, 'UI'],
])

/** Caps that match upstream (`MAX_SOURCE_FILES`, `MAX_PROBLEMS`). */
const MAX_SOURCE_FILES = 4000
const MAX_PROBLEMS = 40

/** Read `ProjectSettings/<name>` as text, or null. */
function readSetting(root, name) {
  try {
    return readFileSync(join(root, 'ProjectSettings', name), 'utf8')
  } catch {
    return null
  }
}

/** Tags (built-in + custom) and named layers from TagManager.asset. */
export function parseTagManager(root) {
  const text = readSetting(root, 'TagManager.asset')
  const tags = [...BUILTIN_TAGS]
  const layers = new Map(BUILTIN_LAYERS)
  if (text === null) return { tags, layers }

  // Unity writes YAML with two-space list indentation; a small state machine is
  // more reliable than a whole-file regex because the lists are positional.
  const lines = text.split(/\r?\n/)
  let section = null
  let layerIndex = 0
  for (const raw of lines) {
    const line = raw.replace(/\t/g, '  ')
    const trimmed = line.trim()
    if (trimmed === 'tags:') {
      section = 'tags'
      continue
    }
    if (trimmed === 'layers:') {
      section = 'layers'
      layerIndex = 0
      continue
    }
    // A new top-level key ends the current list.
    if (section && /^\s{0,3}[A-Za-z_]+:/.test(line) && !trimmed.startsWith('-')) {
      if (!trimmed.startsWith('- ')) section = null
    }
    if (!section) continue
    const item = /^-\s*(.*)$/.exec(trimmed)
    if (!item) continue
    const value = item[1].trim()
    if (section === 'tags') {
      if (value) tags.push(value)
      continue
    }
    if (value) layers.set(layerIndex, value)
    layerIndex += 1
  }
  return { tags, layers }
}

/** Enabled and disabled scene paths from EditorBuildSettings.asset. */
export function parseBuildSettings(root) {
  const text = readSetting(root, 'EditorBuildSettings.asset')
  const result = { enabled: [], disabled: [], hasSettings: false }
  if (text === null) return result
  result.hasSettings = true
  let inScenes = false
  let currentEnabled = false
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim()
    if (trimmed === 'm_Scenes:') {
      inScenes = true
      continue
    }
    if (trimmed === 'm_Scenes: []') {
      inScenes = false
      continue
    }
    if (!inScenes) continue
    if (!raw.startsWith(' ') && trimmed.includes(':')) {
      inScenes = false
      continue
    }
    const enabled = /^-\s*enabled:\s*(\S+)$/.exec(trimmed)
    if (enabled) {
      currentEnabled = enabled[1] === '1' || enabled[1] === 'true'
      continue
    }
    const path = /^path:\s*(.+)$/.exec(trimmed)
    if (path) {
      const value = path[1].trim()
      if (value) (currentEnabled ? result.enabled : result.disabled).push(value)
    }
  }
  return result
}

/** Axis names and button names from InputManager.asset. */
export function parseInputManager(root) {
  const text = readSetting(root, 'InputManager.asset')
  const axes = new Set()
  const buttons = new Set()
  if (text === null) return { axes, buttons, hasSettings: false }
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim()
    const axis = /^m_Name:\s*(.+)$/.exec(trimmed)
    if (axis) {
      const value = axis[1].trim()
      if (value) axes.add(value)
      continue
    }
    // `Input.GetButton` resolves against `m_Name` too, but buttons live in the
    // same list; keep the distinction for the message only.
    const button = /^positiveButton:\s*(.+)$/.exec(trimmed)
    if (button) {
      const value = button[1].trim()
      if (value) buttons.add(value)
    }
  }
  return { axes, buttons, hasSettings: true }
}

/** `activeInputHandler` from ProjectSettings.asset: 0 old, 1 new, 2 both. */
export function parseActiveInputHandler(root) {
  const text = readSetting(root, 'ProjectSettings.asset')
  if (text === null) return null
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*activeInputHandler:\s*(\d+)\s*$/.exec(raw)
    if (match) return Number(match[1])
  }
  return null
}

/**
 * Every asset path reachable through a `Resources` folder.
 *
 * `Resources.Load("Foo/Bar")` resolves to `<any>/Resources/Foo/Bar.<ext>`, so
 * the keys are the paths *after* `Resources/` with the extension stripped.
 */
export function collectResourcePaths(root) {
  const resources = new Map()
  const stack = []
  for (const base of ['Assets', 'Packages']) {
    const dir = join(root, base)
    if (existsSync(dir)) stack.push(dir)
  }
  let visited = 0
  while (stack.length > 0 && visited < 200_000) {
    const current = stack.pop()
    visited += 1
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) continue
        if (entry.name === 'Resources') {
          // Everything below a Resources folder is loadable.
          harvestResources(join(current, entry.name), '', resources, () => visited++)
          continue
        }
        stack.push(join(current, entry.name))
        continue
      }
    }
  }
  return resources
}

function harvestResources(dir, prefix, out, tick) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    tick?.()
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    const key = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      harvestResources(full, key, out, tick)
      continue
    }
    // Unity strips the extension for Resources.Load; `.meta` files are not assets.
    if (entry.name.endsWith('.meta')) continue
    const stem = key.replace(/\.[^.]+$/, '')
    if (!out.has(stem)) out.set(stem, full)
  }
}

/** Closest known value, for an "did you mean" hint. */
export function closestMatch(candidates, value) {
  const target = String(value).toLowerCase()
  let best = null
  let bestDistance = Infinity
  for (const candidate of candidates) {
    const distance = editDistance(target, String(candidate).toLowerCase())
    if (distance < bestDistance) {
      bestDistance = distance
      best = candidate
    }
  }
  const limit = Math.max(2, Math.floor(String(value).length / 3) + 1)
  return best !== null && bestDistance <= limit ? best : null
}

function editDistance(a, b) {
  if (a === b) return 0
  const previous = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j += 1) previous[j] = j
  for (let i = 1; i <= a.length; i += 1) {
    let lastDiagonal = previous[0]
    previous[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const saved = previous[j]
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        lastDiagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      lastDiagonal = saved
    }
  }
  return previous[b.length]
}

const TAG_PATTERNS = [
  /(?:CompareTag|FindWithTag|FindGameObjectsWithTag)\s*\(\s*"([^"]*)"/g,
  /\.tag\s*[!=]=\s*"([^"]*)"/g,
  /\.tag\s*=\s*"([^"]*)"/g,
]
const LAYER_PATTERN = /NameToLayer\s*\(\s*"([^"]*)"/g
const SCENE_PATTERN = /(?:LoadScene|LoadSceneAsync|UnloadSceneAsync|GetSceneByName)\s*\(\s*"([^"]*)"/g
const SCENE_INDEX_PATTERN = /(?:LoadScene|LoadSceneAsync)\s*\(\s*(\d+)\s*[,)]/g
const RESOURCES_PATTERN = /Resources\.(?:Load|LoadAll|LoadAsync)(?:<[^>(]*>)?\s*\(\s*"([^"]*)"/g
const INPUT_PATTERN = /Input\.(?:GetAxis|GetAxisRaw|GetButton|GetButtonDown|GetButtonUp)\s*\(\s*"([^"]*)"/g

function sceneStem(path) {
  const name = String(path).replaceAll('\\', '/').split('/').pop() ?? ''
  return name.replace(/\.unity$/i, '')
}

function* sourceFiles(root, targetFile) {
  if (targetFile) {
    yield targetFile
    return
  }
  let count = 0
  const stack = [join(root, 'Assets')]
  while (stack.length > 0 && count < MAX_SOURCE_FILES) {
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) stack.push(join(current, entry.name))
        continue
      }
      if (!entry.name.toLowerCase().endsWith('.cs')) continue
      count += 1
      yield join(current, entry.name)
      if (count >= MAX_SOURCE_FILES) return
    }
  }
}

/**
 * Scan for string references that compile but fail at run time.
 *
 * @param {string} root      Unity project root
 * @param {string|null} targetFile  one file, or null for every script under Assets/
 * @returns {{ filesChecked: number, filesCapped: boolean, counts: object, problems: Array }}
 */
export function scanProjectRefs(root, targetFile = null) {
  const { tags, layers } = parseTagManager(root)
  const build = parseBuildSettings(root)
  const input = parseInputManager(root)
  const activeInputHandler = parseActiveInputHandler(root)
  const resources = collectResourcePaths(root)

  const layerNames = [...new Set(layers.values())]
  const sceneStems = {
    enabled: build.enabled.map(sceneStem),
    disabled: build.disabled.map(sceneStem),
  }
  const counts = { tags: 0, layers: 0, scenes: 0, resources: 0, axes: 0 }
  const problems = []
  let filesChecked = 0
  let filesCapped = false

  const push = (path, line, message) => {
    if (problems.length >= MAX_PROBLEMS) return
    problems.push({ path, line, message })
  }

  for (const file of sourceFiles(root, targetFile)) {
    if (filesChecked >= MAX_SOURCE_FILES) {
      filesCapped = true
      break
    }
    filesChecked += 1
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const display = relative(root, file).replaceAll('\\', '/')
    let inBlockComment = false
    const lines = text.split(/\r?\n/)
    for (const [index, rawLine] of lines.entries()) {
      const lineNo = index + 1
      let line = rawLine
      if (inBlockComment) {
        const end = line.indexOf('*/')
        if (end < 0) continue
        line = line.slice(end + 2)
        inBlockComment = false
      }
      // Strip block comments, including one that opens and closes on this line.
      // Upstream only handles the multi-line case, which lets
      // `/* CompareTag("Missing") */` through as if it were live code.
      for (;;) {
        const start = line.indexOf('/*')
        if (start < 0) break
        const close = line.indexOf('*/', start + 2)
        if (close < 0) {
          inBlockComment = true
          line = line.slice(0, start)
          break
        }
        line = line.slice(0, start) + line.slice(close + 2)
      }
      const trimmed = line.trimStart()
      if (trimmed.startsWith('//')) continue
      // Most patterns need a string literal, but `LoadScene(9)` does not, so the
      // line is only skipped when it can match neither a quote nor a scene index.
      if (!line.includes('"') && !/LoadScene(?:Async)?\s*\(\s*\d/.test(line)) continue

      for (const pattern of TAG_PATTERNS) {
        for (const match of line.matchAll(pattern)) {
          counts.tags += 1
          const value = match[1]
          if (tags.includes(value)) continue
          const hint = closestMatch(tags, value)
          push(display, lineNo, `unknown tag "${value}"${hint ? ` (did you mean "${hint}"?)` : ''}`)
        }
      }
      for (const match of line.matchAll(LAYER_PATTERN)) {
        counts.layers += 1
        const value = match[1]
        if (layerNames.includes(value)) continue
        const hint = closestMatch(layerNames, value)
        push(display, lineNo, `unknown layer "${value}"${hint ? ` (did you mean "${hint}"?)` : ''}`)
      }
      for (const match of line.matchAll(SCENE_PATTERN)) {
        counts.scenes += 1
        const value = match[1]
        const stem = sceneStem(value)
        if (!build.hasSettings) continue
        if (sceneStems.enabled.includes(stem)) continue
        if (sceneStems.disabled.includes(stem)) {
          push(display, lineNo, `scene "${value}" is in Build Settings but disabled`)
          continue
        }
        push(display, lineNo, `scene "${value}" is not in Build Settings`)
      }
      for (const match of line.matchAll(SCENE_INDEX_PATTERN)) {
        counts.scenes += 1
        const index = Number(match[1])
        if (!build.hasSettings) continue
        if (index >= build.enabled.length) {
          push(
            display,
            lineNo,
            `scene index ${index} is out of range (${build.enabled.length} enabled scene(s))`,
          )
        }
      }
      for (const match of line.matchAll(RESOURCES_PATTERN)) {
        counts.resources += 1
        const value = match[1]
        const key = value.replaceAll('\\', '/')
        if (resources.has(key)) continue
        push(display, lineNo, `Resources path "${value}" has no asset`)
      }
      for (const match of line.matchAll(INPUT_PATTERN)) {
        counts.axes += 1
        const value = match[1]
        // Axes exist in the legacy Input Manager only; with the new Input System
        // active these names resolve through a different system entirely.
        if (!input.hasSettings) continue
        if (activeInputHandler === 1) continue
        if (input.axes.has(value)) continue
        push(display, lineNo, `unknown Input axis/button "${value}"`)
      }
    }
  }

  return { filesChecked, filesCapped, counts, problems, hasBuildSettings: build.hasSettings }
}

/** Render the section appended to `code_diagnostics` file scope. */
export function formatProjectRefsSection(report, maxProblems = 40) {
  const { counts, problems } = report
  const total =
    counts.tags + counts.layers + counts.scenes + counts.resources + counts.axes
  if (total === 0) return ''
  const lines = []
  if (problems.length === 0) {
    lines.push(
      `\nProject string references: ${total} checked (${counts.tags} tag, ${counts.layers} layer, ` +
        `${counts.scenes} scene, ${counts.resources} Resources, ${counts.axes} input) — all resolve.`,
    )
    return lines.join('\n')
  }
  lines.push(`\nProject string references with problems (${problems.length}):`)
  for (const problem of problems.slice(0, maxProblems)) {
    lines.push(`  ${problem.path}:${problem.line}  ${problem.message}`)
  }
  if (problems.length > maxProblems) {
    lines.push(`  … ${problems.length - maxProblems} more`)
  }
  return lines.join('\n')
}

/** Whether a path is a directory (the tool entry point guards on this). */
export function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}