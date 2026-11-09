import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import { normalizePipeName, normalizeProjectPath, projectKey, resolvePipeName, unityPipeNamePart } from '../src/pipe-name.js'
import { toolDefinitions, parameterSpecs } from '../src/tools.js'
import { validateToolDefinitions } from '../scripts/dump-tools.mjs'

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
    assert.equal(resolvePipeName({ projectRoot: 'F:/Projects/Game' }), `\\\\.\\pipe\\${unityPipeNamePart('F:/Projects/Game')}`)
    process.env.LOCUS_UNITY_TEST_PIPE_NAMESPACE = 'test-ns'
    assert.ok(resolvePipeName({ projectRoot: 'F:/Projects/Game' }).endsWith('_test-ns'))
    process.env.LOCUS_UNITY_TEST_PIPE_NAMESPACE = 'bad ns!'
    assert.ok(!resolvePipeName({ projectRoot: 'F:/Projects/Game' }).endsWith('_bad ns!'))
  } finally {
    if (previous === undefined) delete process.env.LOCUS_UNITY_TEST_PIPE_NAMESPACE
    else process.env.LOCUS_UNITY_TEST_PIPE_NAMESPACE = previous
  }
})

test('every tool definition fits the DSH schema subset', () => {
  assert.deepEqual(validateToolDefinitions(toolDefinitions), [])
  assert.deepEqual(
    toolDefinitions.map((definition) => definition.name),
    [
      'unity_status',
      'unity_execute',
      'unity_play_mode',
      'unity_console_log',
      'unity_recompile',
      'unity_asset',
      'unity_scene',
    ],
  )
})

test('plain parameter specs are detached JSON copies', () => {
  const code = toolDefinitions.find((definition) => definition.name === 'unity_execute')
  const specs = parameterSpecs(code)
  assert.notEqual(specs, code.parameters)
  assert.equal(specs.code.type, 'string')
  assert.equal(specs.request_editor_status.required, true)
})
