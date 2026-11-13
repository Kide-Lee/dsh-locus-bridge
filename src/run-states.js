// `unity_run_states`: a C# state machine driven across Unity Editor frames.
//
// The wire contract is the editor's own `run_states` message (see
// `payload/locus_unity/Editor/LocusBridge.RunStates.cs`): the request is a
// plain JSON object and the response is a single text block. This module owns
// the request shape and the output-size policy; the tool definition owns the
// connection and status gate.
//
// Output policy mirrors upstream
// `src-tauri/src/unity_bridge/mod.rs::rewrite_run_states_output_for_size`:
// up to 100k estimated tokens is returned inline, 100k..1M is saved under
// `Library/Locus/RunStates` and replaced by a header + `result_file`, and
// anything above 1M is an error because the editor refused to retain it.

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const RUN_STATES_INLINE_PRINT_LIMIT_TOKENS = 100_000
export const RUN_STATES_HARD_PRINT_LIMIT_TOKENS = 1_000_000
export const RUN_STATES_TOKEN_BYTE_RATIO = 4

// The broker expires an ordinary request after 10 minutes (its execution
// commands get two hours, but `run_states` is not one of them upstream either).
// The client backstop waits slightly longer so the broker's own error, when it
// arrives, is the one the caller sees.
export const RUN_STATES_REQUEST_TIMEOUT_MS = 11 * 60 * 1000

const EDITOR_STATUSES = ['editing', 'playing', 'playing_paused']

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required parameter: ${field}.`)
  }
  return value
}

function optionalString(value, field) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`)
  return value
}

/**
 * Validate and normalize the tool arguments into the editor's request object.
 *
 * Validation is deliberately done here as well as in Unity: it fails before a
 * connection is opened, and it names the argument instead of surfacing the
 * editor's `RunStatesRequest` wording.
 */
export function buildRunStatesRequest(args = {}) {
  const status = requiredString(args.request_editor_status, 'request_editor_status').trim()
  if (!EDITOR_STATUSES.includes(status)) {
    throw new Error(
      `Invalid request_editor_status "${status}". Allowed values: ${EDITOR_STATUSES.join(', ')}.`,
    )
  }

  const initialState = requiredString(args.initial_state, 'initial_state').trim()
  if (!Array.isArray(args.states) || args.states.length === 0) {
    throw new Error('Missing required parameter: states (at least one state).')
  }

  const names = new Set()
  const states = args.states.map((state, index) => {
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error(`states[${index}] must be an object.`)
    }
    const name = requiredString(state.name, `states[${index}].name`).trim()
    if (names.has(name)) throw new Error(`Duplicate state name "${name}".`)
    names.add(name)
    requiredString(state.update, `states[${index}].update`)
    return {
      name,
      variables: optionalString(state.variables, `states[${index}].variables`),
      start: optionalString(state.start, `states[${index}].start`),
      update: state.update,
      end: optionalString(state.end, `states[${index}].end`),
    }
  })

  if (!names.has(initialState)) {
    throw new Error(`initial_state "${initialState}" is not one of the declared states.`)
  }

  return {
    request_editor_status: status,
    initial_state: initialState,
    states,
  }
}

function parseField(output, key) {
  const prefix = `${key}:`
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith(prefix)) continue
    const value = trimmed.slice(prefix.length).trim()
    if (/^\d+$/.test(value)) return Number(value)
  }
  return undefined
}

function headerText(output) {
  const lines = []
  for (const line of output.split('\n')) {
    if (line.trim().toLowerCase() === 'prints:') break
    lines.push(line.replace(/\r$/, ''))
  }
  return lines.join('\n')
}

function computePrintStats(output) {
  let foundPrints = false
  let lines = 0
  let bytes = 0
  for (const line of output.split('\n')) {
    if (foundPrints) {
      lines += 1
      bytes += Buffer.byteLength(line, 'utf8') + 1
      continue
    }
    if (line.trim().toLowerCase() === 'prints:') foundPrints = true
  }

  // Only the header counts: a printed line must never be able to spoof the
  // size fields that decide whether this output is saved or refused.
  const header = headerText(output)
  const declaredLines = parseField(header, 'print_lines')
  const declaredTokens = parseField(header, 'print_tokens_estimate')
  return {
    lines: declaredLines ?? lines,
    tokens:
      declaredTokens ??
      (bytes === 0 ? 0 : Math.ceil(bytes / RUN_STATES_TOKEN_BYTE_RATIO)),
  }
}

function outputHeader(output) {
  return headerText(output)
}

function hasField(output, key) {
  const prefix = `${key}:`
  return output.split('\n').some((line) => line.trimStart().startsWith(prefix))
}

function pushFieldIfMissing(summary, header, key, value) {
  if (!hasField(header, key)) summary.push(`${key}: ${value}`)
}

function buildLargeSummary(output, stats, resultFile) {
  const header = outputHeader(output)
  const summary = []
  summary.push(header.trimEnd())
  pushFieldIfMissing(summary, header, 'print_lines', String(stats.lines))
  pushFieldIfMissing(summary, header, 'print_tokens_estimate', String(stats.tokens))
  pushFieldIfMissing(summary, header, 'print_output', 'too large')
  if (resultFile) {
    pushFieldIfMissing(summary, header, 'result_file', resultFile)
    pushFieldIfMissing(
      summary,
      header,
      'print_output_message',
      `print output exceeded ${RUN_STATES_INLINE_PRINT_LIMIT_TOKENS} estimated tokens; full result saved to result_file.`,
    )
  } else {
    pushFieldIfMissing(
      summary,
      header,
      'print_output_message',
      `print output exceeded hard limit of ${RUN_STATES_HARD_PRINT_LIMIT_TOKENS} estimated tokens; result was not saved.`,
    )
  }
  return summary.filter((line) => line.length > 0).join('\n').trimEnd()
}

function resultDirectory(projectRoot) {
  return join(projectRoot, 'Library', 'Locus', 'RunStates')
}

async function persistResult(projectRoot, output) {
  const directory = resultDirectory(projectRoot)
  await mkdir(directory, { recursive: true })
  const file = join(directory, `run-states-${randomUUID()}.txt`)
  await writeFile(file, output, 'utf8')
  return file
}

/**
 * Apply the inline/saved/refused policy to one `run_states` response body.
 *
 * Returns the text the tool should render. Throws when the body exceeds the
 * editor's hard limit (upstream reports that as an error, because the prints
 * were already discarded) or when a file that should have been saved cannot be.
 */
export async function rewriteRunStatesOutput(projectRoot, output) {
  const text = String(output ?? '')
  const stats = computePrintStats(text)
  if (stats.tokens <= RUN_STATES_INLINE_PRINT_LIMIT_TOKENS) return text

  if (stats.tokens > RUN_STATES_HARD_PRINT_LIMIT_TOKENS) {
    throw new Error(buildLargeSummary(text, stats, null))
  }

  let resultFile
  try {
    resultFile = await persistResult(projectRoot, text)
  } catch (error) {
    throw new Error(
      [
        'print_output: too large',
        `print_lines: ${stats.lines}`,
        `print_tokens_estimate: ${stats.tokens}`,
        'print_output_message: print output exceeded inline limit and could not be saved.',
        error instanceof Error ? error.message : String(error),
      ].join('\n'),
    )
  }

  return buildLargeSummary(text, stats, resultFile)
}

export { computePrintStats }
