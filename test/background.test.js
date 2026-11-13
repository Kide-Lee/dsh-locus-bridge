import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LocusClient } from '../src/locus-client.js'
import { __resetPoolForTest, __setClientForTest, shutdownPool } from '../src/client-pool.js'
import { resolvePipeName } from '../src/pipe-name.js'
import { attachHost, toolDefinitions } from '../src/tools.js'
import { registryDefinitions } from '../src/index.js'
import { parseAsyncMode, startBackground, withAsyncParameter } from '../src/background.js'
import { startFakeBroker } from './fake-broker.js'

const tools = Object.fromEntries(toolDefinitions.map((definition) => [definition.name, definition]))
const PROJECT = mkdtempSync(join(tmpdir(), 'locus-background-test-'))
mkdirSync(join(PROJECT, 'Assets'), { recursive: true })
mkdirSync(join(PROJECT, 'ProjectSettings'), { recursive: true })
process.on('exit', () => rmSync(PROJECT, { recursive: true, force: true }))

function ctx(overrides = {}) {
  return {
    agent: { id: 'agent-test', session: { header: { cwd: PROJECT } } },
    signal: new AbortController().signal,
    publish: () => {},
    ...overrides,
  }
}

/** A minimal stand-in for the DSH jobs registry. */
function fakeJobs() {
  const jobs = new Map()
  const started = []
  const waits = []
  return {
    started,
    waits,
    start(spec) {
      const id = `${spec.kind}-test-${started.length + 1}`
      const handle = {
        id,
        output: '',
        progress: '',
        append(text) {
          this.output += String(text)
        },
        updateProgress(line) {
          this.progress = String(line)
        },
      }
      const hooks = spec.run(handle)
      const job = { id, spec, handle, hooks, status: 'running' }
      jobs.set(id, job)
      started.push(job)
      hooks.done.then((outcome) => {
        job.status = outcome.status
        job.detail = outcome.detail
      })
      return id
    },
    async wait(id, timeoutMs, owner) {
      waits.push({ id, timeoutMs, owner })
      const job = jobs.get(id)
      if (!job) throw new Error(`unknown job ${id}`)
      return job.hooks.done
    },
    async kill(id) {
      const job = jobs.get(id)
      if (!job) throw new Error(`unknown job ${id}`)
      job.hooks.cancel('test kill')
      return 'requested'
    },
  }
}

function hostWith(jobs) {
  return { get: (name) => (name === 'jobs' ? jobs : undefined) }
}

async function withEditor(fn) {
  const broker = await startFakeBroker()
  const client = new LocusClient({ pipe: 'fake', stream: broker.stream })
  await client.connect()
  __resetPoolForTest()
  __setClientForTest(resolvePipeName({ projectRoot: PROJECT }), client)
  try {
    return await fn({ broker, client })
  } finally {
    await shutdownPool()
    __resetPoolForTest()
    await broker.close()
  }
}

test('async is injected only into the tools Locus allows to run in the background', () => {
  const definitions = registryDefinitions()
  for (const name of ['unity_execute', 'unity_test']) {
    const definition = definitions.find((entry) => entry.name === name)
    assert.deepEqual(definition.parameters.properties.async.enum, ['sync', 'async', 'notify'])
    assert.equal(definition.parameters.properties.async.default, 'sync')
  }
  for (const name of ['unity_run_states', 'unity_capture', 'unity_recompile']) {
    const definition = definitions.find((entry) => entry.name === name)
    assert.equal(definition.parameters.properties.async, undefined)
  }
  const injected = withAsyncParameter({
    name: 'unity_capture',
    parameters: { type: 'object', properties: {} },
  })
  assert.equal(injected.parameters.properties.async, undefined)
})

test('async mode parsing accepts the canonical values and rejects typos', () => {
  assert.equal(parseAsyncMode(undefined), 'sync')
  assert.equal(parseAsyncMode('sync'), 'sync')
  assert.equal(parseAsyncMode('async'), 'async')
  assert.equal(parseAsyncMode('notify'), 'notify')
  assert.equal(parseAsyncMode('async_notify'), 'notify')
  assert.throws(() => parseAsyncMode('background'), /async must be one of/)
})

test('unity_execute sync still returns the snippet output without a job', async () => {
  const jobs = fakeJobs()
  attachHost(hostWith(jobs))
  await withEditor(async () => {
    const result = await tools.unity_execute.execute(
      { code: 'return 1;', request_editor_status: 'editing' },
      ctx(),
    )
    assert.match(result.output, /ran: return 1;/)
    assert.equal(jobs.started.length, 0)
  })
})

test('unity_execute async returns a job id, runs the snippet and stays silent', async () => {
  const jobs = fakeJobs()
  attachHost(hostWith(jobs))
  await withEditor(async () => {
    const result = await tools.unity_execute.execute(
      { code: 'return 2;', request_editor_status: 'editing', async: 'async' },
      ctx(),
    )
    assert.match(result.output, /Started background job unity_execute-test-1/)
    assert.match(result.output, /job_output/)
    assert.equal(jobs.started.length, 1)
    const job = jobs.started[0]
    assert.equal(job.spec.owner, 'agent-test')
    assert.equal(job.spec.kind, 'unity_execute')
    const outcome = await job.hooks.done
    assert.equal(outcome.status, 'completed')
    assert.match(job.handle.output, /ran: return 2;/)
    assert.equal(jobs.waits.length, 1)
    assert.equal(jobs.waits[0].owner, 'agent-test')
  })
})

test('unity_execute notify does not register a silent waiter', async () => {
  const jobs = fakeJobs()
  attachHost(hostWith(jobs))
  await withEditor(async () => {
    const result = await tools.unity_execute.execute(
      { code: 'return 3;', request_editor_status: 'editing', async: 'notify' },
      ctx(),
    )
    assert.match(result.output, /delivered automatically/)
    const job = jobs.started[0]
    const outcome = await job.hooks.done
    assert.equal(outcome.status, 'completed')
    assert.equal(jobs.waits.length, 0)
  })
})

test('a failing background run settles as failed and carries the error text', async () => {
  const jobs = fakeJobs()
  const exec = { agent: { id: 'agent-test' } }
  const started = startBackground({
    jobs,
    exec,
    kind: 'unity_execute',
    label: 'unity_execute test',
    mode: 'notify',
    run: async () => {
      throw new Error('boom')
    },
    render: () => '',
    isFailure: () => false,
  })
  const job = jobs.started[0]
  const outcome = await job.hooks.done
  assert.equal(outcome.status, 'failed')
  assert.match(job.handle.output, /Error: boom/)
  assert.match(started.text, /Started background job/)
})

test('cancelling a background job aborts its signal and settles as killed', async () => {
  const jobs = fakeJobs()
  let signal
  startBackground({
    jobs,
    exec: { agent: { id: 'agent-test' } },
    kind: 'unity_execute',
    label: 'unity_execute test',
    mode: 'notify',
    run: async (bgExec) => {
      signal = bgExec.signal
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { output: 'done' }
    },
    render: (value) => value.output,
  })
  const job = jobs.started[0]
  job.hooks.cancel('stop')
  const outcome = await job.hooks.done
  assert.equal(outcome.status, 'killed')
  assert.equal(signal.aborted, true)
  assert.match(job.handle.output, /done/)
})

test('unity_test only background-runs the run action', async () => {
  await assert.rejects(
    () => tools.unity_test.execute({ action: 'list', async: 'async' }, ctx()),
    /async is only supported for action "run"/,
  )
})

test('unity_test async run settles with the formatted test result', async () => {
  const jobs = fakeJobs()
  attachHost(hostWith(jobs))
  await withEditor(async () => {
    const result = await tools.unity_test.execute(
      { action: 'run', async: 'notify' },
      ctx(),
    )
    assert.match(result.text, /Started background job unity_test-test-1/)
    const job = jobs.started[0]
    const outcome = await job.hooks.done
    assert.equal(outcome.status, 'completed')
    assert.match(job.handle.output, /Unity Test run passed/)
  })
})
