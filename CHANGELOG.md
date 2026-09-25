# 变更记录

本文件记录对外发布的版本。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

[1.0.1]: https://github.com/Rice00/dsh-job-progress/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Rice00/dsh-job-progress/compare/7ede4b8...v1.0.0
[0.1.1]: https://github.com/Rice00/dsh-job-progress/compare/a76c03d...7ede4b8
[0.1.0]: https://github.com/Rice00/dsh-job-progress/commit/a76c03d
