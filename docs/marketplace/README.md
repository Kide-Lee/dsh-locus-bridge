# 投稿到 awesome-dsh-plugin 市场

本目录只有一份投稿产物：`Kide-Lee__dsh-locus-bridge.yml`。它**不是**本仓库运行所需的东西，
放在这里是为了让投稿可以复现、可校验，而不是散落在某次对话里。

投稿目标仓库：[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。
规则来源：[contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)。

## 一、投稿要做什么

**一个文件，一次 PR。** 把 `Kide-Lee__dsh-locus-bridge.yml` 复制到目标仓库的
`data/plugins/` 下，文件名必须与文件内 `url` 推出的 slug 一致（`<owner>__<repo>.yml`）。
两个 README **不要手工编辑**——它们由 `data/plugins/*.yml` 生成，合并后在 `main` 上自动重跑。

条目本身的说明：

| 字段 | 取值与理由 |
|---|---|
| `category` | `dev`（Development & Runtime）。库里 4 个 Unity 条目都在 `tools`，但那几行走的是 MCP 或官方 unity CLI，卖点是"加工具"；本插件接管的是编译 / 域重载 / Play 循环，属于运行时。分类选偏了不会被打回，维护者会直接改 |
| `description.en` | 必填。只写代码里能核实的事实：7 个 `unity_*` 工具、主线程 C# 执行、域重载、revision 守卫、场景属性树 |
| `description.zh` | 可选（缺了维护者会补），但本仓库本来就是中文项目，直接给出更省事 |
| `icon` / `tarball` / `screenshots` | 全部可选。见下方"还能做但没做的" |

`url` 必须是仓库根、且根 `package.json` 声明 `dsh.bundle`——否则 CI 会要求把条目指向子包。
本仓库根 `package.json` 已声明 `dsh.bundle`，条目指向根即可，`dsh plugin add github:Kide-Lee/dsh-locus-bridge`
能装出东西。

## 二、逐项对照 CI 门槛

| CI 检查 | 状态 |
|---|---|
| 每个 PR 最多 3 条 | ✅ 本投稿 +1/-0 |
| `dsh.bundle` 在仓库根 | ✅ `package.json` → `dsh.bundle.patch: ./cordis.patch.yml`，文件存在 |
| 仓库满 1 天 | ⏳ 创建于 2026-11-10 01:24 UTC，UTC 2026-11-11 01:24（北京时间 11 日 09:24）达标 |
| `awesome-lint` / 站点构建 | ✅ 见下方本地校验 |
| 真实可用的代码 | ✅ 32 个模块、71 个测试、Rust 移植版 broker |

仓库年龄这一项**不需要你推空提交或关掉重开**：`regate.yml` 每 6 小时重跑一次带
`/days old/` 措辞的失败，veto 会自己翻绿。要一次全绿就在北京时间 11 日 09:24 之后再开 PR。

## 三、本地校验（已跑过，可复跑）

```bash
# 1. 拉目标仓库
git clone --depth 1 https://github.com/awesome-dsh-plugin/awesome-dsh-plugin /tmp/awesome
cd /tmp/awesome && npm ci          # 或 pnpm install

# 2. 放入条目
cp <本仓库>/docs/marketplace/Kide-Lee__dsh-locus-bridge.yml data/plugins/

# 3. 校验形状：输出 problems: 0 即通过
node -e "import('./scripts/lib/entries.mjs').then(m=>console.log('problems:', m.validateEntries(m.readEntries()).length))"

# 4. 预览生成出来的那一行（会动 README，仅本地预览，别提交）
node scripts/generate-readme.mjs
grep -n 'dsh-locus-bridge' README.md README.zh.md
```

第 3 步会报出所有形状问题：未知字段、`url`/`name` 不一致、文件名与 slug 不符、分类不在
`CAT_IDS`、描述含 `: ` 却没加引号、`icon`/`tarball` 指向不允许的主机。

第 4 步生成的行落在 Development & Runtime 段：

```
- [Kide-Lee/dsh-locus-bridge](https://github.com/Kide-Lee/dsh-locus-bridge) - Lets DSH act as a Locus client ...
- [Kide-Lee/dsh-locus-bridge](https://github.com/Kide-Lee/dsh-locus-bridge) — 让 DSH 扮演 Locus 客户端 ...
```

> `node scripts/build-site.mjs` 在缺 `data/stars.json` 时会以"star 覆盖率低于 66%"失败。
> 那是本地没有跑 `probe-stars.mjs` 的正常现象，与条目无关，CI 上不会复现。

## 四、开 PR

```bash
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin
git checkout -b add-dsh-locus-bridge

cp <本仓库>/docs/marketplace/Kide-Lee__dsh-locus-bridge.yml data/plugins/

# 只提交这一个文件。不要 git add -A：README 是生成物
git add data/plugins/Kide-Lee__dsh-locus-bridge.yml
git commit -m "Add Kide-Lee/dsh-locus-bridge"
git push -u origin add-dsh-locus-bridge
gh pr create --fill
```

PR 描述用下面这份：

```markdown
Adds Kide-Lee/dsh-locus-bridge — a DSH plugin that speaks the Locus native broker
protocol, so the agent can drive a Unity editor directly (no MCP server in between).

- `dsh.bundle`: declared at the repository root (`cordis.patch.yml`), so
  `dsh plugin --profile <p> add github:Kide-Lee/dsh-locus-bridge` installs a working
  bundle with no manual patch edit.
- 7 tools: unity_status / unity_execute / unity_play_mode / unity_console_log /
  unity_recompile / unity_asset / unity_scene.
- Windows named pipe and Unix domain socket transports; the Linux/macOS broker port
  lives in `native/locus_unix_native/` (GPL-3.0-or-later, derived from upstream
  Locus — see NOTICE).
- Tests: `npm test` (71), `npm run typecheck`, `npm run validate`.

One entry, one file. READMEs untouched.
```

## 五、被要求修改时

维护者需要改动时会打 **`held: author`** 标签——那是暂停，不是拒绝。做法是**把修复推到同一分支，
再留一条评论说明改了什么**，然后等。不要反复推、不要连发追问：合并队列在有人重新评审前对两者
都不敏感。标签不会自动摘除，只有重新评审能摘。

真被打回，最常见的两条是：

1. **描述不属实。** 描述会被当作对本插件的声明去对着代码核。写了"7 个工具"就要真有 7 个，
   提到某个命令就要能跑。当前描述只列了能在 `src/tools.js` 里点清的 7 个工具签名。
2. **动了别人的条目。** 一个 PR 只该改自己那一行，这正是 README 改为生成的原因。

## 六、还能做但没做的（都不影响收录）

- **发 npm。** 包名 `dsh-locus-bridge` 目前未被占用。发布后 `package.json` 的 `repository`
  必须指回本仓库，市场会自动关联下载量；预构建安装还能跳过 `allowBuilds` 构建授权。
  本仓库 `package.json` 已经补好了 `repository` / `bugs` / `homepage` / `files`，去掉 `private`
  之后即可发布。
- **`tarball:`** 不发 npm 的替代方案：往 GitHub Release 附一个**不带版本号**的
  `dsh-locus-bridge.tgz`，条目加
  `tarball: https://github.com/Kide-Lee/dsh-locus-bridge/releases/latest/download/dsh-locus-bridge.tgz`。
  坑：`latest/download/` 的文件名照字面取，资产名带版本号的话下次发版就 404。
- **`screenshots.json`。** 放仓库根，列 1–8 张仓库内图片的相对路径，市场详情页会按它渲染
  截图；不声明就只能从 README 抽，而两个 README 目前都没有图。
- **`icon:`** GitHub 托管的方图（png/jpg/webp，~96px 显示），不写则回退到作者头像。
