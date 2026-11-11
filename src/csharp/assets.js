// Acquisition of the Roslyn language server, the Unity analyzers and the .NET
// runtime that hosts them.
//
// Mirrors `Locus/src-tauri/src/csharp_lsp/assets.rs` and `dotnet_runtime.rs`,
// with two deliberate differences:
//
//   * the Unix archives are supported. Upstream only wires up Windows ZIPs
//     because its downloader assumed zip; this plugin targets Linux/macOS
//     first (the broker port is Unix-only), so `dotnet-runtime-<v>-<rid>.tar.gz`
//     is handled by `archive.js`.
//   * nothing is downloaded implicitly. `installAssets()` must be called (the
//     `code_analysis` tool's `install` action does) so a 90 MB fetch is never a
//     surprise side effect of a query.
//
// The server and analyzers are pinned to the versions upstream ships so a
// workspace behaves the same in both clients.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

import { extractArchive } from './archive.js'

const execFileAsync = promisify(execFile)

/** Roslyn language server build, matching `assets.rs::SERVER_VERSION`. */
export const SERVER_VERSION = '5.4.0-2.26179.14'
/** Microsoft.Unity.Analyzers, matching `assets.rs::UNITY_ANALYZERS_VERSION`. */
export const UNITY_ANALYZERS_VERSION = '1.26.0'
/** Runtime line both managed sidecars target (`dotnet_runtime.rs`). */
export const DOTNET_RUNTIME_VERSION = '10.0.9'
const DOTNET_RUNTIME_MAJOR = '10.0.0'

const COMPLETE_MARKER = '.locus-complete'
const DOWNLOAD_TIMEOUT_MS = 20 * 60 * 1000

/** An asset could not be downloaded or unpacked. */
export class AssetError extends Error {
  constructor(message, { code = null, hint = null } = {}) {
    super(message)
    this.name = 'AssetError'
    this.code = code
    this.hint = hint
  }
}

/** Runtime identifier for a host, or `null` when the platform is unsupported. */
export function platformRid(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return arch === 'arm64' ? 'win-arm64' : 'win-x64'
  if (platform === 'darwin') return arch === 'arm64' ? 'osx-arm64' : 'osx-x64'
  if (platform === 'linux') return arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
  return null
}

export function isPlatformSupported(platform = process.platform, arch = process.arch) {
  return platformRid(platform, arch) !== null
}

/**
 * Root that holds every downloaded asset.
 *
 * `DSH_LOCUS_CSHARP_HOME` overrides it so tests and air-gapped deployments can
 * pre-seed the tree; otherwise it sits beside the other Locus caches under the
 * user's data directory, matching the desktop layout (`csharp-lsp/`).
 */
export function assetsRoot(env = process.env) {
  if (env.DSH_LOCUS_CSHARP_HOME) return env.DSH_LOCUS_CSHARP_HOME
  const base =
    process.platform === 'win32'
      ? env.APPDATA || join(homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(base, 'locus', 'csharp-lsp')
}

function markerPath(dir) {
  return join(dir, COMPLETE_MARKER)
}

function isComplete(dir) {
  return existsSync(markerPath(dir))
}

function markComplete(dir) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(markerPath(dir), `${new Date().toISOString()}\n`)
}

export function serverDir(env = process.env, rid = platformRid()) {
  return join(assetsRoot(env), 'server', SERVER_VERSION, rid)
}

export function serverDllPath(env = process.env, rid = platformRid()) {
  return join(serverDir(env, rid), 'Microsoft.CodeAnalysis.LanguageServer.dll')
}

export function unityAnalyzersDir(env = process.env) {
  return join(assetsRoot(env), 'unity-analyzers', UNITY_ANALYZERS_VERSION)
}

export function dotnetDir(env = process.env, rid = platformRid()) {
  return join(assetsRoot(env), 'dotnet', DOTNET_RUNTIME_VERSION, rid)
}

function serverDownloadUrl(rid) {
  const id = `microsoft.codeanalysis.languageserver.${rid}`
  const version = SERVER_VERSION.toLowerCase()
  return (
    'https://pkgs.dev.azure.com/azure-public/vside/_packaging/vs-impl/nuget/v3/flat2/' +
    `${id}/${version}/${id}.${version}.nupkg`
  )
}

function analyzersDownloadUrl() {
  return (
    'https://api.nuget.org/v3-flatcontainer/microsoft.unity.analyzers/' +
    `${UNITY_ANALYZERS_VERSION}/microsoft.unity.analyzers.${UNITY_ANALYZERS_VERSION}.nupkg`
  )
}

function runtimeDownloadUrl(rid) {
  const base = `https://builds.dotnet.microsoft.com/dotnet/Runtime/${DOTNET_RUNTIME_VERSION}`
  if (rid.startsWith('win-')) return `${base}/dotnet-runtime-${DOTNET_RUNTIME_VERSION}-${rid}.zip`
  return `${base}/dotnet-runtime-${DOTNET_RUNTIME_VERSION}-${rid}.tar.gz`
}

/**
 * Download one URL to `target`, atomically.
 *
 * A partial file is never left behind under the final name: the body lands in
 * `<target>.part` and is renamed only after the stream ends cleanly.
 */
export async function downloadToFile(url, target, { fetchImpl = fetch, onProgress = null, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  mkdirSync(dirname(target), { recursive: true })
  const partial = `${target}.part`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetchImpl(url, { signal: controller.signal, redirect: 'follow' })
  } catch (error) {
    clearTimeout(timer)
    throw new AssetError(`cannot reach ${url}: ${error.message}`, { code: 'download_failed' })
  }
  if (!response.ok) {
    clearTimeout(timer)
    throw new AssetError(`${url} answered HTTP ${response.status}`, { code: 'download_failed' })
  }
  const total = Number(response.headers.get('content-length') ?? 0) || null
  const chunks = []
  let received = 0
  try {
    for await (const chunk of response.body) {
      chunks.push(Buffer.from(chunk))
      received += chunk.length
      onProgress?.({ received, total })
    }
  } catch (error) {
    clearTimeout(timer)
    rmSync(partial, { force: true })
    throw new AssetError(`download interrupted after ${received} bytes: ${error.message}`, { code: 'download_failed' })
  } finally {
    clearTimeout(timer)
  }
  if (total !== null && received !== total) {
    rmSync(partial, { force: true })
    throw new AssetError(`download truncated: ${received} of ${total} bytes`, { code: 'download_failed' })
  }
  const buffer = Buffer.concat(chunks)
  writeFileSync(partial, buffer)
  renameSync(partial, target)
  return { bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') }
}

async function ensureServer(env, rid, options) {
  const dir = serverDir(env, rid)
  const dll = serverDllPath(env, rid)
  if (isComplete(dir) && existsSync(dll)) return dll
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const archive = join(dir, 'server.nupkg')
  await downloadToFile(serverDownloadUrl(rid), archive, options)
  const prefix = `content/LanguageServer/${rid}/`
  extractArchive(readFileSync(archive), dir, { archiveName: archive, prefix })
  rmSync(archive, { force: true })
  if (!existsSync(dll)) {
    throw new AssetError(
      `the language server archive did not contain Microsoft.CodeAnalysis.LanguageServer.dll`,
      { code: 'asset_corrupt' },
    )
  }
  markComplete(dir)
  return dll
}

async function ensureAnalyzers(env, options) {
  const dir = unityAnalyzersDir(env)
  if (isComplete(dir)) return dir
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const archive = join(dir, 'analyzers.nupkg')
  await downloadToFile(analyzersDownloadUrl(), archive, options)
  const staging = join(dir, 'staging')
  extractArchive(readFileSync(archive), staging, {
    archiveName: archive,
    filter: (name) => name.startsWith('analyzers/dotnet/cs/') && name.endsWith('.dll'),
  })
  // Flatten to `dir/*.dll`: the server takes a directory of analyzer assemblies.
  const flat = join(staging, 'analyzers', 'dotnet', 'cs')
  if (existsSync(flat)) {
    for (const entry of readdirSync(flat)) {
      if (entry.endsWith('.dll')) renameSync(join(flat, entry), join(dir, entry))
    }
  }
  rmSync(staging, { recursive: true, force: true })
  rmSync(archive, { force: true })
  markComplete(dir)
  return dir
}

/**
 * The managed runtime that hosts the server.
 *
 * A system `dotnet` with a compatible major version is preferred — it avoids a
 * ~30 MB download and is what a developer machine already has. Otherwise the
 * official runtime archive is fetched into the asset root.
 */
export async function resolveDotnet(env = process.env, { rid = platformRid(), options = {} } = {}) {
  const executable = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet'
  try {
    const { stdout } = await execFileAsync(executable, ['--list-runtimes'], { timeout: 15_000 })
    // The server's runtimeconfig asks for 10.0.0 with `rollForward: Major`, so
    // any 10.x runtime satisfies it — pinning the exact patch version here made
    // a machine with 10.0.14 download a redundant 30 MB runtime.
    const major = DOTNET_RUNTIME_MAJOR.split('.')[0]
    const hasRuntime = String(stdout)
      .split(/\r?\n/)
      .some((line) => new RegExp(`^Microsoft\\.NETCore\\.App ${major}\\.`).test(line.trim()))
    if (hasRuntime) {
      const { stdout: host } = await execFileAsync(executable, ['--info'], { timeout: 15_000 })
      return { program: executable, source: 'system', info: String(host).split(/\r?\n/)[0] ?? '' }
    }
  } catch {
    // Fall through to the managed runtime.
  }

  const dir = dotnetDir(env, rid)
  const suffix = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet'
  const program = join(dir, suffix)
  if (isComplete(dir) && existsSync(program)) return { program, source: 'managed', info: '' }

  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const archiveName = runtimeDownloadUrl(rid).split('/').pop()
  const archive = join(dir, archiveName)
  await downloadToFile(runtimeDownloadUrl(rid), archive, options)
  extractArchive(readFileSync(archive), dir, { archiveName })
  rmSync(archive, { force: true })
  if (!existsSync(program)) {
    throw new AssetError(`the .NET runtime archive did not contain ${suffix}`, { code: 'asset_corrupt' })
  }
  markComplete(dir)
  return { program, source: 'managed', info: '' }
}

/**
 * What is on disk right now, without downloading anything.
 *
 * `ready` means a query can run. `missing` lists the components an `install`
 * would fetch.
 */
export function assetStatus(env = process.env, { rid = platformRid() } = {}) {
  const server = existsSync(serverDllPath(env, rid)) && isComplete(serverDir(env, rid))
  const analyzers = existsSync(unityAnalyzersDir(env)) && isComplete(unityAnalyzersDir(env))
  const runtime = existsSync(join(dotnetDir(env, rid), process.platform === 'win32' ? 'dotnet.exe' : 'dotnet'))
  const missing = []
  if (!server) missing.push('server')
  if (!analyzers) missing.push('analyzers')
  if (!runtime) missing.push('runtime')
  return {
    rid,
    supported: rid !== null,
    root: assetsRoot(env),
    server: { ready: server, version: SERVER_VERSION, path: server ? serverDllPath(env, rid) : null },
    analyzers: { ready: analyzers, version: UNITY_ANALYZERS_VERSION, path: analyzers ? unityAnalyzersDir(env) : null },
    runtime: { ready: runtime, version: DOTNET_RUNTIME_VERSION, path: runtime ? dotnetDir(env, rid) : null },
    missing,
    // A system dotnet satisfies the runtime requirement without a download.
    installBytes: estimateInstallBytes(missing),
  }
}

function estimateInstallBytes(missing) {
  const sizes = { server: 60 * 1024 * 1024, analyzers: 2 * 1024 * 1024, runtime: 30 * 1024 * 1024 }
  return missing.reduce((total, part) => total + (sizes[part] ?? 0), 0)
}

/**
 * Download every missing component. Resolves to the same report as
 * `assetStatus()` with `ready: true`.
 */
export async function installAssets(env = process.env, { rid = platformRid(), fetchImpl = fetch, onProgress = null, options = {} } = {}) {
  if (!rid) {
    throw new AssetError(`unsupported platform ${process.platform}/${process.arch}`, { code: 'unsupported_platform' })
  }
  const shared = { fetchImpl, onProgress, ...options }
  await ensureServer(env, rid, shared)
  await ensureAnalyzers(env, shared)
  await resolveDotnet(env, { rid, options: shared })
  return { ...assetStatus(env, { rid }), ready: true }
}

/** Resolve everything a query needs; throws when an asset is missing. */
export async function requireAssets(env = process.env, { rid = platformRid() } = {}) {
  const status = assetStatus(env, { rid })
  // `assetStatus()` counts the runtime as missing whenever the managed copy is
  // absent, but a system `dotnet` with a 10.x runtime satisfies it — that is the
  // common developer-machine case and the whole point of `resolveDotnet`. Only
  // the two downloaded artifacts gate here; the runtime is resolved below.
  const required = status.missing.filter((part) => part !== 'runtime')
  if (required.length > 0) {
    throw new AssetError(
      `C# analysis assets are not installed (missing: ${required.join(', ')}). ` +
        'Run the code_analysis tool with action "install".',
      { code: 'assets_missing' },
    )
  }
  const dotnet = await resolveDotnet(env, { rid })
  return {
    rid,
    program: dotnet.program,
    dotnetSource: dotnet.source,
    serverDll: serverDllPath(env, rid),
    analyzersDir: unityAnalyzersDir(env),
  }
}

/** Total size of a directory tree, for the status report. */
export function directorySize(dir) {
  if (!existsSync(dir)) return 0
  let total = 0
  const walk = (current) => {
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        try {
          total += statSync(path).size
        } catch {
          // A file removed mid-walk is not worth failing the report over.
        }
      }
    }
  }
  walk(dir)
  return total
}