// A project-wide asset index, so the asset tools answer questions about assets
// that are not open in the Editor.
//
// The broker's `asset_api` only knows what the Editor's own AssetDatabase has
// loaded (`src/asset-graph.js` uses it for open scenes). "Where is this GUID
// used", "which prefabs reference this material", "what is broken" are
// questions about the whole project, and a `.meta` GUID is on disk whether or
// not the Editor is running. So this module walks `Assets/` and `Packages/`,
// reads each sidecar `.meta`, and keeps the result cached between calls.
//
// Upstream reference (`Locus/src-tauri/src/asset_db/`): GUIDs are the 32 hex
// characters of the `guid:` line in a `.meta` *top level*, path keys use forward
// slashes, `.meta` files are not assets, dotfiles and `~`-suffixed directories
// are skipped (that is how Unity itself marks them), and a GUID that appears
// twice is a real project defect rather than a scan error — reporting it is the
// point of `broken.duplicateGuids`.
//
// Findings live in two places: an in-memory map for the current process, and the
// SQLite index at `Library/Locus/asset-index.db` (`asset-index.js`), which
// survives restarts and is refreshed incrementally — only files whose size or
// mtime moved are re-read. The database is the durable record; the in-memory map
// only spares a rescan inside one process.

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { createRequire } from 'node:module'

import { installBuiltinLoader } from './asset-index.js'
import { refreshIndex } from './asset-index-sync.js'
import { readYamlFile, queryDocument } from './yaml-lite.js'

// `node:sqlite` is a CommonJS builtin, and the index API is synchronous, so the
// loader is handed over once here instead of awaiting an import at every scan.
const requireBuiltin = createRequire(import.meta.url)
installBuiltinLoader((specifier) => requireBuiltin(specifier))

/** Hard ceiling on files in one scan; past it the answer is marked partial. */
export const ASSET_DB_MAX_FILES = 200_000

/**
 * Directory names this walk refuses to enter.
 *
 * `src/args.js` keeps the same list for project *searching*, but does not export
 * it and this line may not edit that file, so the list is repeated here. The
 * entries are either Unity-generated (`Library/`, `Temp/`, `obj/`, `Logs/`,
 * `UserSettings/`, `Builds/`) or version-control noise; none can hold a project
 * asset, and a `Library/` alone is tens of thousands of files.
 */
const SKIP_DIR_NAMES = new Set([
  'node_modules',
  'Library',
  'Temp',
  'Obj',
  'obj',
  'Build',
  'Builds',
  'Logs',
  'UserSettings',
  'MemoryCaptures',
  'Recordings',
  '.git',
  '.svn',
  '.hg',
  '.vs',
  '.idea',
  '.vscode',
  'target',
  'dist',
])

/** Roots that hold assets; `ProjectSettings/` is read for assets but not walked. */
const ASSET_ROOTS = ['Assets', 'Packages']

/** Asset type names, keyed by extension. Mirrors upstream's `AssetKind::camel_str`. */
const TYPE_BY_EXT = Object.freeze({
  unity: 'scene',
  prefab: 'prefab',
  asset: 'genericAsset',
  mat: 'material',
  anim: 'animation',
  controller: 'animatorController',
  overridecontroller: 'otherYaml',
  mixer: 'otherYaml',
  physicmaterial: 'otherYaml',
  preset: 'otherYaml',
  cs: 'script',
  asmdef: 'otherFile',
  asmref: 'otherFile',
  png: 'texture',
  jpg: 'texture',
  jpeg: 'texture',
  tga: 'texture',
  psd: 'texture',
  tif: 'texture',
  tiff: 'texture',
  bmp: 'texture',
  gif: 'texture',
  exr: 'texture',
  hdr: 'texture',
  wav: 'audio',
  mp3: 'audio',
  ogg: 'audio',
  aif: 'audio',
  aiff: 'audio',
  shader: 'shader',
  cginc: 'shader',
  hlsl: 'shader',
  glsl: 'shader',
  compute: 'shader',
  shadergraph: 'shader',
  shadersubgraph: 'shader',
  fbx: 'model',
  obj: 'model',
  blend: 'model',
  dae: 'model',
  '3ds': 'model',
  max: 'model',
  glb: 'model',
  gltf: 'model',
  txt: 'otherFile',
  md: 'otherFile',
  json: 'otherFile',
  xml: 'otherFile',
  csv: 'otherFile',
  html: 'otherFile',
  htm: 'otherFile',
  yaml: 'otherFile',
  yml: 'otherFile',
  fnt: 'otherFile',
  uss: 'otherFile',
  tss: 'otherFile',
  uxml: 'otherFile',
  bytes: 'otherFile',
})

/** Extensions that hold Unity YAML (the only files `memberBindings` reads). */
const YAML_EXTENSIONS = new Set(['.unity', '.prefab', '.asset', '.mat', '.anim', '.controller', '.overridecontroller', '.mixer', '.physicmaterial'])

/** Extensions treated as `metaOnly` (a `.meta` with no visible importer match). */
const DEFAULT_LIMIT = 20
const SEARCH_LIMIT_MAX = 200

/** One scan per process, keyed by absolute project root. */
const caches = new Map()

/**
 * Scan the project and return its asset index.
 *
 * The result is cached: a second call within a few seconds returns the same
 * object without touching the filesystem, which matters because the model tends
 * to ask several follow-up questions about one project. `rescan: true` forces a
 * fresh walk.
 *
 * @param {string} projectRoot - absolute Unity project root.
 * @param {{rescan?: boolean, budgetMs?: number}} [options]
 * @returns {{assets: Array<{guid: string|null, path: string, ext: string, type: string}>,
 *   broken: {missingMeta: string[], duplicateGuids: Array<{guid: string, paths: string[]}>},
 *   memberBindings: Array<{scriptGuid: string, assetPath: string, fileId: number, className: string}>,
 *   partial: boolean, scannedFiles: number, elapsedMs: number}}
 */
export async function scanAssets(projectRoot, { rescan = false, budgetMs = 20_000, durable = true } = {}) {
  const root = await canonicalRoot(projectRoot)
  const cached = caches.get(root)
  if (!rescan && cached !== undefined) return cached

  const startedAt = Date.now()
  // A non-positive budget means "you already spent it": `budgetMs` is the caller's
  // remaining time, not a promise that at least 1 ms of work happens.
  const deadline = startedAt + Math.max(0, budgetMs)
  const files = []
  let partial = false
  for (const name of ASSET_ROOTS) {
    const directory = join(root, name)
    const walk = walkProject(directory, root, deadline, files)
    if (walk.partial) partial = true
  }

  const assets = []
  const missingMeta = []
  const owners = new Map()
  for (const file of files) {
    const guid = readMetaGuid(file.absolute)
    const type = typeOf(file.ext)
    const asset = { guid, path: file.path, ext: file.ext, type }
    // The durable index needs the GUID and type on the walk entry; carrying them
    // here avoids a second `readMetaGuid` in the sync layer.
    file.guid = guid
    file.type = type
    file.root = root
    file.yaml = YAML_EXTENSIONS.has(file.ext)
    if (guid === null) {
      missingMeta.push(file.path)
      assets.push(asset)
      continue
    }
    assets.push(asset)
    const previous = owners.get(guid)
    if (previous === undefined) owners.set(guid, file.path)
    else if (typeof previous === 'string') owners.set(guid, [previous, file.path])
    else previous.push(file.path)
  }

  const duplicateGuids = []
  for (const [guid, owner] of owners) {
    if (Array.isArray(owner)) duplicateGuids.push({ guid, paths: [...owner] })
  }
  duplicateGuids.sort((left, right) => left.guid.localeCompare(right.guid))
  missingMeta.sort()

  assets.sort((left, right) => left.path.localeCompare(right.path))

  // Keep the durable index current. A partial walk must not be written: it would
  // record the un-walked half of the tree as "removed".
  let index = null
  if (durable && !partial) {
    try {
      const summary = refreshIndex(root, files)
      index = {
        available: summary.unavailable === null,
        unavailable: summary.unavailable,
        changed: summary.changed,
        removed: summary.removed,
        objects: summary.objects,
        refs: summary.refs,
      }
    } catch (error) {
      index = { available: false, unavailable: `index update failed: ${error?.message ?? error}`, changed: 0, removed: 0, objects: 0, refs: 0 }
    }
  }

  const scanned = {
    assets,
    broken: { missingMeta, duplicateGuids },
    memberBindings: collectMemberBindings(root, assets, deadline),
    partial,
    scannedFiles: files.length,
    elapsedMs: Date.now() - startedAt,
    index,
  }
  caches.set(root, scanned)
  return scanned
}

/**
 * Search the index.
 *
 * Every filter is optional and combines with AND; a `guid` search ignores the
 * others, because a GUID identifies one asset and name/type/under would only
 * narrow a set of one.
 *
 * @param {string} projectRoot
 * @param {{type?: string, name?: string, under?: string, guid?: string, limit?: number, rescan?: boolean}} [options]
 * @returns {Promise<{assets: Array<object>, broken: object, total: number, partial: boolean, truncated: boolean}>}
 */
export async function searchAssets(projectRoot, { type, name, under, guid, limit, rescan = false } = {}) {
  // A malformed GUID is a caller error, not "no filter": silently dropping it
  // answered every asset in the project, which is worse than a rejection.
  const guidGiven = guid !== undefined && guid !== null && String(guid).trim() !== ''
  const wantedGuid = normalizeGuid(guid)
  if (guidGiven && wantedGuid === null) {
    throw new Error(`guid must be the 32-hex asset GUID (got '${guid}'); it is stored on the guid: line of a .meta file.`)
  }
  const index = await scanAssets(projectRoot, { rescan })
  if (limit !== undefined && limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > SEARCH_LIMIT_MAX)) {
    throw new Error(`limit must be an integer from 1 to ${SEARCH_LIMIT_MAX} (got ${JSON.stringify(limit)}).`)
  }
  const size = clampLimit(limit, DEFAULT_LIMIT, SEARCH_LIMIT_MAX)
  const wantedType = typeof type === 'string' && type.trim() !== '' ? normalizeType(type.trim()) : null
  const wantedName = typeof name === 'string' && name.trim() !== '' ? name.trim().toLowerCase() : null
  const wantedUnder = typeof under === 'string' && under.trim() !== '' ? normalizeUnder(under.trim()) : null

  let candidates = index.assets
  if (wantedGuid !== null) candidates = candidates.filter((asset) => asset.guid === wantedGuid)

  const matches = []
  for (const asset of candidates) {
    if (wantedType !== null && asset.type !== wantedType) continue
    if (wantedUnder !== null && !asset.path.startsWith(wantedUnder)) continue
    if (wantedName !== null && !assetsNameMatches(asset.path, wantedName)) continue
    matches.push(asset)
  }
  const broken = describeBroken(index.broken)
  return {
    assets: matches.slice(0, size),
    broken,
    indexBroken: index.broken,
    total: matches.length,
    partial: index.partial,
    truncated: matches.length > size,
    scannedFiles: index.scannedFiles,
  }
}

/**
 * Which assets carry a script, optionally filtered to one method or field.
 *
 * A MonoBehaviour in a `.prefab`/`.unity` stores the script's GUID in
 * `m_Script`, so "what uses this script" is answerable from disk — and, with
 * `member`, "what calls this method" is answerable from `m_MethodName` in
 * UnityEvents and animation events (upstream's `RawMemberBinding`).
 *
 * @param {string} projectRoot
 * @param {{scriptGuid: string, member?: string, limit?: number}} options
 * @returns {Promise<{attachments: Array<object>, bindings: Array<object>, guid: string, total: number, truncated: boolean}>}
 */
export async function findScriptAttachments(projectRoot, { scriptGuid, member, limit } = {}) {
  const wanted = normalizeGuid(scriptGuid)
  if (wanted === null) throw new Error(`scriptGuid must be the 32-hex GUID of a script; got '${scriptGuid ?? ''}'.`)
  const index = await scanAssets(projectRoot)
  const size = clampLimit(limit, 50, SEARCH_LIMIT_MAX)
  const known = index.assets.find((asset) => asset.guid === wanted)
  if (known === undefined) {
    return {
      attachments: [],
      bindings: [],
      guid: wanted,
      total: 0,
      truncated: false,
      text:
        `No asset in the project has GUID ${wanted}. ` +
        'Check that the script is inside Assets/ and has a .cs.meta, and that the project is not being scanned with a partial index.',
    }
  }
  const wantedMember = typeof member === 'string' && member.trim() !== '' ? member.trim() : null
  const attachments = []
  for (const attachment of index.memberBindings) {
    if (attachment.scriptGuid !== wanted) continue
    if (wantedMember !== null && attachment.className !== wantedMember) continue
    attachments.push(attachment)
  }
  const byAsset = new Map()
  for (const attachment of attachments) {
    const list = byAsset.get(attachment.assetPath) ?? []
    list.push(attachment)
    byAsset.set(attachment.assetPath, list)
  }
  const grouped = [...byAsset].map(([assetPath, entries]) => ({ assetPath, objects: entries }))
  // A UnityEvent's `m_MethodName` names the method, and its `m_Target` names the
  // object; both are already indexed as bindings, so a member query also returns
  // the call sites.
  const bindings = wantedMember === null ? [] : index.memberBindings.filter((binding) => binding.scriptGuid === wanted && binding.className === wantedMember && binding.kind === 'method')
  const rows = grouped.slice(0, size)
  const lines = [`Script ${wanted}${known === undefined ? '' : ` (${known.path})`}: ${grouped.length} asset(s) carry it.`]
  for (const row of rows) {
    lines.push(`- ${row.assetPath}`)
    for (const object of row.objects.slice(0, 10)) lines.push(`    ${object.className} (fileID ${object.fileId})`)
    if (row.objects.length > 10) lines.push(`    … ${row.objects.length - 10} more object(s)`)
  }
  if (grouped.length > rows.length) lines.push(`… showing ${rows.length} of ${grouped.length}`)
  if (wantedMember !== null) {
    lines.push(`${wantedMember}: ${attachments.length} attachment(s), ${bindings.length} call site(s).`)
  }
  return {
    text: lines.join('\n'),
    attachments: rows,
    bindings: bindings.slice(0, size),
    guid: wanted,
    path: known.path,
    total: grouped.length,
    attachmentCount: attachments.length,
    bindingCount: bindings.length,
    truncated: grouped.length > size,
  }
}

/** Render an asset search for the model (the `unity_asset_search` result text). */
export function formatAssetSearch(result) {
  const assets = result?.assets ?? []
  const broken = result?.broken ?? { missingMeta: 0, duplicateGuids: 0 }
  const searched = result?.scannedFiles === undefined ? '' : ` in ${result.scannedFiles} file(s)`
  const header =
    `Unity assets: ${result?.total ?? assets.length} entr${(result?.total ?? assets.length) === 1 ? 'y' : 'ies'}` +
    `${searched}${result?.partial ? ' (partial scan: budget exceeded)' : ''}` +
    `${result?.truncated ? ', truncated' : ''}`
  const lines = [header]
  if (assets.length === 0) {
    lines.push('<no assets matched>')
  } else {
    for (const asset of assets) lines.push(`- ${asset.path} [${asset.type}]${asset.guid === null ? ' (no .meta)' : ` ${asset.guid}`}`)
  }
  if (broken.missingMeta > 0 || broken.duplicateGuids > 0) {
    lines.push(`broken: ${broken.missingMeta} missing .meta, ${broken.duplicateGuids} duplicate GUID(s)`)
  }
  return lines.join('\n')
}

// ─── implementation ────────────────────────────────────────────────────────

/** Resolve a project root to a stable cache key; the caller owns root discovery. */
async function canonicalRoot(projectRoot) {
  const text = String(projectRoot ?? '').trim()
  if (text === '') throw new Error('projectRoot is required.')
  try {
    return realpathSync(text)
  } catch {
    return text
  }
}

/** Depth-first walk of one asset root, honouring the deadline and the skip list. */
function walkProject(directory, root, deadline, output) {
  const result = { partial: false }
  // Real paths already entered. A symlinked directory can point back up the
  // tree, and following it forever would burn the whole time budget on one loop.
  const visited = new Set()
  const stack = [directory]
  while (stack.length > 0) {
    if (Date.now() >= deadline) {
      result.partial = true
      return result
    }
    if (output.length >= ASSET_DB_MAX_FILES) {
      result.partial = true
      return result
    }
    const current = stack.pop()
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      // An unreadable directory is skipped rather than failing the whole scan.
      continue
    }
    for (const entry of entries) {
      const name = entry.name
      // Unity's own rule: dotfiles and `~`-suffixed entries are invisible to it,
      // so they are not assets even when they sit under Assets/ — and the rule
      // applies to the file *name*, so `Foo.cs~` and `Foo~backup.cs` both go.
      if (name.startsWith('.') || name.endsWith('~') || name.includes('~')) continue
      const full = join(current, name)
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        if (SKIP_DIR_NAMES.has(name)) continue
        const real = safeRealPath(full)
        if (real === null || !isDirectory(real)) continue
        if (visited.has(real)) continue
        visited.add(real)
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      if (name.endsWith('.meta')) continue
      if (output.length >= ASSET_DB_MAX_FILES) {
        result.partial = true
        return result
      }
      output.push({ absolute: full, path: toProjectPath(root, full), ext: extensionOf(name) })
    }
  }
  return result
}

/** `realpath`, or null for a broken symlink (which a scan must survive). */
function safeRealPath(path) {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** The GUID from `<path>.meta`, or null when the file has no usable sidecar. */
function readMetaGuid(absolute) {
  const meta = `${absolute}.meta`
  let text
  try {
    text = readFileSync(meta, 'utf8')
  } catch {
    return null
  }
  // The `guid:` key must be top level (column zero); an importer's nested
  // settings can contain a key of the same name.
  for (const line of text.split('\n')) {
    if (!line.startsWith('guid:')) continue
    const value = line.slice('guid:'.length).trim()
    // Exactly 32 hex characters; `get(..32)` guards a multi-byte character
    // landing on the boundary in a hand-edited file.
    const candidate = value.slice(0, 32)
    if (!/^[0-9a-fA-F]{32}$/.test(candidate)) return null
    return candidate.toLowerCase()
  }
  return null
}

/** Every MonoBehaviour binding in the YAML assets, grouped by script GUID. */
function collectMemberBindings(root, assets, deadline) {
  const bindings = []
  for (const asset of assets) {
    if (Date.now() > deadline) break
    if (!YAML_EXTENSIONS.has(asset.ext)) continue
    let parsed
    try {
      parsed = readYamlFile(root, asset.path)
    } catch {
      // A binary or unreadable asset is not a scan failure.
      continue
    }
    for (const document of parsed.documents) {
      if (document.classId !== 114 && document.classId !== 1) continue
      const script = queryDocument(document, '/m_Script/guid')
      if (typeof script?.value !== 'string') continue
      const scriptGuid = script.value.toLowerCase()
      bindings.push({
        scriptGuid,
        assetPath: asset.path,
        fileId: document.fileId,
        className: owningObjectName(parsed.documents, document) ?? typeNameOf(document),
        kind: 'script',
        line: document.lineStart,
      })
      // UnityEvent persistent calls and animation events name a method on a
      // target; those are the "call sites" a member query is after.
      for (const method of findMethodNames(document)) {
        bindings.push({ scriptGuid, assetPath: asset.path, fileId: document.fileId, className: method, kind: 'method', line: document.lineStart })
      }
    }
  }
  return bindings
}

/**
 * The `m_Name` of the GameObject a component document points at.
 *
 * A MonoBehaviour's own `m_Name` is not set, so the readable identity of "which
 * object carries this script" lives on the referenced GameObject (class 1),
 * reachable through `m_GameObject.fileID` — the same hop upstream's
 * `MemberBinding.target_go_name` makes.
 */
function owningObjectName(documents, document) {
  const reference = queryDocument(document, '/m_GameObject/fileID')
  if (typeof reference?.value !== 'string') return null
  const player = Number(reference.value)
  if (!Number.isSafeInteger(player)) return null
  const owner = documents.find((candidate) => candidate.fileId === player && candidate.classId === 1)
  if (owner === undefined) return null
  const name = queryDocument(owner, '/m_Name')
  return typeof name?.value === 'string' && name.value !== '' ? name.value : null
}

/** `MonoBehaviour`, `GameObject`, … — the type name from the document's own block. */
function typeNameOf(document) {
  if (typeof document.typeName === 'string' && document.typeName !== '') return document.typeName
  const first = Array.isArray(document.tree) ? document.tree[0] : undefined
  return typeof first?.key === 'string' ? first.key : 'object'
}

/** `m_MethodName`/`functionName` values anywhere in one document. */
function findMethodNames(document) {
  const names = new Set()
  const walk = (nodes) => {
    for (const node of nodes ?? []) {
      if (node.kind !== 'scalar' && Array.isArray(node.children)) {
        walk(node.children)
        continue
      }
      if ((node.key === 'm_MethodName' || node.key === 'functionName') && typeof node.value === 'string' && node.value !== '') {
        names.add(node.value)
      }
    }
  }
  walk(document.tree ?? [])
  return names
}

function describeBroken(broken) {
  return { missingMeta: broken.missingMeta.length, duplicateGuids: broken.duplicateGuids.length }
}

function toProjectPath(root, absolute) {
  return relative(root, absolute).split(sep).join('/')
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot).toLowerCase()
}

function typeOf(ext) {
  const bare = ext.startsWith('.') ? ext.slice(1) : ext
  return TYPE_BY_EXT[bare] ?? (bare === '' ? 'metaOnly' : 'otherFile')
}

/** `material`, `Material` and `mat` all normalise to the same type name. */
function normalizeType(type) {
  const text = type.toLowerCase()
  if (text === 'mat') return 'material'
  if (text === 'script' || text === 'scripts') return 'script'
  if (text === 'scene' || text === 'scenes') return 'scene'
  if (text === 'prefab' || text === 'prefabs') return 'prefab'
  return text
}

/** `Assets/Prefabs/` and `Assets/Prefabs` both mean "under that directory". */
function normalizeUnder(under) {
  const text = under.split(sep).join('/').replace(/\/+$/, '')
  return text === '' ? '' : `${text}/`
}

/** A search `name` matches the file's base name or its path tail, case-insensitively. */
function assetsNameMatches(path, wanted) {
  const lower = path.toLowerCase()
  if (lower.includes(wanted)) return true
  const base = lower.slice(lower.lastIndexOf('/') + 1)
  const stem = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base
  return stem.includes(wanted)
}

/** Accept a 32-hex GUID with or without dashes/braces; anything else is null. */
export function normalizeGuid(guid) {
  if (typeof guid !== 'string') return null
  const text = guid.trim().replace(/^\{|\}$/g, '').replaceAll('-', '').toLowerCase()
  return /^[0-9a-f]{32}$/.test(text) ? text : null
}

function clampLimit(value, fallback, max) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value) || value < 1) return fallback
  return Math.min(value, max)
}

/** Drop the cached index (used by tests and by `rescan`). */
export function __resetAssetDbForTest(projectRoot) {
  if (projectRoot === undefined) caches.clear()
  else caches.delete(String(projectRoot))
}

export { DEFAULT_LIMIT, SEARCH_LIMIT_MAX, SKIP_DIR_NAMES, TYPE_BY_EXT }