// Validates every Locus tool definition against the JSON Schema subset the DSH
// tool registry accepts (type/oneOf/properties/required/additionalProperties/
// items/enum/const + description/title/default/examples), so an unsupported
// keyword fails here instead of when the plugin loads.
//
// Mirrors dsh-tools/lib shared-DTdn5dXO.js:CONSTRAINT_KEYWORDS.
// Usage: node scripts/dump-tools.mjs [--json]

import { allToolDefinitions } from '../src/index.js'

const toolDefinitions = allToolDefinitions()

const CONSTRAINT = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATION = new Set(['description', 'title', 'default', 'examples'])
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null', 'json'])
const BESIDE_ONE_OF = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'type']

function checkNode(node, path, violations) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    violations.push(`${path} must be a schema object`)
    return
  }
  for (const key of Object.keys(node)) {
    if (CONSTRAINT.has(key) || ANNOTATION.has(key)) continue
    violations.push(
      `${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`,
    )
  }
  if (Object.hasOwn(node, 'type') && !TYPES.has(node.type)) violations.push(`${path}.type must be a JSON type`)
  if (Object.hasOwn(node, 'oneOf')) {
    for (const key of BESIDE_ONE_OF) {
      if (Object.hasOwn(node, key)) violations.push(`${path}.${key} is not supported beside oneOf`)
    }
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) violations.push(`${path}.oneOf needs at least two branches`)
    ;(node.oneOf ?? []).forEach((branch, index) => checkNode(branch, `${path}.oneOf[${index}]`, violations))
  }
  if (Object.hasOwn(node, 'properties')) {
    if (typeof node.properties !== 'object') violations.push(`${path}.properties must be an object`)
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      checkNode(child, `${path}.properties.${key}`, violations)
    }
  }
  if (Object.hasOwn(node, 'required')) {
    if (node.required === true) {
      // Parameter-property annotation that marks the property required.
    } else if (!Array.isArray(node.required) || node.required.some((key) => typeof key !== 'string')) {
      violations.push(`${path}.required must be a string array`)
    }
  }
  if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
    violations.push(`${path}.additionalProperties must be a boolean`)
  }
  if (node.type === 'object' && Object.hasOwn(node, 'properties') && !Object.hasOwn(node, 'additionalProperties')) {
    violations.push(`${path}.additionalProperties must be explicit for object nodes`)
  }
  if (Object.hasOwn(node, 'items')) checkNode(node.items, `${path}.items`, violations)
  if (Object.hasOwn(node, 'enum') && (!Array.isArray(node.enum) || node.enum.length === 0)) {
    violations.push(`${path}.enum must be a non-empty array`)
  }
}

/** The open object root DSH compiles from implicit parameter properties. */
function parameterSchema(properties) {
  return { type: 'object', additionalProperties: true, properties }
}

export function validateToolDefinitions(definitions) {
  const violations = []
  const names = new Set()
  for (const definition of definitions) {
    const label = definition?.name ?? '<unnamed>'
    if (!definition?.name) violations.push(`${label}: missing name`)
    if (names.has(definition?.name)) violations.push(`${label}: duplicate tool name`)
    names.add(definition?.name)
    if (!definition?.description) violations.push(`${label}: missing description`)
    checkNode(parameterSchema(definition?.parameters ?? {}), `${label}.parameters`, violations)
    checkNode(definition?.output?.schema, `${label}.output.schema`, violations)
    if (typeof definition?.output?.render !== 'function') violations.push(`${label}: output.render must be a function`)
    if (typeof definition?.execute !== 'function') violations.push(`${label}: execute must be a function`)
  }
  return violations
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  const violations = validateToolDefinitions(toolDefinitions)
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ tools: toolDefinitions.map(stripFunctions), violations }, null, 2))
  } else {
    for (const definition of toolDefinitions) {
      const params = Object.keys(definition.parameters ?? {})
      console.log(`${definition.name}: ${params.length} params (${params.join(', ')})`)
    }
    for (const violation of violations) console.log(`VIOLATION ${violation}`)
    console.log(violations.length === 0 ? 'OK: all definitions fit the DSH schema subset' : `${violations.length} violation(s)`)
  }
  process.exitCode = violations.length === 0 ? 0 : 1
}

function stripFunctions(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    outputSchema: definition.output?.schema,
  }
}
