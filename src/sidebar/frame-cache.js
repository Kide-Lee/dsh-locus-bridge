// Persisted "last orbit frame" cache for prefab previews.
//
// This mirrors Locus' desktop cache: one PNG plus one JSON sidecar per asset
// under `Library/Locus/asset-preview-cache/`, keyed by a digest of the
// lowercased project-relative path. The sidecar records the file mtime and the
// exact camera parameters, so a changed prefab (or a different angle) can never
// be served from a stale frame.
//
// Locus hashes with BLAKE3; Node's built-in crypto has no BLAKE3, so this uses
// SHA-256. The digest is only a filename — Locus and this plugin can share the
// directory because the sidecar schema is identical (`camelCase` fields), while
// each writes its own hash-named pair.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Directory (relative to a Unity project) Locus and this plugin share. */
export const FRAME_CACHE_DIR = Object.freeze(['Library', 'Locus', 'asset-preview-cache'])

/** Stable cache key for one asset path (case-insensitive, like a Unity path). */
export function frameCacheKey(assetPath) {
  return createHash('sha256').update(String(assetPath ?? '').toLowerCase()).digest('hex')
}

/** Absolute PNG + JSON paths for one asset. */
export function frameCachePaths(projectRoot, assetPath) {
  const key = frameCacheKey(assetPath)
  const dir = join(projectRoot, ...FRAME_CACHE_DIR)
  return { dir, image: join(dir, `${key}.png`), meta: join(dir, `${key}.json`) }
}

/** Current mtime of the source asset in whole milliseconds, or null when absent. */
export function sourceMtimeMs(projectRoot, assetPath) {
  try {
    const info = statSync(join(projectRoot, assetPath))
    return Number.isFinite(info.mtimeMs) ? Math.trunc(info.mtimeMs) : null
  } catch {
    return null
  }
}

/**
 * Read the cached frame for an asset.
 *
 * Returns null for any inconsistency — missing pair, unreadable JSON, a
 * different asset, a different source mtime, or a corrupt image — so callers
 * fall back to a live render instead of showing the wrong picture.
 */
export function readFrameCache(projectRoot, assetPath, { expectedMtimeMs, params } = {}) {
  const mtime = sourceMtimeMs(projectRoot, assetPath)
  if (mtime === null) return null
  if (expectedMtimeMs !== undefined && expectedMtimeMs !== null && mtime !== expectedMtimeMs) return null

  const { image, meta: metaPath } = frameCachePaths(projectRoot, assetPath)
  let meta
  try {
    meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch {
    return null
  }
  if (!meta || meta.assetPath !== assetPath) return null
  if (Math.trunc(Number(meta.sourceMtimeMs)) !== mtime) return null
  const width = Number(meta.width)
  const height = Number(meta.height)
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) return null

  // A caller that already knows the camera it wants can reject a mismatched
  // sidecar before reading the PNG. During a drag this saves a read per frame.
  if (params && !frameParamsMatch(meta, params)) return null

  let bytes
  try {
    bytes = readFileSync(image)
  } catch {
    return null
  }
  // A truncated/corrupt cache entry must fall back to a live render, not be
  // handed to the browser where it would decode as a broken image.
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < png.length || png.some((byte, index) => bytes[index] !== byte)) return null

  return {
    bytes,
    assetPath,
    sourceMtimeMs: mtime,
    width,
    height,
    mimeType: typeof meta.mimeType === 'string' && meta.mimeType ? meta.mimeType : 'image/png',
    yaw: Number(meta.yaw) || 0,
    pitch: Number(meta.pitch) || 0,
    distance: Number(meta.distance) || 1.15,
    panX: Number(meta.panX) || 0,
    panY: Number(meta.panY) || 0,
    panZ: Number(meta.panZ) || 0,
  }
}

/**
 * Persist one rendered frame. Best-effort by contract: a read-only project or a
 * concurrent writer must not turn a successful render into an error.
 */
export function writeFrameCache(projectRoot, assetPath, frame) {
  const mtime = sourceMtimeMs(projectRoot, assetPath)
  if (mtime === null) throw new Error(`Asset is not readable: ${assetPath}`)

  const { dir, image, meta } = frameCachePaths(projectRoot, assetPath)
  mkdirSync(dir, { recursive: true })

  const record = {
    assetPath,
    sourceMtimeMs: mtime,
    width: Math.max(1, Math.trunc(Number(frame.width) || 1)),
    height: Math.max(1, Math.trunc(Number(frame.height) || 1)),
    mimeType: frame.mimeType || 'image/png',
    yaw: Number(frame.yaw) || 0,
    pitch: Number(frame.pitch) || 0,
    distance: Number(frame.distance) || 1.15,
    panX: Number(frame.panX) || 0,
    panY: Number(frame.panY) || 0,
    panZ: Number(frame.panZ) || 0,
  }

  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`
  const imageTmp = `${image}.${suffix}.tmp`
  const metaTmp = `${meta}.${suffix}.tmp`
  try {
    writeFileSync(imageTmp, frame.bytes)
    writeFileSync(metaTmp, JSON.stringify(record))
    // Image first, metadata last: a reader never sees a new sidecar pointing at
    // an old image (the reverse mismatch only causes a redundant render).
    renameSync(imageTmp, image)
    renameSync(metaTmp, meta)
  } finally {
    for (const path of [imageTmp, metaTmp]) {
      try {
        unlinkSync(path)
      } catch {
        // The temporary file was already renamed (or never created).
      }
    }
  }
  return record
}

/** Compare a cached frame's camera to a request, within float noise. */
export function frameParamsMatch(frame, params, epsilon = 1e-3) {
  if (!frame || !params) return false
  for (const key of ['yaw', 'pitch', 'distance', 'panX', 'panY', 'panZ']) {
    const expected = Number(params[key] ?? 0)
    const actual = Number(frame[key] ?? 0)
    if (!Number.isFinite(expected) || !Number.isFinite(actual) || Math.abs(expected - actual) > epsilon) return false
  }
  return true
}
