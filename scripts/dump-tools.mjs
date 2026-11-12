// Validates every Locus tool definition against the JSON Schema subset the DSH
// tool registry accepts (type/oneOf/properties/required/additionalProperties/
// items/enum/const + description/title/default/examples), so an unsupported
// keyword fails here instead of when the plugin loads.
//
// It validates the COMPILED definitions (`registryDefinitions()`), i.e. exactly
// what `ctx.tools.register` receives. Validating the authored form is what let
// the original bug through: `parameterSchema()` below wrapped the authored
// property map in `{ type: 'object', ... }`, so the check passed while the
// registry was actually handing the raw map to the model as `input_schema`.
//
// Mirrors dsh-tools/lib shared-DTdn5dXO.js:CONSTRAINT_KEYWORDS.
// Usage: node scripts/dump-tools.mjs [--json]

import { registryDefinitions, allToolDefinitions } from '../src/index.js'

const toolDefinitions = registryDefinitions()
const authoredDefinitions = allToolDefinitions()

const CONSTRAINT = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATION = new Set(['description', 'title', 'default', 'examples'])
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null', 'json'])
const BESIDE_ONE_OF = ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'type']

function checkNode(node, path, violations, isRoot = false) {
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
    // A field-level `required: true` annotation is legal in the AUTHORED form
    // but never survives compilation: the compiler lifts it into the enclosing
    // object's top-level `required` array. Seeing it here means a definition
    // reached the registry uncompiled.
    if (node.required === true) {
      violations.push(
        `${path}.required must be a string array in a registry definition ` +
          '(field-level `required: true` is authored form and is lifted during compilation)',
      )
    } else if (!Array.isArray(node.required) || node.required.some((key) => typeof key !== 'string')) {
      violations.push(`${path}.required must be a string array`)
    }
  }
  if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
    violations.push(`${path}.additionalProperties must be a boolean`)
  }
  if (
    !isRoot &&
    node.type === 'object' &&
    Object.hasOwn(node, 'properties') &&
    !Object.hasOwn(node, 'additionalProperties')
  ) {
    violations.push(`${path}.additionalProperties must be explicit for object nodes`)
  }
  if (Object.hasOwn(node, 'items')) checkNode(node.items, `${path}.items`, violations)
  if (Object.hasOwn(node, 'enum') && (!Array.isArray(node.enum) || node.enum.length === 0)) {
    violations.push(`${path}.enum must be a non-empty array`)
  }
}

/**
 * The parameter schema of a registry definition.
 *
 * Must be an object-rooted raw schema: the registry forwards it to the model
 * verbatim as `input_schema`, so anything else declares no properties and every
 * call arrives as `{}`.
 */
function parameterSchema(definition) {
  return definition?.parameters
}

export function validateToolDefinitions(definitions, authored = []) {
  const violations = []
  const names = new Set()
  const authoredByName = new Map(authored.map((entry) => [entry.name, entry]))
  for (const definition of definitions) {
    const label = definition?.name ?? '<unnamed>'
    const parameters = parameterSchema(definition)
    if (!definition?.name) violations.push(`${label}: missing name`)
    if (names.has(definition?.name)) violations.push(`${label}: duplicate tool name`)
    names.add(definition?.name)
    if (!definition?.description) violations.push(`${label}: missing description`)
    // The root must declare an object with a property map. A bare property map
    // (`{ code: {...} }`) is the exact shape that broke the model-facing schema.
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) {
      violations.push(`${label}.parameters must be a schema object`)
    } else {
      if (parameters.type !== 'object') {
        violations.push(
          `${label}.parameters.type must be "object" (got ${JSON.stringify(parameters.type)}); ` +
            'register through toRegistryDefinition() so the authored property map is compiled',
        )
      }
      if (!parameters.properties || typeof parameters.properties !== 'object') {
        violations.push(`${label}.parameters.properties must be an object of schemas`)
      }
      checkNode(parameters, `${label}.parameters`, violations, true)
      // Every property the authored form marked required must be reachable.
      const authoredSpec = authoredByName.get(definition?.name)?.parameters ?? {}
      const expected = Object.entries(authoredSpec)
        .filter(([, node]) => node && node.required === true)
        .map(([key]) => key)
        .sort()
      const compiled = Array.isArray(parameters.required) ? [...parameters.required].sort() : []
      if (expected.join(',') !== compiled.join(',')) {
        violations.push(
          `${label}.parameters.required lost authored requiredness: expected [${expected.join(', ')}], ` +
            `compiled [${compiled.join(', ')}]`,
        )
      }
    }
    checkNode(definition?.output?.schema, `${label}.output.schema`, violations)
    if (typeof definition?.output?.render !== 'function') violations.push(`${label}: output.render must be a function`)
    if (typeof definition?.execute !== 'function') violations.push(`${label}: execute must be a function`)
  }
  return violations
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href
if (isMain) {
  const violations = validateToolDefinitions(toolDefinitions, authoredDefinitions)
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ tools: toolDefinitions.map(stripFunctions), violations }, null, 2))
  } else {
    for (const definition of toolDefinitions) {
      const params = Object.keys(definition.parameters?.properties ?? {})
      const required = definition.parameters?.required ?? []
      console.log(
        `${definition.name}: ${params.length} params (${params.join(', ')})` +
          (required.length > 0 ? ` required: ${required.join(', ')}` : ''),
      )
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
