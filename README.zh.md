<div align="center">

<img src="assets/logo.png" alt="dsh-job-progress" width="150" />

# dsh-job-progress

**跑到哪了？**——让我们快速查询当前进度（为每个急哭的人设计）。

一个 DeepSeek Harness 插件：为长时间运行的后台任务显示实时进度。下载、模型转换、渲染、批量任务，都算。

[![License: MIT](https://img.shields.io/badge/License-MIT-2f7de1.svg)](./LICENSE)
[![Platform: DSH web](https://img.shields.io/badge/platform-DSH%20web-334eac.svg)](#兼容性)
[![Runtime: Node 22+](https://img.shields.io/badge/runtime-Node%2022%2B-3c873a.svg)](#兼容性)
[![Zero config](https://img.shields.io/badge/setup-zero%20config-1c7a54.svg)](#功能)
[![PRs: welcome](https://img.shields.io/badge/PRs-welcome-7096d1.svg)](#参与贡献)
[![GitHub stars](https://img.shields.io/github/stars/Rice00/dsh-job-progress?style=flat&label=stars&color=7096d1)](https://github.com/Rice00/dsh-job-progress/stargazers)

<img src="assets/screenshot.png" alt="悬浮小球与任务面板" width="360" />

<sub>小球浮在对话上方，角标显示正在跑的数量，点开就是任务面板。</sub>

[功能](#功能) · [安装](#安装) · [快速上手](#快速上手) · [协议](#进度协议) · [验证](#验证安装) · [常见问题](#常见问题) · [**English**](./README.md)

</div>

---

## 功能

| | |
|---|---|
| 🟢 **悬浮小球** | 只在有任务可看的会话里出现。角标是正在跑的任务数（超过 9 显示 `9+`）。 |
| 🖱️ **可以拖** | 摆哪儿都行，位置刷新页面后还在。 |
| 📊 **实时面板** | 一行一个任务：状态点、名称、进度条、百分比、`已完成/总量`、速度、剩余时间、已用时间。 |
| 🧹 **清除已完成** | 删掉本会话已完成的进度文件，正在跑的绝不动。 |
| 🤝 **不靠自觉** | 任务列表来自作业登记表，所以没上报进度的任务照样会出现，只是没有进度条。 |
| 🔒 **会话隔离** | 一个会话只能看到自己的任务，别的会话的东西不会漏进来。 |
| 🧩 **不限任务类型** | shell 命令、ComfyUI 渲染，任何登记了后台任务的都行。 |
| 🔑 **零配置** | 不要凭据、不要令牌、不联网：它只读作业登记表和自己写的文件。 |
| 📦 **无需构建** | 前端插件是手写的模块加载器模块，没有打包产物要同步。 |

## 安装

### 本地目录（推荐）

```bash
git clone https://github.com/Rice00/dsh-job-progress.git
dsh plugin --profile <profile> add link:/abs/path/to/dsh-job-progress   # 指向上面检出的目录
```

bundle 补丁会往 profile 里插一行（`job-progress`）。**然后重启这个 profile**——宿主插件模块在进程内缓存，运行中的 harness 不会自动读到新行。

`link:` 是活链接：**改源码立刻生效**（宿主代码重启后生效，界面代码刷新后生效），但装完之后不能挪动这个目录。想连文件一起复制走，用 `file:/abs/path/to/dsh-job-progress`，代价是以后每次改都得重新装一遍。

### 从 GitHub 或 npm 安装

```bash
dsh plugin --profile <profile> add github:Rice00/dsh-job-progress
dsh plugin --profile <profile> add dsh-job-progress        # 发布到 npm 之后
```

### 交给 AI 助手（直接复制）

```
请帮我安装 DSH 插件 dsh-job-progress：

1) 装进 web profile，两种来源任选：
     从 GitHub：
       dsh plugin --profile web add github:Rice00/dsh-job-progress
     或从本地检出（填这个文件夹的绝对路径）：
       dsh plugin --profile web add link:<绝对路径>
2) 重启该 profile——宿主插件模块在进程内缓存，新行只在启动时读。
   （只改界面的话，刷新浏览器就够了。）
3) 验证：
     node <绝对路径>/test/preflight-client.mjs      → 应输出 "ALL PASS (12)"
     宿主日志里应出现：  job-progress: mounted, progress root …
   Windows 下宿主日志在 %APPDATA%\DSH Desktop\logs\host\。
   只要 DSH 能正常启动、渲染进程控制台没有新报错，就算装好了。
```

## 快速上手

没有任何要配置的东西——后台跑点活，小球就出来了：

```bash
node download.mjs https://example.com/model.safetensors    # 后台运行
```

想让进度条动起来，让干活的那边报几个数就行（一个文件，什么语言都行）：

```js
import { track } from 'dsh-job-progress/progress';

const t = track({ label: 'model.safetensors', total: 66000000 });
t.update(bytesSoFar);        // 速度和剩余时间会自动算
t.phase('verifying');
t.finish('done');            // 或 t.finish('failed', 'sha256 校验失败')
```

不想改代码，直接在 shell 里报也行：

```bash
node <plugin>/lib/dsh-progress.mjs set --label model.safetensors --done 12 --total 100
node <plugin>/lib/dsh-progress.mjs done --key model.safetensors
```

## 工作原理

```
产出方（你的脚本）              宿主插件                        前端插件（浏览器）
  track({ label, total })  ──▶  读 <DSH_HOME>/job-progress/  ──▶  每 2 秒取一次 jobProgress/snapshot
  写 <key>.json                 <DSH_SESSION_ID>/*.json           渲染小球、角标和面板
                                 + 作业登记表快照
```

小球的位置和"哪些已经清掉了"记在 `localStorage` 里。

## 进度协议

一个任务一个 JSON 文件，写在会话自己的进度目录下：

```
<DSH_HOME>/job-progress/<DSH_SESSION_ID>/<key>.json
```

这两个环境变量在每次 agent shell 调用里都已经存在，所以产出方不需要任何人告诉它路径。

```json
{
  "label": "anima_preview_5B.safetensors",
  "done": 4187599360,
  "total": 9972879360,
  "unit": "bytes",
  "speed": 13107200,
  "eta": 440,
  "phase": "download",
  "status": "running",
  "note": "",
  "jobId": "bash-3",
  "updatedAt": 1758000000000
}
```

| 字段 | 含义 |
|---|---|
| `label` | 面板上显示的名字；也是按名字匹配作业登记表的依据 |
| `done` / `total` | 已完成量；`total: 0` 显示成"正在跑，总量未知" |
| `unit` | `bytes`（默认，按 KiB/MiB/GiB 显示）或 `count`（原样显示） |
| `speed` / `eta` | 可选；没有就不编 |
| `phase` | 自由文本；`merging`、`verifying` 有内置译文 |
| `status` | `running` \| `done` \| `failed` |
| `jobId` | 可选；直接钉住某个作业，而不是按名字匹配 |
| `updatedAt` | 心跳，毫秒时间戳 |

**心跳。** `status` 是 `running` 时，至少要每 15 秒刷新一次 `updatedAt`。停止刷新的活条目会被当作已经没了——一个不再写文件的产出方，和一个崩掉的产出方，从外面看不出区别。`done` / `failed` 的条目会多留两分钟。

**原子写入。** 先写 `<file>.tmp` 再改名覆盖目标文件；读的人永远不该看到半截记录。

### 命令行

| 命令 | 作用 |
|---|---|
| `set --label <名字> [--done N] [--total N] [--unit bytes\|count] [--phase P]` | 新建或续写一条记录 |
| `done --key <key> [--note "..."]` | 标记完成 |
| `failed --key <key> --note "..."` | 标记失败 |
| `dir` | 打印实际用的进度目录 |
| `clear [--key <key>]` | 删除本会话的进度文件 |

## 清除

**清除已完成**会删掉本会话所有已完成的进度文件，正在跑的一律不动。

作业登记表里的任务删不掉——它只是只读投影——所以已经结束的任务行会记进本会话的忽略名单，从此不再出现。名单的键里带了任务的 `startedAt`：作业 id 是按进程数出来的 `<kind>-N`，否则重启之后一条旧的忽略记录会把一个全新的任务也藏掉。

会话 id 里带路径分隔符或 `..` 的，宿主直接拒掉，而且要求会话真的存在。这个 id 同时是目录名，所以这是防路径穿越的闸门，不是走形式。宿主不答应的时候，界面会报失败、什么都不改——不会出现"看起来清掉了、文件还在"。

## 兼容性

| | |
|---|---|
| **DSH** | 在 `0.1.5-rc.2` 上实测；浏览器 GUI 和桌面应用内嵌的 web 宿主都能用 |
| **Profile** | 任何带 web 界面的 profile（`web`；同一行加到 `desktop` 也可以） |
| **运行时** | Node 22+（插件本身不带任何依赖） |
| **作业类型** | 登记进 `ctx.jobs` 的任何作业，不限类型 |
| **额外要求** | 不要凭据、不要令牌、不需要联网 |

## 验证安装

```bash
# 1) 前端插件：模块契约、插槽注册、跑一遍渲染
node test/preflight-client.mjs            # → ALL PASS (12)

# 2) 宿主插件挂上了没（Windows 桌面应用）
Select-String -Path "$env:APPDATA\DSH Desktop\logs\host\dsh-*.log" -Pattern 'job-progress'
#    → dsh-job-progress: mounted, progress root …\.dsh\job-progress

# 3) profile 里有没有这一行
dsh --profile <profile> --dump-config | Select-String 'job-progress'
```

然后在任意会话里起一个后台任务，把鼠标移到小球上。

## 常见问题

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 小球根本不出现 | 这个会话没有后台任务，也没有进度文件 | 起一个后台任务，或者写一个进度文件 |
| 改了界面像是没生效 | 前端插件在页面加载时才取 | 刷新页面（F5） |
| 改了 `lib/index.js` 像是没生效 | 宿主插件模块在进程内缓存 | 重启 profile |
| `清除失败：宿主未就绪` | 正在跑的宿主比 `clear` 接口还老 | 重启 profile |
| 有东西渲染成了方圆形 | 应用全局的 `corner-shape` | 见下面"给插件作者" |
| "这一行到底加载上没有？" | 查宿主日志 | `dsh-job-progress: mounted, progress root …` |
| 任务还没完就不见了 | 产出方超过 15 秒没写心跳（崩了或被杀了） | 让产出方保持心跳 |

<details>
<summary><b>设计说明——为什么要搞一套文件协议</b></summary>

这个设计是被 harness 的两个事实定下来的。两条都对着已发布的包验证过，不是猜的：

1. **作业登记表里没有进度。** `ctx.jobs` 只有 id、类型、名称、状态（`running → stopping → completed | killed | failed`）和时间戳，没有任何字段能让产出方填一个百分比进去。
2. **作业的产出读不得。** `ShellProcess.readOutput` 是**增量**的（连着读两次不会重复给你同样的内容），而 `ctx.jobs.read()` 会把已结束的作业标记为"已上报"。一个靠轮询作业输出来抠百分比的插件，会偷走模型马上要读的输出，还会吞掉它的完成通知。本插件从不调用 `read()`，只读**登记表快照**（纯投影）和自己的文件。

所以进度只能由干活的那边报，而任务的发现过程保持自动。

</details>

<details>
<summary><b>给插件作者——这个 GUI 里的圆</b></summary>

应用全局设了 **`corner-shape: superellipse(1.5)`**。在这个设置下，*任何* `border-radius`——包括 `50%`——都画成**方圆形**，而不是圆弧。所以 `border-radius: 50%` 的计算值不能证明它渲染出来是个圆。应用自己的样式表里，需要真圆的地方（转圈、圆点、开关滑块）都用 `corner-shape: round` 单独改了回去。要真圆就补上这行：

```css
border-radius: 50%;
corner-shape: round;   /* 不写就是方圆形——也可能正是你想要的 */
```

本插件是故意留着方圆形的：它和应用本身的设计语言一致。

</details>

<details>
<summary><b>开发</b></summary>

```bash
node test/preflight-client.mjs     # 不用装东西，不用开浏览器
```

前端插件跑在浏览器里，出错只会落到渲染进程的控制台，而那个控制台不写盘——所以"前端插件写坏了"和"插件压根没加载"看起来一模一样。preflight 用一个假的模块加载器把 `lib/client.js` 装进来，对着桩 React 跑一遍工厂函数、`apply`、插槽注册和一次渲染。它在这个插件开发过程中抓到过一次漏写 `module`/`exports` 声明，和一次渲染门槛的回归。

```
cordis.patch.yml            bundle 补丁：插入 `job-progress` 这一行
package.json                清单：bundle 补丁 + web 前端插件
lib/client.js               前端插件：小球、拖拽、面板、清除
lib/index.js                宿主插件：作业登记表快照 + 进度目录 + jobProgress/clear
lib/dsh-progress.mjs        产出方：协议、辅助函数、命令行
test/preflight-client.mjs   前端插件的 12 项检查
assets/                     本 README 用的 logo 和截图
```

宿主插件注册了一个 Typert Remote 服务（`jobProgress`），走标准的 `/api` 网关，接口是 `jobProgress/snapshot` 和 `jobProgress/clear`。给 `job-progress` 这一行加上 `debug: true`，快照返回里会带上找到了哪些登记表、匹配到多少条记录和作业。

</details>

## 卸载

```bash
dsh plugin --profile <profile> remove dsh-job-progress
```

产出方写在 `<DSH_HOME>/job-progress/` 下的进度文件不会跟着删——不需要了就自己清。插件从不删这个目录以外的任何东西。

## 后续计划

- [ ] 子代理名下的作业（现在一个会话只看得到自己 owner 的作业）
- [ ] 图标和大资源改走宿主路由，不再内联成 data URI
- [ ] 更丰富的阶段，让产出方能自己命名任意阶段
- [ ] 这份 README 的更多语言版本

## 参与贡献

欢迎提 [issue](https://github.com/Rice00/dsh-job-progress/issues) 和 PR。开 PR 之前：

```bash
node test/preflight-client.mjs     # 必须 ALL PASS
```

前端插件请保持零依赖（只用 React），改完记得跑一遍 preflight——它存在的理由就是前端的问题平时看不见。

## 许可证

本项目采用 [MIT](./LICENSE) 许可。

<div align="center">

MIT License © dsh-job-progress contributors

</div>
