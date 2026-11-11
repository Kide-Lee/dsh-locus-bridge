/**
 * Live smoke test against a real Unity Editor running the Locus plugin.
 *
 *   node scripts/live-smoke.mjs --project "F:/Projects/Game" [--recompile] [--scene Assets/Scenes/Main.unity]
 *
 * Requires the Locus Unity package with the native broker DLL and
 * Library/Locus/NativeBridge.enabled (or LOCUS_UNITY_NATIVE_BRIDGE=1).
 * Locus native bridges are Windows-only.
 *
 * Steps (each independent; failures are reported, not fatal):
 *   1. connect + ping + capabilities
 *   2. unity_status
 *   3. unity_execute (read-only sample)
 *   4. unity_console_log
 *   5. unity_asset read (first .asset found under Assets/, when one exists)
 *   6. unity_scene search (first open scene)
 *   7. unity_recompile  (only with --recompile; requires Edit Mode)
 *   8. cancel_execute_code (caller abort stops a long snippet)
 */

import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { LocusClient } from '../src/locus-client.js'
import { describeTarget } from '../src/client-pool.js'
import { readEditorStatus, executeSnippet } from '../src/execute.js'
import { allToolDefinitions } from '../src/index.js'

const toolDefinitions = allToolDefinitions()

const args = parseArgs(process.argv.slice(2))
if (!args.project && !args.pipe) {
  console.error(
    'usage: node scripts/live-smoke.mjs --project <UnityProject> | --pipe <pipeName> [--recompile] [--scene <Assets/...unity>]',
  )
  process.exit(2)
}

const projectRoot = args.project ? resolve(args.project) : undefined
const target = describeTarget({ projectRoot, pipe: args.pipe })
console.log(`pipe: ${target.pipe}`)

const tools = Object.fromEntries(toolDefinitions.map((definition) => [definition.name, definition]))

// The tools resolve `project_path` from the Session cwd in DSH; here we hand
// them an explicit project root through the same argument surface.
const exec = { agent: { session: { header: { cwd: projectRoot } } }, signal: new AbortController().signal, publish() {} }
const withProject = (callArgs) => ({ project_path: projectRoot, ...callArgs })

let failures = 0
let state = { status: 'editing', scenes: [] }
const step = async (name, fn) => {
  process.stdout.write(`- ${name}: `)
  try {
    const detail = await fn()
    console.log(`ok${detail ? ` (${detail})` : ''}`)
  } catch (error) {
    failures += 1
    console.log(`FAILED — ${error.message}`)
  }
}

const status = await tools.unity_status.execute(withProject({ pipe: args.pipe }), exec).catch((error) => ({
  connected: false,
  text: error.message,
  status: 'disconnected',
  scenes: [],
}))
state = status
await step('connect + status', async () => {
  if (!status.connected) throw new Error(status.text)
  return status.text.split('\n')[0]
})

await step('bridge_capabilities', async () => {
  const client = new LocusClient({ pipe: target.pipe })
  await client.connect()
  try {
    return `${client.capabilities.length} capabilities`
  } finally {
    // A connect attempt that never completed leaves a worker blocked on
    // open(); close with a bounded wait so the smoke run cannot hang.
    await Promise.race([client.close(), new Promise((done) => setTimeout(done, 2_000).unref?.())])
  }
})

await step('unity_execute (readonly sample)', async () => {
  const result = await tools.unity_execute.execute(
    withProject({
      code: 'print("dsh-locus-bridge smoke: " + Application.unityVersion);',
      readonly: true,
      request_editor_status: state.status,
      timeout: 30_000,
    }),
    exec,
  )
  if (result.output.startsWith('Error:')) throw new Error(result.output)
  return result.output.trim()
})

await step('unity_console_log', async () => {
  const result = await tools.unity_console_log.execute(withProject({ limit: 5 }), exec)
  return result.text.split('\n')[0]
})

await step('unity_asset read', async () => {
  const asset = args.asset ?? (await firstAssetUnderAssets(projectRoot))
  if (!asset) return 'no .asset file under Assets/ to sample'
  const result = await tools.unity_asset.execute(withProject({ action: 'read', path: asset }), exec)
  return `${asset} revision ${result.revision}`
})

await step('unity_scene search', async () => {
  const result = await tools.unity_scene.execute(withProject({ action: 'search', query: args.object ?? 'Camera', limit: 5 }), exec)
  return result.text.split('\n')[0]
})

if (args.recompile) {
  await step('unity_recompile', async () => {
    const result = await tools.unity_recompile.execute(withProject({ reason: 'dsh-locus-bridge smoke' }), exec)
    return `${result.status} in ${Math.round(result.elapsedMs / 100) / 10}s`
  })
}

await step('cancel_execute_code', async () => {
  const client = new LocusClient({ pipe: target.pipe })
  await client.connect()
  try {
    const controller = new AbortController()
    const run = executeSnippet(client, {
      // Holds the main thread; the cancel must reach it within a few seconds.
      code: 'Thread.Sleep(15000); print("too late");',
      executionId: randomUUID(),
      timeoutMs: 30_000,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 400)
    try {
      await run
      throw new Error('execution completed instead of being cancelled')
    } catch (error) {
      if (!/cancelled/.test(String(error.message))) throw error
      return 'cancelled'
    }
  } finally {
    await Promise.race([client.close(), new Promise((done) => setTimeout(done, 2_000).unref?.())])
  }
})

console.log(failures === 0 ? 'smoke: all steps passed' : `smoke: ${failures} step(s) failed`)
process.exitCode = failures === 0 ? 0 : 1

function parseArgs(argv) {
  const parsed = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--recompile') parsed.recompile = true
    else if (arg === '--project') parsed.project = argv[++i]
    else if (arg === '--pipe') parsed.pipe = argv[++i]
    else if (arg === '--asset') parsed.asset = argv[++i]
    else if (arg === '--object') parsed.object = argv[++i]
  }
  return parsed
}

/** Best-effort directory scan (stops at the first .asset file). */
async function firstAssetUnderAssets(root) {
  if (!root) return null
  try {
    const { readdir } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const queue = [join(root, 'Assets')]
    while (queue.length > 0) {
      const dir = queue.shift()
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) queue.push(full)
        else if (entry.name.endsWith('.asset')) {
          return full.slice(root.length + 1).replaceAll('\\', '/')
        }
      }
    }
  } catch {
    return null
  }
  return null
}

// Surface unexpected early exits (an unhandled stream error would otherwise
// look like a plain non-zero exit).
process.on('unhandledRejection', (reason) => {
  console.error(`unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`)
  process.exitCode = 1
})
