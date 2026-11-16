// 构建插件自带的 .NET 编译服务（`tools/dsh-finish/Compiler`）。
//
// 为什么需要这个脚本而不是让用户自己敲 `dotnet build`：产物路径是
// `src/csharp/sidecar.js` 的约定（它在第一次用到编译服务时按同样的路径找产物），
// 两边一旦写歪，错误会表现成"编译服务不可用"这种看不出原因的症状。所以路径只
// 在这里算一次，`--check` 让 CI 能验证产物是否与源码同步。
//
// 用法：node scripts/build-compiler.mjs [--check]
//   --check 只在 Release 产物缺失或比任何源文件旧时失败，不写任何文件。
//
// 缺 .NET SDK 时：非 `--check` 模式以退出码 1 失败并说明原因（编译服务是可选能力，
// 但"手动请求构建却没装 SDK"是用户要看见的错误）；`--check` 模式同样失败，因为
// 发布流程要求产物存在。

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROJECT_DIR = join(ROOT, 'tools', 'dsh-finish', 'Compiler')
const PROJECT_FILE = join(PROJECT_DIR, 'DshFinishCompileServer.csproj')
const ASSEMBLY_NAME = 'DshFinishCompileServer.dll'
const OUTPUT = join(PROJECT_DIR, 'bin', 'Release', 'net10.0', ASSEMBLY_NAME)

const checkOnly = process.argv.includes('--check')

/** 递归收集比 `newer` 新的 .cs/.csproj 文件，用来判断产物是否过期。 */
function staleSources() {
  const stale = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'bin' || entry.name === 'obj') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(cs|csproj)$/.test(entry.name)) continue
      if (statSync(full).mtimeMs > statSync(OUTPUT).mtimeMs) stale.push(full)
    }
  }
  walk(PROJECT_DIR)
  return stale
}

if (!existsSync(OUTPUT)) {
  if (checkOnly) {
    console.error(`compiler: ${OUTPUT} is missing; run node scripts/build-compiler.mjs`)
    process.exit(1)
  }
} else if (checkOnly) {
  const stale = staleSources()
  if (stale.length > 0) {
    console.error(`compiler: ${OUTPUT} is older than ${stale.length} source file(s), e.g. ${stale[0]}`)
    process.exit(1)
  }
  console.log(`compiler: ${OUTPUT} is up to date`)
  process.exit(0)
}

// 没有 HOME 的沙箱里 dotnet 会在 `~/.dotnet/*.sentinel` 上失败（只读家目录）；
// 给它一个项目内的 CLI home 与包目录，构建就与运行环境的写权限无关。
const buildEnv = {
  ...process.env,
  DOTNET_CLI_HOME: process.env.DOTNET_CLI_HOME ?? join(ROOT, '.tmp', 'dotnet-home'),
  NUGET_PACKAGES: process.env.NUGET_PACKAGES ?? join(ROOT, '.tmp', 'nuget'),
  DOTNET_CLI_TELEMETRY_OPTOUT: process.env.DOTNET_CLI_TELEMETRY_OPTOUT ?? '1',
  DOTNET_NOLOGO: process.env.DOTNET_NOLOGO ?? '1',
}

const result = spawnSync(
  'dotnet',
  ['build', PROJECT_FILE, '-c', 'Release', '--nologo', '-v', 'minimal'],
  { cwd: ROOT, stdio: 'inherit', env: buildEnv },
)

if (result.error) {
  console.error(
    `compiler: could not run "dotnet build" (${result.error.code ?? result.error.message}).\n` +
      'The compile sidecar is optional: without it the bridge compiles through the Unity Editor instead. ' +
      'Install the .NET 10 SDK to build it.',
  )
  process.exit(1)
}

if (result.status !== 0) {
  console.error(`compiler: dotnet build failed with exit code ${result.status}`)
  process.exit(result.status ?? 1)
}

if (!existsSync(OUTPUT)) {
  console.error(`compiler: dotnet build reported success but ${OUTPUT} does not exist`)
  process.exit(1)
}

console.log(`compiler: built ${OUTPUT}`)