# 变更记录

本文件记录对外发布的版本。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.6] - 2026-11-19

### 新增

- **面板上每一行都回答了「在做什么 / 到哪了 / 还要多久」**。此前后台命令作业的行标题就是它的
  命令行（harness 把作业 `label` 写死成 `args.command`），用户看到的是一串命令、也不知道跑到
  哪了 —— 2026-10-13 核查：盘上 57 条进度记录的任务名都很像样，问题全出在「作业自己那一行」。
  现在作业行也补齐了信息：
  - 标题取**那次工具调用时模型写的 `description`**（`pwsh` / `bash` 的必填参数，本来就是写给
    用户看的那句话）；读不到就退到命令行的可读摘要（如 `node other.mjs`），再不行就由前端用
    界面语言拼一句 —— **原始命令行任何情况下都不再当标题**；
  - 数字从**作业输出尾部**读（curl / aria2 / pip / ffmpeg 都会把百分比与速率打在那里），
    输出里没有数字就只显示已运行时长，**不编数字**；
  - 原始命令行降级成悬停里的备查信息。
- 面板加了两个标注：「据输出估算」与「未上报进度」，让用户一眼知道数字的来源。
- **标题语言跟随用户界面**：插件自己生成的字（进行中 / 未上报进度 / 据输出估算 / 剩 X，以及既没
  `description` 也没有可读摘要时的兜底文案）全部走前端中英词典；模型写的 `description` 与生产者
  写的任务名则由会话自己决定语言。因此技能里放了两处要求：正文有一条硬要求，技能在目录里显示的
  那一行（`description`）也带上了这句。两处都写成**跟随界面语言**（中文界面写中文、英文界面写英文），
  **不写死某一种语言**。目录行是关键，因为很多会话**根本不加载技能正文**（随手起个命令检查一下就走），
  但每个会话每次请求都能看到技能目录行
  （2026-10-13 实测：新会话把说明写成了英文，面板标题于是成了英文，用户误以为那是命令行）。
- 技能正文补一句：给 `pwsh` / `bash` 写的 `description` 会直接成为面板标题。
- **同一件事不再占两行**。生产者的进度记录与它所在的作业此前会各出一行（记录里没人写 `jobId` ——
  作业 id 是作业起来之后才交给模型的，跑在作业里的脚本拿不到）。现在「唯一候选」时自动认领：
  三条硬条件全满足才动手 —— 本会话**只有一个还在跑的作业**、只有**一条未配对且还在刷心跳的记录**、
  两者没被别的键配上。合并后名字与数字取记录的（生产者最准），状态与退出码取作业的（注册表权威），
  命令行仍只进悬停。认领过的组合会记住（作业跑完、记录写下终态后仍是一行），作业从注册表消失即
  清掉那段记忆。任何一条不满足就原样显示两行 —— **这条规则不做猜测**。

### 实现要点

- 读作业输出用 `readAt`（纯读），不像 `read()` 那样推进模型自己的输出游标；标题只在遇到新作业时
  扫一次会话日志尾部并缓存，输出采样按作业缓存（超过 256 条时清理已经不在列表里的）。
- 兜底文案不在宿主拼：宿主不知道用户界面是中文还是英文，所以空标题会原样送到前端，由词典补
  「pwsh 作业 pwsh-3」/「pwsh job pwsh-3」。
- 认领的边界：多个候选（两个以上活作业、两条以上未配对记录、记录里的 `jobId` 指向别处）一律不
  认领 —— 宁可显示两行，也不把 A 的名字挂到 B 的成功或失败上。

### 测试

- `test/preflight-host.mjs` 从 7 项扩到 22 项：标题来源、命令行绝不作为标题、摘要不含参数、
  输出解析（百分比 / 已下载与总量 / 速率 / 显式 ETA / 两次采样自算）、没数字时不编数字、
  配对到记录时以记录为准、宿主不自己编标题，以及自动认领的六项（合成、三种拒绝、终态后仍合、
  缓存随作业消失而清）。
- `test/preflight-client.mjs` 从 14 项扩到 17 项：两个标注的渲染、悬停里保留原始命令行、
  空标题走界面语言词典。

### 修复

- **桌面端那颗悬浮球从来不显示**。桌面 GUI 把插件槽位渲染在标题栏里：标题行带
  `container-type: inline-size`，按 CSS 包含规则会成为 `position: fixed` 后代的包含块；外面
  那层标题簇又带 `overflow: clip`。于是球在 DOM 里、坐标也正常，却永远画不出来（issue #1）。
  插件根节点现在改用 `createPortal` 到 `document.body` 渲染，脱离这套布局；`react-dom` 由宿主
  提供，不新增依赖，事件仍沿组件树冒泡，所以拖拽与点击照旧。
- 修法来自 @Lucifer-mutu 的 PR #2。本机桌面端（DSH Desktop 0.2.2-rc.1 / Electron 44.7）做了
  三态对照：不打补丁看不见球；打上补丁球出现、点击能开面板；还原后又消失。

## [1.0.5] - 2026-10-08

### 新增

- **把进度协议注册成一个「会话可见的技能」**（`ctx.skills.register`）。此前只有读过 README 的
  生产者才会写进度记录，别的会话压根不知道这条路存在 —— 2026-10-07 实测：本机另一个会话在跑
  60 GiB 下载，全程只看到命令行，而进度上报的实现（`lib/dsh-progress.mjs`）与文档一直都有。
  现在插件挂载时会把协议注册成技能 `dsh-job-progress`：任何 agent 一翻技能目录就知道
  「长任务要报进度」，不必再靠用户把说明贴进提示词。
  `skills` 服务不是必需依赖：拿不到就安静跳过，注册抛错只记一条 warn，不影响插件其余功能。
- 技能正文写清两件用户点名的规则：**下载任务必须开「带 ETA 的上报」**（同一个进程里连续
  `update()` 才算得出速度与剩余时间，只丢一条命令行作业等于没上报）；**面板标题写任务名**
  （「下载 anima_5B 模型（6.6 GB）」），不要写整条命令行或 URL —— 面板一行放不下、会截断。
- README / README.zh 的功能表补一行（「助手自己会找到」/ Agents find it themselves）。

### 修复

- **技能注册成功却加载不出来**。运行时注册（`ctx.skills.register`）只替技能补 `invocation`
  与 `provider` 两个默认值，**不补 `source`**；而加载时 `validateDefinition` 要求
  `source` 是字符串。于是条目在技能目录里看得见，真去加载却报
  `loaded skill "dsh-job-progress" source must be a string`（2026-10-08 实测）。
  现在定义里显式带上 `source: "plugin"`。
- **`dsh-progress.mjs set --speed` 只给出速度、ETA 恒为 `null`**。`update()` 里 ETA 是在应用
  显式参数**之前**算的，所以「自己算好速度、交给 CLI 写一条」这条路永远拿不到剩余时间。
  现在统一在参数之后重算：给了 `--speed` 就会顺带算出 ETA。

### 测试

- 新增 `test/preflight-skill.mjs`（16 项）：钉死注册契约（名称 / 描述 / 何时使用 / 正文要点 /
  `source` / helper 路径真实存在）、skills 服务缺失时的降级、注册抛错时的容错。
- 新增 `test/preflight-progress.mjs`（12 项，无外部依赖，CI 里也跑）：模块接口的速度与 ETA、
  原子写、终态，以及 CLI 的 `--speed` → ETA、二次 `set` 沿用同一份记录、`dir` / `clear`。
- `package.json`：`test` 顺带跑生产者侧自检，新增 `test:progress`，`test:local` 一把跑四项。

## [1.0.4] - 2026-10-04

### 修复

- **后台任务不再自动出现在面板上**。宿主半边把 owner **对象**交给了作业注册表
  `ctx.jobs.list(caller)`，而注册表的签名是 `list(caller?: SessionId)`，内部按
  `job.owner.id === caller` 比较 —— 对象永远不等于字符串，带 owner 的作业被整批滤掉。
  于是只有「自己写进度文件」的任务能显示，普通后台任务（`pwsh`、bash、子代理等）一条都不出现
  （2026-10-04 实测：会话里起了 `pwsh-36`，`/api/job/kill` 认它属于本会话、快照却返回空列表）。
  现在传 `owner.id` 字符串，与官方控制器的用法一致（`registry.list(request.sessionId)`）。
- **客户端半边读的作业镜像键不存在**。组件读的是 `state.jobsBySession`，而当前 harness 的
  客户端作业模型是 `dsh-api-job-controller` 的 `ClientJobsModel`，快照落在 `rows`（按会话 id）。
  旧键恒为 `undefined`，所以面板拿不到注册表作业、轮询也一直停在 10 秒档。
  现在改为绑定官方模型 `ctx.jobs.state`（`jobs` 已加进客户端 `inject`），拿不到时安静退化。

### 测试

- 新增 `test/preflight-host.mjs`（7 项）：用桩复现注册表的官方语义，钉死「必须传会话 id 字符串」
  与「别的会话的作业不得混入」。
- `test/preflight-client.mjs` 从 12 项扩到 14 项：断言 `inject` 里带了 `jobs`，并按新的镜像键
  校验「有任务时渲染 / 无任务时不渲染 / 拿不到作业模型时不抛」。

## [1.0.3] - 2026-09-30

### 新增

- 插件面板图标：`assets/icon.png`，并在 `package.json` 声明 `"icon": "./assets/icon.png"`。
  全局「插件」页的图标来自清单里的 `icon` 字段（`@deepseek-ai/dsh-app-boot` 的 `iconOf()`），
  不声明就退回默认插画。图标由现有 logo 缩到 256×256 生成（保留 alpha）：logo 本身
  **320,676 字节**，超过 `iconOf()` 强制的 **256 KiB** 上限（会抛 `icon exceeds 256 KiB`），
  所以另出一张小图，logo 仍留给 README。

## [1.0.2] - 2026-09-29

### 修复

- peer 范围补上 `0.2` 分支，否则在 DSH `0.2.0-rc.1` 上会被插件管理器的兼容性检查拦下而**整个插件不被装载**。
  原来的 `^0.1.0-rc.6 || ^0.1.5-rc.1` 只覆盖到 `0.1.x`；管理器在安装时按 peer 声明比对运行中的 dsh 版本，
  不匹配就不装载（日志原文：`Plugin dsh-job-progress@1.0.1 is incompatible with dsh 0.2.0-rc.1: peerDependencies {…}`）。
  现在为 `^0.1.0-rc.6 || ^0.1.5-rc.1 || ^0.2.0-rc.1`：覆盖 `0.2.0-rc.1` 与整个 `0.2.x`，仍不含 `0.1.6-alpha.x`
  与 `0.3.x`（未验证的版本不声明）。宿主侧用的是通用接口——`dshHomePath()` 与 Typert Remote，
  在 `0.2.0-rc.1` 下未发现需要改代码之处。

## [1.0.1] - 2026-09-25

### 修复

- 任务面板的背景不再透出后面的会话内容。面板此前直接借用了主题的菜单色
  `--dsw-specific-menu`，而那个值本身是半透明的（亮色 `#f8f9fa94`、暗色 `#30313680`）
  且**约定与模糊滤镜成对使用**——应用自己的菜单就是这么用的（`--dsw-menu-backdrop-filter`，
  即 `blur(40px) saturate(150%)`）。面板里是数字与标签、没有那层模糊，于是直接透出底下的内容。
  现在把同一层色调叠在不透明底色 `--dsw-alias-bg-base` 上：既保持主题色，又完全不透明，
  主题被自定义时也仍然跟随（不硬编码色值）。

## [1.0.0] - 2026-09-25

首个稳定版。这一版没有引入不兼容改动：自 0.1.0 首发以来，对外接口（`dsh.bundle` 补丁行、
`./client` 与 `./progress` 两个入口、进度文件的目录约定）都没有改过，本版把语言与依赖声明
两处不一致补齐，并把包标记为稳定。

### 新增

- `CHANGELOG.md`：从这一版开始记录每次发布。

### 修复

- `lib/client.js`：剩余时间的前缀过去是硬编码中文，英文界面下显示成「剩11m16s」。改为走
  locale 词条 `eta.left`，中文为 `剩{d}`、英文为 `{d} left`（中英词序相反，所以用占位符而不是拼接）。

### 变更

- `package.json`：peer 范围改为 `^0.1.0-rc.6 || ^0.1.5-rc.1`。原来的 `^0.1.0-rc.6` 按 semver
  规则**不匹配**预发布版本 `0.1.5-rc.2`（只允许同一 `major.minor.patch` 元组内的预发布比较），
  补上同元组分支后当前 harness 才落在声明范围内。
- `package.json`：声明 `engines.node`（`>=22.19.0`）。

## [0.1.1] - 2026-09-25

### 新增

- `screenshots.json`：向插件目录声明界面截图。
- README 增加 npm 安装方式与 npm 徽章；截图改用 Markdown 图片语法——插件目录渲染 README 时会丢弃
  裸 HTML，于是相对路径也就无法被改写成可访问的绝对地址。

## [0.1.0] - 2026-09-25

### 新增

- 首个公开发布。

[1.0.6]: https://github.com/Rice00/dsh-job-progress/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/Rice00/dsh-job-progress/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/Rice00/dsh-job-progress/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/Rice00/dsh-job-progress/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/Rice00/dsh-job-progress/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Rice00/dsh-job-progress/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Rice00/dsh-job-progress/compare/7ede4b8...v1.0.0
[0.1.1]: https://github.com/Rice00/dsh-job-progress/compare/a76c03d...7ede4b8
[0.1.0]: https://github.com/Rice00/dsh-job-progress/commit/a76c03d
