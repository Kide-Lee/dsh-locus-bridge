// .NET 编译服务客户端（`src/csharp/sidecar.js`）的测试。
//
// 这些测试**不启动真正的 dotnet 进程**：一次真实启动要加载 Roslyn、一次构建要
// 还原 NuGet 包，那样的套件既慢又依赖网络。取而代之的是 `configureSidecar()` 注入
// 的假进程——一个 EventEmitter，`stdin.write` 收到一帧就回一帧，完全是
// `lsp-client.js` 测试里用的同一套做法。
//
// 测试覆盖的是 sidecar 自己的逻辑：分帧往返、错误码映射、失败原因分类
// （no_dotnet / build_failed / start_failed）、并发只启动一次、空闲回收、容量淘汰、
// 以及"绝不自动下载 SDK"这条契约。

import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SIDECAR_CODES,
  SIDECAR_IDLE_TIMEOUT_MS,
  SIDECAR_MAX_WORKSPACES,
  SidecarConnection,
  SidecarError,
  SidecarUnavailable,
  compileRunStates,
  compileSnippet,
  compilerAssemblyPath,
  compilerProjectPath,
  configureSidecar,
  resolveDotnetProgram,
  sidecarPoolSize,
  sidecarStatus,
  shutdownSidecar,
} from '../src/csharp/sidecar.js'
import { encodeLspMessage } from '../src/csharp/lsp-protocol.js'

afterEach(async () => {
  // 池和 Reaper 都挂在模块级状态上，测试之间必须清干净：否则上一个测试留下的
  // 定时器会在下一个测试的假时钟上跑起来，把别人的进程当成"空闲"回收掉。
  await shutdownSidecar()
  configureSidecar(null)
})

/** 一个假子进程：写进来的帧被解析、交给 handler、回的帧通过 stdout 吐出去。 */
class FakeChild extends EventEmitter {
  #handlerPromise = null

  constructor({ handler, pid = 4242 } = {}) {
    super()
    this.pid = pid
    this.exitCode = null
    this.killed = false
    this.writes = []
    this.stdin = new EventEmitter()
    this.stdout = new EventEmitter()
    this.stderr = new EventEmitter()
    this.stdout.setEncoding = () => {}
    this.stderr.setEncoding = () => {}
    // 编译服务的正常收尾就是 stdin EOF（`shutdown` 之后进程自己退），所以
    // `end()` 模拟"它已经走了"，但不主动发 exit——exit 事件由测试或 kill 触发。
    this.stdin.ended = false
    this.stdin.end = () => {
      this.stdin.ended = true
      this.#exit(0, null)
    }
    this.stdin.write = (buffer) => {
      for (const message of decodeFrames(buffer)) this.#handle(message)
      return true
    }
    this.kill = () => {
      this.killed = true
      this.#exit(null, 'SIGTERM')
    }
    this.handler = handler ?? defaultHandler
  }

  #handle(message) {
    this.writes.push(message)
    // 构造里已经设过 null，这里用 ??= 兜住外部直接调用的路径。
    this.#handlerPromise ??= Promise.resolve()
    this.#handlerPromise = this.#handlerPromise
      .then(() => this.handler(message, this))
      .then((reply) => {
        if (reply === undefined || reply === null) return
        const replies = Array.isArray(reply) ? reply : [reply]
        for (const item of replies) this.stdout.emit('data', encodeLspMessage(item))
      })
      .catch((error) => this.emit('error', error))
  }

  #exit(code, signal) {
    if (this.exitCode !== null) return
    this.exitCode = code ?? 0
    setImmediate(() => this.emit('exit', code, signal))
  }
}

/** 把写进 stdin 的字节流解回 JSON 消息（一帧可能被拆成多次写）。 */
function decodeFrames(buffer) {
  const messages = []
  let rest = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer))
  for (;;) {
    const headerEnd = rest.indexOf('\r\n\r\n')
    if (headerEnd < 0) break
    const header = rest.subarray(0, headerEnd).toString('ascii')
    const match = /content-length:\s*(\d+)/i.exec(header)
    if (match === null) break
    const length = Number.parseInt(match[1], 10)
    const bodyStart = headerEnd + 4
    if (rest.length < bodyStart + length) break
    messages.push(JSON.parse(rest.subarray(bodyStart, bodyStart + length).toString('utf8')))
    rest = rest.subarray(bodyStart + length)
  }
  return messages
}

/** 编译服务的默认假应答：initialize 应答版本，compile/snippet 回一个诊断。 */
function defaultHandler(message) {
  if (message.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: { serverName: 'DshFinishCompileServer', protocolVersion: 1, roslynVersion: '5.6.0.0', pid: 4242 },
    }
  }
  if (message.method === 'shutdown') {
    return { jsonrpc: '2.0', id: message.id, result: { ok: true } }
  }
  if (message.method === 'compile/snippet') {
    return {
      jsonrpc: '2.0',
      id: message.id,
      result: {
        ok: false,
        diagnostics: [{ severity: 'error', id: 'CS0103', message: 'The name `x` does not exist.', line: 2, column: 5 }],
        error: 'compilation failed:\n  CS0103 at 2:5: The name `x` does not exist.\n',
        mode: 'csharp',
        reference_origin: 'host',
        duration_ms: 12,
      },
    }
  }
  return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } }
}

/** 装好一份"可用的 .NET + 已构建产物"，返回被 spawn 出来的假进程列表。 */
function installFakeRuntime({ handler, probe = '10.0.403' } = {}) {
  const spawned = []
  const timers = new Map()
  let nextTimerId = 1
  configureSidecar({
    dotnetProgram: '/fake/dotnet',
    probeDotnet: async () => probe,
    ensureBuilt: async () => '/fake/bin/DshFinishCompileServer.dll',
    platformSupported: true,
    spawn: () => {
      const child = new FakeChild({ handler, pid: 5000 + spawned.length })
      spawned.push(child)
      return child
    },
    // 假定时器：不真跑，但必须能被 clearInterval 清掉（`stopReaper()` 依赖这一点）。
    setInterval: (fn) => {
      const id = nextTimerId
      nextTimerId += 1
      timers.set(id, fn)
      return { id, unref() {} }
    },
    clearInterval: (handle) => {
      timers.delete(handle?.id)
    },
  })
  spawned.timers = timers
  return spawned
}

test('sidecar constants and codes match the contract', () => {
  assert.equal(SIDECAR_IDLE_TIMEOUT_MS, 600_000)
  assert.equal(SIDECAR_MAX_WORKSPACES, 8)
  assert.deepEqual([...SIDECAR_CODES], ['no_dotnet', 'build_failed', 'start_failed', 'unsupported_platform'])
})

test('compiler project and assembly paths point into tools/dsh-finish/Compiler', () => {
  assert.match(compilerProjectPath(), /tools[/\\]dsh-finish[/\\]Compiler[/\\]DshFinishCompileServer\.csproj$/)
  assert.match(compilerAssemblyPath(), /tools[/\\]dsh-finish[/\\]Compiler[/\\]bin[/\\](Release|Debug)[/\\]net10\.0[/\\]DshFinishCompileServer\.dll$/)
})

test('SidecarUnavailable carries a code and defaults to no_dotnet', () => {
  const error = new SidecarUnavailable('boom')
  assert.equal(error.name, 'SidecarUnavailable')
  assert.equal(error.code, 'no_dotnet')
  assert.ok(error instanceof Error)
  assert.equal(new SidecarUnavailable('x', { code: 'build_failed' }).code, 'build_failed')
})

test('resolveDotnetProgram honours DOTNET_ROOT and PATH without downloading', () => {
  const root = sandbox()
  try {
    const dotnetRoot = join(root, 'dotnet-root')
    mkdirSync(dotnetRoot, { recursive: true })
    const exeName = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet'
    const exe = join(dotnetRoot, exeName)
    writeFileSync(exe, '')

    assert.equal(resolveDotnetProgram({ env: { DOTNET_ROOT: dotnetRoot, PATH: '' } }), exe)
    assert.equal(resolveDotnetProgram({ env: { PATH: '/nowhere' } }), null)
    // 显式注入优先（测试接缝）。
    configureSidecar({ dotnetProgram: '/injected/dotnet' })
    assert.equal(resolveDotnetProgram({ env: {} }), '/injected/dotnet')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('sidecarStatus reports no_dotnet without throwing', async () => {
  configureSidecar({ dotnetProgram: null, probeDotnet: async () => null, platformSupported: true })
  const status = await sidecarStatus('/some/project')
  assert.equal(status.available, false)
  assert.equal(status.reason, 'no_dotnet')
  assert.equal(typeof status.message, 'string')
  assert.equal('dotnetVersion' in status, false)
})

test('sidecarStatus reports unsupported_platform first', async () => {
  configureSidecar({ dotnetProgram: '/fake/dotnet', probeDotnet: async () => '10.0.403', platformSupported: false })
  const status = await sidecarStatus()
  assert.equal(status.available, false)
  assert.equal(status.reason, 'unsupported_platform')
})

test('sidecarStatus reports not_built when the assembly is missing', async () => {
  const root = sandbox()
  try {
    // 指向一个没有 bin/ 的工程目录：等价于"干净检出、还没 build:compiler"。
    configureSidecar({
      dotnetProgram: '/fake/dotnet',
      probeDotnet: async () => '10.0.403',
      platformSupported: true,
      projectDir: join(root, 'Compiler'),
    })
    const status = await sidecarStatus()
    assert.equal(status.built, false)
    assert.equal(status.available, false)
    assert.equal(status.reason, 'not_built')
    assert.match(status.message, /build:compiler/)
    assert.equal('pid' in status, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('sidecarStatus reports available once a build artifact exists', async () => {
  const root = sandbox()
  try {
    const projectDir = join(root, 'Compiler')
    const binDir = join(projectDir, 'bin', 'Release', 'net10.0')
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, 'DshFinishCompileServer.dll'), '')
    configureSidecar({ dotnetProgram: '/fake/dotnet', probeDotnet: async () => '10.0.403', platformSupported: true, projectDir })
    const status = await sidecarStatus()
    assert.equal(status.available, true)
    assert.equal(status.built, true)
    assert.equal(status.dotnetVersion, '10.0.403')
    assert.equal(status.running, false)
    assert.equal('reason' in status, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('compileSnippet sends a framed request and normalizes the answer', async () => {
  const spawned = installFakeRuntime()
  const result = await compileSnippet('/tmp/unity-project', { code: 'var x = ;' })

  assert.equal(spawned.length, 1)
  const initialize = spawned[0].writes.find((message) => message.method === 'initialize')
  assert.equal(initialize.params.protocolVersion, 1)

  const compile = spawned[0].writes.find((message) => message.method === 'compile/snippet')
  assert.equal(compile.params.code, 'var x = ;')

  // snake_case 的线上格式在 JS 侧变成 camelCase。
  assert.equal(result.ok, false)
  assert.equal(result.diagnostics.length, 1)
  assert.deepEqual(result.diagnostics[0], {
    severity: 'error',
    id: 'CS0103',
    message: 'The name `x` does not exist.',
    line: 2,
    column: 5,
  })
  assert.equal(result.referenceOrigin, 'host')
  assert.match(result.error, /^compilation failed:/)
})

test('compileSnippet forwards usings, mode, references and loop guard', async () => {
  const spawned = installFakeRuntime()
  await compileSnippet('/tmp/p', {
    code: 'var go = Selection.activeGameObject;',
    usings: ['System.Text', 'System.Linq'],
    mode: 'unity',
    references: ['/p/Library/ScriptAssemblies/UnityEngine.dll'],
    loopGuard: true,
  })
  const compile = spawned[0].writes.find((message) => message.method === 'compile/snippet')
  assert.equal(compile.params.mode, 'unity')
  assert.equal(compile.params.loop_guard, true)
  assert.deepEqual(compile.params.references, [{ path: '/p/Library/ScriptAssemblies/UnityEngine.dll' }])
  // usings 被展开成 using 指令行，放在代码前面。
  assert.match(compile.params.code, /^using System\.Text;\nusing System\.Linq;\nvar go = /)
})

test('compileSnippet returns ok with an assembly payload', async () => {
  installFakeRuntime({
    handler: (message) => {
      if (message.method === 'initialize') return { jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } }
      return { jsonrpc: '2.0', id: message.id, result: { ok: true, diagnostics: [], assembly_b64: 'TVqQAAM=' } }
    },
  })
  const result = await compileSnippet('/tmp/p', { code: 'print(1);' })
  assert.equal(result.ok, true)
  assert.equal(result.assemblyB64, 'TVqQAAM=')
  assert.deepEqual(result.diagnostics, [])
  assert.equal('error' in result, false)
})

test('compileSnippet surfaces a JSON-RPC error as SidecarError with the numeric code', async () => {
  installFakeRuntime({
    handler: (message) => {
      if (message.method === 'initialize') return { jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } }
      return { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'missing required parameter: code' } }
    },
  })
  await assert.rejects(compileSnippet('/tmp/p', { code: 'x' }), (error) => {
    assert.ok(error instanceof SidecarError)
    assert.equal(error.code, -32602)
    assert.match(error.message, /missing required parameter: code/)
    return true
  })
})

test('compileSnippet rejects empty code without spawning', async () => {
  const spawned = installFakeRuntime()
  await assert.rejects(compileSnippet('/tmp/p', { code: '' }), (error) => {
    assert.ok(error instanceof SidecarError)
    assert.equal(error.code, 'invalid_params')
    return true
  })
  assert.equal(spawned.length, 0)
})

test('ensureSidecar path: missing .NET raises SidecarUnavailable no_dotnet', async () => {
  const spawned = installFakeRuntime({ probe: null })
  await assert.rejects(compileSnippet('/tmp/p', { code: 'print(1);' }), (error) => {
    assert.ok(error instanceof SidecarUnavailable)
    assert.equal(error.code, 'no_dotnet')
    // 契约：缺 .NET 时绝不启动进程、也绝不下载运行时。
    return true
  })
  assert.equal(spawned.length, 0)
})

test('a failed build becomes build_failed, not a crash', async () => {
  configureSidecar({
    dotnetProgram: '/fake/dotnet',
    probeDotnet: async () => '10.0.403',
    platformSupported: true,
    ensureBuilt: async () => {
      throw new SidecarUnavailable('building the compile sidecar failed: NU1301 offline', { code: 'build_failed' })
    },
  })
  await assert.rejects(compileSnippet('/tmp/p', { code: 'print(1);' }), (error) => {
    assert.ok(error instanceof SidecarUnavailable)
    assert.equal(error.code, 'build_failed')
    return true
  })
})

test('a process that never initializes becomes start_failed', async () => {
  const spawned = installFakeRuntime({
    handler: (message, child) => {
      // 立刻退出，模拟产物坏了。
      if (message.method === 'initialize') {
        setImmediate(() => {
          child.exitCode = 139
          child.emit('exit', 139, null)
        })
      }
      return null
    },
  })
  await assert.rejects(compileSnippet('/tmp/p', { code: 'print(1);' }), (error) => {
    assert.ok(error instanceof SidecarUnavailable)
    assert.equal(error.code, 'start_failed')
    return true
  })
  assert.equal(spawned.length, 1)
})

test('a protocol version mismatch is rejected as a stale build', async () => {
  installFakeRuntime({
    handler: (message) => {
      if (message.method === 'initialize') return { jsonrpc: '2.0', id: message.id, result: { protocolVersion: 99 } }
      if (message.method === 'shutdown') return { jsonrpc: '2.0', id: message.id, result: { ok: true } }
      return null
    },
  })
  await assert.rejects(compileSnippet('/tmp/p', { code: 'print(1);' }), (error) => {
    assert.ok(error instanceof SidecarUnavailable)
    assert.equal(error.code, 'build_failed')
    assert.match(error.message, /protocol 99/)
    return true
  })
})

test('concurrent calls share one process', async () => {
  const spawned = installFakeRuntime()
  const [first, second, third] = await Promise.all([
    compileSnippet('/tmp/p', { code: 'print(1);' }),
    compileSnippet('/tmp/p', { code: 'print(2);' }),
    compileSnippet('/tmp/p', { code: 'print(3);' }),
  ])
  assert.equal(spawned.length, 1)
  assert.equal(first.ok, false)
  assert.equal(second.ok, false)
  assert.equal(third.ok, false)
})

test('a request timeout is reported as SidecarError timeout', async () => {
  installFakeRuntime({
    handler: (message) => {
      if (message.method === 'initialize') return { jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } }
      // 编译请求永不应答（要测超时），但收尾必须应：否则 afterEach 里的 close()
      // 会一直等 `shutdown` 的 3 秒超时，把整个套件拖慢。
      if (message.method === 'shutdown') return { jsonrpc: '2.0', id: message.id, result: { ok: true } }
      return null
    },
  })
  await assert.rejects(compileSnippet('/tmp/p', { code: 'print(1);', timeoutMs: 30 }), (error) => {
    assert.ok(error instanceof SidecarError)
    assert.equal(error.code, 'timeout')
    return true
  })
})

test('shutdownSidecar closes the process and clears the pool', async () => {
  const spawned = installFakeRuntime()
  await compileSnippet('/tmp/p', { code: 'print(1);' })
  assert.equal(spawned.length, 1)
  assert.equal(spawned[0].exitCode, null)

  const closed = await shutdownSidecar('/tmp/p')
  assert.deepEqual(closed, ['/tmp/p'])
  assert.equal(spawned[0].exitCode, 0)

  // 关闭之后再请求会重新起一个进程。
  await compileSnippet('/tmp/p', { code: 'print(2);' })
  assert.equal(spawned.length, 2)
})

test('the workspace cap evicts the least recently used process', async (t) => {
  // 用单调时钟：同一毫秒内启动的进程 lastUsed 完全相同，只靠 Date.now() 的话淘汰
  // 掉哪一个都不算错，断言就没法精确定位到"第 0 个"。时钟通过 t.after 恢复——即便
  // 断言失败也不会把假时钟漏给后面的测试和 afterEach（那会让池里的进程被误判成空闲）。
  const realNow = Date.now
  let clock = realNow() + 1_000_000
  Date.now = () => clock
  t.after(() => {
    Date.now = realNow
  })

  const spawned = installFakeRuntime()
  const roots = Array.from({ length: SIDECAR_MAX_WORKSPACES }, (_, index) => `/tmp/ws-${index}`)
  // 前 7 个只是把池子填起来，不应该淘汰任何进程。
  for (const root of roots.slice(0, SIDECAR_MAX_WORKSPACES - 1)) {
    clock += 1_000
    await compileSnippet(root, { code: 'print(1);' })
  }
  assert.equal(spawned.length, SIDECAR_MAX_WORKSPACES - 1)
  assert.equal(sidecarPoolSize(), SIDECAR_MAX_WORKSPACES - 1)
  assert.ok(spawned.every((child) => child.exitCode === null))

  // 第 8 个工作区正好填满容量：容量是"最多 8 个"，所以这一步还不该淘汰。
  clock += 1_000
  await compileSnippet(`/tmp/ws-${SIDECAR_MAX_WORKSPACES - 1}`, { code: 'print(1);' })
  assert.equal(spawned.length, SIDECAR_MAX_WORKSPACES)
  assert.equal(sidecarPoolSize(), SIDECAR_MAX_WORKSPACES)
  assert.ok(spawned.every((child) => child.exitCode === null))

  // 第 9 个工作区：最久未用的 /tmp/ws-0 被回收。
  // （反过来的 bug 也一并盯住：淘汰条件写成 "> max" 之外的任何形状都会让第 8 个
  // 工作区提前关掉第 1 个，所以上面每步都断言了池子和存活进程。）
  clock += 1_000
  await compileSnippet('/tmp/ws-new', { code: 'print(1);' })
  assert.equal(spawned.length, SIDECAR_MAX_WORKSPACES + 1)
  assert.equal(sidecarPoolSize(), SIDECAR_MAX_WORKSPACES)
  assert.notEqual(spawned[0].exitCode, null)
  assert.equal(spawned[1].exitCode, null)

  // 再来一个：这次轮到 /tmp/ws-1。
  clock += 1_000
  await compileSnippet('/tmp/ws-newer', { code: 'print(1);' })
  assert.equal(spawned.length, SIDECAR_MAX_WORKSPACES + 2)
  assert.equal(sidecarPoolSize(), SIDECAR_MAX_WORKSPACES)
  assert.notEqual(spawned[1].exitCode, null)
  assert.equal(spawned[2].exitCode, null)
})

test('the pool never exceeds the workspace cap, even interleaved', async (t) => {
  // 并发 + 交错是淘汰逻辑最容易越界的地方：两个工作区同时启动时，两边都会看到
  // "已经满员"，如果淘汰条件宽松一点就会关掉两个而只剩 N-1 个。
  const realNow = Date.now
  let clock = realNow() + 2_000_000
  Date.now = () => clock
  t.after(() => {
    Date.now = realNow
  })

  const spawned = installFakeRuntime()
  for (let round = 0; round < 2; round += 1) {
    const batch = Array.from({ length: SIDECAR_MAX_WORKSPACES }, (_, index) => `/tmp/inter-${round}-${index}`)
    clock += 1_000
    await Promise.all(batch.map((root) => compileSnippet(root, { code: 'print(1);' })))
    assert.equal(sidecarPoolSize(), SIDECAR_MAX_WORKSPACES)
    const alive = spawned.filter((child) => child.exitCode === null)
    assert.equal(alive.length, SIDECAR_MAX_WORKSPACES)
  }
})

test('the idle reaper closes processes that sat too long', async (t) => {
  let tick = null
  const spawned = []
  configureSidecar({
    dotnetProgram: '/fake/dotnet',
    probeDotnet: async () => '10.0.403',
    ensureBuilt: async () => '/fake/bin/DshFinishCompileServer.dll',
    platformSupported: true,
    spawn: () => {
      const child = new FakeChild({ pid: 6000 + spawned.length })
      spawned.push(child)
      return child
    },
    setInterval: (fn) => {
      tick = fn
      return { unref() {} }
    },
    clearInterval: () => {
      tick = null
    },
  })

  await compileSnippet('/tmp/p', { code: 'print(1);' })
  assert.equal(spawned.length, 1)
  assert.equal(typeof tick, 'function')

  // 还没到空闲阈值：不回收。
  tick()
  assert.equal(spawned[0].exitCode, null)

  // 把"现在"推到阈值之外，再跑一次回收。
  const realNow = Date.now
  t.after(() => {
    Date.now = realNow
  })
  const offset = SIDECAR_IDLE_TIMEOUT_MS + 1_000
  Date.now = () => realNow() + offset
  tick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.notEqual(spawned[0].exitCode, null)
})

test('compileRunStates sends the request and normalizes the result', async () => {
  const spawned = installFakeRuntime({
    handler: (message) => {
      if (message.method === 'initialize') return { jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } }
      if (message.method === 'compile/runStates') {
        return { jsonrpc: '2.0', id: message.id, result: { ok: true, diagnostics: [], assembly_b64: 'TVqQ' } }
      }
      if (message.method === 'shutdown') return { jsonrpc: '2.0', id: message.id, result: { ok: true } }
      return null
    },
  })

  const result = await compileRunStates('/tmp/p', {
    request_editor_status: 'editing',
    initial_state: 'idle',
    states: [{ name: 'idle', update: 'print(1);' }],
  })
  assert.equal(result.ok, true)
  assert.equal(result.assemblyB64, 'TVqQ')
  const request = spawned[0].writes.find((message) => message.method === 'compile/runStates')
  assert.equal(request.params.initial_state, 'idle')
  assert.equal(request.params.project_root, '/tmp/p')
})

test('a corrupt frame fails the pending request instead of hanging', async () => {
  installFakeRuntime({
    handler: (message, child) => {
      if (message.method === 'initialize') return { jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } }
      // 回一个没有 Content-Length 的垃圾帧。
      child.stdout.emit('data', Buffer.from('garbage without framing\r\n\r\n'))
      return null
    },
  })
  await assert.rejects(compileSnippet('/tmp/p', { code: 'print(1);', timeoutMs: 2_000 }), (error) => {
    assert.ok(error instanceof SidecarUnavailable || error instanceof SidecarError)
    assert.match(String(error.message), /corrupt frame|closed|not running/)
    return true
  })
})

test('SidecarConnection closes its child when the process dies under it', async () => {
  const children = []
  configureSidecar({
    spawn: () => {
      const child = new FakeChild({
        pid: 7000 + children.length,
        handler: (message) => ({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } }),
      })
      children.push(child)
      return child
    },
  })
  const connection = new SidecarConnection({ program: '/fake/dotnet', assembly: '/fake/x.dll' })
  await connection.start()
  assert.equal(connection.connected, true)
  assert.equal(connection.pid, 7000)

  children[0].exitCode = 1
  children[0].emit('exit', 1, null)
  assert.equal(connection.connected, false)
  await assert.rejects(connection.request('compile/snippet', { code: 'x' }), (error) => {
    assert.match(error.message, /not running/)
    return true
  })
})

function sandbox() {
  return mkdtempSync(join(tmpdir(), 'locus-sidecar-test-'))
}