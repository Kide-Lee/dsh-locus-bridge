// Which asset paths the right-Sidebar bridge will touch, and where they live.
//
// The browser never names a filesystem path: it names a project-relative Unity
// asset path (`Assets/…`), exactly the vocabulary `asset_api` and
// `property_tree_*` speak. Resolving that to the Unity project root is the Host
// side's job, and it is the same resolution every `unity_*` tool performs
// (`src/args.js`). Keeping the two apart is what makes a browser request unable
// to name a file outside the project.

import { isAbsolute, relative, resolve, sep } from 'node:path'

/** The Unity asset suffixes `asset_api` can serialize (`LocusBridge.AssetApi.cs`). */
export const ASSET_API_EXTENSIONS = Object.freeze([
  '.asset',
  '.mat',
  '.prefab',
  '.unity',
  '.controller',
  '.anim',
  '.overrideController',
  '.playable',
  '.mask',
])

/**
 * The extension list lowercased for comparison.
 *
 * `suffixOf` lowercases, and Unity itself compares extensions with
 * `OrdinalIgnoreCase` (`OpenAssetApiScope`), so `.overrideController` must match
 * the lowercased suffix a path produces.
 */
const ASSET_API_LOOKUP = new Set(ASSET_API_EXTENSIONS.map((extension) => extension.toLowerCase()))

/**
 * Suffixes the preview claims on a `dsh-resource://file/**` address.
 *
 * These are also the extensions the client registers with its own tab type, so
 * a click on one of these files in the file tree lands here instead of in the
 * plain-text fallback. Two choices worth stating:
 *
 *   * `.unity` is deliberately absent. Reading a scene through the property
 *     tree requires the scene to be *loaded* in the editor, so a click would
 *     either fail or change what the editor has open. Locus makes that trade
 *     for its own asset page (it is an editor surface); a file viewer should
 *     not.
 *   * `.physicsMaterial2D` and friends are here even though `asset_api` refuses
 *     them: `property_tree_read` walks any persistent `UnityEngine.Object`, and
 *     that is the source this panel uses. `asset_api` (`ASSET_API_EXTENSIONS`)
 *     is only the flat-snapshot reader.
 *   * Model files are here because DSH cannot show them any other way and the
 *     broker can: `property_tree_read` returns the imported GameObject and
 *     `asset_preview_render` orbits it. They are **read-only** — see
 *     `isEditableAssetPath` — because an importer's settings are not what the
 *     panel edits, and a mesh is not a serialized field.
 */
export const PREVIEW_EXTENSIONS = Object.freeze([
  'prefab',
  'asset',
  'mat',
  'controller',
  'anim',
  'overridecontroller',
  'playable',
  'mask',
  'physicsmaterial2d',
  'fbx',
  'obj',
  'dae',
  '3ds',
  'max',
  'blend',
  'gltf',
  'glb',
])

/** Model suffixes: previewable (tree + orbit) but never writable. */
export const MODEL_EXTENSIONS = Object.freeze(['.fbx', '.obj', '.dae', '.3ds', '.max', '.blend', '.gltf', '.glb'])

/** True when this suffix is a model (read-only preview only). */
export function isModelPath(path) {
  return MODEL_EXTENSIONS.includes(suffixOf(path))
}

/** Lowercased lookup for `PREVIEW_EXTENSIONS` (`suffixOf` lowercases first). */
const PREVIEW_LOOKUP = new Set(PREVIEW_EXTENSIONS.map((extension) => extension.toLowerCase()))

/** Normalize a browser-supplied asset path; throws when it is not `Assets/…`. */
export function normalizeAssetPath(value) {
  const path = String(value ?? '').trim().replaceAll('\\', '/')
  if (!path) throw new Error('path is required (a project-relative Assets/ path).')
  if (path.includes('\0')) throw new Error('path must not contain a NUL byte.')
  if (isAbsolute(path) || /^[A-Za-z]:\//.test(path) || path.startsWith('//')) {
    throw new Error('path must be project-relative (for example Assets/Prefabs/Player.prefab).')
  }
  const segments = path.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error('path must not contain empty, "." or ".." segments.')
  }
  if (segments[0] !== 'Assets') throw new Error('path must be inside Assets/.')
  return path
}

/** Suffix of an asset path, lowercased, with the leading dot. */
export function suffixOf(path) {
  const name = String(path ?? '').split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot).toLowerCase()
}

/** True when `asset_api` can read and write this suffix. */
export function isAssetApiPath(path) {
  return ASSET_API_LOOKUP.has(suffixOf(path))
}

/** True when the Sidebar previews this suffix at all. */
export function isPreviewPath(path) {
  return PREVIEW_LOOKUP.has(suffixOf(path).slice(1))
}

/**
 * True when the preview may edit this asset through `property_tree_write`.
 *
 * `property_tree_write` works on any persistent object, so the gate is the
 * preview list rather than `asset_api`. Scenes stay read-only: a scene edit has
 * to save the whole scene document, and a viewer that silently saved one would
 * be a data-loss surface for a click.
 */
export function isEditableAssetPath(path) {
  const suffix = suffixOf(path)
  return PREVIEW_LOOKUP.has(suffix.slice(1)) && suffix !== '.unity' && !MODEL_EXTENSIONS.includes(suffix)
}

/**
 * Reject a path that resolves outside the project root.
 *
 * `normalizeAssetPath` already refuses `..`, so this is a second, independent
 * check on the resolved path — the belt to the lexical braces.
 */
export function assertInsideProject(projectRoot, assetPath) {
  const root = resolve(projectRoot)
  const target = resolve(root, assetPath)
  const rel = relative(root, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) {
    throw new Error(`path escapes the Unity project: ${assetPath}`)
  }
  return target
}
