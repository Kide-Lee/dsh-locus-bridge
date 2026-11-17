// Making the durable index (`src/asset-index.js`) usable from the scan in
// `src/asset-db.js`, without changing what a call *returns*.
//
// The in-memory scan is the source of truth for one call: it walks the tree and
// knows which files it saw. This layer's job is only to avoid paying for files
// whose stamp did not move, and to keep the durable rows (objects, refs) current
// so the reference graph can be answered later.
//
// The walk itself stays in `asset-db.js`: it already skips dotfiles, `~`
// entries, `Library/`, symlink loops and the file ceiling, and duplicating those
// rules here would let the two indexes disagree about what an asset is.

import { join } from 'node:path'

import { queryDocument, readYamlFile } from './yaml-lite.js'
import {
  closeIndex,
  countRows,
  openIndex,
  readKnownFiles,
  selectAssets,
  selectManagedRefsByClassKeys,
  selectManagedRefTypeSummaries,
  selectObjects,
  selectReferences,
  setMeta,
  statFile,
  writeBatch,
} from './asset-index.js'

/** How many files one incremental apply may re-read before it gives up and defers. */
export const INDEX_APPLY_LIMIT = 20_000

/** `MonoBehaviour`, the only document class that carries a `references` block. */
const MONOBEHAVIOUR_CLASS_ID = 114

/**
 * Bring the durable index up to date with one walk.
 *
 * Returns a description the caller folds into its result (`index`), or an
 * `unavailable` reason when `node:sqlite` is missing — in which case the
 * in-memory index is used unchanged and nothing else changes.
 *
 * @param {string} projectRoot canonical project root.
 * @param {Array<{absolute: string, path: string, ext: string}>} walked
 *   every file the walk saw, in walk order.
 * @param {{applyLimit?: number, openIndexImpl?: Function, readYamlFileImpl?: Function}} [options]
 * @returns {{db: object|null, unavailable: string|null, file: string,
 *   changed: number, removed: number, added: number, objects: number, refs: number}}
 */
export function refreshIndex(projectRoot, walked, options = {}) {
  const applyLimit = options.applyLimit ?? INDEX_APPLY_LIMIT
  const open = options.openIndexImpl ?? openIndex
  const readYaml = options.readYamlFileImpl ?? readYamlFile

  const opened = open(projectRoot)
  const summary = {
    db: null,
    unavailable: opened.unavailable,
    file: opened.file,
    changed: 0,
    removed: 0,
    added: 0,
    objects: 0,
    refs: 0,
    managedRefs: 0,
  }
  if (opened.db === null) return summary

  const db = opened.db
  try {
    const known = readKnownFiles(db)
    const seen = new Set()
    const upsert = []
    const stats = new Map()

    for (const file of walked) {
      if (seen.has(file.path)) continue
      seen.add(file.path)
      const stamp = statFile(file.absolute)
      if (stamp === null) continue
      stats.set(file.path, stamp)
      const previous = known.get(file.path)
      if (previous !== undefined && previous.size === stamp.size && previous.mtimeMs === stamp.mtimeMs) continue
      if (upsert.length >= applyLimit) continue
      upsert.push({ ...file, ...stamp })
    }

    const removed = []
    for (const path of known.keys()) {
      if (!seen.has(path)) removed.push(path)
    }
    // A path that comes back within the same call is a re-add, not a removal.
    for (const entry of upsert) {
      if (removed.includes(entry.path)) removed.splice(removed.indexOf(entry.path), 1)
    }

    let objects = 0
    let refs = 0
    let managedRefs = 0
    const enriched = upsert.map((entry) => {
      const derived = deriveRows(entry, readYaml)
      objects += derived.objects.length
      refs += derived.refs.length
      managedRefs += derived.managedRefs.length
      return { ...entry, ...derived }
    })

    writeBatch(db, { upsert: enriched, removed })
    summary.db = db
    summary.changed = enriched.length
    summary.removed = removed.length
    summary.added = enriched.filter((entry) => !known.has(entry.path) && entry.asset !== undefined).length
    summary.objects = objects
    summary.refs = refs
    summary.managedRefs = managedRefs
    setMeta(db, 'scanned_at', new Date().toISOString())
  } catch (error) {
    summary.unavailable = `index update failed: ${error?.message ?? error}`
  }
  return summary
}

/**
 * The derived rows for one changed file: its asset row and, for an asset that
 * holds Unity YAML, its documents and cross-references.
 *
 * Binary assets (an AssetBundle-serialised scene) yield no YAML documents. That
 * is correct and must not be reported as an error: the file still has a GUID and
 * therefore still appears in the asset table.
 */
export function deriveRows(entry, readYaml) {
  const objects = []
  const refs = []
  const managedRefs = []
  // Both columns are NOT NULL in the schema, so a missing walk field has to
  // become a placeholder rather than `undefined` (which node:sqlite refuses to bind).
  const asset = { guid: entry.guid ?? '', type: entry.type ?? '' }
  if (!entry.yaml) return { asset, objects, refs, managedRefs }

  let parsed
  try {
    parsed = readYaml(entry.root ?? '', entry.path)
  } catch {
    return { asset, objects, refs, managedRefs }
  }
  const documents = parsed?.documents ?? []
  // A MonoBehaviour stores its script's GUID in `m_Script`, and its GameObject
  // one hop away through `m_GameObject`; both are per-document facts the parser
  // does not surface on its own.
  const namesByFileId = new Map()
  for (const document of documents) {
    const name = queryDocument(document, '/m_Name')
    if (typeof name?.value === 'string' && name.value !== '') namesByFileId.set(document.fileId, name.value)
  }
  for (const document of documents) {
    const script = queryDocument(document, '/m_Script/guid')
    const scriptGuid = typeof script?.value === 'string' ? script.value.toLowerCase() : null
    const owner = queryDocument(document, '/m_GameObject/fileID')
    const ownerValue = typeof owner?.value === 'string' ? Number(owner.value) : NaN
    const ownerFileId = Number.isSafeInteger(ownerValue) ? ownerValue : null
    const own = queryDocument(document, '/m_Name')
    const ownName = typeof own?.value === 'string' && own.value !== '' ? own.value : null
    objects.push({
      classId: document.classId,
      fileId: document.fileId,
      typeName: document.typeName ?? '',
      name: ownName ?? (ownerFileId === null ? null : (namesByFileId.get(ownerFileId) ?? null)),
      scriptGuid,
      ownerFileId,
    })
    for (const ref of collectGuidRefs(document.tree ?? [])) {
      refs.push({ fromFileId: document.fileId, toGuid: ref.guid, toFileId: ref.fileId ?? null })
    }
    if (document.classId === MONOBEHAVIOUR_CLASS_ID) {
      for (const managed of collectManagedRefs(parsed?.text ?? '', document)) {
        managedRefs.push({ hostFileId: document.fileId, ...managed })
      }
    }
  }
  return { asset, objects, refs, managedRefs }
}

/**
 * The `[SerializeReference]` registry entries of one MonoBehaviour document.
 *
 * The `references` block is scanned as text rather than read from the parsed
 * tree on purpose: a `type: {…}` value may wrap across lines, and the field
 * tree keeps only what fits on the key's own line. Unity itself writes the
 * short form, but a hand-merged or pretty-printed file must not silently lose
 * its type identities — losing one here would be reported as an unresolved type
 * that is in fact fine.
 *
 * Layout being walked (Unity 2021+):
 *
 *     references:
 *       version: 2
 *       RefIds:
 *       - rid: 1
 *         type: {class: Foo, ns: Game, asm: Assembly-CSharp}
 *       - rid: 2
 *         type: {class: Terminus, ns: UnityEngine.DMAT, asm: FAKE_ASM}
 *
 * `rid: -2` and the Terminus sentinel are Unity's own "nothing here" markers and
 * are skipped, as upstream does.
 *
 * @param {string} text the whole asset file.
 * @param {object} document the parsed document supplying the host file id.
 * @returns {Array<{hostFileId: number, rid: number, className: string, namespace: string,
 *   assembly: string, classKey: string, line: number}>}
 */
export function collectManagedRefs(text, document) {
  const lines = text.split('\n')
  const found = []
  let index = document.lineStart - 1
  const end = Math.min(lines.length, document.lineEnd)
  while (index < end) {
    const line = lines[index] ?? ''
    const stripped = stripTrailingComment(line)
    if (!/^\s*references:\s*(#.*)?$/.test(stripped)) {
      index += 1
      continue
    }
    const blockIndent = indentOf(line)
    let cursor = index + 1
    let pendingRid = null
    while (cursor < end) {
      const current = lines[cursor] ?? ''
      if (current.trim() === '') {
        cursor += 1
        continue
      }
      const depth = indentOf(current)
      if (depth <= blockIndent) break
      const body = stripTrailingComment(current).trim()
      if (body === 'RefIds:') {
        cursor += 1
        continue
      }
      // A new entry is a sequence item at the block's own child indent; its
      // fields sit one level deeper. Unity writes v2 as `- rid: N` and older
      // files as `NNNNNNNN:`, and both forms mark the same thing.
      if (depth === blockIndent + 2) {
        const lineNumber = cursor + 1
        if (/^-\s/.test(body)) {
          const value = Number(/^-\s*rid:\s*(-?\d+)/.exec(body)?.[1] ?? NaN)
          pendingRid = Number.isSafeInteger(value) ? value : null
          const entry = readManagedType(lines, cursor + 1, end, blockIndent + 4)
          if (entry !== null && isReportableRid(pendingRid)) found.push({ ...entry, rid: pendingRid, line: lineNumber })
        } else {
          const match = /^(-?\d+):\s*(\{.*\}|)$/.exec(body)
          if (match !== null) {
            const value = Number(match[1])
            pendingRid = Number.isSafeInteger(value) ? value : null
            const entry =
              match[2] === '' ? readManagedType(lines, cursor + 1, end, blockIndent + 4) : parseManagedTypeFlow(match[2])
            if (entry !== null && isReportableRid(pendingRid)) found.push({ ...entry, rid: pendingRid, line: lineNumber })
          }
        }
      }
      cursor += 1
    }
    index = cursor
  }
  return found
}

/** `-2` is Unity's "no reference"; anything else is a real registry entry. */
function isReportableRid(rid) {
  return rid !== null && rid !== -2
}

/** The `type:` value of one entry, joining continuation lines until the braces close. */
function readManagedType(lines, start, end, depth) {
  let cursor = start
  while (cursor < end) {
    const line = lines[cursor] ?? ''
    if (line.trim() === '') {
      cursor += 1
      continue
    }
    if (indentOf(line) !== depth) return null
    const value = /^type:\s*(.*)$/.exec(stripTrailingComment(line).trim())
    if (value === null) return null
    const text = value[1].trim()
    if (text === '' || text === 'null') return null
    let joined = text
    let next = cursor + 1
    while (countBraces(joined) > 0 && next < end) {
      joined += ` ${(lines[next] ?? '').trim()}`
      next += 1
    }
    return parseManagedTypeFlow(joined)
  }
  return null
}

/**
 * `{class: Foo, ns: Game, asm: Assembly-CSharp}` → `{className, namespace, assembly, classKey}`.
 *
 * Values are arbitrary strings, optionally quoted, and a namespace may itself
 * contain dots, so the split is on top-level commas only.
 */
export function parseManagedTypeFlow(text) {
  const trimmed = String(text ?? '').trim()
  const open = trimmed.indexOf('{')
  const close = trimmed.lastIndexOf('}')
  if (open === -1 || close <= open) return null
  const fields = new Map()
  for (const part of splitTopLevel(trimmed.slice(open + 1, close))) {
    const colon = part.indexOf(':')
    if (colon === -1) continue
    fields.set(part.slice(0, colon).trim(), unquote(part.slice(colon + 1).trim()))
  }
  const className = fields.get('class') ?? ''
  if (className === '') return null
  const namespace = fields.get('ns') ?? ''
  const assembly = fields.get('asm') ?? ''
  if (className === 'Terminus' && namespace === 'UnityEngine.DMAT' && assembly === 'FAKE_ASM') return null
  return { className, namespace, assembly, classKey: managedClassKey(className) }
}

function splitTopLevel(text) {
  const parts = []
  let current = ''
  let depth = 0
  let quote = ''
  for (const character of text) {
    if (quote !== '') {
      current += character
      if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      current += character
      continue
    }
    if (character === '(' || character === '[' || character === '{') depth += 1
    if (character === ')' || character === ']' || character === '}') depth -= 1
    if (character === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += character
  }
  parts.push(current)
  return parts.map((part) => part.trim()).filter((part) => part !== '')
}

function unquote(value) {
  if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value[value.length - 1] === value[0]) {
    return value.slice(1, -1).replace(/\\(.)/g, '$1')
  }
  return value
}

function countBraces(text) {
  let depth = 0
  for (const character of text) {
    if (character === '{') depth += 1
    if (character === '}') depth -= 1
  }
  return depth
}

function indentOf(line) {
  let count = 0
  for (const character of line) {
    if (character === ' ') count += 1
    else if (character === '\t') count += 2
    else break
  }
  return count
}

/** Unity never quotes a `#` inside a name, so a trailing comment can be cut blindly. */
function stripTrailingComment(line) {
  const hash = line.indexOf(' #')
  return hash === -1 ? line : line.slice(0, hash)
}

/**
 * The lookup key for a managed class name: the last segment, lowercased.
 *
 * `Game.Foo+Inner`, `Game.Foo/Inner` and `Inner` all key to `inner`; generics
 * keep their arity (`Inner\`1` → `inner\`1`), because a type argument list is
 * part of the identity in Unity's registry.
 */
export function managedClassKey(className) {
  const segments = managedClassSegments(className)
  return (segments[segments.length - 1] ?? '').toLowerCase()
}

/** `Outer/Inner` and `Outer+Inner` split into names, generic arguments dropped. */
export function managedClassSegments(className) {
  const bare = String(className ?? '').split('[')[0]
  return bare
    .split(/[/+]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '')
}

/**
 * Every `{fileID, guid}` pair in one document's field tree.
 *
 * Unity serialises an object reference as a two-key mapping — a local `fileID`
 * and, for anything living in another asset, a `guid`. A pair where both keys
 * sit in the same mapping is a cross-asset edge; a `fileID` alone is a reference
 * inside the same file and is already covered by the document's own identity.
 */
function collectGuidRefs(nodes) {
  const found = []
  const visit = (list) => {
    for (const node of list ?? []) {
      if (node.kind !== 'scalar' && Array.isArray(node.children)) {
        const guid = node.children.find((child) => child.key === 'guid' && typeof child.value === 'string')
        const fileId = node.children.find((child) => child.key === 'fileID')
        if (guid !== undefined && /^[0-9a-fA-F]{32}$/.test(guid.value)) {
          const numeric = fileId === undefined ? NaN : Number(fileId.value)
          found.push({ guid: guid.value.toLowerCase(), fileId: Number.isSafeInteger(numeric) ? numeric : null })
        }
        visit(node.children)
      }
    }
  }
  visit(nodes)
  return found
}

/**
 * Answer a reference question from the durable index.
 *
 * `guid` is the target. Returns the referencing paths with the asset type of the
 * target when it is known, or an empty array when the index has never seen the
 * GUID (which is different from "nothing references it" — the caller must be
 * able to tell those apart, so `available` says whether the index could answer).
 */
export function lookupReferences(projectRoot, guid, { limit = 200, openIndexImpl = openIndex } = {}) {
  const opened = openIndexImpl(projectRoot, { create: false, readonly: true })
  if (opened.db === null) return { available: false, unavailable: opened.unavailable, references: [] }
  try {
    return { available: true, unavailable: null, references: selectReferences(opened.db, guid, { limit }) }
  } finally {
    closeIndex(opened.db)
  }
}

/** Document-level view of one asset, from the durable index. */
export function lookupObjects(projectRoot, path, { limit = 500, openIndexImpl = openIndex } = {}) {
  const opened = openIndexImpl(projectRoot, { create: false, readonly: true })
  if (opened.db === null) return { available: false, unavailable: opened.unavailable, objects: [] }
  try {
    return { available: true, unavailable: null, objects: selectObjects(opened.db, path, { limit }) }
  } finally {
    closeIndex(opened.db)
  }
}

/** Whole-table asset read (used when a search runs against the durable index). */
export function lookupAssets(projectRoot, filters = {}, { openIndexImpl = openIndex } = {}) {
  const opened = openIndexImpl(projectRoot, { create: false, readonly: true })
  if (opened.db === null) return { available: false, unavailable: opened.unavailable, assets: [], total: 0 }
  try {
    const assets = selectAssets(opened.db, filters)
    return { available: true, unavailable: null, assets, total: assets.length }
  } finally {
    closeIndex(opened.db)
  }
}

/**
 * Managed types the index knows about, for `code_diagnostics`.
 *
 * The index is opened read-only and never created: a project that was never
 * scanned has no serialized facts to check, which is exactly the "no asset
 * database" case upstream answers silently. Opening a missing index read-write
 * would build an empty database and then claim every type is unresolved.
 */
export function lookupManagedRefs(projectRoot, { classKeys = null, openIndexImpl = openIndex } = {}) {
  const opened = openIndexImpl(projectRoot, { create: false, readonly: true })
  if (opened.db === null) return { available: false, unavailable: opened.unavailable, types: [], entries: [], guidToPath: new Map() }
  try {
    const types = selectManagedRefTypeSummaries(opened.db)
    const entries = classKeys === null ? [] : selectManagedRefsByClassKeys(opened.db, classKeys, { limit: 2000 })
    // `.asmref` files name their target by GUID; the index already maps every
    // GUID to a path, so assembly resolution can follow one without a second scan.
    const guidToPath = new Map()
    if (classKeys !== null) {
      for (const row of selectAssets(opened.db, { limit: null })) {
        if (typeof row.guid === 'string' && row.guid !== '' && row.path.endsWith('.asmdef')) guidToPath.set(row.guid.toLowerCase(), row.path)
      }
    }
    return { available: true, unavailable: null, types, entries, guidToPath }
  } finally {
    closeIndex(opened.db)
  }
}

/** Row counts, for the "index built from N files" line in search results. */
export function indexStats(projectRoot, { openIndexImpl = openIndex } = {}) {
  const opened = openIndexImpl(projectRoot, { create: false, readonly: true })
  if (opened.db === null) return { available: false, unavailable: opened.unavailable, files: 0, assets: 0, objects: 0, refs: 0 }
  try {
    return {
      available: true,
      unavailable: null,
      files: countRows(opened.db, 'files'),
      assets: countRows(opened.db, 'assets'),
      objects: countRows(opened.db, 'objects'),
      refs: countRows(opened.db, 'refs'),
      managedRefs: countRows(opened.db, 'managed_refs'),
    }
  } finally {
    closeIndex(opened.db)
  }
}

/** Where the durable index lives for a project (kept in one place for tests). */
export function indexPath(projectRoot) {
  return join(projectRoot, 'Library', 'Locus', 'asset-index.db')
}
