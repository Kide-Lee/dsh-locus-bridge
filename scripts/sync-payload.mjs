// Copy the buildable `locus_unity` Unity package from the upstream Locus
// checkout into this package's `payload/` directory.
//
// Why a vendored copy: upstream git-ignores the compiled DLLs the package
// cannot run without (`Locus.Json.dll`, `Locus.Detour.dll`,
// `Locus.HotReload.Runtime.dll`, `Locus.Roslyn.dll`, and the native broker), so
// a UPM `git+https://…?path=locus_unity` dependency installs an incomplete
// package. Shipping the built tree here lets `unity_status(setup:)` install a
// package that actually compiles.
//
// The 15 MB tree is mostly `Editor/Roslyn/Locus.Roslyn.dll` (≈9 MB, needed in
// process for `execute_code`), which is why it is published as a release asset
// and kept out of the npm tarball; see the README's "安装来源" section.
//
// Usage:
//   node scripts/sync-payload.mjs                 # from ./Locus (default)
//   node scripts/sync-payload.mjs --source <dir>
//   node scripts/sync-payload.mjs --check         # verify only, never write

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PAYLOAD_DIR = join(ROOT, 'payload', 'locus_unity')

/** Files present at a fixed path in every build of the package. */
const REQUIRED_FILES = ['package.json', 'Editor/Locus.Editor.asmdef']

/**
 * Managed assemblies the editor loads, matched by file name at any depth.
 *
 * Upstream stages them in one directory per concern (`Editor/Json`,
 * `Editor/Detour`, …), but a bundled build merges all four into
 * `Editor/Roslyn/`. `Locus.Editor.asmdef` lists them in `precompiledReferences`
 * by bare file name, so Unity resolves either layout; requiring exact
 * subdirectories here would reject a package that compiles fine.
 */
const REQUIRED_ASSEMBLIES = [
  'Locus.Json.dll',
  'Locus.Roslyn.dll',
  'Locus.Detour.dll',
  'Locus.HotReload.Runtime.dll',
]

/** The native broker file name per platform, relative to the package root. */
const NATIVE_BROKERS = {
  'win32-x64': 'Editor/Native/x86_64/locus_unity_native.dll',
  'linux-x64': 'Editor/Native/linux-x86_64/liblocus_unity_native.so',
}

/**
 * Build output and editor state that must never reach a project.
 *
 * `Editor/Skills` is deliberately absent: upstream preserves hand-written
 * skills across upgrades (`preserve_installed_skill_files`), and a kit that
 * baked one author's skills into every install would overwrite them.
 */
const SKIP_DIR_NAMES = new Set(['obj', 'bin', 'target', '.tmp', '.git', 'Logs', 'UserSettings', 'Library'])
const SKIP_FILE_PATTERNS = [/^ILRepack-/, /\.pdb$/i, /\.orig$/, /\.rej$/, /~$/]

function parseArgs(argv) {
  const options = { source: join(ROOT, 'Locus'), check: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--check') options.check = true
    else if (arg === '--source') options.source = resolve(argv[++index] ?? '')
    else if (arg.startsWith('--source=')) options.source = resolve(arg.slice('--source='.length))
  }
  return options
}

function skipEntry(name) {
  if (SKIP_DIR_NAMES.has(name)) return true
  return SKIP_FILE_PATTERNS.some((pattern) => pattern.test(name))
}

/**
 * Recursively collect files worth shipping.
 * @param root - package root being walked
 * @param dir - current directory
 * @param out - relative POSIX paths, appended
 */
function collect(root, dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipEntry(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collect(root, full, out)
    else if (entry.isFile()) out.push(relative(root, full).split('\\').join('/'))
  }
}

function missingRequired(root) {
  const missing = REQUIRED_FILES.filter((rel) => !isFile(join(root, rel)))
  for (const name of REQUIRED_ASSEMBLIES) {
    if (!findByName(root, name)) missing.push(`${name} (not found at any depth)`)
    if (!findByName(root, `${name}.meta`)) missing.push(`${name}.meta (not found at any depth)`)
  }
  return missing
}

/** First path whose base name equals `name`, searched breadth-first from `root`. */
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
      if (entry.isDirectory() && !skipEntry(entry.name)) frontier.push(join(dir, entry.name))
    }
  }
  return null
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function detectNativeBrokers(root) {
  return Object.entries(NATIVE_BROKERS)
    .filter(([, rel]) => isFile(join(root, rel)))
    .map(([key]) => key)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const source = join(options.source, 'locus_unity')

  if (!existsSync(join(source, 'package.json'))) {
    fail(`no Unity package at ${source} (pass --source <Locus checkout>)`)
  }

  const missing = missingRequired(source)
  if (missing.length > 0) {
    fail(
      `the package at ${source} is incomplete:\n  ${missing.join('\n  ')}\n` +
        'Build the DLLs first (upstream: bun run unity:bundle, plus npm run build:native here).',
    )
  }

  const files = []
  collect(source, source, files)
  files.sort()
  const brokers = detectNativeBrokers(source)

  if (options.check) {
    const stale = files.filter((rel) => !isFile(join(PAYLOAD_DIR, rel)))
    if (stale.length > 0 || !existsSync(PAYLOAD_DIR)) {
      fail(`payload/ is out of date: ${stale.length} file(s) missing. Run without --check.`)
    }
    console.log(`payload OK: ${files.length} files, native brokers: ${brokers.join(', ') || 'none'}`)
    return
  }

  rmSync(PAYLOAD_DIR, { recursive: true, force: true })
  mkdirSync(PAYLOAD_DIR, { recursive: true })
  for (const rel of files) {
    const dest = join(PAYLOAD_DIR, rel)
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(join(source, rel), dest)
  }

  console.log(`payload synced: ${files.length} files -> ${relative(ROOT, PAYLOAD_DIR)}`)
  console.log(`native brokers: ${brokers.join(', ') || 'none (the editor will not start the bridge on this host)'}`)
  if (brokers.length < Object.keys(NATIVE_BROKERS).length) {
    console.log('note: a platform without a broker still installs; unity_status reports the missing library.')
  }
}

function fail(message) {
  console.error(`sync-payload: ${message}`)
  process.exit(1)
}

main()
