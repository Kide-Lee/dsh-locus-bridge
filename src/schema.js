// Compile Locus tool schemas into the object-rooted JSON Schema that DSH's
// tool registry expects.
//
// `src/tools.js` and `src/csharp/tools.js` author `parameters` as an *implicit
// property map* (`{ code: { type: 'string', required: true } }`) — the shape
// `defineTool()` consumes. Registering that map through `ctx.tools.register`
// directly is silently accepted (the registry only asserts `output.schema`) but
// the map is handed to the model verbatim as `input_schema`, so no property is
// declared and every call arrives as `{}`.
//
// This module performs locally the same compilation
// `dsh-tools/lib/types/schema.js:parameterSchemaSpecToJsonSchema` performs, so
// the definitions cross the registry boundary as a real
// `{ type: 'object', properties, required? }`. It is deliberately local: the
// package must stay loadable without resolving `@deepseek-ai/dsh-tools`
// (scripts/dump-tools.mjs validates it outside a DSH process).
//
// Mirrors dsh-tools/lib/types/schema.js:runSchemaCompiler.

const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples']
const SCALAR_TYPES = ['string', 'number', 'integer', 'boolean', 'null']

function assertSchemaObject(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${path} must be a schema object (got ${describe(value)})`)
  }
  return value
}

function describe(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function assertKeys(node, path, allowed) {
  for (const key of Object.keys(node)) {
    if (allowed.includes(key)) continue
    throw new TypeError(
      `${path}.${key} is not supported by the value schema DSL ` +
        `(allowed here: ${allowed.join(', ')})`,
    )
  }
}

function copyAnnotations(source, target) {
  for (const key of ANNOTATION_KEYS) {
    if (Object.hasOwn(source, key)) target[key] = source[key]
  }
}

/**
 * Compile one value node (the schema of a single argument, an array item, or a
 * `oneOf` branch).
 * @param node - authored value schema.
 * @param path - diagnostic path.
 * @param allowRequired - whether this node may carry a property-level
 *   `required: true` annotation (false inside `items` and `oneOf` branches).
 * @returns The compiled node.
 */
function compileValueNode(node, path, allowRequired) {
  assertSchemaObject(node, path)
  const authorKeys = [...ANNOTATION_KEYS, ...(allowRequired ? ['required'] : [])]

  if (Object.hasOwn(node, 'oneOf')) {
    assertKeys(node, path, [...authorKeys, 'oneOf', 'type'])
    if (Object.hasOwn(node, 'type')) throw new TypeError(`${path} cannot declare both type and oneOf`)
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      throw new TypeError(`${path}.oneOf must be an array of at least two value schemas`)
    }
    const compiled = { oneOf: node.oneOf.map((branch, index) => compileValueNode(branch, `${path}.oneOf[${index}]`, false)) }
    copyAnnotations(node, compiled)
    return compiled
  }

  const type = Object.hasOwn(node, 'type') ? node.type : undefined

  // `json` is the author-only spelling of "any lossless JSON value": DSH
  // compiles it to an annotation-only schema with no `type`.
  if (type === 'json') {
    assertKeys(node, path, [...authorKeys, 'type'])
    const compiled = {}
    copyAnnotations(node, compiled)
    return compiled
  }

  if (type === 'object') {
    assertKeys(node, path, [...authorKeys, 'type', 'properties', 'additionalProperties'])
    if (typeof node.additionalProperties !== 'boolean') {
      throw new TypeError(`${path}.additionalProperties must be explicitly true or false`)
    }
    const compiled = { type: 'object' }
    copyAnnotations(node, compiled)
    compiled.additionalProperties = node.additionalProperties
    if (Object.hasOwn(node, 'properties')) {
      const map = compilePropertyMap(node.properties, `${path}.properties`)
      compiled.properties = map.properties
      if (map.required) compiled.required = map.required
    }
    return compiled
  }

  if (type === 'array') {
    assertKeys(node, path, [...authorKeys, 'type', 'items'])
    const compiled = { type: 'array' }
    copyAnnotations(node, compiled)
    if (Object.hasOwn(node, 'items')) compiled.items = compileValueNode(node.items, `${path}.items`, false)
    return compiled
  }

  if (SCALAR_TYPES.includes(type)) {
    assertKeys(node, path, [...authorKeys, 'type', 'enum', 'const'])
    const compiled = { type }
    copyAnnotations(node, compiled)
    if (Object.hasOwn(node, 'enum')) {
      if (!Array.isArray(node.enum) || node.enum.length === 0) {
        throw new TypeError(`${path}.enum must be a non-empty array of ${type} values`)
      }
      compiled.enum = [...node.enum]
    }
    if (Object.hasOwn(node, 'const')) compiled.const = node.const
    return compiled
  }

  throw new TypeError(
    `${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`,
  )
}

/**
 * Compile one implicit property map, lifting each property's `required: true`
 * annotation into the map's top-level `required` array.
 * @param spec - authored property map.
 * @param path - diagnostic path.
 * @returns `{ properties, required? }`.
 */
export function compilePropertyMap(spec, path = 'parameters') {
  assertSchemaObject(spec, path)
  const properties = {}
  const required = []
  for (const [key, node] of Object.entries(spec)) {
    assertSchemaObject(node, `${path}.${key}`)
    if (Object.hasOwn(node, 'required') && node.required !== true) {
      throw new TypeError(`${path}.${key}.required must be true when present`)
    }
    if (node.required === true) required.push(key)
    properties[key] = compileValueNode(node, `${path}.${key}`, true)
  }
  return required.length > 0 ? { properties, required } : { properties }
}

/**
 * Compile a tool's authored `parameters` into the object-rooted JSON Schema the
 * registry and the model-facing catalog both require.
 *
 * Accepts either authored form:
 *   - an implicit property map (`{ code: {...} }`), or
 *   - an already object-rooted schema (`{ type: 'object', properties, required }`).
 * @param spec - authored parameters.
 * @returns An object-rooted raw JSON Schema.
 */
export function compileParameterSpec(spec) {
  const node = spec ?? {}
  assertSchemaObject(node, 'parameters')
  if (node.type === 'object' && Object.hasOwn(node, 'properties')) {
    const compiled = compileValueNode(node, 'parameters', false)
    delete compiled.required
    return compiled
  }
  const map = compilePropertyMap(node, 'parameters')
  return { type: 'object', properties: map.properties, ...(map.required ? { required: map.required } : {}) }
}

/**
 * Compile a tool's `output.schema`, which is a value schema rather than a
 * property map, so it may legitimately be non-object-rooted.
 * @param spec - authored output schema.
 * @returns The compiled value schema.
 */
export function compileOutputSchema(spec) {
  return compileValueNode(spec ?? {}, 'output.schema', false)
}

/**
 * Return a registry-ready copy of one tool definition with both schemas
 * compiled. The `execute` and `render` callbacks are shared, not copied.
 * @param definition - an authored Locus tool definition.
 * @returns The definition to pass to `ctx.tools.register`.
 */
export function toRegistryDefinition(definition) {
  return {
    ...definition,
    parameters: compileParameterSpec(definition.parameters),
    output: { ...definition.output, schema: compileOutputSchema(definition.output?.schema) },
  }
}
