// Real-registry validation: load the definitions through the installed DSH's
// own dsh-tools (when resolvable) so schema compilation/validation errors show
// up here instead of when DSH loads the plugin.
//
// The bare-ESM definitions register as-is; this script additionally wraps them
// with `defineTool` and validates a sample argument set per tool.

import { createRequire } from 'node:module'
import { toolDefinitions, parameterSpecs } from '../src/tools.js'

const require = createRequire(import.meta.url)

async function loadDshTools() {
  const candidates = [
    '@deepseek-ai/dsh-tools',
    // DSH checkout installs every bundled package under its own node_modules.
    process.env.DSH_TOOLS_PATH,
  ].filter(Boolean)
  for (const specifier of candidates) {
    try {
      return await import(specifier.startsWith('/') ? `file://${specifier}` : specifier)
    } catch {
      // try the next candidate
    }
  }
  return null
}

const dshTools = await loadDshTools()
if (!dshTools) {
  console.log('dsh-tools not resolvable; run with DSH_TOOLS_PATH=/abs/path/to/dsh-tools/lib/index.js')
  process.exitCode = 2
} else {
  const { defineTool, validateArgs } = dshTools
  let failures = 0
  for (const raw of toolDefinitions) {
    try {
      const parameters = parameterSpecs(raw)
      const definition = defineTool({ ...raw, parameters })
      const violations = validateArgs(parameters, sampleArgs(definition.name))
      if (violations.length > 0) {
        failures += 1
        console.log(`${definition.name}: sample args rejected: ${violations.join('; ')}`)
      } else {
        console.log(`${definition.name}: ok (${Object.keys(definition.parameters.properties ?? {}).length} params)`)
      }
    } catch (error) {
      failures += 1
      console.log(`${raw.name}: defineTool rejected: ${error.message}`)
    }
  }
  process.exitCode = failures === 0 ? 0 : 1
}

function sampleArgs(name) {
  switch (name) {
    case 'unity_status':
      return { project_path: 'F:/Projects/Game' }
    case 'unity_execute':
      return {
        code: 'print(Application.dataPath);',
        readonly: true,
        request_editor_status: 'editing',
        timeout: 600000,
      }
    case 'unity_play_mode':
      return { mode: 'edit' }
    case 'unity_console_log':
      return { levels: ['warn', 'error'], limit: 50 }
    case 'unity_recompile':
      return { sync: { mode: 'targeted', paths: ['Assets/Scripts/Player.cs'] }, reason: 'validation sample' }
    case 'unity_asset':
      return {
        action: 'apply',
        path: 'Assets/Config/Balance.asset',
        snapshot: { revision: 'live:abc', path: 'Assets/Config/Balance.asset', objects: [] },
        edits: [
          {
            operation: {
              op: 'set',
              object_id: '11400000',
              property_path: 'maxHealth',
              value: 120,
            },
          },
        ],
      }
    case 'unity_scene':
      return {
        action: 'set',
        scene_path: 'Assets/Scenes/Main.unity',
        object_path: 'Canvas/Button',
        component_type: 'RectTransform',
        property_path: 'm_LocalPosition',
        operation: { op: 'set', value: '0,1,0' },
      }
    default:
      return {}
  }
}
