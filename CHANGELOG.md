# 变更记录

本文件记录对外发布的版本。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

[1.0.4]: https://github.com/Rice00/dsh-job-progress/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/Rice00/dsh-job-progress/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/Rice00/dsh-job-progress/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/Rice00/dsh-job-progress/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Rice00/dsh-job-progress/compare/7ede4b8...v1.0.0
[0.1.1]: https://github.com/Rice00/dsh-job-progress/compare/a76c03d...7ede4b8
[0.1.0]: https://github.com/Rice00/dsh-job-progress/commit/a76c03d
