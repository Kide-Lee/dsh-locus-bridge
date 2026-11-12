# AGENTS.md

本文件是给在本仓库中工作的 AI agent 的说明。

## 如何选择 Unity 项目

**由你自己决定一次调用针对哪个 Unity 项目，不要问人类。**

本仓库发布的是插件和 Linux/macOS broker，本身不是一个 Unity 项目。实际的工作
会话通常会在代码旁边检出一份工程——本地开发用的固定工程是 `unity-test/`（它包
含 `Assets/` 和 `ProjectSettings/`，这才是目录被称为 Unity 工程的原因）——而
`unity_*` 工具会自己找到它：先在当前工作目录及其向下三层里搜，再到每个祖先目录
旁边找，直到最近的 `.git` 为止。

所以无论会话是从仓库根目录还是从某个子目录启动，不带 `project_path` 的
`unity_status` 通常都能自己解析出工程。

只有在候选工程不止一个、或者你要指向另一份检出时才传 `project_path`。如果某次
调用报告了多个候选，挑出与本次需求相关的那个传进去——这种歧义本身就是信息，
不是发问的理由。只有当需求内容和仓库都无法说明指的是哪个工程时，才去问人类。

## Unity 工具需要什么

- 一个正在运行的 Unity 编辑器，装有 Locus 包和原生 broker（Windows 上是
  `locus_unity_native.dll`，Linux 上是 `liblocus_unity_native.so`），并且存在
  `<工程>/Library/Locus/NativeBridge.enabled`（或者设置了
  `LOCUS_UNITY_NATIVE_BRIDGE=1`）。
- Linux 上 broker 走 Unix domain socket。在当前沙箱里它必须放在工作区内
  （`.locus/`），因为 `/tmp` 不会在命令之间共享；因此编辑器要跑在长驻的后台作业
  里，而不是一次性命令。
- 没有 GPU 时按 `Unity -batchmode -nographics -projectPath <工程>` 启动，并且
  需要 broker 一直可连时**不要**加 `-quit`。

## 修改本插件

- `npm test` 跑 JS 测试套件。`npm run typecheck` 检查模块接线；
  `node scripts/dump-tools.mjs` 校验每个工具 schema。
- `src/model-viewer/` 是浏览器 three.js 模型查看器的源码，构建成独立的
  `lib/model-viewer.js`（`npm run build:viewer`）；它由侧栏按需懒加载，不进主客户端包。
  `three`/`esbuild` 是 devDependencies，`lib/client.js` 与 `lib/model-viewer.js` 都是生成物。
- `src/tools.js` 存放七个工具定义；`src/args.js` 负责工程解析，由
  `test/args.test.js` 覆盖。
- `src/setup.js` 负责工程诊断与包安装，由 `test/setup.test.js` 覆盖；把
  `DSH_LOCUS_PAYLOAD_DIR` 指向一个测试用的假 payload，就能避开真实 payload。
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
