// Port of Locus `crates/locus-native-protocol/src/names.rs`.
//
// The Unity plugin derives the broker pipe name from the project root and must
// stay byte-identical with every older Locus build (`LocusBridge.Native.cs`
// `GenerateNativePipeName`), so this file is a deliberate line-by-line mirror.

import { createHash } from 'node:crypto'

const PIPE_PREFIX = '\\\\.\\pipe\\'

/** Lowercase, backslash-separated, no trailing separator (drive roots keep theirs). */
export function normalizeProjectPath(projectPath) {
  const trimmed = String(projectPath ?? '').replace(/^\\\\\?\\/, '').trim()
  let value = trimmed.replaceAll('/', '\\')
  while (value.endsWith('\\') && value.length > 3) value = value.slice(0, -1)
  return value.toLowerCase()
}

/** First 16 bytes of SHA-256 over the normalized project path, as hex. */
export function projectKey(projectPath) {
  return createHash('sha256').update(normalizeProjectPath(projectPath), 'utf8').digest('hex').slice(0, 32)
}

/** Unity broker pipe name without the `\\.\pipe\` prefix. */
export function unityPipeNamePart(projectPath) {
  return `locus_unity_native_${projectKey(projectPath)}`
}

/** Full `\\.\pipe\…` path for a bare or full pipe name. */
export function normalizePipeName(pipeName) {
  const value = String(pipeName ?? '').trim()
  if (value.startsWith(PIPE_PREFIX)) return value
  return `${PIPE_PREFIX}${value.replace(/^\\+/, '')}`
}

/**
 * Resolve the pipe a Locus client should connect to.
 *
 * Precedence (highest first):
 *   1. an explicit pipe name;
 *   2. the first non-empty line of `<project>/Library/Locus/NativeBridge.enabled`
 *      (the plugin reads the same line, so both ends agree byte-for-byte);
 *   3. the name derived from the project root;
 *   4. `LOCUS_UNITY_TEST_PIPE_NAMESPACE` (same suffix rule as the Rust client),
 *      which lets a test broker live next to a production one.
 */
export function resolvePipeName({ projectRoot, pipe, markerLines } = {}) {
  if (pipe && String(pipe).trim()) return normalizePipeName(pipe)
  const markerLine = (markerLines ?? [])
    .map((line) => String(line).replace(/^\uFEFF/, '').trim())
    .find(Boolean)
  if (markerLine) return normalizePipeName(markerLine)
  const namespace = process.env.LOCUS_UNITY_TEST_PIPE_NAMESPACE
  const suffix = namespace && /^[A-Za-z0-9-]{1,64}$/.test(namespace) ? `_${namespace}` : ''
  if (projectRoot && String(projectRoot).trim()) {
    return `${PIPE_PREFIX}${unityPipeNamePart(projectRoot)}${suffix}`
  }
  return ''
}
