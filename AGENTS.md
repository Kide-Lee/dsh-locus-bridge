# AGENTS.md

本文件是给在本仓库中工作的 AI agent 的说明。

## 修改本插件

- `npm test` 跑 JS 测试套件。`npm run typecheck` 检查模块接线；
  `node scripts/dump-tools.mjs` 校验每个工具 schema。
- `src/model-viewer/` 是浏览器 three.js 模型查看器的源码，构建成独立的
  `lib/model-viewer.js`（`npm run build:viewer`）；它由侧栏按需懒加载，不进主客户端包。
  `three`/`esbuild` 是 devDependencies，`lib/client.js` 与 `lib/model-viewer.js` 都是生成物。
- `src/tools.js` 存放 19 个 `unity_*` 工具定义（`code_*` 6 个在 `src/index.js` 里注册，
  合计 25 个；改工具数量时四处都要一起改：`src/tools.js`、`src/index.js`、
  `docs/marketplace/` 的 yml 与 README 条目描述，以及 `README.md`/`README.en.md` 的工具表）；
  `src/args.js` 负责工程解析，由 `test/args.test.js` 覆盖。
- 工具的 `parameters`/`output.schema` 走 `src/schema.js` 的受限 DSL：`type` 只接受单一标量、
  `array`、`object`（必须显式写 `additionalProperties`）或 `oneOf`，**不支持** `type: [...]` 联合数组、
  `minimum`/`maximum` 之类的断言关键字。`node scripts/dump-tools.mjs` 是唯一会立刻报出来的检查；
  `scripts/typecheck.mjs` 只查导入与绑定，不查这些。
- `packages/unity-bridge/` 是本仓库自己的协作 Unity 包（`com.locus.dsh-bridge`），补的是 payload
  不暴露的编辑器侧能力（热重载补丁的应用与 detour 账本、健康阶段上报、实时值源与 prefab 覆盖；
  热重载的**分类**在插件进程 `src/hotreload-classify.js`，不在这个包里）。
  安装时由 `src/setup.js` 一并复制到 `Packages/com.locus.dsh-bridge`。它通过 asmdef 显式引用
  `Locus.Editor` 接入 bridge（`autoReferenced: false` 不妨碍显式 `references`）；payload 缺接口时
  是编译失败，而不是运行时悄悄失效。
- **插件整体声明它对应的 payload 版本**，写在根 `package.json` 的 `locus` 块：`locus.version`
  是来源的上游 Locus release，`locus.payload`（`package` + `version`）是其中 `com.farlocus.locus`
  的包版本。`src/setup.js` 的 `payloadDeclaration()` / `payloadContract()` 用这份声明对照插件自带
  副本与工程已安装包，`unity_status` 的工程诊断会对不一致给出警告；`npm run check:payload`
  （`scripts/sync-payload.mjs --check`）把声明与 `payload/locus_unity` 的版本不一致当作硬失败。
  改动 payload 时同步这两处，硬引用与升级都以该声明为准。
- `tools/dsh-finish/Compiler/` 是可选 .NET 10 编译服务；`npm run build:compiler` 构建，
  `npm run build:compiler -- --check` 校验产物是否与源码同步。缺 .NET 时它的正确行为是报
  `no_dotnet` 并让调用方退回 Unity 路径，**绝不**在运行时下载 SDK。
- 原生的编辑器健康能力（`dsh_health` / `dsh_health_snapshot` / `dsh_main_thread_stack` /
  `dsh_set_background_hook`）由 broker 自己应答，不进 managed 队列——主线程卡死时 managed 侧
  正是答不了的那个。后台调度钩子只在 Windows 真正生效，别的平台必须报 `unsupported`。
- `src/setup.js` 负责工程诊断与包安装（Locus 包 + 协作包），由 `test/setup.test.js` 覆盖；把
  `DSH_LOCUS_PAYLOAD_DIR` 指向一个测试用的假 payload，就能避开真实 payload。
- `src/asset-index.js` / `src/asset-index-sync.js` 是 `Library/Locus/asset-index.db` 这层持久索引
  （`node:sqlite`，WAL）。纯读路径必须用只读连接打开——第二个进程碰 WAL 会让 Unity 崩溃；`node:sqlite`
  在 ESM 里要靠 `installBuiltinLoader` 注入，不能直接用 `require`。
- 安装入口是命令行 `scripts/install-unity-package.mjs`，**不是工具参数**：
  `unity_status` 的工具定义保持与上游一致（只有 `project_path`/`pipe`），
  只有诊断出「缺插件」时才会在输出里给出这条命令。不要为了装包再加参数。
- `payload/locus_unity/` 是上游已编译 Unity 包的生成副本（15 MB）。**不要手工
  编辑它**：用 `npm run sync:payload` 重新生成，用 `npm run check:payload` 校验。
  它纳入 git、排除在 npm tarball 之外，并在 `NOTICE` 中记录归属。
- `native/locus_unix_native/` 是 Linux/macOS 版 broker 移植，派生自上游 Locus 的
  `locus-native-broker`，因此是 GPL-3.0-or-later。它的协议依赖
  `native/locus-native-protocol/` 是未经修改的上游副本。两者都能独立构建：
  `npm run build:native` / `npm run test:native`。改动任一个之前先看 `NOTICE`；
  所有修改都必须记录在那里。
- `unity-test/` 是本地一次性验证工程，已被 git 忽略、永不提交。构建或测试本仓库
  并不需要它。
