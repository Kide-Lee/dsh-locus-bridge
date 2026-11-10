// Connect a Unity project to the Locus bridge: diagnose what is missing, and
// (on explicit confirmation) install the package this plugin ships.
//
// Three facts drive the design:
//
//   * The native broker only starts when the editor sees
//     `Library/Locus/NativeBridge.enabled` (or `LOCUS_UNITY_NATIVE_BRIDGE=1`).
//     Upstream's desktop client writes that marker; the Unity package itself
//     writes it back only on Linux/macOS, because it can derive a Unix socket
//     path but on Windows relies on the client for the pipe name. Without this
//     module a Windows project with a perfect install still never connects.
//
//   * Upstream git-ignores the compiled DLLs, so a UPM `git+https://…?path=`
//     dependency installs a package that cannot compile. The only install
//     source that works everywhere is a local, complete package — the one
//     vendored under `payload/locus_unity` and copied in by
//     `scripts/sync-payload.mjs`.
//
//   * Diagnostic data is per project and must not open the broker. Every check
//     below is a filesystem probe, so `unity_status(setup:)` answers while the
//     editor is closed or not yet installed.

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePipeName } from './pipe-name.js'

const PACKAGE_ID = 'com.farlocus.locus'
/** Where the editor loads the package from, matching upstream's install layout. */
const INSTALL_DIR = join('Packages', PACKAGE_ID)
const MARKER = join('Library', 'Locus', 'NativeBridge.enabled')

/** Assemblies the package needs on disk, matched by file name at any depth. */
const REQUIRED_ASSEMBLIES = [
  'Locus.Json.dll',
  'Locus.Roslyn.dll',
  'Locus.Detour.dll',
  'Locus.HotReload.Runtime.dll',
]

/** Broker library file name per host platform; the same name Unity resolves. */
const NATIVE_LIBRARY = {
  win32: { file: 'locus_unity_native.dll', relative: join('Editor', 'Native', 'x86_64', 'locus_unity_native.dll') },
  linux: { file: 'liblocus_unity_native.so', relative: join('Editor', 'Native', 'linux-x86_64', 'liblocus_unity_native.so') },
  darwin: { file: 'liblocus_unity_native.so', relative: join('Editor', 'Native', 'linux-x86_64', 'liblocus_unity_native.so') },
}

/** Holds the built `locus_unity` tree; see `scripts/sync-payload.mjs`. */
const BUNDLED_PAYLOAD_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'payload', 'locus_unity')

/**
 * The package tree this build installs.
 *
 * `DSH_LOCUS_PAYLOAD_DIR` lets a deployment keep the 15 MB tree outside the
 * npm tarball (for example unpacked from a release asset), and lets tests point
 * at a fixture without touching the real payload.
 */
export function payloadDir(env = process.env) {
  const override = String(env.DSH_LOCUS_PAYLOAD_DIR ?? '').trim()
  return override ? override : BUNDLED_PAYLOAD_DIR
}

/** Read the payload's own version, without trusting it to exist. */
function payloadVersion(env = process.env) {
  try {
    return JSON.parse(readFileSync(join(payloadDir(env), 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** First path under `root` whose base name is `name` (breadth-first), or null. */
function findByName(root, name) {
  const frontier = [root]
  while (frontier.length > 0) {
    const dir = frontier.shift()
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === name) return join(dir, entry.name)
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'obj' && entry.name !== 'bin') {
        frontier.push(join(dir, entry.name))
      }
    }
  }
  return null
}

/** Native broker description for this host, or null on an unsupported platform. */
export function nativeBrokerFor(platform = process.platform) {
  return NATIVE_LIBRARY[platform] ?? null
}

/**
 * The package the editor currently loads, if any.
 *
 * Three shapes count as installed: a `Packages/com.farlocus.locus` directory, a
 * `file:` manifest dependency that resolves to a complete local package (how a
 * checkout next to the project is wired), and a legacy `Assets/Locus` copy.
 * The last two are reported separately because only the first is what this
 * module installs.
 */
function installedPackage(projectRoot) {
  const primary = join(projectRoot, INSTALL_DIR)
  const dependency = manifestDependency(projectRoot)
  const legacy = ['Assets/Locus', 'Assets/Plugins/Locus']
    .map((rel) => ({ rel, root: join(projectRoot, rel) }))
    .find(({ root }) => isFile(join(root, 'package.json')))

  const resolve = () => {
    if (isFile(join(primary, 'package.json'))) {
      return { root: primary, relativeRoot: INSTALL_DIR.split('\\').join('/'), via: 'packages' }
    }
    if (legacy) return { root: legacy.root, relativeRoot: legacy.rel, via: 'assets' }
    if (dependency.declared && dependency.localPath && dependency.resolves) {
      return { root: dependency.localPath, relativeRoot: dependency.specifier, via: 'file-dependency' }
    }
    return null
  }

  const found = resolve()
  if (!found) return null
  const manifest = readJson(join(found.root, 'package.json')) ?? {}
  return {
    ...found,
    legacy: found.via === 'assets',
    name: manifest.name ?? null,
    version: manifest.version ?? null,
  }
}

/** Project-relative form of an absolute path inside the project. */
function relativeTo(projectRoot, path) {
  const prefix = projectRoot.endsWith('/') || projectRoot.endsWith('\\') ? projectRoot : `${projectRoot}${process.platform === 'win32' ? '\\' : '/'}`
  return path.toLowerCase().startsWith(prefix.toLowerCase()) ? path.slice(prefix.length).split('\\').join('/') : path
}

/**
 * Whether the project declares or vendors the Locus package.
 *
 * A `file:` entry pointing at a complete local package is reported as such: it
 * needs no install step, only the marker.
 */
export function manifestDependency(projectRoot) {
  const manifest = readJson(join(projectRoot, 'Packages', 'manifest.json'))
  const entry = manifest?.dependencies?.[PACKAGE_ID]
  if (!entry) return { declared: false, specifier: null, localPath: null, resolves: false }
  const specifier = String(entry)
  const local = specifier.startsWith('file:') ? join(projectRoot, 'Packages', specifier.slice('file:'.length)) : null
  return {
    declared: true,
    specifier,
    localPath: local,
    resolves: local ? isFile(join(local, 'package.json')) : false,
  }
}

/**
 * Diagnose one project without touching the editor.
 *
 * Returns the raw facts; `formatSetup` turns them into the text the model sees
 * and `installPackage` acts on them. `ready` means "connectable as-is", which
 * requires the package, the broker library, and the marker.
 */
export function inspectSetup(projectRoot, { platform = process.platform, env = process.env } = {}) {
  const pkg = installedPackage(projectRoot)
  const dependency = manifestDependency(projectRoot)
  const broker = nativeBrokerFor(platform)

  // The marker read here must match what the editor resolves, so reuse the
  // shared name derivation rather than re-implementing the project key.
  const markerPath = join(projectRoot, MARKER)
  const markerPresent = isFile(markerPath)
  const markerLines = markerPresent ? safeLines(markerPath) : []
  const markerEndpoint = markerLines.find(Boolean) ?? null
  const endpoint = resolvePipeName({ projectRoot, markerLines, env })

  const packageRoot = pkg?.root ?? (dependency.localPath && dependency.resolves ? dependency.localPath : null)
  const missingAssemblies = packageRoot ? REQUIRED_ASSEMBLIES.filter((name) => !findByName(packageRoot, name)) : [...REQUIRED_ASSEMBLIES]
  const brokerPath = packageRoot && broker ? join(packageRoot, broker.relative) : null
  const brokerPresent = brokerPath ? isFile(brokerPath) : false

  const envOverride = String(env.LOCUS_UNITY_NATIVE_BRIDGE ?? '') === '1' || String(env.LOCUS_UNITY_NATIVE_BRIDGE ?? '').toLowerCase() === 'true'
  const payloadRoot = payloadDir(env)
  const payloadAvailable = isFile(join(payloadRoot, 'package.json'))
  const payloadBrokerPresent = broker ? isFile(join(payloadRoot, broker.relative)) : false

  const problems = []
  if (!packageRoot) problems.push({ code: 'package_missing', detail: `${PACKAGE_ID} is not installed in this project.` })
  if (packageRoot && missingAssemblies.length > 0) {
    problems.push({ code: 'package_incomplete', detail: `The installed package is missing ${missingAssemblies.join(', ')}.` })
  }
  if (broker && packageRoot && !brokerPresent) {
    problems.push({
      code: 'broker_missing',
      detail: `The package has no ${broker.file}; the bridge cannot start on this platform.`,
    })
  }
  if (broker && !packageRoot && payloadAvailable && !payloadBrokerPresent) {
    problems.push({
      code: 'payload_lacks_broker',
      detail: `The bundled package has no ${broker.file} for this platform, so installing it would still not connect.`,
    })
  }
  if (!markerPresent && !envOverride) {
    problems.push({
      code: 'marker_missing',
      detail: `The editor starts the native bridge only when ${MARKER.split('\\').join('/')} exists or LOCUS_UNITY_NATIVE_BRIDGE=1 is set.`,
    })
  }
  if (pkg?.legacy) {
    problems.push({ code: 'legacy_install', detail: `The package is installed at ${pkg.relativeRoot}; ${INSTALL_DIR.split('\\').join('/')} is the current location.` })
  }

  return {
    projectRoot,
    package: pkg
      ? { relativeRoot: pkg.relativeRoot, via: pkg.via, version: pkg.version, legacy: pkg.legacy, missingAssemblies }
      : dependency.declared && dependency.specifier
        ? { declaredOnly: true, specifier: dependency.specifier, resolves: dependency.resolves }
        : null,
    broker: broker
      ? {
          file: broker.file,
          // Without a package there is nothing to look inside; saying "missing"
          // would blame the wrong thing.
          known: Boolean(packageRoot),
          present: brokerPresent,
          path: brokerPresent ? relativeTo(projectRoot, brokerPath) : null,
        }
      : null,
    brokerMissingForHost: Boolean(broker && !brokerPresent && packageRoot),
    marker: { present: markerPresent, endpoint: markerEndpoint, envOverride },
    endpoint,
    payload: { available: payloadAvailable, version: payloadVersion(env), brokerForHost: payloadBrokerPresent },
    problems,
    ready: problems.length === 0,
  }
}

function safeLines(path) {
  try {
    return readFileSync(path, 'utf8').split(/\r?\n/)
  } catch {
    return []
  }
}

// ─── package install ────────────────────────────────────────────────────────

/** Content hash over the payload tree, ignoring the same entries Unity ignores. */
function payloadDigest(root = payloadDir()) {
  const entries = []
  walk(root, root, entries)
  entries.sort((a, b) => a.rel.localeCompare(b.rel))
  const hash = createHash('sha256')
  for (const { rel, path } of entries) {
    hash.update(rel)
    hash.update('\0')
    hash.update(readFileSync(path))
    hash.update('\0')
  }
  return hash.digest('hex')
}

function walk(root, dir, out) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === 'obj' || entry.name === 'bin' || entry.name.startsWith('ILRepack-') || entry.name.endsWith('~')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(root, full, out)
    else if (entry.isFile()) out.push({ rel: relativeTo(root, full), path: full })
  }
}

/**
 * Copy the bundled package into the project.
 *
 * Staged in `Library/Locus/` first so a failed copy never leaves a half-written
 * package that Unity would try to compile: the target is removed only after the
 * copy is complete. An embedded `Packages/` copy takes precedence over a
 * manifest dependency, so a leftover `file:` entry is reported instead of
 * silently rewritten — deleting another tool's manifest line is not this
 * module's decision.
 */
export function installPackage(projectRoot) {
  const payloadRoot = payloadDir()
  if (!isFile(join(payloadRoot, 'package.json'))) {
    throw new Error(
      'This build of dsh-locus-bridge has no bundled Locus package. ' +
        'Run `npm run sync:payload` against a Locus checkout that has the compiled DLLs.',
    )
  }

  const target = join(projectRoot, INSTALL_DIR)
  const staging = join(projectRoot, 'Library', 'Locus', 'package-staging')
  const preserved = collectPreserved(join(target, 'Editor', 'Skills'))

  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  try {
    copyTree(payloadRoot, staging)
    for (const rel of preserved) {
      const source = join(target, rel)
      if (!isFile(source)) continue
      const dest = join(staging, rel)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, readFileSync(source))
    }
    writeFileSync(join(staging, '.locus_plugin_hash'), `${payloadDigest(payloadRoot)}\n`)
    rmSync(target, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    try {
      renameSync(staging, target)
    } catch {
      // A cross-device or in-use rename falls back to a copy; Library and
      // Packages share a volume in practice, so this is a last resort.
      copyTree(staging, target)
      rmSync(staging, { recursive: true, force: true })
    }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    throw error
  }

  return { target, relativeTarget: INSTALL_DIR.split('\\').join('/'), keptSkills: preserved.length, version: payloadVersion() }
}

/** Files under `Editor/Skills` the user wrote, which an upgrade must keep. */
function collectPreserved(skillsDir) {
  if (!isDir(skillsDir)) return []
  const out = []
  walk(skillsDir, skillsDir, out)
  return out.map(({ rel }) => join('Editor', 'Skills', rel))
}

function copyTree(source, dest) {
  let entries
  try {
    entries = readdirSync(source, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === 'obj' || entry.name === 'bin' || entry.name.startsWith('ILRepack-') || entry.name.endsWith('~')) continue
    const from = join(source, entry.name)
    const to = join(dest, entry.name)
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true })
      copyTree(from, to)
    } else if (entry.isFile()) {
      mkdirSync(dirname(to), { recursive: true })
      writeFileSync(to, readFileSync(from))
    }
  }
}

// ─── marker ─────────────────────────────────────────────────────────────────

/**
 * Write the native-bridge marker with the endpoint this client derives.
 *
 * Only meaningful on Windows/macOS: on Linux the package publishes the marker
 * itself, and on Win32 Unity must be told the pipe name the client will dial.
 * Rewriting an existing marker is load-bearing — its content is the endpoint,
 * so a stale file from another checkout would point at a socket nobody serves.
 */
export function writeMarker(projectRoot, endpoint = resolvePipeName({ projectRoot })) {
  if (!endpoint) throw new Error('Cannot write the native-bridge marker: no endpoint could be derived.')
  const path = join(projectRoot, MARKER)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${endpoint}\n`)
  return { path, relativePath: MARKER.split('\\').join('/'), endpoint }
}

// ─── reporting ──────────────────────────────────────────────────────────────

/**
 * Render what is wrong with a project, and — only when the package is missing —
 * how to install it.
 *
 * Two constraints shape this:
 *
 *   * A healthy project renders nothing. "The package is present" is the absence
 *     of a finding, and reporting it on every call would cost context while
 *     answering nothing.
 *   * Install instructions are unreachable from the tool schema on purpose. The
 *     schema stays identical to the upstream client's, so a project that already
 *     works pays no context for a capability it will never use. The instructions
 *     appear here, once, in the only situation that makes them actionable.
 */
export function formatSetup(result) {
  const lines = result.problems.map((problem) => `${problem.detail}${hintFor(problem.code, result)}`)
  const install = installInstructions(result)
  if (install) lines.push('', install)
  return lines.join('\n')
}

/** One imperative sentence per blocking code; empty when the detail says it. */
function hintFor(code, result) {
  switch (code) {
    case 'marker_missing':
      return ' Reopen the editor once the package is in place; the bridge needs this marker.'
    case 'broker_missing':
      return ' Build the broker for this platform and copy it into the package.'
    case 'legacy_install':
      return ' Move it to Packages/com.farlocus.locus.'
    default:
      return ''
  }
}

/**
 * The install recipe, emitted only when the package itself is absent.
 *
 * A missing package is the one failure the agent can fix unaided, so this is the
 * single place that says how. Everything else stays a report of the problem.
 */
function installInstructions(result) {
  const missing = result.problems.some((p) => p.code === 'package_missing')
  if (!missing) return null
  const version = result.payload.version ? ` v${result.payload.version}` : ''
  const lines = [
    `The project has no Locus Unity package. ${result.payload.available
      ? `This plugin bundles one${version} and can install it:`
      : 'This build bundles none, so obtain a complete package from Locus upstream.'}`,
  ]
  if (result.payload.available) {
    lines.push(
      `  node ${installerScript()} ${result.projectRoot} --install`,
      'That copies the package into ' + INSTALL_DIR.split('\\').join('/') + ', writes ' +
        'Library/Locus/NativeBridge.enabled, and verifies the result.',
      'Run it with the Unity Editor closed: Unity holds the package assemblies open.',
      'Then reopen the editor and run unity_status again.',
    )
  } else {
    lines.push(
      `  Copy a complete package (including its compiled .dll files) to ${INSTALL_DIR.split('\\').join('/')}/,`,
      '  then write Library/Locus/NativeBridge.enabled containing the endpoint this client dials:',
      `  ${result.endpoint}`,
    )
  }
  return lines.join('\n')
}

/** Absolute path to the installer script, for a copy-pasteable command. */
function installerScript() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'install-unity-package.mjs')
}
