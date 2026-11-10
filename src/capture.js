// Unity viewport capture.
//
// Ported from `Locus/src-tauri/src/unity_bridge/capture.rs`: the broker writes a
// PNG to disk and answers with its path plus the dimensions, so the caller needs
// no image transport of its own. The tool deliberately returns that path rather
// than an image block — DSH's own `read_image` already turns a file on disk into
// an attachment, and duplicating it here would mean a second image pipeline.

import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { withClient } from './client-pool.js'

const CAPTURE_TIMEOUT_MS = 120_000
export const CAPTURE_TARGETS = ['game', 'scene', 'editor_window']
export const DEFAULT_MAX_LONG_EDGE = 1280
const MAX_LONG_EDGE = 8192

/** Validate one capture request into the camelCase payload the broker parses. */
export function buildCaptureRequest({ target, window_title, max_long_edge } = {}) {
  const normalized = String(target ?? '').trim().toLowerCase()
  if (!CAPTURE_TARGETS.includes(normalized)) {
    throw new Error(`target must be one of ${CAPTURE_TARGETS.join(', ')}.`)
  }
  const edge = max_long_edge === undefined || max_long_edge === null ? DEFAULT_MAX_LONG_EDGE : max_long_edge
  if (!Number.isInteger(edge) || edge < 0 || edge > MAX_LONG_EDGE) {
    throw new Error(`max_long_edge must be an integer in 0..${MAX_LONG_EDGE} (0 keeps the source size).`)
  }
  const request = { target: normalized, maxLongEdge: edge }
  const title = String(window_title ?? '').trim()
  if (title) request.windowTitle = title
  return JSON.stringify(request)
}

/** Normalize the broker's answer; unknown fields stay out of the model's view. */
export function parseCapture(message) {
  let parsed
  try {
    parsed = JSON.parse(message || '{}')
  } catch (error) {
    throw new Error(`capture_viewport returned invalid JSON: ${error.message}`)
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('capture_viewport returned an empty response.')
  const path = String(parsed.path ?? '')
  if (!path) throw new Error('capture_viewport did not report a file path.')
  const width = Number(parsed.width ?? parsed.outputWidth ?? 0)
  const height = Number(parsed.height ?? parsed.outputHeight ?? 0)
  return {
    target: String(parsed.target ?? ''),
    title: String(parsed.title ?? ''),
    path,
    width,
    height,
    sourceWidth: Number(parsed.sourceWidth ?? parsed.originalWidth ?? width),
    sourceHeight: Number(parsed.sourceHeight ?? parsed.originalHeight ?? height),
    mimeType: String(parsed.mimeType ?? 'image/png'),
    pixelsPerPoint: Number(parsed.pixelsPerPoint ?? 0),
  }
}

/** Capture one viewport and return the normalized answer (the PNG stays on disk). */
export async function captureViewport(target, request, { signal } = {}) {
  if (signal?.aborted) throw new Error('cancelled')
  const envelope = await withClient(target, (client) =>
    client.call('capture_viewport', request, { timeoutMs: CAPTURE_TIMEOUT_MS }),
  )
  return parseCapture(envelope.message)
}

/**
 * The path the model can hand to `read_image`. Unity answers with a path it
 * considers absolute; a relative one is resolved against the project root.
 */
export function readablePath(projectRoot, captured) {
  const path = captured.path
  const absolute = isAbsolute(path) ? path : resolve(projectRoot, path)
  const exists = existsSync(absolute)
  return {
    absolute,
    exists,
    bytes: exists ? statSync(absolute).size : 0,
  }
}

/** Render a capture for the model, pointing at `read_image` for the pixels. */
export function formatCapture(captured, resolved, { target } = {}) {
  const lines = [
    `Captured ${captured.target || target}${captured.title ? ` (${captured.title})` : ''} to ${resolved.absolute}`,
    `${captured.width}x${captured.height} px, ${captured.mimeType}` +
      (captured.sourceWidth !== captured.width || captured.sourceHeight !== captured.height
        ? ` (downscaled from ${captured.sourceWidth}x${captured.sourceHeight})`
        : '') +
      `${resolved.exists ? `, ${resolved.bytes} bytes` : ''}`,
  ]
  if (resolved.exists) {
    lines.push(`Read the image with read_image: ${resolved.absolute}`)
  } else {
    lines.push('Warning: the reported file is not readable from this host; the editor may run elsewhere.')
  }
  return lines.join('\n')
}

export { CAPTURE_TIMEOUT_MS, MAX_LONG_EDGE }
