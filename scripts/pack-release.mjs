#!/usr/bin/env node
// Single-mode release packager. It never produces a slim/full variant: every ZIP is
// installable and contains the Unity payload plus its installer.
//
// Preflight gates:
//   - the vendored Locus version must equal the latest upstream GitHub release (hard stop);
//   - the latest published DSH version is checked against engines.dsh (soft warning).

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, readFile, readdir, rm, stat, utimes } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compareVersions, normalizeVersion, satisfiesRange } from './lib/semver.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCUS_REPOSITORY = 'r1n7aro/Locus'
const DSH_PACKAGE = '@deepseek-ai/dsh'
const FETCH_TIMEOUT_MS = 15_000
const ZIP_EPOCH_FLOOR = 315_532_800 // 1980-01-01, the earliest DOS timestamp

class HttpError extends Error {
  constructor(url, status, body) {
    super(`${url} returned HTTP ${status}${body ? `: ${body.slice(0, 300)}` : ''}`)
    this.name = 'HttpError'
    this.status = status
  }
}

function log(message) {
  console.log(`[release] ${message}`)
}

function warn(message) {
  console.warn(`[release] WARNING: ${message}`)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  })
  if (result.error) throw new Error(`${command} could not run: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new Error(`${command} ${args.join(' ')} failed (exit ${result.status})${detail ? `:\n${detail}` : ''}`)
  }
  return result.stdout ?? ''
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function fetchJson(url, headers = {}) {
  let response
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'dsh-locus-bridge-packager',
        ...headers,
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(`could not reach ${url}: ${error.message}`)
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new HttpError(url, response.status, body)
  }
  return response.json()
}

function githubHeaders() {
  const headers = { accept: 'application/vnd.github+json' }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  return headers
}

function isSemver(value) {
  try {
    normalizeVersion(value)
    return true
  } catch {
    return false
  }
}

export async function fetchLatestLocusVersion() {
  try {
    const release = await fetchJson(
      `https://api.github.com/repos/${LOCUS_REPOSITORY}/releases/latest`,
      githubHeaders(),
    )
    if (!release?.tag_name) throw new Error('GitHub release response has no tag_name')
    return normalizeVersion(release.tag_name)
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 404) throw error
    const tags = await fetchJson(
      `https://api.github.com/repos/${LOCUS_REPOSITORY}/tags?per_page=100`,
      githubHeaders(),
    )
    if (!Array.isArray(tags)) throw new Error('GitHub tags response is not an array')
    const versions = tags.map((tag) => tag?.name).filter(isSemver)
    if (versions.length === 0) throw new Error(`no semantic-version tag found for ${LOCUS_REPOSITORY}`)
    versions.sort(compareVersions)
    return normalizeVersion(versions.at(-1))
  }
}

export async function fetchLatestDshVersion() {
  const data = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(DSH_PACKAGE)}/latest`)
  if (!data?.version) throw new Error('npm registry response has no version')
  return normalizeVersion(data.version)
}

export function evaluateLocusVersion(recorded, latest) {
  if (!recorded) {
    throw new Error('package.json is missing "locus.version"; record the vendored upstream version before packaging')
  }
  const baseline = normalizeVersion(recorded)
  const latestVersion = normalizeVersion(latest)
  if (compareVersions(baseline, latestVersion) !== 0) {
    throw new Error(
      `vendored Locus ${baseline} is not the latest upstream release ${latestVersion}.\n` +
        'Update the payload with `npm run sync:payload`, bump package.json "locus.version" and NOTICE, then retry.',
    )
  }
  return { baseline, latest: latestVersion }
}

export async function checkLocusVersion(pkg) {
  const recorded = pkg?.locus?.version
  if (!recorded) {
    throw new Error('package.json is missing "locus.version"; record the vendored upstream version before packaging')
  }
  const latest = await fetchLatestLocusVersion()
  return evaluateLocusVersion(recorded, latest)
}

export function evaluateDshCompatibility(range, latest) {
  if (!range) return { status: 'unknown', reason: 'package.json has no engines.dsh range' }
  return {
    status: satisfiesRange(latest, range) ? 'compatible' : 'incompatible',
    latest: normalizeVersion(latest),
    range,
  }
}

export async function checkDshCompatibility(pkg) {
  const range = pkg?.engines?.dsh
  if (!range) return { status: 'unknown', reason: 'package.json has no engines.dsh range' }
  const latest = await fetchLatestDshVersion()
  return evaluateDshCompatibility(range, latest)
}

function firstChangelogVersion(changelog) {
  const match = /^## \[([^\]]+)\]/m.exec(changelog)
  return match?.[1] ?? null
}

export async function assertReleaseInputs(root, pkg, lock) {
  const version = pkg?.version
  if (!version) throw new Error('package.json has no version')
  if (lock?.version !== version) {
    throw new Error(`package-lock.json version ${lock?.version} does not match package.json ${version}`)
  }
  if (lock?.packages?.['']?.version !== version) {
    throw new Error(`package-lock.json packages[""].version does not match package.json ${version}`)
  }
  if (!Array.isArray(pkg.files) || !pkg.files.includes('CHANGELOG.md')) {
    throw new Error('package.json files must include CHANGELOG.md')
  }
  const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8')
  const heading = firstChangelogVersion(changelog)
  if (heading !== version) {
    throw new Error(`CHANGELOG.md first version heading is ${JSON.stringify(heading)}, expected ${version}`)
  }

  const payloadDir = path.join(root, 'payload', 'locus_unity')
  const payloadPackage = await readJson(path.join(payloadDir, 'package.json'))
  if (!payloadPackage?.version) throw new Error('payload/locus_unity/package.json has no version')
  for (const relative of [
    'Editor/Native/x86_64/locus_unity_native.dll',
    'Editor/Native/linux-x86_64/liblocus_unity_native.so',
  ]) {
    if (!existsSync(path.join(payloadDir, relative))) {
      throw new Error(`payload is incomplete: payload/locus_unity/${relative} is missing`)
    }
  }

  const installerPath = path.join(root, 'scripts', 'install-unity-package.mjs')
  const installer = await readFile(installerPath, 'utf8')
  if (!installer.includes('../src/setup.js')) {
    throw new Error('scripts/install-unity-package.mjs does not import ../src/setup.js')
  }

  const noticePath = path.join(root, 'NOTICE')
  if (existsSync(noticePath) && pkg?.locus?.version) {
    const notice = await readFile(noticePath, 'utf8')
    const locusVersion = normalizeVersion(pkg.locus.version)
    if (!notice.includes(`v${locusVersion}`) && !notice.includes(locusVersion)) {
      warn('NOTICE does not mention the current Locus version; keep it in sync with package.json "locus.version"')
    }
  }

  return { version, payloadVersion: payloadPackage.version }
}

function resolveNpm() {
  if (process.env.npm_execpath && existsSync(process.env.npm_execpath)) {
    return { command: process.execPath, args: [process.env.npm_execpath] }
  }
  const sibling = path.join(
    path.dirname(process.execPath),
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
  )
  if (existsSync(sibling)) return { command: sibling, args: [] }
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [] }
}

function pkgName(root) {
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).name
}

function parsePackJson(output) {
  const text = output.trim()
  try {
    return JSON.parse(text)
  } catch {
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1))
    throw new Error(`could not parse npm pack --json output: ${text.slice(0, 300)}`)
  }
}

async function collectFiles(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...(await collectFiles(full)))
    else result.push(full)
  }
  return result
}

async function stampTree(directory, epoch) {
  const date = new Date(epoch * 1000)
  const files = await collectFiles(directory)
  for (const file of files) await utimes(file, date, date)
  // Directory mtimes do not matter for a file-only ZIP, but keep them stable too.
  for (const file of files) {
    let current = path.dirname(file)
    while (current.startsWith(directory)) {
      await utimes(current, date, date)
      if (current === directory) break
      current = path.dirname(current)
    }
  }
}

function gitEpoch(root) {
  const result = spawnSync('git', ['log', '-1', '--format=%ct'], { cwd: root, encoding: 'utf8' })
  const value = Number(result.stdout?.trim())
  return Number.isFinite(value) && value > 0 ? value : ZIP_EPOCH_FLOOR
}

function humanSize(bytes) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

export async function buildZip(root, version) {
  const name = `dsh-locus-bridge-${version}`
  const distDir = path.join(root, 'dist')
  const workDir = path.join(root, '.tmp', 'release')
  const packDir = path.join(workDir, 'pack')
  const stageParent = path.join(workDir, 'stage')
  const stageDir = path.join(stageParent, name)
  const zipPath = path.join(distDir, `${name}.zip`)

  await rm(workDir, { recursive: true, force: true })
  await mkdir(packDir, { recursive: true })
  await mkdir(stageDir, { recursive: true })
  await mkdir(distDir, { recursive: true })
  await rm(zipPath, { force: true })

  try {
    const npm = resolveNpm()
    const stdout = run(
      npm.command,
      [...npm.args, 'pack', '--json', '--ignore-scripts', '--pack-destination', packDir],
      {
        cwd: root,
        env: {
          ...process.env,
          npm_config_cache: path.join(workDir, 'npm-cache'),
          npm_config_logs_dir: path.join(workDir, 'npm-logs'),
          npm_config_update_notifier: 'false',
          npm_config_fund: 'false',
          npm_config_audit: 'false',
        },
      },
    )
    const packReport = parsePackJson(stdout)
    const record = Array.isArray(packReport)
      ? packReport[0]
      : packReport[pkgName(root)] ?? Object.values(packReport)[0]
    if (!record?.filename) throw new Error('npm pack --json did not report a filename')
    const tarball = path.isAbsolute(record.filename) ? record.filename : path.join(packDir, record.filename)

    run('tar', ['-xzf', tarball, '--strip-components=1', '-C', stageDir], { cwd: root })
    await cp(path.join(root, 'payload', 'locus_unity'), path.join(stageDir, 'payload', 'locus_unity'), {
      recursive: true,
    })
    await mkdir(path.join(stageDir, 'scripts'), { recursive: true })
    await cp(
      path.join(root, 'scripts', 'install-unity-package.mjs'),
      path.join(stageDir, 'scripts', 'install-unity-package.mjs'),
    )

    const epoch = Math.max(
      Number(process.env.SOURCE_DATE_EPOCH) || 0,
      gitEpoch(root),
      ZIP_EPOCH_FLOOR,
    )
    await stampTree(stageDir, epoch)

    const entries = (await collectFiles(stageDir))
      .map((file) => path.relative(stageParent, file).split(path.sep).join('/'))
      .sort()
    if (entries.length === 0) throw new Error('staging directory is empty')
    run('zip', ['-X', '-q', '-@', zipPath], {
      cwd: stageParent,
      input: `${entries.join('\n')}\n`,
      env: { ...process.env, TZ: 'UTC' },
    })

    run('unzip', ['-t', zipPath], { cwd: root })
    const listing = run('unzip', ['-Z1', zipPath], { cwd: root })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    const files = listing.filter((entry) => !entry.endsWith('/'))
    if (files.length !== entries.length) {
      throw new Error(`ZIP has ${files.length} files, expected ${entries.length}`)
    }
    for (const required of [
      `${name}/package.json`,
      `${name}/CHANGELOG.md`,
      `${name}/payload/locus_unity/package.json`,
      `${name}/scripts/install-unity-package.mjs`,
      `${name}/src/background.js`,
      `${name}/cordis.patch.yml`,
    ]) {
      if (!files.includes(required)) throw new Error(`ZIP is missing ${required}`)
    }
    const forbidden = files.find((entry) =>
      /(^|\/)(\.git|node_modules|Locus|unity-test|\.tmp|dist|target)(\/|$)/.test(entry),
    )
    if (forbidden) throw new Error(`ZIP contains forbidden path: ${forbidden}`)

    const info = await stat(zipPath)
    const hash = createHash('sha256').update(await readFile(zipPath)).digest('hex')
    return { zipPath, files: files.length, bytes: info.size, sha256: hash }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

export async function main() {
  const pkg = await readJson(path.join(ROOT, 'package.json'))
  const lock = await readJson(path.join(ROOT, 'package-lock.json'))
  const inputs = await assertReleaseInputs(ROOT, pkg, lock)
  log(`version ${inputs.version}; payload ${inputs.payloadVersion}`)

  const locus = await checkLocusVersion(pkg)
  log(`Locus upstream ${locus.latest} matches vendored ${locus.baseline}`)

  try {
    const dsh = await checkDshCompatibility(pkg)
    if (dsh.status === 'compatible') {
      log(`latest DSH ${dsh.latest} satisfies engines.dsh ${dsh.range}`)
    } else if (dsh.status === 'incompatible') {
      warn(
        `latest DSH ${dsh.latest} does not satisfy engines.dsh ${dsh.range}; ` +
          'packaging continues because DSH compatibility is a soft gate.',
      )
    } else {
      warn(`${dsh.reason}; cannot verify DSH compatibility, packaging continues.`)
    }
  } catch (error) {
    warn(`could not verify the latest DSH version (${error.message}); packaging continues.`)
  }

  const artifact = await buildZip(ROOT, inputs.version)
  log(`built ${path.relative(ROOT, artifact.zipPath)}`)
  log(`${artifact.files} files, ${humanSize(artifact.bytes)}, sha256 ${artifact.sha256}`)
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[release] ERROR: ${error.message}`)
    process.exitCode = 1
  })
}
