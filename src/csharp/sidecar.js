// .NET sidecar：本插件自带的一个小型编译服务（tools/dsh-finish/Compiler）。
//
// 为什么需要它：`unity_execute` 那条路径靠 Unity 编辑器自己编译代码——快，但要求
// 编辑器连着、在正确的模式下、而且一次只能编一段。而"这段代码能不能编译"这个
// 问题在写代码的时候就要有答案，不该等编辑器。所以这里加了一个独立的 Roslyn
// 进程：不连 Unity，直接把代码编成程序集，只回诊断。
//
// 与 `lsp-pool.js` 相同的生命周期策略（每工作区一个进程、懒启动、空闲 600 秒回收、
// 全局上限 8 个、LRU 淘汰），因为两者面对的是同一类资源：一个占着几百 MB 的 .NET
// 进程，用户没在用的时候必须还回去。
//
// ## 绝不下载 SDK
//
// `assets.js` 会在缺 .NET 运行时的时候下载一个（那是给语言服务器用的、已经签过
// 契约的大型资产）。这里复用不了那条路：编译服务是随插件源码发布的、用户机器上
// 未必有 .NET 10，缺的时候唯一正确的行为是**如实报告**——抛 `SidecarUnavailable`
// 带 `code: 'no_dotnet'`，让调用方退回 Unity 编辑器那条路。悄悄下载一个 SDK 会让
// 一个"只读一下诊断"的请求变成几百 MB 的网络流量。
//
// ## 构建与离线
//
// 编译服务是随插件发布的 C# 工程（`tools/dsh-finish/Compiler`），不预编译进
// tarball：产物依赖宿主机的运行时，交叉编译出来也不能保证在别人机器上加载。所以
// 第一次用到时跑一次 `dotnet build -c Release`，之后同一个进程里一直复用产物。
//
// 这一步**需要** NuGet 上的 `Microsoft.CodeAnalysis.CSharp`；如果本机缓存里已有
// （跑过一次、或离线镜像预热过），构建完全离线可用——`dotnet build` 会先在
// `~/.nuget/packages` 里找。真正的离线语义是：构建失败就报 `build_failed` 并让
// 调用方回退，而不是假装编译成功。

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LspProtocolError, LspReader, encodeLspMessage } from './lsp-protocol.js'

/** 空闲多久回收编译进程（与上游 `compile_idle_timeout_secs` 同值 600 秒）。 */
export const SIDECAR_IDLE_TIMEOUT_MS = 600_000
/**
 * 常驻（pinned）进程的空闲回收时限。
 *
 * 常驻是一种**租约**而不是"永不退出"：插件进程被 DSH 换掉时没人会写文件解除它，
 * 那个 .NET 进程就会永远占着几百 MB。所以常驻只是把回收窗口从 10 分钟拉长到
 * {@link SIDECAR_PINNED_IDLE_TIMEOUT_MS}；调一次用一次就把租约续上。
 */
export const SIDECAR_PINNED_IDLE_TIMEOUT_MS = 8 * 60 * 60 * 1000
/** 同时保留的编译进程上限；超出时淘汰最久未用的。 */
export const SIDECAR_MAX_WORKSPACES = 8
/** 进程启动到 `initialize` 应答的时限。冷启动要加载 Roslyn，留足余量。 */
const START_TIMEOUT_MS = 120_000
/** 首次 `dotnet build` 的时限：要还原 NuGet 包、编译十几个源文件。 */
const BUILD_TIMEOUT_MS = 600_000
/** 单次编译请求的默认时限；超过就当失败，不无限占着进程。 */
const COMPILE_TIMEOUT_MS = 120_000
const REAPER_INTERVAL_MS = 60_000
/** 与 `tools/dsh-finish/Compiler/Program.cs` 的 `ProtocolVersion` 必须一致。 */
const PROTOCOL_VERSION = 1
/** 目标框架；同时是 `bin/<config>/<tfm>` 的目录名。 */
const TARGET_FRAMEWORK = 'net10.0'
const PROJECT_NAME = 'DshFinishCompileServer'
const ASSEMBLY_NAME = `${PROJECT_NAME}.dll`

/** 编译器服务不可用的原因，逐项对应调用方能采取的补救动作。 */
export const SIDECAR_CODES = Object.freeze(['no_dotnet', 'build_failed', 'start_failed', 'unsupported_platform'])

/** 编译器服务不可用。调用方据此回退到 Unity 编辑器路径。 */
export class SidecarUnavailable extends Error {
  constructor(message, { code } = {}) {
    super(message)
    this.name = 'SidecarUnavailable'
    // 缺省的 code 是 no_dotnet：绝大多数失败都是"这台机器上没有 .NET 10"。
    this.code = code ?? 'no_dotnet'
  }
}

/** 一个编译请求失败（进程在、但编不过或拒绝回答）。 */
export class SidecarError extends Error {
  constructor(message, { code = null, data = null } = {}) {
    super(message)
    this.name = 'SidecarError'
    this.code = code
    this.data = data
  }
}

/**
 * 常驻租约：`Library/Locus/compile-sidecar.json`。
 *
 * DSH 插件不能保证进程比用户的项目活得久，而"编译服务一直热着"恰好要求跨调用、
 * 最好跨会话复用同一个 .NET 进程。做法是把租约写在项目的 `Library/` 里：文件在，
 * 空闲窗口就是 {@link SIDECAR_PINNED_IDLE_TIMEOUT_MS}；谁来调用都先把里面的 `touched_at`
 * 和 `pid` 续上。宿主没了、文件过期、或 `pid` 已经不是我们的进程，租约就自动失效，
 * 不需要任何清理进程。
 */
export const RESIDENCY_FILE = 'compile-sidecar.json'
/** 租约多久没被续过就作废。比 pinned 窗口略宽，留一次调用的余量。 */
export const RESIDENCY_TTL_MS = SIDECAR_PINNED_IDLE_TIMEOUT_MS + 60 * 60 * 1000

/** projectRoot → { connection, lastUsed, starting, build, pinned } */
const pool = new Map()
let reaper = null
/** 与 `reaper` 配对创建的那个 `clearInterval`。 */
let reaperClearer = null
/** 注入的依赖（测试用）：`spawn`、`runBuild`、`resolveDotnetProgram` 等。 */
let dependencies = null

/**
 * 覆盖进程相关依赖。
 *
 * 测试里必须能注入假进程：一次真实 `dotnet build` 要几秒、要网络还原 NuGet
 * 包，那样的测试套件既慢又不稳定。生产代码不调用它——这是给测试留的唯一接缝，
 * 而不是一个"运行时配置项"。
 */
export function configureSidecar(overrides = {}) {
  dependencies = overrides === null ? null : { ...(dependencies ?? {}), ...overrides }
}

function deps() {
  return dependencies ?? {}
}

/** 测试接缝：只看池子的规模，用来断言"复用进程"而不是"每次新建"。 */
export function sidecarPoolSize() {
  return pool.size
}

/** 编译服务工程目录（`tools/dsh-finish/Compiler`）。 */
export function compilerProjectDir() {
  return deps().projectDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'dsh-finish', 'Compiler')
}

/** 编译服务工程文件。 */
export function compilerProjectPath() {
  return join(compilerProjectDir(), `${PROJECT_NAME}.csproj`)
}

/**
 * 构建产物路径：`bin/<configuration>/<tfm>/DshFinishCompileServer.dll`。
 *
 * 同时接受 `Debug` 和 `Release`——用户可能用任意一种配置构建过，而一个已经建好
 * 的产物不该因为配置名不同就当作不存在再构建一遍。
 */
export function compilerAssemblyPath({ configuration = null } = {}) {
  const root = join(compilerProjectDir(), 'bin')
  const configs = configuration ? [configuration] : ['Release', 'Debug']
  const found = []
  for (const config of configs) {
    const candidate = join(root, config, TARGET_FRAMEWORK, ASSEMBLY_NAME)
    if (existsSync(candidate)) found.push(candidate)
  }
  if (found.length === 0) return join(root, configs[0], TARGET_FRAMEWORK, ASSEMBLY_NAME)
  // 两种配置都在时用更新的一份，避免改完源码却跑着旧的 Release 产物。
  found.sort((left, right) => mtimeMs(right) - mtimeMs(left))
  return found[0]
}

function mtimeMs(path) {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 在当前环境里找 .NET 可执行文件。
 *
 * 只用 PATH 和 `DOTNET_ROOT`，**不**碰 `assets.js` 的 `resolveDotnet`：那条路
 * 会下载一个 .NET 运行时。这里的契约是"没有就报 no_dotnet"。
 */
export function resolveDotnetProgram({ env = process.env, exists = existsSync } = {}) {
  const injected = deps().dotnetProgram
  if (injected) return injected

  const isWindows = process.platform === 'win32'
  const fileName = isWindows ? 'dotnet.exe' : 'dotnet'
  const candidates = []
  const dotnetRoot = env.DOTNET_ROOT
  if (dotnetRoot) candidates.push(join(dotnetRoot, fileName))
  const pathVar = env.PATH ?? env.Path ?? ''
  for (const segment of pathVar.split(isWindows ? ';' : ':')) {
    if (segment) candidates.push(join(segment, fileName))
  }
  // 逐个检查而不是直接返回 'dotnet'：返回值要能进错误信息，而一个虚设的路径
  // 会让用户以为问题出在权限上。
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return null
}

/**
 * 查询 .NET SDK 的版本号（`dotnet --version`），不可用时返回 null。
 *
 * 只关心"能不能用"，所以版本号解析失败也算不可用：一个装坏了的 dotnet 会对
 * 每个调用报同样的错，早点失败比让每个编译请求去踩更省事。
 */
export async function dotnetVersion({ env = process.env } = {}) {
  const probe = deps().probeDotnet
  if (probe) return await probe({ env })

  const program = resolveDotnetProgram({ env })
  if (!program) return null

  const run = deps().runProcess ?? runProcess
  let result
  try {
    result = await run(program, ['--version'], { env: childEnv(null), timeoutMs: 30_000 })
  } catch {
    return null
  }
  if (result.code !== 0) return null
  const version = String(result.stdout ?? '').trim()
  return /^\d+\.\d+\.\d+/.test(version) ? version : null
}

/**
 * 编译服务的状态，永远不会抛异常。
 *
 * 调用方（工具层）用它决定"要不要走 sidecar"，所以它必须能在任何环境下返回
 * 一个答案——包括没有 .NET、构建失败、进程在忙的时候。
 */
export async function sidecarStatus(projectRoot = null, { env = process.env } = {}) {
  const version = await dotnetVersion({ env })
  const built = existsSync(compilerAssemblyPath())
  const key = projectRoot ? normalizeRoot(projectRoot) : null
  const entry = key ? pool.get(key) : null

  const status = {
    available: version !== null && built && platformSupported(),
    built,
    running: Boolean(entry?.connection?.connected),
    projectRoot: key,
  }
  if (version !== null) status.dotnetVersion = version
  if (entry?.connection?.pid) status.pid = entry.connection.pid

  if (!status.available) {
    if (!platformSupported()) {
      status.reason = 'unsupported_platform'
      status.message = `the compile sidecar does not run on ${process.platform}.`
    } else if (version === null) {
      status.reason = 'no_dotnet'
      status.message = 'a .NET 10 SDK/runtime is required for the compile sidecar; none was found on PATH.'
    } else {
      status.reason = 'not_built'
      status.message = 'the compile sidecar has not been built yet; run `npm run build:compiler`.'
    }
  }
  return status
}

function platformSupported() {
  const injected = deps().platformSupported
  if (typeof injected === 'boolean') return injected
  return process.platform === 'win32' || process.platform === 'linux' || process.platform === 'darwin'
}

/**
 * 确保编译服务可用：必要时构建、必要时启动，然后返回连接。
 *
 * 抛出的 `SidecarUnavailable` 覆盖全部"这台机器干不了"的情况，调用方一律回退到
 * Unity 编辑器路径；真正的编译失败不会走到这里，而是出现在 `compileSnippet` 的
 * 返回值里。
 */
export async function ensureSidecar(projectRoot = null, { env = process.env, build = true } = {}) {
  if (!platformSupported()) {
    throw new SidecarUnavailable(`the compile sidecar does not run on ${process.platform}.`, { code: 'unsupported_platform' })
  }

  const version = await dotnetVersion({ env })
  if (version === null) {
    throw new SidecarUnavailable(
      'no .NET 10 found on PATH: the compile sidecar needs a local .NET 10 SDK (or a prebuilt server). ' +
        'Install the SDK, or keep using the Unity-hosted compile path.',
      { code: 'no_dotnet' },
    )
  }

  // 判空而不是判 falsy：`''` 是合法的 key（没有工作区的调用），而 `if (key)`
  // 会把 `pool.get('')` 整个跳过，于是无工作区调用每次新建一个进程、且永不回收。
  const key = projectRoot ? normalizeRoot(projectRoot) : ''
  const existing = pool.has(key) ? pool.get(key) : null
  if (existing?.connection && !existing.connection.connected) {
    // 进程已经退出（崩溃、被外部杀掉）：淘汰这个死条目，下面重建。
    pool.delete(key)
  } else if (existing?.starting) {
    // 并发调用：等同一个启动结果，不重复起进程。
    const service = await existing.starting
    return { service, dotnetVersion: version, pid: service.pid }
  } else if (existing?.connection) {
    existing.lastUsed = Date.now()
    return { service: existing.connection, dotnetVersion: version, pid: existing.connection.pid }
  }

  // 条目在启动**之前**就落池：这是并发去重唯一的抓手（同一个 key 的第二个调用要
  // 能看到 `starting`，而不是在 `await` 之后各自起一个进程）。代价是
  // `shutdownSidecar()` 可能在启动中途把条目摘走，所以建成后要确认条目还在池里——
  // 不在就说明有人在这期间要求关闭了它。
  //
  // 淘汰排在落池之后：`evictIfNeeded()` 有 `await`，放在前面的话两个并发调用都会
  // 先腾位置、再各自 `pool.set()`，去重就失效了。落池之后新条目自己也在候选里，所以
  // 淘汰条件必须是"多于 N 个"（`>`）而不是"满 N 个"（`>=`）。
  const entry = { connection: null, lastUsed: Date.now(), starting: null, pinned: false }
  pool.set(key, entry)
  // 分开两步赋值：`evictIfNeeded()` 会 `await`，那段窗口里并发的第二个调用必须看到
  // `starting` 已经就位，否则它会以为"没人起这个进程"而再起一个。
  const starting = startSidecar({ key, env, build })
  entry.starting = starting
  await evictIfNeeded()
  let service
  try {
    service = await starting
  } catch (error) {
    if (pool.get(key) === entry) pool.delete(key)
    throw error
  } finally {
    entry.starting = null
  }

  if (pool.get(key) !== entry) {
    // 启动期间被 `shutdownSidecar()` 摘掉了：我们的连接不在池子里，就地关掉。
    await Promise.resolve(service.close?.()).catch(() => {})
    throw new SidecarUnavailable('the compile sidecar was shut down while it was starting.', { code: 'start_failed' })
  }
  entry.connection = service
  entry.lastUsed = Date.now()
  return { service, dotnetVersion: version, pid: service.pid }
}

async function startSidecar({ key, env, build }) {
  const assembly = await ensureBuilt({ env, build })
  const program = resolveDotnetProgram({ env })
  if (!program) {
    throw new SidecarUnavailable('no .NET found on PATH: the compile sidecar cannot be started.', { code: 'no_dotnet' })
  }

  const connection = new SidecarConnection({ program, assembly, workspaceRoot: key || null, env })
  try {
    await connection.start()
  } catch (error) {
    await Promise.resolve(connection.close()).catch(() => {})
    if (error instanceof SidecarUnavailable) throw error
    throw new SidecarUnavailable(`the compile sidecar failed to start: ${error.message}`, { code: 'start_failed' })
  }
  if (pool.size > 0) startReaper()
  return connection
}

/** 构建产物存在就复用，否则跑一次 `dotnet build`。 */
async function ensureBuilt({ env, build }) {
  const injected = deps().ensureBuilt
  if (injected) return await injected({ env })

  const existing = compilerAssemblyPath()
  if (existsSync(existing) && !build) return existing
  if (existsSync(existing)) return existing

  if (!build) {
    throw new SidecarUnavailable('the compile sidecar has not been built and building is disabled.', { code: 'build_failed' })
  }

  const program = resolveDotnetProgram({ env })
  if (!program) {
    throw new SidecarUnavailable('no .NET found on PATH: the compile sidecar cannot be built.', { code: 'no_dotnet' })
  }

  const projectPath = compilerProjectPath()
  if (!existsSync(projectPath)) {
    throw new SidecarUnavailable(`compiler project not found at ${projectPath}.`, { code: 'build_failed' })
  }

  const run = deps().runProcess ?? runProcess
  let result
  try {
    result = await run(program, ['build', projectPath, '-c', 'Release', '--nologo', '--verbosity', 'quiet'], {
      env: childEnv(dirname(projectPath)),
      timeoutMs: BUILD_TIMEOUT_MS,
      cwd: compilerProjectDir(),
    })
  } catch (error) {
    throw new SidecarUnavailable(`building the compile sidecar failed: ${error.message}`, { code: 'build_failed' })
  }
  if (result.code !== 0) {
    throw new SidecarUnavailable(`building the compile sidecar failed: ${tail(result)}`, { code: 'build_failed' })
  }
  const assembly = compilerAssemblyPath()
  if (!existsSync(assembly)) {
    throw new SidecarUnavailable(`building the compile sidecar produced no ${ASSEMBLY_NAME}.`, { code: 'build_failed' })
  }
  return assembly
}

function tail(result) {
  const text = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.trim()
  return text.length > 800 ? `${text.slice(-800)}` : text || 'no output'
}

/**
 * 子进程环境。
 *
 * `DOTNET_CLI_HOME` 必须可写：`dotnet` 启动时会往 `$HOME/.dotnet` 写一个首运行
 * 哨兵文件，只读的 home（沙箱、CI 容器、Nix 装机）会让它直接崩在
 * "Read-only file system" 上而不是编译。项目目录旁边一定可写，就放进它的 `.tmp/`。
 */
function childEnv(stateDir) {
  const env = {
    ...(deps().env ?? process.env),
    DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_NOLOGO: '1',
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
  }
  if (stateDir) {
    const home = join(stateDir, '.tmp', `dotnet-home-${process.pid}`)
    mkdirSync(home, { recursive: true })
    env.DOTNET_CLI_HOME = env.DOTNET_CLI_HOME ?? home
    env.XDG_RUNTIME_DIR = env.XDG_RUNTIME_DIR ?? home
  }
  return env
}

/** 跑一个子进程并收集输出；超时则杀掉并抛错。 */
function runProcess(program, args, { env = process.env, timeoutMs = 60_000, cwd = null } = {}) {
  const spawnFn = deps().spawn ?? spawn
  return new Promise((resolvePromise, reject) => {
    let child
    try {
      child = spawnFn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env, cwd: cwd ?? undefined })
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {
        // 已经退出
      }
      reject(new SidecarError(`${program} timed out after ${Math.round(timeoutMs / 1000)}s`, { code: 'timeout' }))
    }, timeoutMs)
    timer.unref?.()
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({ code: code ?? (signal ? 1 : 0), signal, stdout, stderr })
    })
  })
}

/**
 * 空闲回收：定期关掉太久没用过的进程。
 *
 * 定时器句柄连同创建它的 `setInterval` 一起记下来：注入的 fake 定时器（测试里换掉
 * 了 `setInterval`）必须用同一个 `clearInterval` 清掉，否则 `shutdownSidecar()` 之后
 * 旧定时器还挂着，下一个测试的 `pool` 会被上一轮的时钟判成"空闲"而误杀。
 */
function startReaper() {
  if (reaper) return
  const interval = deps().setInterval ?? setInterval
  reaperClearer = deps().clearInterval ?? clearInterval
  reaper = interval(() => {
    const now = Date.now()
    for (const [key, entry] of pool) {
      if (entry.starting) continue
      const window = entry.pinned ? SIDECAR_PINNED_IDLE_TIMEOUT_MS : SIDECAR_IDLE_TIMEOUT_MS
      if (now - entry.lastUsed < window) continue
      pool.delete(key)
      Promise.resolve(entry.connection?.close?.()).catch(() => {})
    }
    if (pool.size === 0) stopReaper()
  }, REAPER_INTERVAL_MS)
  reaper.unref?.()
}

function stopReaper() {
  if (!reaper) return
  const clear = reaperClearer ?? deps().clearInterval ?? clearInterval
  clear(reaper)
  reaper = null
  reaperClearer = null
}

/**
 * 超额时淘汰最久未用的工作区进程。
 *
 * 容量是"池里最多同时 N 个"。调用方在 `pool.set()` **之后**调用它，所以判断的是
 * "现在是否多于 N 个"（`>`）：第 N 个工作区落池时池里正好 N 个，一个都不淘汰；
 * 第 N+1 个落池时才关掉最久没用的那个。早先写成 `>=` 配合"落池前淘汰"，结果是第
 * 8 个工作区把第 1 个关掉了（off-by-one）。`starting` 的条目可能被在途请求
 * await 着，不能动。
 */
async function evictIfNeeded() {
  while (pool.size > SIDECAR_MAX_WORKSPACES) {
    let oldestKey = null
    let oldest = Infinity
    for (const [key, entry] of pool) {
      if (entry.starting) continue
      if (entry.lastUsed < oldest) {
        oldest = entry.lastUsed
        oldestKey = key
      }
    }
    if (oldestKey === null) return
    const victim = pool.get(oldestKey)
    pool.delete(oldestKey)
    await Promise.resolve(victim?.connection?.close?.()).catch(() => {})
  }
}

/**
 * 编译一段代码。
 *
 * 返回 `{ok, diagnostics, assemblyB64?, error?}`；`ok: false` 且带 diagnostics 是
 * 正常结果（代码写错了），不抛异常。只有"服务用不了"才抛 `SidecarUnavailable`。
 */
export async function compileSnippet(projectRoot, { code, usings, timeoutMs = COMPILE_TIMEOUT_MS, mode = null, references = null, loopGuard = false } = {}) {
  if (typeof code !== 'string' || code.length === 0) {
    throw new SidecarError('compileSnippet needs a non-empty code string.', { code: 'invalid_params' })
  }

  const { service } = await ensureSidecar(projectRoot ?? null)
  const params = { code }
  if (Array.isArray(usings) && usings.length > 0) params.code = `${usings.map((entry) => `using ${entry};`).join('\n')}\n${code}`
  if (mode) params.mode = mode
  if (projectRoot) params.project_root = normalizeRoot(projectRoot)
  if (Array.isArray(references) && references.length > 0) params.references = references.map((path) => ({ path }))
  if (loopGuard) params.loop_guard = true

  let result
  try {
    result = await service.request('compile/snippet', params, { timeoutMs })
  } catch (error) {
    if (error instanceof SidecarError) throw error
    throw new SidecarUnavailable(`the compile sidecar stopped answering: ${error.message}`, { code: 'start_failed' })
  }

  const key = projectRoot ? normalizeRoot(projectRoot) : ''
  if (pool.has(key)) pool.get(key).lastUsed = Date.now()
  return normalizeCompileResult(result)
}

/** 把一个编译结果整理成稳定的 JS 形状（JSON 的 snake_case → camelCase）。 */
function normalizeCompileResult(result) {
  const diagnostics = Array.isArray(result?.diagnostics) ? result.diagnostics.map(normalizeDiagnostic) : []
  const normalized = { ok: Boolean(result?.ok), diagnostics }
  if (typeof result?.error === 'string') normalized.error = result.error
  if (typeof result?.assembly_b64 === 'string') normalized.assemblyB64 = result.assembly_b64
  if (typeof result?.mode === 'string') normalized.mode = result.mode
  if (typeof result?.reference_origin === 'string') normalized.referenceOrigin = result.reference_origin
  if (typeof result?.duration_ms === 'number') normalized.durationMs = result.duration_ms
  return normalized
}

function normalizeDiagnostic(diagnostic) {
  return {
    severity: String(diagnostic?.severity ?? 'error'),
    id: String(diagnostic?.id ?? ''),
    message: String(diagnostic?.message ?? ''),
    line: Number(diagnostic?.line ?? 0),
    column: Number(diagnostic?.column ?? 0),
  }
}

/** 编译一段 run_states 状态机定义；参数与 Unity 侧同名。 */
export async function compileRunStates(projectRoot, request, { timeoutMs = COMPILE_TIMEOUT_MS } = {}) {
  if (!request || typeof request !== 'object') {
    throw new SidecarError('compileRunStates needs a request object.', { code: 'invalid_params' })
  }
  const { service } = await ensureSidecar(projectRoot ?? null)
  const params = { ...request }
  if (projectRoot) params.project_root = normalizeRoot(projectRoot)
  try {
    const result = await service.request('compile/runStates', params, { timeoutMs })
    return normalizeCompileResult(result)
  } catch (error) {
    if (error instanceof SidecarError) throw error
    throw new SidecarUnavailable(`the compile sidecar stopped answering: ${error.message}`, { code: 'start_failed' })
  }
}

/** 关闭一个或全部编译进程；返回关掉的 key。 */
/**
 * 把某个工作区的编译进程标成常驻，并把租约写进 `Library/Locus/compile-sidecar.json`。
 *
 * 常驻**不**意味着永不退出（见 {@link SIDECAR_PINNED_IDLE_TIMEOUT_MS}）：它只是把空闲窗口
 * 从 10 分钟拉到 8 小时，每次经由 `ensureSidecar()` 的调用都会把这个窗口续上。
 * 进程已经在跑就直接转常驻，没跑就起一个。
 */
export async function pinSidecar(projectRoot, { env = process.env } = {}) {
  if (!projectRoot) throw new SidecarError('pinSidecar needs a project root.', { code: 'invalid_params' })
  const key = normalizeRoot(projectRoot)
  const { service, dotnetVersion: version, pid } = await ensureSidecar(projectRoot, { env })
  const entry = pool.get(key)
  if (entry) entry.pinned = true
  const lease = {
    version: 1,
    pid: pid ?? null,
    dotnet_version: version ?? null,
    assembly: compilerAssemblyPath(),
    touched_at: new Date().toISOString(),
    ttl_ms: RESIDENCY_TTL_MS,
  }
  const file = join(projectRoot, 'Library', 'Locus', RESIDENCY_FILE)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(lease, null, 2)}\n`)
  } catch {
    // 写不了租约不是失败：进程已经在跑，只是这个会话结束后它会按普通空闲回收。
  }
  return { pinned: true, pid: service?.pid ?? null, file, lease }
}

/** 取消常驻：删掉租约并把空闲窗口退回 10 分钟（进程本身继续服务）。 */
export async function unpinSidecar(projectRoot) {
  const key = normalizeRoot(projectRoot)
  const entry = pool.get(key)
  if (entry) entry.pinned = false
  const file = join(projectRoot, 'Library', 'Locus', RESIDENCY_FILE)
  let removed = false
  try {
    rmSync(file, { force: true })
    removed = true
  } catch {
    // ignore
  }
  return { pinned: false, removed, file }
}

/**
 * 租约现在是否有效：文件在、没过期、且里面的 pid 还活着。
 *
 * `pid` 已经不在了就是"上次会话留下的文件"——那种情况必须报无效，否则我们会
 * 一直以为有进程在给这个项目加速。
 */
export function readResidency(projectRoot, { now = Date.now(), alive = isProcessAlive } = {}) {
  const file = join(projectRoot ?? '', 'Library', 'Locus', RESIDENCY_FILE)
  let lease
  try {
    lease = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { pinned: false, file, lease: null, reason: 'no lease' }
  }
  const touched = Date.parse(String(lease?.touched_at ?? ''))
  if (!Number.isFinite(touched)) return { pinned: false, file, lease, reason: 'lease has no timestamp' }
  const ttl = Number.isFinite(Number(lease?.ttl_ms)) ? Number(lease.ttl_ms) : RESIDENCY_TTL_MS
  if (now - touched > ttl) return { pinned: false, file, lease, reason: 'lease expired' }
  const pid = Number(lease?.pid)
  if (Number.isSafeInteger(pid) && pid > 0 && !alive(pid)) {
    return { pinned: false, file, lease, reason: `pid ${pid} is gone` }
  }
  const key = normalizeRoot(projectRoot)
  const keyed = pool.get(key)
  return { pinned: true, file, lease, reason: null, attached: Boolean(keyed?.connection?.connected) }
}

/** 进程是否还在（`kill(pid, 0)`），用于租约的存活判断。 */
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/**
 * 直接问常驻的编译服务要这个项目的编译参数（引用集、define、语言版本）。
 *
 * 上游的 `get_compile_params` 走 Unity 桥；这里走我们自己的 sidecar，
 * 所以编辑器不在线时也能拿到一套可用的参数——这是热补丁能脱离 Unity 分析的前提。
 */
export async function compileParams(projectRoot, { env = process.env } = {}) {
  if (!projectRoot) throw new SidecarError('compileParams needs a project root.', { code: 'invalid_params' })
  const { service } = await ensureSidecar(projectRoot, { env })
  let result
  try {
    result = await service.request('compile/params', { project_root: normalizeRoot(projectRoot) }, { timeoutMs: COMPILE_TIMEOUT_MS })
  } catch (error) {
    if (error instanceof SidecarError) throw error
    throw new SidecarUnavailable(`the compile sidecar stopped answering: ${error.message}`, { code: 'start_failed' })
  }
  const key = normalizeRoot(projectRoot)
  if (pool.has(key)) pool.get(key).lastUsed = Date.now()
  return {
    referencePaths: Array.isArray(result?.reference_paths) ? result.reference_paths.map(String) : [],
    defines: Array.isArray(result?.defines) ? result.defines.map(String) : [],
    langVersion: typeof result?.lang_version === 'string' ? result.lang_version : null,
    allowUnsafe: Boolean(result?.allow_unsafe),
    origin: typeof result?.origin === 'string' ? result.origin : null,
  }
}

/**
 * 分析一批编辑能不能热打补丁（只分析，不编译）。
 *
 * `files` 是 `[{path, oldText, newText}]`；返回值告诉我们哪些文件是"方法体级别
 * 的编辑"、哪些方法可以替换。这是纯函数式的——同一个输入永远得到同一个答案，
 * 所以调用方可以先分析再决定要不要真的打。
 */
export async function hotDiff(projectRoot, files, { env = process.env } = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new SidecarError('hotDiff needs at least one edited file.', { code: 'invalid_params' })
  }
  const { service } = await ensureSidecar(projectRoot, { env })
  const params = { project_root: normalizeRoot(projectRoot ?? ''), files }
  let result
  try {
    result = await service.request('analyze/hotDiff', params, { timeoutMs: COMPILE_TIMEOUT_MS })
  } catch (error) {
    if (error instanceof SidecarError) throw error
    throw new SidecarUnavailable(`the compile sidecar stopped answering: ${error.message}`, { code: 'start_failed' })
  }
  const key = normalizeRoot(projectRoot ?? '')
  if (pool.has(key)) pool.get(key).lastUsed = Date.now()
  return {
    hot: Boolean(result?.hot),
    files: Array.isArray(result?.files)
      ? result.files.map((file) => ({
          path: String(file?.path ?? ''),
          hot: Boolean(file?.hot),
          reason: typeof file?.reason === 'string' ? file.reason : null,
          methods: Array.isArray(file?.methods) ? file.methods.map(normalizePatchMethod) : [],
          addedTypes: Array.isArray(file?.added_types) ? file.added_types.map(String) : [],
          addedFields: Array.isArray(file?.added_fields) ? file.added_fields.map(String) : [],
        }))
      : [],
  }
}

/** 编译补丁程序集（`compile/hotPatch`），返回程序集字节与需要登记的补丁方法。 */
export async function hotPatch(projectRoot, edits, { env = process.env } = {}) {
  if (!Array.isArray(edits) || edits.length === 0) {
    throw new SidecarError('hotPatch needs at least one edit.', { code: 'invalid_params' })
  }
  const { service } = await ensureSidecar(projectRoot, { env })
  let result
  try {
    result = await service.request(
      'compile/hotPatch',
      { project_root: normalizeRoot(projectRoot ?? ''), files: edits },
      { timeoutMs: COMPILE_TIMEOUT_MS },
    )
  } catch (error) {
    if (error instanceof SidecarError) throw error
    throw new SidecarUnavailable(`the compile sidecar stopped answering: ${error.message}`, { code: 'start_failed' })
  }
  const key = normalizeRoot(projectRoot ?? '')
  if (pool.has(key)) pool.get(key).lastUsed = Date.now()
  return {
    ok: Boolean(result?.ok),
    error: typeof result?.error === 'string' ? result.error : null,
    assemblyB64: typeof result?.assembly_b64 === 'string' ? result.assembly_b64 : null,
    assemblyName: typeof result?.assembly_name === 'string' ? result.assembly_name : null,
    methods: Array.isArray(result?.methods) ? result.methods.map(normalizePatchMethod) : [],
    diagnostics: Array.isArray(result?.diagnostics) ? result.diagnostics.map(normalizeDiagnostic) : [],
    addedTypes: Array.isArray(result?.added_types) ? result.added_types.map(String) : [],
  }
}

/** 一个补丁方法：原方法签名 + 承载它的补丁类型。 */
function normalizePatchMethod(method) {
  return {
    declaringType: String(method?.declaring_type ?? method?.DeclaringType ?? ''),
    patchDeclaringType: String(method?.patch_declaring_type ?? method?.PatchDeclaringType ?? ''),
    name: String(method?.name ?? method?.Name ?? ''),
    paramTypeNames: Array.isArray(method?.param_type_names) ? method.param_type_names.map(String) : [],
    isStatic: Boolean(method?.is_static ?? method?.IsStatic),
    isCtor: Boolean(method?.is_ctor ?? method?.IsCtor),
    originalAssembly: typeof method?.original_assembly === 'string' ? method.original_assembly : null,
  }
}

export async function shutdownSidecar(projectRoot = null) {
  const targets = projectRoot ? [normalizeRoot(projectRoot)] : [...pool.keys()]
  const closed = []
  for (const key of targets) {
    const entry = pool.get(key)
    if (!entry) continue
    pool.delete(key)
    await Promise.resolve(entry.connection?.close?.()).catch(() => {})
    closed.push(key)
  }
  if (pool.size === 0) stopReaper()
  return closed
}

function normalizeRoot(root) {
  return String(root ?? '')
    .replaceAll('\\', '/')
    .replace(/\/+$/, '')
}

/**
 * 一条到编译服务的连接：Content-Length 分帧的 JSON-RPC，和语言服务器共用
 * `lsp-protocol.js` 的编解码器。
 */
export class SidecarConnection {
  #child = null
  #nextId = 0
  #pending = new Map()
  #closed = false
  #stderrTail = []
  #pid = null

  constructor({ program, assembly, workspaceRoot = null, env = null }) {
    this.program = program
    this.assembly = assembly
    this.workspaceRoot = workspaceRoot
    this.env = env
    this.reader = new LspReader()
  }

  get connected() {
    return this.#child !== null && !this.#closed
  }

  get pid() {
    return this.#pid
  }

  get stderrTail() {
    return [...this.#stderrTail]
  }

  /** 启动进程并完成 `initialize` 握手。 */
  async start() {
    // `#closed` 一旦置位永不复位，所以连过的对象只能起来一次；复用前先换一个新的。
    if (this.#child !== null || this.#closed) {
      throw new SidecarError('this compile sidecar connection was already used; create a new one.', { code: 'already_started' })
    }
    const spawnFn = deps().spawn ?? spawn
    const child = spawnFn(this.program, [this.assembly], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: this.env ?? childEnv(null),
    })
    this.#child = child
    this.#pid = child.pid ?? null

    child.on('error', (error) => this.#fail(new SidecarError(`compile sidecar failed to start: ${error.message}`, { code: 'spawn_failed' })))
    child.on('exit', (code, signal) => {
      this.#fail(
        new SidecarError(
          `compile sidecar exited (${signal ? `signal ${signal}` : `code ${code}`})` +
            (this.#stderrTail.length ? `: ${this.#stderrTail.slice(-3).join('').trim().slice(0, 400)}` : ''),
          { code: 'exited' },
        ),
      )
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) this.#stderrTail.push(`${line}\n`)
      }
      while (this.#stderrTail.length > 100) this.#stderrTail.shift()
    })
    child.stdout?.on('data', (chunk) => this.#onData(chunk))
    child.stdin?.on('error', () => {
      // EPIPE 由 exit 处理器统一报告。
    })

  const info = await this.request('initialize', { protocolVersion: PROTOCOL_VERSION }, { timeoutMs: START_TIMEOUT_MS })
    const version = Number(info?.protocolVersion ?? 0)
    if (version !== PROTOCOL_VERSION) {
      await this.close()
      throw new SidecarUnavailable(
        `the compile sidecar speaks protocol ${version || 'unknown'}, expected ${PROTOCOL_VERSION}; rebuild it with \`npm run build:compiler\`.`,
        { code: 'build_failed' },
      )
    }
    return info
  }

  /** 发一个请求并等结果；`timeoutMs` 到点就拒绝。 */
  request(method, params = {}, { timeoutMs = COMPILE_TIMEOUT_MS } = {}) {
    if (!this.connected) {
      return Promise.reject(new SidecarError('the compile sidecar is not running.', { code: 'not_started' }))
    }
    const id = (this.#nextId += 1)
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new SidecarError(`the compile sidecar did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`, { code: 'timeout' }))
      }, timeoutMs)
      timer.unref?.()
      this.#pending.set(id, { resolve: resolvePromise, reject, timer, method })
      try {
        this.#child.stdin.write(encodeLspMessage({ jsonrpc: '2.0', id, method, params }))
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(new SidecarError(`failed to write to the compile sidecar: ${error.message}`, { code: 'write_failed' }))
      }
    })
  }

  #onData(chunk) {
    let messages
    try {
      messages = this.reader.push(chunk)
    } catch (error) {
      // 分帧坏了就无法重新同步，只能让所有等待者失败。
      if (error instanceof LspProtocolError) {
        this.#fail(new SidecarError(`corrupt frame from the compile sidecar: ${error.message}`, { code: 'protocol' }))
        return
      }
      throw error
    }
    for (const message of messages) this.#onMessage(message)
  }

  #onMessage(message) {
    const id = message?.id
    if (id === undefined || id === null) return
    const pending = this.#pending.get(Number(id))
    if (!pending) return
    this.#pending.delete(Number(id))
    clearTimeout(pending.timer)

    if (message.error) {
      pending.reject(
        new SidecarError(String(message.error.message ?? `${pending.method} failed`), {
          code: Number(message.error.code ?? 0),
          data: message.error.data ?? null,
        }),
      )
      return
    }
    pending.resolve(message.result ?? null)
  }

  #fail(error) {
    if (this.#closed) return
    this.#closed = true
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer)
      this.#pending.delete(id)
      pending.reject(error)
    }
  }

  /** 关掉进程：先发 `shutdown` 让它自己退，再等一会儿，最后强杀。 */
  async close() {
    if (!this.#child) return
    const child = this.#child
    if (this.connected) {
      try {
        await this.request('shutdown', {}, { timeoutMs: 3_000 })
      } catch {
        // 进程可能已经死了；下面照样收尾。
      }
    }
    this.#fail(new SidecarError('the compile sidecar was closed.', { code: 'closed' }))
    try {
      child.stdin?.end()
    } catch {
      // 已关闭
    }
    const exited = await waitForExit(child, 3_000)
    if (!exited) {
      try {
        child.kill()
      } catch {
        // 已退出
      }
    }
    this.#child = null
    this.#pid = null
  }
}

function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true)
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), timeoutMs)
    timer.unref?.()
    child.once('exit', () => {
      clearTimeout(timer)
      resolvePromise(true)
    })
  })
}

/** 列出构建产物目录，供 `sidecarStatus`/诊断使用。 */
export function listBuildSymbols() {
  const dir = dirname(compilerAssemblyPath())
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.dll') || name.endsWith('.pdb'))
  } catch {
    return []
  }
}

/** 读编译服务工程的包引用版本（诊断用：告诉用户需要哪个 Roslyn）。 */
export function compilerRoslynVersion() {
  try {
    const text = readFileSync(compilerProjectPath(), 'utf8')
    const match = /Microsoft\.CodeAnalysis\.CSharp[^"]*" Version="([^"]+)"/.exec(text)
    return match === null ? null : match[1]
  } catch {
    return null
  }
}
