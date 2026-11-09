// Scene inspection without leaving the Locus protocol:
//   search  → `search_scene_objects` {query, limit} ranked results
//   get     → `property_tree_read` {target:{kind:'gameobject', scenePath,
//             objectPath}, maxDepth, maxArrayItems} serialized snapshot
//   set     → an atomic `execute_code` wrapper (one undo step) that resolves
//             the object, writes the SerializedProperty, saves the dirty scene
//             and reports the applied value. Edits leave Edit Mode only after
//             `unity_recompile` has applied pending scripts (the property type
//             must exist in the loaded assemblies).

import { withClient } from './client-pool.js'

const SEARCH_LIMIT_DEFAULT = 40
const SEARCH_LIMIT_MAX = 160
const DEPTH_MAX = 16
const ARRAY_ITEMS_MAX = 1024

/** Validate a search request and return the JSON `message` for the bridge. */
export function searchRequest({ query, limit }) {
  const text = String(query ?? '').trim()
  if (!text) throw new Error('query is required (object name or path fragment).')
  const size = limit === undefined ? SEARCH_LIMIT_DEFAULT : limit
  if (!Number.isInteger(size) || size < 1 || size > SEARCH_LIMIT_MAX) {
    throw new Error(`limit must be an integer in 1..${SEARCH_LIMIT_MAX}.`)
  }
  return JSON.stringify({ query: text, limit: size })
}

/** Validate a read request and return the JSON `message` for the bridge. */
export function readRequest({ scenePath, objectPath, maxDepth, maxArrayItems }) {
  if (!String(scenePath ?? '').trim()) throw new Error('scene_path is required (for example Assets/Scenes/Main.unity).')
  if (!String(objectPath ?? '').trim()) throw new Error('object_path is required (for example "Player" or "Canvas/Button").')
  const depth = maxDepth === undefined ? 4 : maxDepth
  const items = maxArrayItems === undefined ? 64 : maxArrayItems
  if (!Number.isInteger(depth) || depth < 1 || depth > DEPTH_MAX) throw new Error(`max_depth must be in 1..${DEPTH_MAX}.`)
  if (!Number.isInteger(items) || items < 1 || items > ARRAY_ITEMS_MAX) {
    throw new Error(`max_array_items must be in 1..${ARRAY_ITEMS_MAX}.`)
  }
  return JSON.stringify({
    target: { kind: 'gameobject', scenePath: String(scenePath).trim(), objectPath: String(objectPath).trim() },
    maxDepth: depth,
    maxArrayItems: items,
  })
}

/** Ask Unity to select (and ping) the object; fails on a stale path. */
export async function selectSceneObject(target, { scenePath, objectPath }) {
  const payload = JSON.stringify({ scenePath: String(scenePath || '').trim(), objectPath: String(objectPath || '').trim() })
  return withClient(target, (client) => client.call('select_scene_object', payload, { timeoutMs: 30_000 }))
}

/** Run the ranked scene-object search and return parsed results. */
export async function searchSceneObjects(target, request) {
  return withClient(
    target,
    async (client) => {
      const envelope = await client.call('search_scene_objects', request, { timeoutMs: 60_000 })
      const parsed = parseJson(envelope.message, 'search_scene_objects')
      return Array.isArray(parsed?.results) ? parsed.results : []
    },
    { exclusive: false },
  )
}

/** Parse one property-tree read answer; throws when the target could not be resolved. */
export function parseTree(message) {
  const tree = parseJson(message, 'property_tree_read')
  if (tree?.ok === false) throw new Error(tree.message || 'property tree read failed')
  return tree
}

/** Read one object's property tree through the bridge. */
export async function readSceneObject(target, request) {
  return withClient(
    target,
    async (client) => parseTree((await client.call('property_tree_read', request, { timeoutMs: 60_000 })).message),
    { exclusive: false },
  )
}

/** Render a property-tree node as one line per field. */
export function formatSceneTree(tree, { maxLines = 200 } = {}) {
  const lines = []
  const walk = (node, indent) => {
    if (!node) return
    if (lines.length >= maxLines) return
    const prefix = '  '.repeat(Math.min(indent, 12))
    const name = node.displayName || node.name || node.propertyPath || '?'
    const type = node.type || node.valueType || ''
    const value = node.isArray ? `[${node.arraySize}]` : node.value !== undefined ? formatValue(node.value) : node.displayValue || ''
    lines.push(`${prefix}${name}${type ? ` (${type})` : ''}${value !== '' ? ` = ${value}` : ''}`)
    if (Array.isArray(node.children)) for (const child of node.children) walk(child, indent + 1)
  }
  walk(tree, 0)
  if (lines.length >= maxLines) lines.push(`… (truncated at ${maxLines} lines)`)
  return lines.join('\n')
}

function formatValue(value) {
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'object') {
    const short = JSON.stringify(value)
    return short.length > 80 ? `${short.slice(0, 77)}…` : short
  }
  return String(value)
}

function parseJson(message, what) {
  try {
    return JSON.parse(message || '{}')
  } catch (error) {
    throw new Error(`${what} returned invalid JSON: ${error.message}`)
  }
}

export { SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, DEPTH_MAX, ARRAY_ITEMS_MAX }
