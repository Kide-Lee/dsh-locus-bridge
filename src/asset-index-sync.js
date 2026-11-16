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
  selectObjects,
  selectReferences,
  setMeta,
  statFile,
  writeBatch,
} from './asset-index.js'

/** How many files one incremental apply may re-read before it gives up and defers. */
export const INDEX_APPLY_LIMIT = 20_000

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
    const enriched = upsert.map((entry) => {
      const derived = deriveRows(entry, readYaml)
      objects += derived.objects.length
      refs += derived.refs.length
      return { ...entry, ...derived }
    })

    writeBatch(db, { upsert: enriched, removed })
    summary.db = db
    summary.changed = enriched.length
    summary.removed = removed.length
    summary.added = enriched.filter((entry) => !known.has(entry.path) && entry.asset !== undefined).length
    summary.objects = objects
    summary.refs = refs
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
  // Both columns are NOT NULL in the schema, so a missing walk field has to
  // become a placeholder rather than `undefined` (which node:sqlite refuses to bind).
  const asset = { guid: entry.guid ?? '', type: entry.type ?? '' }
  if (!entry.yaml) return { asset, objects, refs }

  let parsed
  try {
    parsed = readYaml(entry.root ?? '', entry.path)
  } catch {
    return { asset, objects, refs }
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
  }
  return { asset, objects, refs }
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
    }
  } finally {
    closeIndex(opened.db)
  }
}

/** Where the durable index lives for a project (kept in one place for tests). */
export function indexPath(projectRoot) {
  return join(projectRoot, 'Library', 'Locus', 'asset-index.db')
}
