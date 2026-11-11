// `unity_asset`: read an asset's serialized snapshot, apply property edits with
// Locus' revision guard (hash-checked disk apply), and re-import changed files.
//
// Locus' live asset API (`LocusBridge.AssetApi.cs`) is a two-step protocol:
//   read        {action:"read", path} → {revision, objects:[{object_id, class_id,
//               root_type, fields:[{property_path, kind, value}]}], capabilities}
//   apply_batch {action:"apply_batch", persist:"disk", entries:[{path,
//               expected_revision, operations:[{op:"set", object_id,
//               property_path, value_json} | array_insert/remove/move/resize…}]}]}
// The apply must supply the revision from a read; a mismatch is a
// `revision_conflict` and nothing is written. Batch apply is all-or-nothing in
// Unity (undo + file restore), so this tool records one undo checkpoint.

import { openEditSession, withClient } from './client-pool.js'

export const ATOMIC_OPS = new Set(['set', 'array_insert', 'array_remove', 'array_move', 'array_resize'])

/**
 * Validate the tool's `edits` argument and flatten it into apply_batch entries.
 * Several edits may target one asset; each operation names its object and a
 * serialized property path (`m_Name`, `m_Value`, `values.Array.data[0]`).
 */
export function buildApplyRequest({ snapshot, edits }) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.revision) {
    throw new Error('edits require the "snapshot" a read returned (it carries the revision).')
  }
  if (!Array.isArray(edits) || edits.length === 0) throw new Error('edits must be a non-empty array.')
  const entries = []
  const byPath = new Map()
  for (const [index, edit] of edits.entries()) {
    if (!edit || typeof edit !== 'object') throw new Error(`edits[${index}] must be an object.`)
    const path = String(edit.path ?? snapshot.path ?? '').trim().replaceAll('\\', '/')
    if (!path.startsWith('Assets/')) throw new Error(`edits[${index}].path must be inside Assets/.`)
    const operation = edit.operation && typeof edit.operation === 'object' ? edit.operation : null
    const op = String(operation?.op ?? 'set')
    if (!ATOMIC_OPS.has(op)) throw new Error(`edits[${index}].operation.op '${op}' is not supported.`)
    const objectId = String(operation?.object_id ?? '').trim()
    const propertyPath = String(operation?.property_path ?? '').trim()
    if (!objectId) throw new Error(`edits[${index}].operation.object_id is required.`)
    if (!propertyPath) throw new Error(`edits[${index}].operation.property_path is required.`)
    let entry = byPath.get(path)
    if (!entry) {
      entry = { path, expected_revision: String(edit.expected_revision ?? snapshot.revision), operations: [] }
      byPath.set(path, entry)
      entries.push(entry)
    }
    entry.operations.push(toWireOperation(op, objectId, propertyPath, operation))
  }
  return { action: 'apply_batch', persist: 'disk', entries }
}

function toWireOperation(op, objectId, propertyPath, operation) {
  const wire = { op, object_id: objectId, property_path: propertyPath }
  if (op === 'set') {
    wire.value_json = encodeAssetValue(propertyPath, operation.value)
  } else if (op === 'array_insert' || op === 'array_resize') {
    if (operation.value === undefined) throw new Error(`${op} requires a value.`)
    wire.value_json = encodeAssetValue(propertyPath, operation.value)
  }
  if (['array_insert', 'array_remove', 'array_move'].includes(op)) {
    if (!Number.isInteger(operation.index)) throw new Error(`${op} requires an integer index.`)
    wire.index = operation.index
  }
  if (op === 'array_move') {
    if (!Number.isInteger(operation.to_index)) throw new Error('array_move requires an integer to_index.')
    wire.to_index = operation.to_index
  }
  if (op === 'array_resize') {
    if (!Number.isInteger(operation.size) || operation.size < 0) throw new Error('array_resize requires a non-negative size.')
    wire.size = operation.size
  }
  return wire
}

/**
 * Encode a plain JSON value into the `value_json` text Unity's
 * `SetAssetApiValue` parses: integers/bools as raw literals, floats as raw
 * numbers, strings as JSON strings, object references as `{fileID, guid?}`,
 * arrays as JSON arrays (recursively), and compound structs (Vector3, Color,
 * Quaternion, Rect, Bounds, …) as JSON objects.
 *
 * Compound objects ARE supported by the broker: `SetAssetApiValue`'s `default`
 * branch deserializes the object and requires **exactly** the serialized members
 * (`type_mismatch: set object requires exactly the serialized members` otherwise,
 * `LocusBridge.AssetApi.cs:1119`). Refusing them here would make the Sidebar's
 * editor more capable than this tool and disagree with the protocol, so the
 * value is passed through and a wrong shape is reported by Unity with its own,
 * more precise message.
 */
export function encodeAssetValue(propertyPath, value) {
  if (Array.isArray(value)) return JSON.stringify(value.map((item) => JSON.parse(encodeAssetValue(propertyPath, item))))
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('values must be finite JSON numbers.')
    return JSON.stringify(value)
  }
  if (typeof value === 'string') {
    // `fileID #guid` / `{fileID,guid}` style references are passed through as
    // the object-reference form Unity expects.
    const match = /^fileID:(\d+)(?:\s+(?:guid:)?([0-9a-fA-F]{32}))?$/.exec(value.trim())
    if (match) {
      return match[2] ? JSON.stringify({ fileID: match[1], guid: match[2].toLowerCase() }) : JSON.stringify({ fileID: match[1] })
    }
    return JSON.stringify(value)
  }
  if (typeof value === 'object') {
    if ('fileID' in value) {
      const id = String(value.fileID)
      if (!/^-?\d+$/.test(id)) throw new Error(`${propertyPath}: object reference fileID must be a decimal string.`)
      if (id === '0' && Object.keys(value).length === 1) return JSON.stringify({ fileID: '0' })
      if (typeof value.guid !== 'string' || !/^[0-9a-fA-F]{32}$/.test(value.guid)) {
        throw new Error(`${propertyPath}: object reference needs {fileID, guid} (guid = 32 hex digits).`)
      }
      return JSON.stringify({ fileID: id, guid: value.guid.toLowerCase() })
    }
    // A compound struct. Unity walks its serialized children and needs every
    // one of them, so the shape is reported by the broker rather than guessed
    // here; a cycle would make JSON.stringify throw, which is the right outcome.
    for (const [key, member] of Object.entries(value)) {
      if (member === undefined) throw new Error(`${propertyPath}.${key}: compound members must not be undefined.`)
    }
    return JSON.stringify(value)
  }
  throw new Error(`${propertyPath}: unsupported value type ${typeof value}.`)
}

function parseJson(message, what) {
  // Unity's error wording sometimes carries a machine code prefix
  // (`revision_conflict: …`); keep it untouched, only reject non-JSON.
  try {
    return JSON.parse(message || '{}')
  } catch (error) {
    throw new Error(`${what} returned invalid JSON: ${error.message}`)
  }
}

/** `action: read` → validated snapshot JSON. */
export async function readAsset(target, path) {
  const assetPath = String(path ?? '').trim().replaceAll('\\', '/')
  if (!assetPath.startsWith('Assets/')) throw new Error('path must be a project-relative Assets/ path.')
  return withClient(
    target,
    async (client) => {
      const envelope = await client.call('asset_api', JSON.stringify({ action: 'read', path: assetPath }), {
        timeoutMs: 60_000,
      })
      const snapshot = parseJson(envelope.message, 'asset_api read')
      if (!snapshot.revision) throw new Error('asset_api read returned no revision.')
      return snapshot
    },
    { exclusive: true },
  )
}

/**
 * Apply edits inside one owner edit session. Returns the Unity result plus an
 * undo token (the previous revision per file) that `undoAssetEdit` can restore.
 */
export async function applyAssetEdits(target, { snapshot, edits, owner, touchBarrier, undoBarrier }) {
  const request = buildApplyRequest({ snapshot, edits })
  return touchBarrier(async () => {
    const session = await openEditSession(target, owner)
    try {
      const envelope = await withClient(
        target,
        (client) =>
          client.call('asset_api', JSON.stringify(request), { timeoutMs: 180_000 }),
        { exclusive: true },
      )
      const result = parseJson(envelope.message, 'asset_api apply_batch')
      const previous = request.entries.map((entry) => ({
        path: entry.path,
        expected_revision: entry.expected_revision,
        operations_count: entry.operations.length,
      }))
      return {
        applied: result.applied !== false,
        persisted: result.persisted !== false,
        transaction_id: result.transaction_id ?? null,
        timings: result.timings ?? null,
        undo: { kind: 'asset', previous, snapshot_revision: snapshot.revision },
      }
    } finally {
      await session.release()
    }
  }).finally(() => undoBarrier?.())
}

/** `import_assets` for files written outside the editor (Assets/ + Packages/). */
export async function reloadAssets(target, paths, owner) {
  const list = (Array.isArray(paths) ? paths : [paths])
    .map((value) => String(value ?? '').trim().replaceAll('\\', '/'))
    .filter(Boolean)
  if (list.length === 0) throw new Error('paths must list at least one Assets/ or Packages/ path.')
  return withClient(
    target,
    async (client) => {
      const session = owner ? await openEditSession(target, owner) : null
      try {
        const envelope = await client.call('asset_api', JSON.stringify({ action: 'disk_reload', paths: list }), {
          timeoutMs: 120_000,
        })
        return parseJson(envelope.message, 'asset_api disk_reload')
      } finally {
        await session?.release()
      }
    },
    { exclusive: true },
  )
}

