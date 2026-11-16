// The project-wide asset index, stored on disk as SQLite.
//
// `src/asset-db.js` walks the project and answers "which asset has this GUID",
// "what is broken" and "which MonoBehaviour carries this script" from memory.
// That is enough for file-level questions, but it has three costs the model
// feels: the whole tree is re-walked when its mtime moves, the index dies with
// the process, and there is nowhere to put object-level rows (so references and
// prefab overrides stay unanswerable).
//
// This module owns the durable half:
//
//   * `Library/Locus/asset-index.db` — the same place every other cache of this
//     plugin lives. `Library/` is Unity-generated, git-ignored, and deleting it
//     costs a rebuild, never a project asset.
//
//   * Incremental updates: a file is re-read only when its (size, mtime) moved,
//     so a second call touches a handful of paths instead of thousands.
//
//   * Object-level rows: `objects` (one Unity document per row: class id,
//     file id, owning GameObject) and `refs` (every `{fileID, guid}` pair a
//     document stores). Those two tables are what make "what references this
//     GUID" and "which prefab overrides this property" answerable at all.
//
// SQLite comes from `node:sqlite`, which Node ships from 22.5 on — this package
// already requires 22.12 — so the index needs no dependency of its own. The
// database is opened with WAL so a reader (an agent mid-query) never blocks the
// writer that a second session's scan might be running.

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** The database file name, relative to `Library/Locus/`. */
export const INDEX_FILE = 'asset-index.db'

/** Bumping this drops the tables and rebuilds from scratch. */
export const INDEX_SCHEMA_VERSION = 1

/** Column/index definitions, applied when `PRAGMA user_version` is behind. */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS files (
     path TEXT PRIMARY KEY,
     size INTEGER NOT NULL,
     mtime_ms INTEGER NOT NULL,
     ext TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS assets (
     guid TEXT NOT NULL,
     path TEXT NOT NULL,
     ext TEXT NOT NULL,
     type TEXT NOT NULL,
     PRIMARY KEY (path)
   )`,
  `CREATE INDEX IF NOT EXISTS assets_by_guid ON assets (guid)`,
  `CREATE INDEX IF NOT EXISTS assets_by_type ON assets (type)`,
  `CREATE TABLE IF NOT EXISTS objects (
     path TEXT NOT NULL,
     class_id INTEGER NOT NULL,
     file_id INTEGER NOT NULL,
     type_name TEXT NOT NULL,
     name TEXT,
     script_guid TEXT,
     owner_file_id INTEGER,
     PRIMARY KEY (path, class_id, file_id)
   )`,
  `CREATE INDEX IF NOT EXISTS objects_by_script ON objects (script_guid)`,
  `CREATE TABLE IF NOT EXISTS refs (
     path TEXT NOT NULL,
     from_file_id INTEGER NOT NULL,
     to_guid TEXT NOT NULL,
     to_file_id INTEGER,
     PRIMARY KEY (path, from_file_id, to_guid, to_file_id)
   )`,
  `CREATE INDEX IF NOT EXISTS refs_by_target ON refs (to_guid)`,
  `CREATE TABLE IF NOT EXISTS meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
]

/**
 * Open (or create) the index for one project.
 *
 * A missing `node:sqlite` — an older Node, or a build without the module — is
 * not an error: the caller falls back to the in-memory index, which still
 * answers file-level questions. `unavailable` explains which.
 *
 * @param {string} projectRoot absolute, already canonicalised by the caller.
 * @param {{create?: boolean, file?: string, databaseSync?: Function}} [options]
 *   `file` overrides the location (tests), `databaseSync` overrides the driver.
 * @returns {{db: object|null, unavailable: string|null, file: string}}
 */
export function openIndex(projectRoot, { create = true, file = null, databaseSync = null, readonly = false } = {}) {
  const target = file ?? join(projectRoot, 'Library', 'Locus', INDEX_FILE)
  let DatabaseSync = databaseSync
  if (DatabaseSync === null) {
    try {
      ;({ DatabaseSync } = require_sqlite())
    } catch (error) {
      return { db: null, unavailable: `node:sqlite is not available: ${error?.message ?? error}`, file: target }
    }
  }
  if (typeof DatabaseSync !== 'function') {
    return { db: null, unavailable: 'node:sqlite did not export DatabaseSync.', file: target }
  }
  // A read-only open must never create anything: it is what a reader uses when
  // it only wants to look, and a missing database is a legitimate answer.
  if (readonly && !existsSync(target)) {
    return { db: null, unavailable: `${target} does not exist yet; run an asset scan first`, file: target }
  }
  if (create && !readonly) mkdirSync(join(projectRoot, 'Library', 'Locus'), { recursive: true })
  let db
  try {
    // Read-only connections say so up front. Opening the *same* database
    // read-write from a second process is what a WAL database cannot always
    // share (a checkpoint needs the write lock), and a reader has no business
    // taking one.
    db = readonly ? new DatabaseSync(target, { readOnly: true }) : new DatabaseSync(target, { timeout: 5000 })
  } catch (error) {
    return { db: null, unavailable: `could not open ${target}: ${error?.message ?? error}`, file: target }
  }
  try {
    // WAL lets a second session read while this one indexes; `busy_timeout`
    // makes a concurrent write wait instead of throwing SQLITE_BUSY.
    if (!readonly) db.exec('PRAGMA journal_mode = WAL')
    if (!readonly) db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA busy_timeout = 5000')
    if (!readonly) applySchema(db)
  } catch (error) {
    closeIndex(db)
    return { db: null, unavailable: `could not prepare ${target}: ${error?.message ?? error}`, file: target }
  }
  return { db, unavailable: null, file: target }
}

/** `node:sqlite`, loaded lazily so an old Node fails at the call site, not at import. */
function require_sqlite() {
  // Inside an ES module there is no bare `require`; `createRequire` is the ESM
  // way to reach a CommonJS builtin such as `node:sqlite`. It is obtained here,
  // not at module scope, so a Node that lacks `node:sqlite` degrades into
  // `unavailable` instead of failing to import this file.
  return loadBuiltin('node:sqlite')
}

/** Injected once by {@link installBuiltinLoader}; keeps this file synchronous. */
let builtinLoader = null

/**
 * Let the ESM entry point hand us a synchronous builtin loader.
 *
 * `import 'node:module'` is itself asynchronous to await, and this module's API
 * is synchronous (a scan needs its rows before it returns), so the loader is
 * installed once from the module that already does top-level imports.
 *
 * @param {(specifier: string) => object} loader
 */
export function installBuiltinLoader(loader) {
  builtinLoader = loader
}

function loadBuiltin(specifier) {
  if (builtinLoader === null) throw new Error('the builtin-module loader has not been installed')
  const loaded = builtinLoader(specifier)
  if (specifier === 'node:sqlite' && typeof loaded.DatabaseSync !== 'function') {
    throw new Error('node:sqlite did not export DatabaseSync')
  }
  return loaded
}

/** Create the tables and stamp the schema version. */
function applySchema(db) {
  const current = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
  // Anything that is not the schema this build writes gets dropped. That
  // includes `0`, which means "tables written by a build that predates the
  // version stamp": keeping them would leave rows missing columns this build
  // now expects.
  if (current !== INDEX_SCHEMA_VERSION) {
    // A stale schema is dropped rather than migrated: the database holds
    // nothing but a cache, and a rebuild is cheaper than a migration bug.
    for (const table of ['refs', 'objects', 'assets', 'files', 'meta']) db.exec(`DROP TABLE IF EXISTS ${table}`)
  }
  for (const statement of SCHEMA) db.exec(statement)
  db.exec(`PRAGMA user_version = ${INDEX_SCHEMA_VERSION}`)
}

/** Close without throwing; a failed close must not mask the real error. */
export function closeIndex(db) {
  try {
    db?.close?.()
  } catch {
    // ignore
  }
}

/**
 * The `path → {size, mtimeMs}` map of everything the index already knows.
 *
 * The scan compares this against the walk's result and re-reads only the
 * difference, which is the whole point of keeping the file.
 */
export function readKnownFiles(db) {
  const known = new Map()
  for (const row of db.prepare('SELECT path, size, mtime_ms FROM files').all()) {
    known.set(row.path, { size: Number(row.size), mtimeMs: Number(row.mtime_ms) })
  }
  return known
}

/** `stat` one walked file; null when it vanished between walk and read. */
export function statFile(absolute) {
  try {
    const info = statSync(absolute, { bigint: false })
    return { size: info.size, mtimeMs: Math.floor(info.mtimeMs) }
  } catch {
    return null
  }
}

/**
 * Write one scan's worth of rows in a single transaction.
 *
 * `upsert` carries only the files whose stamp moved; `removed` carries paths the
 * walk no longer saw. Everything else in the database is left untouched, which
 * is what makes this incremental.
 *
 * @param {object} db
 * @param {{upsert: Array<{path: string, size: number, mtimeMs: number, ext: string,
 *   asset?: {guid: string|null, type: string}, objects?: Array<object>, refs?: Array<object>}>,
 *   removed: string[]}} batch
 */
export function writeBatch(db, { upsert, removed }) {
  if (upsert.length === 0 && removed.length === 0) return
  const insertFile = db.prepare('INSERT OR REPLACE INTO files (path, size, mtime_ms, ext) VALUES (?, ?, ?, ?)')
  const insertAsset = db.prepare('INSERT OR REPLACE INTO assets (guid, path, ext, type) VALUES (?, ?, ?, ?)')
  const deleteAsset = db.prepare('DELETE FROM assets WHERE path = ?')
  const deleteObjects = db.prepare('DELETE FROM objects WHERE path = ?')
  const deleteRefs = db.prepare('DELETE FROM refs WHERE path = ?')
  const insertObject = db.prepare(
    'INSERT OR REPLACE INTO objects (path, class_id, file_id, type_name, name, script_guid, owner_file_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  const insertRef = db.prepare(
    'INSERT OR REPLACE INTO refs (path, from_file_id, to_guid, to_file_id) VALUES (?, ?, ?, ?)',
  )
  const deleteFile = db.prepare('DELETE FROM files WHERE path = ?')

  db.exec('BEGIN IMMEDIATE')
  try {
    for (const path of removed) {
      deleteRefs.run(path)
      deleteObjects.run(path)
      deleteAsset.run(path)
      deleteFile.run(path)
    }
    for (const entry of upsert) {
      insertFile.run(entry.path, entry.size, entry.mtimeMs, entry.ext)
      // Every upserted file rewrites its derived rows: an asset may have gained
      // or lost its .meta (asset row appears/disappears), and object/ref rows
      // are whole-file facts.
      deleteRefs.run(entry.path)
      deleteObjects.run(entry.path)
      deleteAsset.run(entry.path)
      if (entry.asset) {
        insertAsset.run(entry.asset.guid ?? '', entry.path, entry.ext, entry.asset.type)
      }
      for (const object of entry.objects ?? []) {
        insertObject.run(
          entry.path,
          object.classId,
          object.fileId,
          object.typeName,
          object.name ?? null,
          object.scriptGuid ?? null,
          object.ownerFileId ?? null,
        )
      }
      for (const ref of entry.refs ?? []) {
        insertRef.run(entry.path, ref.fromFileId, ref.toGuid, ref.toFileId ?? null)
      }
    }
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The transaction may already be gone; the original error is the useful one.
    }
    throw error
  }
}

/** Query: every asset row, optionally filtered. */
export function selectAssets(db, { guid = null, type = null, under = null, limit = null } = {}) {
  const clauses = []
  const values = []
  if (guid !== null) {
    clauses.push('guid = ?')
    values.push(guid)
  }
  if (type !== null) {
    clauses.push('type = ?')
    values.push(type)
  }
  if (under !== null) {
    clauses.push('path LIKE ?')
    values.push(`${under}%`)
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
  const tail = limit === null ? '' : ` LIMIT ${Number(limit)}`
  return db
    .prepare(`SELECT guid, path, ext, type FROM assets${where} ORDER BY path${tail}`)
    .all(...values)
    .map((row) => ({ guid: row.guid === '' ? null : row.guid, path: row.path, ext: row.ext, type: row.type }))
}

/** Count rows in one table (used by `unity_asset_search` to report index size). */
export function countRows(db, table) {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0)
}

/** Which assets reference a GUID (the reference graph's read side). */
export function selectReferences(db, guid, { limit = 200 } = {}) {
  return db
    .prepare(
      `SELECT r.path, r.from_file_id, r.to_file_id, a.type, a.path AS target_path
         FROM refs r LEFT JOIN assets a ON a.guid = r.to_guid
        WHERE r.to_guid = ? ORDER BY r.path LIMIT ${Number(limit)}`,
    )
    .all(guid)
    .map((row) => ({
      path: row.path,
      fromFileId: Number(row.from_file_id),
      toFileId: row.to_file_id === null ? null : Number(row.to_file_id),
      type: row.type ?? null,
      targetPath: row.target_path ?? null,
    }))
}

/** Every document in one asset (objects table read side). */
export function selectObjects(db, path, { limit = 500 } = {}) {
  return db
    .prepare(`SELECT class_id, file_id, type_name, name, script_guid, owner_file_id FROM objects WHERE path = ? LIMIT ${Number(limit)}`)
    .all(path)
    .map((row) => ({
      classId: Number(row.class_id),
      fileId: Number(row.file_id),
      typeName: row.type_name,
      name: row.name,
      scriptGuid: row.script_guid,
      ownerFileId: row.owner_file_id === null ? null : Number(row.owner_file_id),
    }))
}

/** Store a named fact (scan timestamp, schema notes) beside the rows. */
export function setMeta(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, String(value))
}

/** Read a named fact back, or null. */
export function getMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null
}
