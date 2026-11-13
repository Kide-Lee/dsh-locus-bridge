// Background execution for the synchronous Unity tools.
//
// Locus exposes this as a host-injected `async` argument on a small whitelist
// of tools: `sync` waits for the result, `async` returns a job id and leaves
// the result for `job_output`, and `notify` also returns a job id but lets the
// host deliver the completion automatically.
//
// DSH's equivalent primitive is `ctx.jobs` (`@deepseek-ai/dsh-jobs`). A job is
// owned by the calling agent session, is process-local, and is observed through
// the `job_output` / `job_kill` tools. The host only skips its completion
// notice for a job that somebody is already waiting on, which is how the silent
// `async` mode is produced: the bridge starts an internal wait, but does not
// read the result itself.

export const ASYNC_MODES = ['sync', 'async', 'notify']

/** Only these tools get the host-injected `async` parameter. */
export const BACKGROUND_TOOL_NAMES = new Set(['unity_execute', 'unity_test'])

/**
 * Long enough for the tools' own one-hour ceilings. The wait exists only to
 * mark the job as observed, so a timeout merely restores the normal notice.
 */
const SILENT_WAIT_MS = 24 * 60 * 60 * 1000

/** Job output is text; keep the ring bounded well below the DSH default. */
const OUTPUT_LIMIT_BYTES = 64 * 1024

export const ASYNC_PARAMETER = {
  type: 'string',
  enum: ASYNC_MODES,
  default: 'sync',
  description:
    'How to run this tool. `sync` (default) waits for the result. `async` returns a job id immediately and leaves ' +
    'the result for `job_output`; no completion notice is sent. `notify` also returns immediately, but the host ' +
    'delivers the completion result automatically. The job runs in this Session; `job_kill` cancels it.',
}

/**
 * Parse the host-injected `async` argument.
 *
 * `async_notify` is accepted as an alias for `notify`, matching the mode name
 * Locus itself accepts internally even though its tool schema only advertises
 * the three canonical values.
 */
export function parseAsyncMode(value) {
  if (value === undefined || value === null || value === '') return 'sync'
  const mode = String(value).trim()
  if (mode === 'async_notify') return 'notify'
  if (ASYNC_MODES.includes(mode)) return mode
  throw new Error(`async must be one of ${ASYNC_MODES.join(', ')} (got ${JSON.stringify(value)}).`)
}

/**
 * Add the `async` parameter to one compiled registry definition.
 *
 * The value is injected here, after `toRegistryDefinition` has compiled the
 * authored parameter map, so the model sees a normal property in the tool
 * schema while the tool's own `parameters` stays unchanged.
 */
export function withAsyncParameter(definition) {
  if (!BACKGROUND_TOOL_NAMES.has(definition.name)) return definition
  const parameters = definition.parameters ?? {}
  if (!parameters.properties) {
    throw new TypeError(`${definition.name}: async injection needs a compiled parameters object.`)
  }
  return {
    ...definition,
    parameters: {
      ...parameters,
      properties: { ...parameters.properties, async: { ...ASYNC_PARAMETER } },
    },
  }
}

function ownerOf(exec) {
  const owner = exec?.agent?.id ?? exec?.agent?.session?.id
  if (typeof owner !== 'string' || owner.length === 0) {
    throw new Error('background execution needs an agent-owned Session; this call has no owner id.')
  }
  return owner
}

/**
 * Start one job and return the id plus the text the tool should return.
 *
 * @param jobs - the DSH `jobs` service (`ctx.get('jobs')`).
 * @param exec - the tool execution context; `agent`, `callId`, `rootCallId`.
 * @param kind - short job kind, e.g. `unity_execute`.
 * @param label - human-readable label for `job_list`.
 * @param mode - `async` or `notify`.
 * @param run - async `(bgExec) => result` that performs the real tool call.
 * @param render - `(result) => string` producing the job's final output.
 * @param isFailure - optional `(result) => boolean` for tools that report
 *   failures as ordinary return values instead of throwing.
 */
export function startBackground({ jobs, exec, kind, label, mode, run, render = (value) => String(value ?? ''), isFailure }) {
  if (!jobs || typeof jobs.start !== 'function') {
    throw new Error(
      'background execution unavailable: no DSH jobs service is loaded. ' +
        'Load @deepseek-ai/dsh-tool-jobs in this profile, or call this tool with async: "sync".',
    )
  }
  const owner = ownerOf(exec)
  const toolCall = typeof exec?.callId === 'string'
    ? { callId: exec.callId, rootCallId: typeof exec.rootCallId === 'string' ? exec.rootCallId : exec.callId }
    : undefined

  let id
  try {
    id = jobs.start({
      kind,
      label: label || kind,
      owner,
      ...(toolCall ? { toolCall } : {}),
      outputLimitBytes: OUTPUT_LIMIT_BYTES,
      run(handle) {
        const controller = new AbortController()
        let cancelled = false
        let finishing = false
        const bgExec = {
          ...exec,
          signal: controller.signal,
          publish: (text) => {
            if (text) handle.updateProgress(String(text))
          },
        }
        const done = (async () => {
          // Let `start()` return the id and let a silent waiter register before
          // a fast tool can settle the job.
          await Promise.resolve()
          try {
            const result = await run(bgExec)
            const text = render(result)
            if (text) handle.append(text)
            const wasCancelled = cancelled || result?.cancelled === true || result?.status === 'cancelled'
            if (wasCancelled) return { status: 'killed', detail: text || 'cancelled' }
            if (isFailure?.(result)) return { status: 'failed', detail: text || 'failed' }
            return { status: 'completed', detail: text }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const text = `Error: ${message}`
            handle.append(text)
            if (cancelled || controller.signal.aborted) return { status: 'killed', detail: text }
            return { status: 'failed', detail: text }
          } finally {
            finishing = true
          }
        })()
        return {
          cancel(reason) {
            if (finishing) return
            cancelled = true
            controller.abort(reason ?? new Error('background job cancelled'))
          },
          done,
        }
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`background job could not start: ${message}`)
  }

  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('background job could not start: the jobs service returned no job id.')
  }

  if (mode === 'async' && typeof jobs.wait === 'function') {
    // Deliberately not awaited: this only marks the job as observed so the
    // host suppresses its completion notice, matching Locus's silent `async`.
    try {
      void jobs.wait(id, SILENT_WAIT_MS, owner).catch(() => {})
    } catch {
      // A wait failure is not a execution failure; the job still runs.
    }
  }

  const text = [
    `Started background job ${id} (${kind}).`,
    mode === 'notify'
      ? 'The completion result is delivered automatically when it finishes.'
      : 'Read its output with `job_output`; this mode sends no completion notice.',
    `Cancel it with \`job_kill\` and the id above.`,
  ].join('\n')
  return { id, mode, text }
}

/** A stable, readable job label without pulling in path helpers. */
export function jobLabel(kind, detail) {
  return detail ? `${kind} ${String(detail).slice(0, 120)}` : kind
}
