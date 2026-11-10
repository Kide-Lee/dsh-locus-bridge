// Port of Locus `crates/locus-native-protocol/src/names.rs`, plus the Unix
// endpoint derivation the Linux/macOS port uses (`locus_unix_native/src/names_unix.rs`).
//
// The Unity plugin derives the broker endpoint from the project root and must
// stay byte-identical with every older Locus build (`LocusBridge.Native.cs`
// `GenerateNativePipeName`), so this file is a deliberate line-by-line mirror.

import { createHash } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'

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

/**
 * True when `endpoint` is an absolute Unix socket path rather than a Win32 pipe
 * name. The Unity plugin writes exactly this form into the marker on Linux, and
 * the native broker binds the same path.
 */
export function isSocketEndpoint(endpoint) {
  const value = String(endpoint ?? '').trim()
  return value.startsWith('/')
}

/**
 * Full `\\.\pipe\…` path for a bare or full pipe name.
 *
 * Absolute Unix socket paths are returned unchanged: they are already the exact
 * endpoint the broker bound (see `isSocketEndpoint`).
 */
export function normalizePipeName(pipeName) {
  const value = String(pipeName ?? '').trim()
  if (isSocketEndpoint(value)) return value
  if (value.startsWith(PIPE_PREFIX)) return value
  return `${PIPE_PREFIX}${value.replace(/^\\+/, '')}`
}

/**
 * The directory the Unix broker puts its objects in.
 *
 * Mirrors `names_unix::runtime_root`: `$XDG_RUNTIME_DIR/locus` when writable,
 * else `$TMPDIR/locus`, else `/tmp/locus`. The broker itself probes by creating
 * the directory, so a plain write check is close enough for the fallback: the
 * marker file stays authoritative and this only covers a missing marker.
 * `runtimeRoot` overrides the probe entirely (used by tests and by a caller that
 * knows where the broker put its socket).
 */
export function unixRuntimeRoot({ env = process.env, runtimeRoot } = {}) {
  if (runtimeRoot) return String(runtimeRoot)
  const candidates = [env.XDG_RUNTIME_DIR, env.TMPDIR, '/tmp'].filter(Boolean)
  for (const base of candidates) {
    const dir = join(base, 'locus')
    try {
      accessSync(dir, constants.W_OK)
      return dir
    } catch {
      // not there yet: the broker may still be able to create it
      try {
        accessSync(base, constants.W_OK)
        return dir
      } catch {
        // keep looking
      }
    }
  }
  return '/tmp/locus'
}

/** Absolute Unix socket path the broker derives for one Unity project. */
export function unitySocketPath(projectPath, options) {
  return join(unixRuntimeRoot(options), `${unityPipeNamePart(projectPath)}.sock`)
}

/** Endpoint shape on this host: socket paths on Unix, Win32 pipe names on Windows. */
export function isWindowsHost() {
  return process.platform === 'win32'
}

/**
 * Resolve the endpoint a Locus client should connect to.
 *
 * Precedence (highest first):
 *   1. an explicit pipe name or socket path;
 *   2. the first non-empty line of `<project>/Library/Locus/NativeBridge.enabled`
 *      (the plugin reads the same line, so both ends agree byte-for-byte);
 *   3. the name derived from the project root — a `\\.\pipe\…` name on Windows,
 *      an absolute `.sock` path elsewhere;
 *   4. `LOCUS_UNITY_TEST_PIPE_NAMESPACE` (same suffix rule as the Rust client),
 *      which lets a test broker live next to a production one.
 */
export function resolvePipeName({ projectRoot, pipe, markerLines, env, runtimeRoot } = {}) {
  if (pipe && String(pipe).trim()) return normalizePipeName(pipe)
  const markerLine = (markerLines ?? [])
    .map((line) => String(line).replace(/^\uFEFF/, '').trim())
    .find(Boolean)
  if (markerLine) return normalizePipeName(markerLine)
  if (!projectRoot || !String(projectRoot).trim()) return ''
  const namespace = env ? env.LOCUS_UNITY_TEST_PIPE_NAMESPACE : process.env.LOCUS_UNITY_TEST_PIPE_NAMESPACE
  const suffix = namespace && /^[A-Za-z0-9-]{1,64}$/.test(namespace) ? `_${namespace}` : ''
  if (isWindowsHost()) {
    return `${PIPE_PREFIX}${unityPipeNamePart(projectRoot)}${suffix}`
  }
  const derived = unitySocketPath(projectRoot, { env, runtimeRoot })
  return suffix ? derived.replace(/\.sock$/, `${suffix}.sock`) : derived
}
