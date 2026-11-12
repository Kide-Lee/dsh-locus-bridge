import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  isSocketEndpoint,
  isWindowsHost,
  normalizePipeName,
  normalizeProjectPath,
  projectKey,
  resolvePipeName,
  unityPipeNamePart,
  unitySocketPath,
} from '../src/pipe-name.js'
import { toolDefinitions, parameterSpecs } from '../src/tools.js'
import { registryDefinitions, allToolDefinitions } from '../src/index.js'
import { validateToolDefinitions } from '../scripts/dump-tools.mjs'

/** A fixed environment so the socket-derivation test does not depend on the host. */
const UNIX_ENV = { runtimeRoot: '/run/user/1000/locus' }

test('pipe names match the Rust/Unity derivation (names.rs)', () => {
  // Mirrors `unity_names_match_the_historical_derivation`.
  const key = projectKey('F:/Projects/Game/')
  assert.equal(key.length, 32)
  assert.equal(key, projectKey('f:\\projects\\game'))
  assert.equal(key, projectKey('\\\\?\\F:\\Projects\\Game'))
  assert.equal(
    unityPipeNamePart('F:/Projects/Game'),
    `locus_unity_native_${createHash('sha256').update('f:\\projects\\game').digest('hex').slice(0, 32)}`,
  )
  assert.equal(normalizeProjectPath('C:\\'), 'c:\\')
})

test('pipe name normalization prefixes \\\\.\\pipe\\ exactly once', () => {
  assert.equal(normalizePipeName('locus_unity_native_abc'), '\\\\.\\pipe\\locus_unity_native_abc')
  assert.equal(normalizePipeName('\\\\.\\pipe\\x'), '\\\\.\\pipe\\x')
  assert.equal(normalizePipeName('  abc  '), '\\\\.\\pipe\\abc')
})

test('absolute socket paths pass through normalization unchanged', () => {
  // The marker on Linux holds the exact path the broker bound; rewriting it
  // would point the client at a Win32 pipe that can never exist.
  const path = '/run/user/1000/locus/locus_unity_native_abc.sock'
  assert.equal(isSocketEndpoint(path), true)
  assert.equal(isSocketEndpoint('\\\\.\\pipe\\x'), false)
  assert.equal(normalizePipeName(path), path)
  assert.equal(normalizePipeName(`  ${path}  `), path)
})

test('socket path derivation mirrors names_unix.rs', { skip: isWindowsHost() && 'POSIX path derivation is host-relative' }, () => {
  // `<runtime dir>/locus/locus_unity_native_<project key>.sock`
  // `unitySocketPath` uses `path.join`, so on Windows the same inputs produce
  // backslashes; this derivation only describes a Unix host.
  assert.equal(
    unitySocketPath('/home/me/Game', UNIX_ENV),
    `/run/user/1000/locus/locus_unity_native_${projectKey('/home/me/Game')}.sock`,
  )
  // TMPDIR is the fallback when XDG_RUNTIME_DIR is unset; the broker probes the
  // same candidate list.
  assert.equal(
    unitySocketPath('/home/me/Game', { runtimeRoot: '/var/tmp/locus' }),
    `/var/tmp/locus/locus_unity_native_${projectKey('/home/me/Game')}.sock`,
  )
  // A relative project path still gets a stable, per-project name.
  assert.notEqual(unitySocketPath('/a/Game', UNIX_ENV), unitySocketPath('/a/Other', UNIX_ENV))
})

test('resolvePipeName precedence: explicit > marker line > project > empty', () => {
  const previous = process.env.LOCUS_UNITY_TEST_PIPE_NAMESPACE
  delete process.env.LOCUS_UNITY_TEST_PIPE_NAMESPACE
  try {
    // The plugin reads the FIRST non-empty marker line (`ResolveNativePipeName`).
    assert.equal(
      resolvePipeName({ projectRoot: 'F:/Projects/Game', markerLines: ['\uFEFF marker_pipe ', '', 'late'] }),
      '\\\\.\\pipe\\marker_pipe',
    )
    assert.equal(resolvePipeName({ projectRoot: 'F:/Projects/Game', pipe: 'explicit' }), '\\\\.\\pipe\\explicit')
    // The marker may name an absolute Unix socket; it is never re-prefixed.
    const socketPath = '/run/user/1000/locus/locus_unity_native_abc.sock'
    assert.equal(
      resolvePipeName({ projectRoot: 'F:/Projects/Game', markerLines: [socketPath] }),
      socketPath,
    )
    if (isWindowsHost()) {
      assert.equal(resolvePipeName({ projectRoot: 'F:/Projects/Game' }), `\\\\.\\pipe\\${unityPipeNamePart('F:/Projects/Game')}`)
    } else {
      assert.equal(
        resolvePipeName({ projectRoot: '/home/me/Game', ...UNIX_ENV }),
        unitySocketPath('/home/me/Game', UNIX_ENV),
      )
    }
    assert.equal(resolvePipeName({}), '')
  } finally {
    if (previous === undefined) delete process.env.LOCUS_UNITY_TEST_PIPE_NAMESPACE
    else process.env.LOCUS_UNITY_TEST_PIPE_NAMESPACE = previous
  }
})

test('the test namespace suffixes both endpoint shapes', { skip: isWindowsHost() && 'POSIX socket naming is host-relative' }, () => {
  // The namespace travels in the same environment object as the runtime root, so
  // a test broker can live next to a production one on either transport.
  const namespaced = { ...UNIX_ENV, LOCUS_UNITY_TEST_PIPE_NAMESPACE: 'test-ns' }
  const unix = resolvePipeName({ projectRoot: '/home/me/Game', env: namespaced })
  assert.ok(unix.endsWith('_test-ns.sock'), unix)
  const rejected = { ...UNIX_ENV, LOCUS_UNITY_TEST_PIPE_NAMESPACE: 'bad ns!' }
  assert.ok(!resolvePipeName({ projectRoot: '/home/me/Game', env: rejected }).includes('bad ns!'))
})

test('every tool definition fits the DSH schema subset', () => {
  // The REGISTRY definitions, not the authored ones: these are what
  // `ctx.tools.register` receives and what the model sees as `input_schema`.
  // Validating the authored form is what let a property-map `parameters` reach
  // the registry uncompiled while every check still passed.
  const registry = registryDefinitions()
  assert.deepEqual(validateToolDefinitions(registry, allToolDefinitions()), [])
  assert.deepEqual(
    registry.map((definition) => definition.name),
    [
      'unity_status',
      'unity_execute',
      'unity_play_mode',
      'unity_console_log',
      'unity_recompile',
      'unity_test',
      'unity_asset',
      'unity_asset_graph',
      'unity_capture',
      'unity_scene',
      'code_symbol_search',
      'code_goto_definition',
      'code_find_references',
      'code_hover',
      'code_diagnostics',
      'code_analysis',
    ],
  )
})

test('registry parameters are object-rooted schemas with authored requiredness', () => {
  const registry = registryDefinitions()
  for (const definition of registry) {
    assert.equal(definition.parameters.type, 'object', `${definition.name} must be object-rooted`)
    assert.equal(typeof definition.parameters.properties, 'object', `${definition.name} must declare properties`)
    // No field-level `required` may survive into the registry form.
    for (const [key, node] of Object.entries(definition.parameters.properties)) {
      assert.equal(node.required, undefined, `${definition.name}.${key} kept a field-level required`)
    }
    // The root must be an open object: DSH rejects a closed root for parameters.
    assert.equal(definition.parameters.additionalProperties, undefined)
  }
  // Spot-check the tools whose requiredness the model depends on.
  const capture = registry.find((definition) => definition.name === 'unity_capture')
  assert.deepEqual([...capture.parameters.required].sort(), ['request_editor_status', 'target'])
  const execute = registry.find((definition) => definition.name === 'unity_execute')
  assert.deepEqual([...execute.parameters.required].sort(), ['code', 'request_editor_status'])
})

test('an uncompiled definition is rejected by the schema check', () => {
  // Regression guard: this is precisely the shipped bug — registering the
  // authored property map instead of the compiled schema.
  const violations = validateToolDefinitions(toolDefinitions, toolDefinitions)
  assert.ok(violations.length > 0, 'the authored property map must fail validation')
  assert.ok(
    violations.some((violation) => violation.includes('parameters.type must be "object"')),
    'the check must name the missing object root',
  )
})

test('plain parameter specs are detached JSON copies', () => {
  const code = toolDefinitions.find((definition) => definition.name === 'unity_execute')
  const specs = parameterSpecs(code)
  assert.notEqual(specs, code.parameters)
  assert.equal(specs.code.type, 'string')
  assert.equal(specs.request_editor_status.required, true)
})
