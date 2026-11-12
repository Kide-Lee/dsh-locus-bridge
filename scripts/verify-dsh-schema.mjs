// Verify the registry definitions against DSH's REAL schema compiler, not our
// own reimplementation. Extracts dsh-tools out of the installed app.asar,
// shims its two package deps, and asserts every compiled definition passes
// `assertSupportedJsonSchema` and yields the authored requiredness.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'

import { registryDefinitions, allToolDefinitions } from '../src/index.js'

const asar = process.env.DSH_ASAR
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-schema-probe-'))

function extract(archive, prefix) {
  const fd = fs.openSync(archive, 'r')
  const sizeBuf = Buffer.alloc(8)
  fs.readSync(fd, sizeBuf, 0, 8, 0)
  const pickleSize = sizeBuf.readUInt32LE(4)
  const pickle = Buffer.alloc(pickleSize)
  fs.readSync(fd, pickle, 0, pickleSize, 8)
  const stringSize = pickle.readUInt32LE(4)
  const header = JSON.parse(pickle.subarray(8, 8 + stringSize).toString('utf8'))
  const base = 8 + pickleSize
  const written = []
  const walk = (node, trail) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const full = trail ? `${trail}/${name}` : name
      if (entry.files) walk(entry, full)
      else if (full.startsWith(prefix)) {
        const target = path.join(out, full.slice(prefix.length))
        fs.mkdirSync(path.dirname(target), { recursive: true })
        const buf = Buffer.alloc(entry.size)
        if (entry.size > 0) fs.readSync(fd, buf, 0, entry.size, base + Number(entry.offset))
        fs.writeFileSync(target, buf)
        written.push(target)
      }
    }
  }
  walk(header, '')
  fs.closeSync(fd)
  return written
}

const files = extract(asar, 'dsh/node_modules/@deepseek-ai/dsh-tools/')
const libDir = path.join(out, 'lib')

// dsh-tools imports two workspace packages; give them minimal, faithful shims.
fs.mkdirSync(path.join(out, 'shim'), { recursive: true })
fs.writeFileSync(
  path.join(out, 'shim/llm.js'),
  'export class HarnessError extends Error { constructor(m, code, o) { super(m, o); this.code = code } }\n',
)
fs.writeFileSync(
  path.join(out, 'shim/values.js'),
  `export function snapshotJsonValue(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)) }
export function assertNever(v, label) { throw new Error('unexpected ' + label + ': ' + String(v)) }
export function isJsonValue(v) {
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true
  if (typeof v === 'number') return Number.isFinite(v)
  if (Array.isArray(v)) return v.every(isJsonValue)
  if (typeof v === 'object') return Object.values(v).every(isJsonValue)
  return false
}
`,
)
/** A `file://` URL for an absolute path (Windows drive letters need the prefix). */
function fileUrl(target) {
  return new URL(`file://${target.replaceAll('\\', '/')}`).href
}

for (const file of files) {
  if (!file.endsWith('.js')) continue
  const llmShim = fileUrl(path.join(out, 'shim/llm.js'))
  const valuesShim = fileUrl(path.join(out, 'shim/values.js'))
  const text = fs
    .readFileSync(file, 'utf8')
    .replaceAll("'@deepseek-ai/dsh-llm'", `'${llmShim}'`)
    .replaceAll('"@deepseek-ai/dsh-llm"', `'${llmShim}'`)
    .replaceAll("'@deepseek-ai/dsh-util-values'", `'${valuesShim}'`)
    .replaceAll('"@deepseek-ai/dsh-util-values"', `'${valuesShim}'`)
  fs.writeFileSync(file, text)
}

const require = createRequire(import.meta.url)

// `types/schema.js` is the compiler itself (defineTool /
// parameterSchemaSpecToJsonSchema / validateArgs); `types/json-schema.js` holds
// the subset assertion and the runtime value validator. The package ROOT also
// pulls in cordis, which a plain Node process cannot resolve out of an .asar.
// Dynamic import is spelled through `dynamicImport` so the repo's line-based
// typecheck (scripts/typecheck.mjs) does not read it as a call to a missing
// identifier.
const dynamicImport = (specifier) => import(specifier)
const schema = await dynamicImport(fileUrl(path.join(libDir, 'types/schema.js')))
const jsonSchema = await dynamicImport(fileUrl(path.join(libDir, 'types/json-schema.js')))
const assertObjectJsonSchema = jsonSchema.assertObjectJsonSchema
const validateJsonSchemaValue = jsonSchema.validateJsonSchemaValue

const registry = registryDefinitions()
const authored = allToolDefinitions()
let failures = 0

for (const definition of registry) {
  const source = authored.find((entry) => entry.name === definition.name)
  const expectedRequired = Object.entries(source?.parameters ?? {})
    .filter(([, node]) => node?.required === true)
    .map(([key]) => key)
    .sort()

  try {
    // The subset assertion `dsh-tools` applies to any raw schema, plus the
    // object root it requires of a parameter schema.
    assertObjectJsonSchema(definition.parameters)
  } catch (error) {
    failures += 1
    console.log(`✗ ${definition.name}: DSH rejects parameters -> ${error.message}`)
    continue
  }

  // Cross-check against DSH's own author compiler: compiling the AUTHORED spec
  // must produce exactly the schema we ship. This is the fixed-point proof.
  const fromDsh = schema.parameterSchemaSpecToJsonSchema(source.parameters)
  const ours = JSON.stringify(definition.parameters)
  const theirs = JSON.stringify(fromDsh)
  if (ours !== theirs) {
    failures += 1
    console.log(`✗ ${definition.name}: compiled schema differs from DSH's own compiler`)
    console.log(`   ours:   ${ours.slice(0, 240)}`)
    console.log(`   theirs: ${theirs.slice(0, 240)}`)
    continue
  }

  // The model-facing schema is what `tools.schemas()` projects.
  const projected = schema.projectToolSchema(definition, true)
  if (projected.parameters.type !== 'object' || typeof projected.parameters.properties !== 'object') {
    failures += 1
    console.log(`✗ ${definition.name}: projected schema is not object-rooted`)
    continue
  }

  // Runtime validation, exactly as the pipeline performs it on a call.
  const emptyViolations = validateJsonSchemaValue(definition.parameters, {}, '')
  const verdict =
    emptyViolations.length === 0 ? 'accepts {} (nothing required)' : `rejects {} (${emptyViolations.length} missing)`
  const consistent = expectedRequired.length === 0 ? emptyViolations.length === 0 : emptyViolations.length > 0
  if (!consistent) {
    failures += 1
    console.log(`✗ ${definition.name}: empty-args verdict contradicts authored requiredness: ${verdict}`)
    continue
  }
  console.log(`✓ ${definition.name}: ${Object.keys(projected.parameters.properties).length} props, ${verdict}`)
}

// The headline regression: unity_capture must refuse a call with no arguments
// and accept one that supplies both required fields.
const capture = registry.find((d) => d.name === 'unity_capture')
const emptyCapture = validateJsonSchemaValue(capture.parameters, {}, '')
const fullCapture = validateJsonSchemaValue(capture.parameters, { target: 'game', request_editor_status: 'editing' }, '')
console.log(`\nunity_capture {} -> ${emptyCapture.length === 2 ? 'rejected both required ✓' : JSON.stringify(emptyCapture)}`)
console.log(`unity_capture full -> ${fullCapture.length === 0 ? 'accepted ✓' : JSON.stringify(fullCapture)}`)
if (emptyCapture.length !== 2) failures += 1
if (fullCapture.length !== 0) failures += 1

console.log(`\n${failures === 0 ? 'PASS: every registry definition is valid under DSH\'s own compiler' : `FAIL: ${failures} problem(s)`}`)
fs.rmSync(out, { recursive: true, force: true })
process.exitCode = failures === 0 ? 0 : 1
