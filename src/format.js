// Human-readable renderings for Locus tool results.

import { CAPABILITIES, splitCapabilities } from './protocol.js'

/** Render a `status` result (or a failed connection attempt). */
export function formatStatus({ connected, status, scenes = [], pipe, projectRoot, capabilities = [], reloadState = null, error }) {
  const lines = []
  if (connected) {
    lines.push(`Unity Editor: connected (${status})`)
  } else {
    lines.push('Unity Editor: disconnected')
  }
  if (projectRoot) lines.push(`Project: ${projectRoot}`)
  if (pipe) lines.push(`Pipe: ${pipe}`)
  if (connected && scenes.length > 0) {
    lines.push(`Scenes: ${scenes.join(', ')}`)
    if (scenes.length > 1) lines.push(`Active scene: ${scenes[0]}`)
  }
  if (capabilities && capabilities.length > 0) {
    const caps = splitCapabilities(capabilities.join(','))
    // Highlight the capabilities this bridge relies on; the rest stay implied.
    const required = [CAPABILITIES.EXECUTION_PROGRESS_V1, CAPABILITIES.EXECUTION_CANCEL_V1, CAPABILITIES.COMPILE_RESULT_V1]
    const missing = required.filter((capability) => !caps.includes(capability))
    lines.push(
      `Capabilities: ${caps.join(', ')}` + (missing.length > 0 ? ` (missing: ${missing.join(', ')})` : ''),
    )
  }
  if (connected && reloadState && typeof reloadState === 'object') {
    const parts = []
    if (reloadState.converged_serial !== undefined) parts.push(`converged serial ${reloadState.converged_serial}`)
    if (reloadState.is_compiling) parts.push('compiling')
    if (reloadState.is_updating) parts.push('importing')
    if (reloadState.domain_generation) parts.push(`domain ${String(reloadState.domain_generation).slice(0, 8)}`)
    if (parts.length > 0) lines.push(`Reload state: ${parts.join(', ')}`)
  }
  if (error) lines.push(`Reason: ${error}`)
  if (!connected) {
    lines.push(
      'Hint: require the Locus Unity package + native broker DLL, and Library/Locus/NativeBridge.enabled ' +
        '(or LOCUS_UNITY_NATIVE_BRIDGE=1).',
    )
  }
  return lines.join('\n')
}
