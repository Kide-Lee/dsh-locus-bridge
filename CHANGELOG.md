# 更新日志

本文件记录 dsh-locus-bridge 的版本变更。版本号遵循 SemVer，条目按用户可见的变化归纳。

## [1.1.0] - 2026-11-16

本版把插件的能力面推到与 Locus 官方接近的位置：热补丁从「只分类」变成真正编译并挂进运行中的编辑器，
新增常驻编译服务、持久化资产库、YAML 实时值、离线文档与协作锁，原生侧补上状态探针与卡死诊断。
同时删掉官方没有的 `code_analysis` 工具，`code_*` 恢复为与官方一致的五个查询工具。

工具面从 17 个增加到 23 个（18 个 `unity_*` + 5 个 `code_*`）。

#### 新增工具

- **`unity_hot_reload`**：用编译服务做签名级 diff（`analyze/hotDiff`），生成补丁程序集（`compile/hotPatch`），
  再交给编辑器 detour 应用——`applied` / `detourEngine` / `patches` 说明真正挂上了什么，`dry_run` 只分类。
  分类规则与上游一致：只有方法体、构造函数体、访问器体或字段初始化器变了才算 hot；改签名、加减成员、
  改基类一律 cold，因为错误的 hot 比要求重新编译更糟。
- **`unity_recompile` 新增 `mode`**（`auto` / `compile` / `scripts`，默认 `compile`）：`auto` 先分类再决定，
  能热补丁就报 `hot`；`scripts` 走 `request_script_reload` 的快速重载，并明确说明它不代表收敛。
- **`unity_asset_search`**：全工程资产索引（GUID、类型、路径），编辑器关着也能答，并报告缺 `.meta` 与重复 GUID。
  索引落在 `Library/Locus/asset-index.db`（`node:sqlite`，WAL）：重扫只 stat 变化的文件，可跨会话复用。
- **`unity_yaml_read` / `unity_yaml_search`**：直接读/搜 Unity YAML（`.unity` / `.prefab` / `.asset`），
  scope 与 match_fields 可收窄，不需要打开场景；带 object 选择器时读编辑器内存里的未保存修改。
- **`unity_lock` / `unity_release`**：跨会话的协作锁，带持有者与等待/试拿两种语义，
  持有进程已消失时自动视为过期而不是永久卡住。
- **`unity_offline_docs`**：导入 Unity 官方离线文档（中文/英文，版本按工程当前编辑器版本解析），
  导入后可关键词检索、读页、删除；导入过程报告进度并可取消。同时注册 `unity-offline-docs` 技能。

#### 变化的工具

- **`unity_status`**：新增编辑器发行版（Unity / 团结引擎 Tuanjie，读 `ProjectVersion.txt`，编辑器没开也能答）、
  响应性（`responsive` / `diagnosis`，来自原生状态探针），输出新增 `flavor` / `version` / `diagnosis`。
  旧 broker 缺这项能力时降级为「无结论」，不会让状态查询失败。
- **`unity_console_log`**：新增 `source`（`console` / `editorLog`）。编辑器连不上时也能读 `Editor.log`
  尾部，并区分「这个工程的日志」与「别的工程的日志」。
- **`unity_asset_graph`**：`references` / `usages` 不再强制要求先打开场景——有工程索引时走索引并标
  `source: "project"`，降级到已打开场景时标 `source: "open-scene"`。
- **`unity_execute`**：失败路径在开启编译服务时追加编辑器外的编译检查（`Compile check (off-editor …)`），
  直接回答「是不是我的代码编不过」。

#### 与 Locus 官方对齐

- **编辑器侧只用 payload 已有的消息**：热补丁的 apply / 摘除 / 自检直接发 payload 自带的
  `hot_patch_loaded` / `hot_patch_dispose` / `hot_reload_probe`，与 Locus 桌面端走同一条路；
  整批补丁原子生效（任一处失败即回滚），`domain_generation` 取自 `get_reload_state`，旧域编译的补丁
  被 payload 直接拒绝；detour 账本在插件进程中按 payload 的 `MethodKey` / `DetourKey` 规则维护。
  实时值走 payload 自带的 `read_yaml`，文本原样透传。**插件不含任何 Unity 侧 C# 代码**，
  工程里只需要 `com.farlocus.locus` 一个包。
- **prefab 覆盖读磁盘**：按官方 `unity_yaml_read` 的 `detail: "prefab_overrides"` 语义解析
  `m_Modifications` 与嵌套 PrefabInstance，读法就是 `unity_yaml_read`。
- **编辑器健康只看原生证据**：`dsh_health` 由原生 broker 自己应答（主线程卡死时 managed 侧正是答不了的那个），
  CPU、心跳、存活与主线程栈两档探针；官方的挂起诊断同样只看原生栈与 CPU。「编辑器是否在编译」由
  broker 在编译期拒绝 managed 请求体现（`managed_not_ready` / `managed_reloading`）。
- **`code_*` 收拢为官方的五个查询工具**：`code_symbol_search`、`code_goto_definition`、
  `code_find_references`、`code_hover`、`code_diagnostics`；语言服务器的 Roslyn 组件与 .NET 运行时
  在第一次查询时自动下载并在插件目录复用（对应桌面端 `assets::ensure_assets`），机器上已有 .NET 10
  时不额外下运行时。
- **工具权限契约**：`unity_execute` 的 `readonly` 为必填（官方 schema 即如此），只读调用跳过编辑会话，
  写操作必须显式声明 `readonly: false`；参数根一律闭合（`additionalProperties: false`），拼错参数是参数错误
  而不是被静默丢弃；`unity_asset` 的 `apply` / `undo` 与 `unity_scene` 的 `set` / `batch` / `undo`
  都要求 `request_editor_status` 并与实时状态比对；`unity_execute` / `unity_run_states` 的
  `enable_non_public_access` 如实反映能力边界（`unity_run_states` 只接受 `false`）。
- **`unity_lock` 契约与官方一致**：`reason` 在 acquire 时必填，`timeout_seconds` 只接受 1..900（越界报错），
  acquire 结果带回锁文件路径（`Library/Locus/session-lock.json`）。

#### 新增能力与基础设施

- **常驻编译服务**：`pinSidecar` / `unpinSidecar` / `readResidency`。常驻是**租约**（默认 8 小时，
  `Library/Locus/compile-sidecar.json` 记录 pid 与心跳），不是永不退出：插件进程被换掉时没人续租，
  进程自己退出，不会留下孤儿。编译服务是独立 Roslyn 进程（.NET 10 CoreCLR），每工作区一个、空闲 600 秒回收、
  上限 8 个，缺 .NET 时**如实报不可用**并回退编辑器路径，绝不静默下载 SDK。源码在 `tools/dsh-finish/Compiler/`，
  用 `npm run build:compiler` 构建，新增 `compile/params`、`analyze/hotDiff`、`compile/hotPatch` 三个 RPC。
- **原生状态探针 / 卡死诊断 / 后台钩子**（`native/locus_unix_native/`）：卡死时抓主线程栈并给「Stuck at」结论，
  抓不到就明说抓不到；`dsh_set_background_hook` 在 Windows 走 dbghelp 符号，Unix 走「导出符号 → 模式扫描」
  两条路径，且**只在唯一命中且符号名相邻时**才打补丁，否则如实报 `unsupported` 并给原因。
- **团结引擎识别**：`ProjectVersion.txt` 与编辑器窗口标题两路识别，`unity_status` 报告发行版。
- **设置页**：新增编译服务、后台调度钩子、离线文档三个开关，默认值与 Locus 一致（开启）；
  settings 文档升到 v2，v1 会被自动迁移。后台加速开关由 `unity_status` 幂等同步到 broker，
  非 Windows 仍如实报不支持。

#### 修复

- **`unity_offline_docs` 在 DSH 里不可能成功**：导入器要求注入 `fetch`，工具却从未传入，任何运行时都报
  `no fetch implementation available`。现在显式使用 `globalThis.fetch`。
- **取消后状态永远停在 importing**：取消文件在场时 `docsImportState` 仍报「在跑」，界面会卡在一根不动的
  进度条上。现在取消文件在场即 `running: false`。
- **每个文档页标题重复两遍**：正文自带的 `<h1>` 与写入时的 `# title` 叠在一起，26660 个页面全部如此。
- **`unity_execute` 的 `enable_non_public_access` 曾让每个片段都编不过**：桥会在片段前插
  `using __LocusNonPublicAccess.<程序集>;`，而没有任何 Unity 程序集定义这个命名空间，开着默认设置时一律
  `CS0246`。上游这项能力由编译服务用 `IgnoresAccessChecksTo` 实现，桥用编辑器自带 Roslyn 做不到；
  现在片段按原样发送，并在结果后附一句明确的能力限制（私有成员请用反射）。
- **`unity_hot_reload` 对 Allman 风格的方法体漏判**：分类器逐行扫描时要求开括号与签名同行，
  工程里最常见的「签名一行、`{` 下一行」写法因此得到空方法表，还会输出
  `nothing to classify: no edited scripts were given`。现在等待下一行的 `{` 作为方法体起点，
  应答新增逐文件结论 `files[]`（`state` / `reason` / `method_count`）。
- **补丁程序集三处不匹配**：方法表是 camelCase 而编辑器 DTO 是 snake_case、补丁类型在
  `Locus.DshHotPatch` 命名空间下而查找时没有前缀、补丁类名被截短成类型短名——现在三者一致。
- **空补丁**：`ProjectFacts` 用类型短名造方法键、`PatchCompiler` 用全名比对，现在统一。
- **引擎引用缺失**：工程 `Library/ScriptAssemblies` 里没有引擎模块时补丁编译找不到 `System.Object` 与
  `UnityEngine`；现在按 `ProjectVersion.txt` 去编辑器安装目录补齐。
- **`node:sqlite` 在 ESM 下不可用**：`require` 未定义被静默吞掉，索引一直悄悄降级；改为 `installBuiltinLoader`。
- **资产库 schema 不重建、`type` 为 undefined 时写库报错**：`user_version = 0` 的旧库现在会丢弃重建；
  `node:sqlite` 不接受 undefined 绑定导致的整批写入失败已修。
- **`unity_yaml_read` 对二进制资产的说法**：AssetBundle 序列化的场景/预制体不是文本 YAML，
  提示语现在说明「这个资产不是文本 YAML」，而不是误导性的「文件没有 --- 头」。
- **`unity_yaml_search`**：`scanned` 曾恒为 0；`match_fields` 的描述曾与实现不符（示例给的是字段名，
  实现只接受 `path` / `field_name` / `field_value` / `type` / `all`）；`source:"live"` 无 `scope` 时曾崩溃。
- **`unity_asset_search` 的非法 `guid` 曾被静默忽略**：`guid:"ZZZ"` 会返回全库资产；现在明确报错，
  `limit` 也改为越界报错而不是悄悄夹紧。
- **`unity_yaml_read` 对不存在的路径曾先报「文件不存在」**：空内容与「文件不存在」现在可区分。

### 兼容性与分发（1.1.0）

- 运行环境：Node >= 22.12，`@deepseek-ai/dsh` `>=0.2.1-alpha.2 <0.3.0-0`，Unity 2021.3+（团结引擎同样识别）。
- `payload/locus_unity/` 是上游 `com.farlocus.locus` 0.1.0 的逐字副本（来自 Locus 0.9.3），未作任何修改；
  `npm run check:payload` 校验漂移。插件整体声明它对应的 payload 版本，不一致时 `unity_status` 给出警告。
- **可选 .NET 10 编译服务**：未构建或没有 .NET 时全部工具照常走 Unity 自带 Roslyn，
  只是少了编辑器外编译检查、常驻租约与签名级热补丁 diff。
- **C# 语义分析用到的组件在第一次查询时自动下载**（约 90 MB），机器上没有 .NET 10 运行时才会额外下运行时。
- 发布 ZIP 包含 Unity payload 与安装脚本；npm tarball 仍不含 `payload/`。

### 验证（1.1.0）

- `node --test --test-concurrency=1 "test/*.test.js"`：**704 通过 / 0 失败**。
- `dump-tools`：23 个工具的 schema 全部符合 DSH 子集；`typecheck`：120 个模块的 import / 调用点一致；
  客户端与 three.js 查看器 bundle 均是最新。
- 真机（Unity 2022.3.62f3）：热补丁全链路（diff → 编译 → `applied: 1`，`detourEngine: "detour"` →
  `disposed: 1`）；离线文档完整导入（26660 页）、检索、读页、删除；YAML 实时读（二进制场景）、
  资产检索（7515 文件）、`unity_status` / `unity_recompile` 一次生命周期内全部通过。
- 原生 broker 的改动（去掉阶段快照，`dsh_health` 只剩 CPU 与存活两档）在开发机上**未做编译验证**
  （cargo 缓存只读），请在 Linux / macOS 上用 `npm run build:native && npm run test:native` 复核。

### 升级说明（1.1.0）

- 工具数从 17 增至 23（18 个 `unity_*` + 5 个 `code_*`）。若在 1.0.0 下依赖过 `unity_execute` 的私有成员访问：
  该能力从未真正生效，升级后会在结果里明确说明限制，请改用反射访问非公开成员。
- **`unity_status` / `dsh_health` 不再有 `phase`**：编辑器阶段不在 payload 能看见的接口里，官方也不用阶段；
  「是不是在编译」看 managed 请求被拒绝（`managed_not_ready`）。依赖 `tiers.t1` 的调用方请改看 `t2` / `t3`。
- **`unity_prefab_overrides` 工具删除**：用 `unity_yaml_read` 读实例的 `m_Modifications`。
- **`code_analysis` 工具删除**：分析组件在第一次查询时自动下载；要关闭整个功能面用设置页的
  「C# 分析」开关（或部署级 `DSH_LOCUS_CSHARP=0`）。
- **不需要在工程里安装额外的 Unity 包**：`Packages/` 下只需 `com.farlocus.locus`。
- 设置页新增三个开关（编译服务、后台钩子、离线文档），默认开启，与 Locus 一致。

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
  `code_diagnostics` 五个工具。
- 第一次查询自动下载 Roslyn 服务器与 .NET 运行时（约 90 MB），之后复用。
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
