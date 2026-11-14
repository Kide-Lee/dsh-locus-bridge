# 更新日志

本文件记录 dsh-locus-bridge 的版本变更。版本号遵循 SemVer，条目按用户可见的变化归纳。

## [1.0.0] - 2026-11-14

首个稳定版本。DSH 作为 Locus 客户端，通过 Locus 原生 broker 操作 Unity 编辑器：Windows 使用命名管道，
Linux / macOS 使用 Unix domain socket。

### 亮点

- **11 个 `unity_*` 工具**：状态与诊断、主线程 C# 执行、逐帧状态机、Play 模式、Console、编译与域重载、
  测试、资产编辑、引用图、截图、场景结构化编辑。
- **6 个 `code_*` C# 语义工具**：基于 Roslyn 语言服务器，支持跨文件/跨 asmdef 的符号、定义、引用、
  Hover 与诊断；Unity 关着也能用。
- **右侧栏 Unity 资产预览与编辑**：支持 prefab / asset / mat / anim / controller，包含属性树编辑、
  revision 守卫、undo、缩略图、轨道预览和 three.js 模型查看器。
- **设置页**：选择 DSH 工作区与 Unity 工程，独立开关 Unity 操纵、C# 分析、文件预览三个功能面，
  以及五个领域技能；改动立即生效，无需重启。
- **官方行为对齐**：新增 `unity_run_states` 逐帧状态机，并为 `unity_execute` / `unity_test action:"run"`
  接入与 Locus 一致的 `sync` / `async` / `notify` 后台执行语义。

### 新增

#### Unity 工具链

- `unity_status`：连接检查、编辑器状态、打开的场景、capabilities 与域重载状态；连不上时自动诊断，
  缺少 Locus 包时给出安装命令。
- `unity_execute`：在 Unity 主线程编译并执行 C# 方法体，支持 `print` / `printJson` / `ctx.Progress` /
  `ctx.WaitFrame(s)` / `ctx.WaitSeconds`；带 edit session、取消与主线程阻塞提示。
- `unity_run_states`：用 C# 状态机跨帧驱动 Unity（`start` / `update` / `end`），长观察没有 30 秒空闲
  看门狗；输出 ≤100k token 内联，100k–1M 落盘 `Library/Locus/RunStates`，更大报错。
- `unity_play_mode`：切换到 Play / Edit 模式并等待生效。
- `unity_console_log`：读取 Unity Console，按级别合并去重。
- `unity_recompile`：编译 + 域重载 + 跨断线等待收敛；`editor_status` 必填且须与实况一致；
  `sync: none/targeted/full` 控制资产导入范围。
- `unity_test`：发现并运行 Unity Test Framework 测试，返回通过/失败/跳过计数与失败堆栈；
  支持取消后的终态收尾。
- `unity_asset`：资产序列化读取；带 revision 守卫的原子编辑（`set` 与数组操作）；undo；磁盘 reload。
- `unity_asset_graph`：`references` / `dependencies` / `usages`，按 `.meta` 的 GUID 比对 Unity 序列化字段。
- `unity_capture`：截取 Game / Scene / 编辑器窗口，PNG 通过附件服务直接随结果返回 `ImageBlock`；
  提交前检查模型是否具备图片能力。
- `unity_scene`：场景对象按名称检索、按组件类型查找、属性树读取、原子 `set`、单事务 `batch` 与 `undo`。

#### 后台执行

- `unity_execute` 与 `unity_test`（仅 `action:"run"`）接受宿主注入的 `async` 参数：
  - `sync`（默认）等待结果；
  - `async` 立即返回 job id，不发送完成通知，用 `job_output` 读取；
  - `notify` 立即返回，并在完成时自动投递结果。
- job 由 DSH 的 jobs 服务管理，可用 `job_kill` 取消，生命周期限于当前 Session；未加载
  `dsh-tool-jobs` 时给出明确错误并保留 `sync` 可用。
- `unity_run_states` 保持同步，与官方行为一致。

#### C# 语义分析

- 新增 `code_symbol_search`、`code_goto_definition`、`code_find_references`、`code_hover`、
  `code_diagnostics`、`code_analysis` 六个工具。
- 首次使用时 `code_analysis action:"install"` 下载 Roslyn 服务器与 .NET 运行时（约 90 MB）；
  支持 `status` / `warm` / `restart` / `reset`。
- 支持生成/还原创 `.sln` / `.csproj`，运行 Roslyn 与 Unity 分析器，不触发 Unity 编译。
- 可用设置页关闭，或用部署级开关 `DSH_LOCUS_CSHARP=0` 整组关闭。

#### 右侧栏资产工作台

- 在 Web GUI 右栏打开 `.prefab` / `.asset` / `.mat` / `.anim` / `.controller`，读取属性树并编辑字段。
- 编辑是内存改动，显式 Save 才落盘，Revert 恢复本次打开后的改动；带 revision 守卫与 undo。
- prefab 支持可旋转的轨道预览，拖动时按 90 ms 下限连续渲染，松手补最后一帧；帧缓存写入
  `Library/Locus/asset-preview-cache/`，按源文件 mtime 失效。
- `.fbx` / `.glb` 由浏览器内 three.js 查看器直接解析，支持动画、线框、Clay、网格与统计；
  其他模型格式走 Unity `PreviewRenderUtility`。
- `.unity` 场景只读；越界路径、继承自 prefab 的字段等会被明确拒绝。

#### 设置与领域技能

- 设置页新增 **Unity 桥接** 分组：工作区选择、Unity 工程选择、Locus 插件状态胶囊与安装按钮。
- 三个功能面开关立即生效：Unity 操纵、C# 分析、文件预览。
- 内置五个 Unity 领域技能：`debugger`、`profiler`、`graphics-debugger`、`ui-toolkit`、`view`；
  按技能独立开关，技能随插件版本走，不往工作区写副本。
- 带 C# 的两个技能在首次 `unity_execute` 时自动编译激活，之后可直接 `using Locus.Skills;`。

#### 分发与安装

- 根 `package.json` 声明 `dsh.bundle`，`dsh plugin add github:Kide-Lee/dsh-locus-bridge` 安装后即启用。
- 仓库随附 Locus Unity 包与 Windows 原生 broker；Linux / macOS 使用本仓库移植的 broker。
- npm tarball 不包含 Unity payload；发布 ZIP 额外包含完整的 `payload/locus_unity/` 与 `scripts/install-unity-package.mjs`，可直接给 Unity 工程安装。
- 发布前由 `scripts/pack-release.mjs` 检查：vendored Locus 与上游最新 release 不一致时停止打包；最新 DSH 与 `engines.dsh` 不兼容时警告但继续。
- `unity_status` 能诊断工程缺少插件、插件不完整、编辑器已打开工程等情况，并给出对应安装/处理建议。
- 新增插件图标、中文/英文 README、GPL-3.0-or-later 许可与 `NOTICE` 归属说明。

### 修复

- 修复 Win32 命名管道改用事件式 `net` 连接后仍然连不上的问题。
- 修复注册前未编译 `parameters`、导致模型侧参数恒为空的问题。
- 修复域重载窗口内全盘工具失败，并按上游补齐重连与超时参数。
- 修复 `unity_recompile` 的 `editor_status` 必填性与枚举范围。
- 修复 `unity_scene` 写入标量时多套一层 JSON、以及 `batch` / `find` 片段的两处 C# 编译错误。
- 修复 `unity_asset_graph` 按名字搜索序列化字段的问题，改为按 `.meta` GUID 匹配。
- 修复多工程工作区右栏按资产路径定位工程的问题，并补齐面板中英文文案。
- 修复侧栏标签页被通用文件编辑器抢占的问题。

### 兼容性

- Node.js `>=22.12`。
- DSH `>=0.2.1-alpha.2 <0.3.0-0`。
- 面向 Unity 2022.3，随包提供对应 Locus payload。
- `unity_test` 需要项目安装 `com.unity.test-framework >= 1.4.0`。
- C# 语义分析是可选功能，首次安装约 90 MB；没有 .NET 10 运行时时会额外下载运行时。
- npm 包包含插件源码、客户端 bundle 与 Linux / macOS broker 源码；发布 ZIP 额外包含 Unity payload 与安装脚本，npm tarball 仍不包含 payload。

### 验证

- `node --test --test-concurrency=1 "test/*.test.js"`：411 个测试通过，0 失败。
- `dump-tools`：全部工具定义符合 DSH schema 子集。
- `typecheck`：88 个模块的 import / 调用点一致。
- `validate-dsh-tools`：通过真实 DSH `defineTool` 与注册后的 JSON Schema 校验。
- 客户端与 three.js 模型查看器 bundle 均为最新。

### 升级说明

- 这是首个稳定版本；若此前从源码或 `0.1.0` 安装，直接替换插件并重启 DSH 即可，包名、工具名与
  配置路径不变，无需迁移。
- 若之前手工安装过 Unity 包，可继续使用；新版本会通过 `unity_status` 的诊断结果提示是否需要重装。
