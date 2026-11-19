/**
 * dsh-job-progress — host half.
 *
 * Two questions, one answer each:
 *   1. "Which background jobs does this session have?"  → read the job registry
 *      (read-only snapshots; the plugin NEVER calls read(), because that stream
 *      is incremental and marks terminal jobs reported — polling it would steal
 *      the model's own `job_output` reads and swallow completion notices).
 *   2. "How far along are they?" → read the progress directory that producers
 *      write to (see ./dsh-progress.mjs for the file contract).
 *
 * The web GUI reaches this through the standard `/api` Remote gateway as
 * `jobProgress/snapshot`; nothing is generated ahead of time (SRC discovery).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import z from '@deepseek-ai/schemastery';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';

// ── decorator support (stage-3 decorators, transpiled — Node has none) ─────
var __esDecorate = function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
  function accept(f) {
    if (f !== void 0 && typeof f !== 'function') throw new TypeError('Function expected');
    return f;
  }
  var kind = contextIn.kind, key = kind === 'getter' ? 'get' : kind === 'setter' ? 'set' : 'value';
  var target = !descriptorIn && ctor ? (contextIn['static'] ? ctor : ctor.prototype) : null;
  var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
  var _, done = false;
  for (var i = decorators.length - 1; i >= 0; i--) {
    var context = {};
    for (var p in contextIn) context[p] = p === 'access' ? {} : contextIn[p];
    for (var p in contextIn.access) context.access[p] = contextIn[p];
    context.addInitializer = function (f) {
      if (done) throw new Error('Cannot add initializers after decoration has completed');
      extraInitializers.push(accept(f || null));
    };
    var result = (0, decorators[i])(kind === 'accessor' ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
    if (kind === 'accessor') {
      if (result === void 0) continue;
      if (result === null || typeof result !== 'object') throw new TypeError('Object expected');
      if ((_ = accept(result.get))) descriptor.get = _;
      if ((_ = accept(result.set))) descriptor.set = _;
      if ((_ = accept(result.init))) initializers.unshift(_);
    } else if ((_ = accept(result))) {
      if (kind === 'field') initializers.unshift(_);
      else descriptor[key] = _;
    }
  }
  if (target) Object.defineProperty(target, contextIn.name, descriptor);
  done = true;
};
var __runInitializers = function (thisArg, initializers, value) {
  var useValue = arguments.length > 2;
  for (var i = 0; i < initializers.length; i++) {
    value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
  }
  return useValue ? value : void 0;
};

/** A producer that stopped refreshing `updatedAt` for this long is gone. */
const STALE_MS = 20000;
/** A finished task stays on the panel this long before it ages out. */
const KEEP_MS = 120000;
/**
 * 面板上的每一行都要回答「在做什么 / 到哪了 / 还要多久」，所以注册表作业也要补上标题与数字：
 *   - 标题来自那次工具调用时模型自己写的那句话（pwsh/bash 的 description 参数，必填），
 *     它就在会话日志尾部 —— 只扫尾部，不翻全史；
 *   - 数字来自作业输出尾部（curl / aria2 / pip / ffmpeg 都会把百分比与速率打在那里），
 *     用 readAt 纯读，不推进模型的输出游标。
 * 两处都只在没查过的作业上花一次，然后缓存住。
 */
const EVENT_WINDOW = 800;
const OUTPUT_TAIL_BYTES = 8192;
/** 两次采样至少隔这么久，才用差值算速度（与 helper 的 0.4s 门槛同源）。 */
const SAMPLE_MIN_MS = 1200;
/** 大小单位 → 字节。只认这些写法，别的当没看见（宁可没有数字，也不要错数字）。 */
const SIZE_UNITS = {
  b: 1, k: 1e3, kb: 1e3, m: 1e6, mb: 1e6, g: 1e9, gb: 1e9, t: 1e12, tb: 1e12,
  kib: 1024, mib: 1048576, gib: 1073741824, tib: 1099511627776
};

/**
 * 命令行的可读摘要 —— 只在拿不到模型那句 description 时才用，而且**永不返回整条命令**：
 * 面板一行放不下、用户也读不懂。「node dl.mjs --url」这样够了，剩下的进悬停。
 *
 * @param command - 作业的原始命令行。
 * @returns 摘要（可能为空串，调用方会退到兜底文案）。
 */
function commandSummary(command, depth = 0) {
  if (typeof command !== 'string' || command.length === 0 || depth > 2) return '';
  const tokens = tokenizeCommand(command);
  if (tokens.length === 0) return '';
  const head = baseName(tokens[0]).toLowerCase();
  const HOSTS = new Set(['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'cmd', 'cmd.exe', 'bash', 'sh', 'wsl', 'wsl.exe']);
  if (HOSTS.has(head)) {
    // powershell -NoProfile -Command "…" / bash -lc "…"：真正在做什么在引号里那段。
    const inline = tokens.slice(1).find((token) => /[;&|]/.test(token) || token.length > 32);
    if (inline !== undefined && inline.length < command.length) return commandSummary(inline, depth + 1);
    return baseName(tokens[0]);
  }
  // 摘要只取「可执行名 + 第一个不是开关、也不是 URL 的参数」：再往后就是噪音，
  // 用户也从那一串里读不出更多东西（要细节就悬停看整条命令）。
  const parts = [baseName(tokens[0])];
  for (const token of tokens.slice(1)) {
    if (token.length === 0 || token[0] === '-' || token.includes('://')) continue;
    parts.push(baseName(token));
    break;
  }
  const text = parts.join(' ');
  return text.length > 48 ? `${text.slice(0, 47)}…` : text;
}

/** Split a command line into tokens, honouring single and double quotes. */
function tokenizeCommand(command) {
  const out = [];
  let current = '';
  let quote = '';
  for (let at = 0; at < command.length; at += 1) {
    const char = command[at];
    if (quote !== '') {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
      if (current.length > 0) { out.push(current); current = ''; }
      continue;
    }
    current += char;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** Last path segment of a token (`C:\a\b.mjs` → `b.mjs`). */
function baseName(token) {
  const cleaned = String(token ?? '').replace(/^["']|["']$/g, '');
  const cut = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return cut >= 0 ? cleaned.slice(cut + 1) : cleaned;
}

/** Last match of a /g regex in a string, or null. */
function lastMatch(text, pattern) {
  let found = null;
  let match = pattern.exec(text);
  while (match !== null) {
    found = match;
    match = pattern.exec(text);
  }
  pattern.lastIndex = 0;
  return found;
}

/**
 * 从作业输出的尾部数出进度。只认最后一条匹配 —— 滚上去的老数字没有意义。
 * 拿不准就返回 undefined：面板宁可退回「已运行时长」，也不要编一个数。
 *
 * @param text - 作业输出（调用方已截到尾部一段）。
 * @param previous - 上一次采样 `{ at, done }`，用来在输出没给速率时自己算。
 * @param now - 当前时间戳。
 * @returns `{ unit, done, total, speed, eta }` 或 undefined。
 */
function parseOutputNumbers(text, previous, now) {
  const tail = typeof text === 'string' ? text.slice(-OUTPUT_TAIL_BYTES) : '';
  if (tail.length === 0) return undefined;
  const out = { unit: 'bytes', done: undefined, total: undefined, speed: 0, eta: null };
  const pair = lastMatch(tail, /(\d+(?:[.,]\d+)?)\s*([KMGT]i?B)\s*\/\s*(\d+(?:[.,]\d+)?)\s*([KMGT]i?B)\b/gi);
  if (pair !== null) {
    out.done = Number(pair[1].replace(',', '.')) * (SIZE_UNITS[pair[2].toLowerCase()] ?? 1);
    out.total = Number(pair[3].replace(',', '.')) * (SIZE_UNITS[pair[4].toLowerCase()] ?? 1);
  } else {
    const counts = lastMatch(tail, /(\d+)\s*\/\s*(\d+)(?!\s*[KMGT]i?B)/g);
    if (counts !== null) {
      out.done = Number(counts[1]);
      out.total = Number(counts[2]);
      out.unit = 'count';
    }
  }
  const percent = lastMatch(tail, /(\d{1,3}(?:\.\d+)?)\s*%/g);
  if (percent !== null) out.percent = Number(percent[1]);
  const rate = lastMatch(tail, /(\d+(?:[.,]\d+)?)\s*([KMGT]i?B)\s*\/\s*s/gi);
  if (rate !== null) out.speed = Number(rate[1].replace(',', '.')) * (SIZE_UNITS[rate[2].toLowerCase()] ?? 1);
  const etaText = lastMatch(tail, /(\d+):(\d{2})(?![\d:])/g);
  if (etaText !== null) out.eta = Number(etaText[1]) * 60 + Number(etaText[2]);
  if (out.total === undefined && out.percent !== undefined) {
    out.done = out.percent;
    out.total = 100;
    out.unit = 'percent';
  }
  if (out.speed === 0 && out.done !== undefined && previous !== undefined && previous !== null) {
    const elapsed = (now - previous.at) / 1000;
    if (elapsed * 1000 >= SAMPLE_MIN_MS && Number.isFinite(previous.done) && out.done > previous.done) {
      out.speed = (out.done - previous.done) / elapsed;
    }
  }
  if (out.eta === null && out.speed > 0 && Number.isFinite(out.total) && out.total > (out.done ?? 0)) {
    out.eta = Math.round((out.total - out.done) / out.speed);
  }
  const hasAnything = out.done !== undefined || out.percent !== undefined || out.speed > 0;
  return hasAnything ? out : undefined;
}

/**
 * 技能正文：本机任何会话的 agent 只要翻技能目录就会看到它，从而知道「长任务要报进度」。
 * 这是本插件对"别的会话自动可用"的答案 —— 协议本身早就有（README 与 lib/dsh-progress.mjs），
 * 缺的是让会话自己发现它；2026-10-07 实测：另一个会话在跑 60 GiB 下载时压根不知道有这条路。
 * 正文里刻意不出现反引号（外面就是模板字面量），也不写死 Windows 路径。
 */
const SKILL_NAME = 'dsh-job-progress';

/**
 * 注册时必须给的出处标签。这不是可选项：注册表（@deepseek-ai/dsh-skill）只替运行时技能
 * 补 invocation 与 provider，**不补 source**；而加载时走的是 validateDefinition，里面有
 * `typeof source !== "string"` 直接抛错（dsh-skill/lib/index.js:486）。2026-10-08 实测：
 * 缺了它，技能目录里能看到条目，但 skill 工具一加载就报
 * `loaded skill "dsh-job-progress" source must be a string` —— 注册成功、加载失败。
 */
const SKILL_SOURCE = 'plugin';

const SKILL_DESCRIPTION =
  '让长任务（下载、编码、批处理）在 DSH 的任务面板里显示进度、速度与剩余时间：写一个 JSON 记录即可，不需要装任何东西。给 pwsh/bash 写的说明请用用户界面语言（中文界面写中文，English UI writes English）—— 面板直接把它当任务标题显示。';

const SKILL_WHEN_TO_USE =
  '在开始一个要跑几十秒以上的后台任务之前 —— 尤其是下载模型/大文件、转码、批量处理、长时间的命令行任务。';

const SKILL_CONTENT = [
  '# 长任务报进度（dsh-job-progress）',
  '',
  '## 什么时候用',
  '',
  '开跑一个要花几十秒以上的后台任务之前，先给它接上进度上报。这样用户右上角那',
  '「任务球 + 面板」里能看到百分比、速度与剩余时间，而不是只有一行命令行。',
  '',
  '## 下载任务：必须开「带 ETA 的上报」',
  '',
  '下载是最常见的长任务，也最容易被写成「一条命令行丢进后台」—— 那样面板上只有一条命令，',
  '没有百分比、没有速度、没有剩余时间。下载一律这样上报（用模块接口，边写盘边报数）：',
  '',
  '    import { track } from "<插件目录>/lib/dsh-progress.mjs";',
  '    const t = track({ label: "下载 anima_5B 模型（6.6 GB）", total: contentLength, phase: "download" });',
  '    // 每写一块文件就调一次：',
  '    t.update(bytesWritten);      // 速度（B/s）与 ETA（秒）由它按两次调用的间隔算出来',
  '    t.phase("verify");           // 校验/合并等阶段有内置文案',
  '    t.finish("done");            // 失败用 t.finish("failed", "sha256 mismatch")',
  '',
  '  - **要 ETA 就得在同一个进程里连续调 update()** —— CLI 每次调用都是新进程，算不出速度。',
  '  - 只用 CLI 也行，但速度得你自己给：set --key x --total 100 --done 40 --speed 10',
  '    （给了 --speed 就会顺带算出 ETA）。',
  '  - 拿不到 Content-Length（total 未知）就留 0：面板显示「进行中，大小未知」，不要编一个数。',
  '  - 外部下载器（aria2 / curl / huggingface-cli）：让包装脚本读它自己的进度输出，再喂给 update()。',
  '',
  '## 标题写什么',
  '',
  'label 就是面板上的任务名，写「在做什么」：',
  '',
  '  - **用用户界面的语言写**：中文界面写中文，英文界面写英文 —— 跟着用户走，别因为是工具参数就',
  '    一律写英文（工具自带的示例是英文，很容易被带偏）。面板标题直接取这句话，语言对不上用户会',
  '    觉得没做完。',
  '  - 好：下载 anima_5B 模型（6.6 GB） · 转码 4 个视频到 1080p · 安装 PyTorch CUDA 12.4',
  '  - 不要写整条命令行、不要写 URL、不要写一长串参数 —— 面板一行放不下，会被截断成一串',
  '    看不出在干什么的符号，用户还得自己猜。',
  '  - 下载类顺便带上体积或来源（「下载 anima_5B 模型 6.6 GB · HuggingFace」），一眼知道在等什么。',
  '  - 你给 pwsh/bash 写的那句 description（工具卡上「这个命令在做什么」）会**直接成为面板标题**；',
  '    面板拿不到它时才会退回命令行的可读摘要（脚本名那种）。',
  '  - 后台作业自己也会在面板上占一行（标题同样取你写的那句 description）。若你**另写了进度记录**，',
  '    面板上就是两行 —— 想让记录取代作业那一行：作业起来后写一条带 --jobId <作业 id> 的记录，之后',
  '    一律用同一个 --key 更新（CLI 与 track({ resume: true }) 都会继承 jobId），只剩一行、名字取记录里的。',
  '',
  '## 最短路径',
  '',
  '不需要 import，也不需要装包 —— 插件自带 CLI（下面用 <插件目录> 表示本插件的绝对路径）：',
  '',
  '    node "<插件目录>/lib/dsh-progress.mjs" set --key anima_5B --label "下载 anima_5B 模型" --total 66000000 --done 0',
  '    node "<插件目录>/lib/dsh-progress.mjs" set --key anima_5B --done 12500000 --speed 12000000',
  '    node "<插件目录>/lib/dsh-progress.mjs" done --key anima_5B',
  '',
  '或者在长驻进程里用模块接口（速度与 ETA 由它自己算，见上一节）：',
  '',
  '    const t = track({ label: "下载 anima_5B 模型", total: 66000000 });',
  '    t.update(bytesSoFar);        // 速度与 ETA 由它自己算',
  '    t.phase("verifying");        // 合并/校验等阶段会有内置文案',
  '    t.finish("done");            // 或 t.finish("failed", "sha256 mismatch")',
  '',
  '## 记录长什么样',
  '',
  '一个任务一个 JSON 文件，写在下面这个目录（两个环境变量在 agent 的每个 shell 里都已经有，',
  '不用问用户）：',
  '',
  '    <DSH_HOME>/job-progress/<DSH_SESSION_ID>/<key>.json',
  '',
  '  - label      面板上显示的名字；也是与后台作业配对的依据',
  '  - done/total 已完成与总量；total 为 0 时显示成「进行中，大小未知」',
  '  - unit       bytes（默认）或 count',
  '  - speed/eta  可选；没有就不编造',
  '  - phase      自由文本；merging / verifying 有内置文案',
  '  - status     running | done | failed',
  '  - jobId      可选；把记录钉到某个后台作业上（比按 label 配对可靠）',
  '  - updatedAt  ms 心跳时间戳',
  '',
  '## 三条硬规则',
  '',
  '1. **心跳**：status 为 running 时，updatedAt 至少要每 15 秒刷一次。停止刷新的记录会被',
  '   当成「已失联」—— 因为卡死的生产者和崩溃的生产者长得一样。done / failed 的条目会在',
  '   面板上多留两分钟。',
  '2. **原子写**：先写 <file>.tmp 再改名覆盖，读者不应该看到半截记录。',
  '3. **算得出就算**：速度与 ETA 能算就别省 —— 用户看的就是这两个数。',
  '',
  '## 别这么做',
  '',
  '  - 不要把进度只打到 stdout 就以为面板会看到：面板不解析命令输出（进度行是任务生产者',
  '    通过 JobHandle.updateProgress 发布的，pwsh/bash 类任务不会发布它）。',
  '  - 不要把命令行或 URL 当任务名（面板会截断成看不懂的一串），也不要把下载写成「一条命令行',
  '    作业」了事 —— 没有百分比/速度/ETA 的上报等于没上报（见「下载任务」一节）。',
  '  - 不要再起一个「监视器 job」在旁边报数：那只会多一个任务，数字还可能对不上。',
  '  - 不要往别人的会话目录里写：只用自己 shell 里的 DSH_SESSION_ID。',
  '  - 找不准路径时先问它：node "<插件目录>/lib/dsh-progress.mjs" dir',
  '',
  '## 收尾',
  '',
  '任务结束时调 done（或 failed 带 note）。没写终态的记录会一直等到心跳停止才被判失联，',
  '面板上会多挂一条「已失联」，用户会以为任务还在跑。',
].join('\n');

/**
 * 技能定义 —— 注册与测试共用同一份，避免测试里的手工副本跟实现漂移。
 * `helper` 为空串时省略正文末尾的「本机插件目录」一段（helper 解析失败也能注册）。
 *
 * @param helper - 本插件 lib/dsh-progress.mjs 的绝对路径。
 * @returns 交给 ctx.skills.register 的定义（source 必给，理由见 SKILL_SOURCE 上方）。
 */
function skillDefinition(helper = '') {
  const content = helper.length > 0 ? [SKILL_CONTENT, '（本机插件目录：' + helper + '）'].join('\n\n') : SKILL_CONTENT;
  return {
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    whenToUse: SKILL_WHEN_TO_USE,
    content,
    source: SKILL_SOURCE,
    metadata: { plugin: 'dsh-job-progress', ...(helper.length > 0 ? { helper } : {}) }
  };
}

/** 本插件 lib/dsh-progress.mjs 的绝对路径，用于在技能正文里给出可直接复制的命令。 */
function producerHelperPath() {
  try {
    return fileURLToPath(new URL('./dsh-progress.mjs', import.meta.url));
  } catch {
    return '';
  }
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

let JobProgressService = (() => {
  let _classSuper = TypertRemoteService;
  let _instanceExtraInitializers = [];
  let _snapshot_decorators;
  let _clear_decorators;
  return class JobProgressService extends _classSuper {
    static {
      const _metadata = typeof Symbol === 'function' && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
      _snapshot_decorators = [Remote('snapshot')];
      _clear_decorators = [Remote('clear')];
      __esDecorate(this, null, _clear_decorators, {
        kind: 'method',
        name: 'clear',
        static: false,
        private: false,
        access: { has: (obj) => 'clear' in obj, get: (obj) => obj.clear },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      __esDecorate(this, null, _snapshot_decorators, {
        kind: 'method',
        name: 'snapshot',
        static: false,
        private: false,
        access: { has: (obj) => 'snapshot' in obj, get: (obj) => obj.snapshot },
        metadata: _metadata
      }, null, _instanceExtraInitializers);
      if (_metadata) Object.defineProperty(this, Symbol.metadata, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: _metadata
      });
    }

    /** Required service: live sessions (the job registry is reached optionally). */
    static inject = ['sessions'];

    /** Optional: `dir` overrides the progress root, `debug` adds diagnostics. */
    static Config = z.object({
      dir: z.string().default(''),
      debug: z.boolean().default(false)
    });

    root;
    debug;
    /** 本插件 `lib/dsh-progress.mjs` 的绝对路径（空串表示解析失败，只影响技能正文里的示例）。 */
    helper;
    /** jobId → 人话标题（那次工具调用时模型写的 description）；空串表示查过但没找到。 */
    jobTitles = new Map();
    /** jobId → 上一次从作业输出采到的 `{ at, done }`，用来估算速度与剩余时间。 */
    jobSamples = new Map();
    /** jobId → 进度记录的 key：自动认领过的组合，作业跑完、记录写完终态后仍然合成一行。 */
    pairCache = new Map();

    constructor(ctx, config = {}) {
      super(ctx, 'jobProgress');
      __runInitializers(this, _instanceExtraInitializers);
      this.root = config.dir && config.dir.length > 0 ? config.dir : dshHomePath('job-progress');
      this.debug = config.debug === true;
      this.helper = producerHelperPath();
      ctx.logger?.info?.('dsh-job-progress: mounted, progress root ' + this.root);
      this.registerSkill(ctx);
    }

    /**
     * 把进度协议注册成一个**会话可见的技能**：本机（以及装配了本插件的任何机器）的 agent
     * 只要翻技能目录就知道长任务要报进度 —— 这是"别的会话能不能自动用"的答案。
     * 技能目录是每个 agent 都会看到的地方，不需要用户记着把它贴进提示词。
     * `skills` 服务不是本插件的必需依赖：拿不到就安静跳过（插件其余功能照旧）。
     */
    registerSkill(ctx) {
      let skills;
      try {
        skills = ctx.get('skills');
      } catch {
        skills = undefined;
      }
      if (skills === undefined || typeof skills.register !== 'function') {
        ctx.logger?.debug?.('dsh-job-progress: skills service unavailable — progress protocol not registered as a skill');
        return;
      }
      // 自己解析 helper 路径：注册这件事不该依赖构造器先跑过。
      if (typeof this.helper !== 'string' || this.helper.length === 0) this.helper = producerHelperPath();
      try {
        skills.register(skillDefinition(this.helper));
        ctx.logger?.info?.('dsh-job-progress: registered skill ' + SKILL_NAME);
      } catch (error) {
        // 技能是增益项，不能因为注册失败就把整个插件拖下来。
        ctx.logger?.warn?.('dsh-job-progress: registering skill ' + SKILL_NAME + ' failed: ' + String(error));
      }
    }

    /** `/api` endpoint `jobProgress/snapshot` → this session's tasks. */
    async snapshot(request) {
      const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : '';
      const now = Date.now();
      if (sessionId.length === 0) return { sessionId: null, now, tasks: [], debug: this.diagnostics() };
      const entries = this.readEntries(sessionId, now);
      const jobs = this.readJobs(sessionId);
      this.describeJobs(sessionId, jobs);
      const tasks = this.merge(entries, jobs, now, sessionId);
      return {
        sessionId,
        now,
        tasks,
        debug: this.debug ? { ...this.diagnostics(), entries: entries.length, jobs: jobs.length } : undefined
      };
    }

    /**
     * 给注册表作业配一个人话标题：面板要回答「在做什么」，而**那次工具调用时模型自己写的那句话**
     * （pwsh/bash 的 description，参数必填）就是现成答案 —— 比解析命令行可靠得多。
     * 只对没查过的作业去读一次会话日志尾部，结果缓存住（作业的标题不会变）。
     */
    describeJobs(sessionId, jobs) {
      const unresolved = jobs.filter((job) => typeof job?.id === 'string' && !this.jobTitles.has(job.id));
      if (unresolved.length === 0) {
        this.pruneHints(jobs);
        return;
      }
      const calls = this.readToolCalls(sessionId);
      for (const job of unresolved) {
        let title = '';
        for (const call of calls) {
          if (call.command === job.label && call.description.length > 0) title = call.description;
        }
        this.jobTitles.set(job.id, title);
      }
      this.pruneHints(jobs);
    }

    /**
     * 会话日志尾部里 pwsh/bash 的工具调用。读不到（服务缺失、接口变更、日志超窗）就返回空数组，
     * 调用方会退到命令行摘要 —— 这里从不抛。
     */
    readToolCalls(sessionId) {
      let session;
      try {
        const sessions = this.ctx.get('sessions');
        session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined;
      } catch {
        session = undefined;
      }
      if (session === undefined || session === null || typeof session.snapshotEvents !== 'function') return [];
      let events;
      try {
        const end = finiteNumber(session.seq) ?? 0;
        events = session.snapshotEvents(Math.max(0, end - EVENT_WINDOW), end);
      } catch {
        return [];
      }
      if (!Array.isArray(events)) return [];
      const out = [];
      for (const event of events) {
        if (event === null || typeof event !== 'object' || event.type !== 'tool/call') continue;
        const data = event.data;
        if (data === null || typeof data !== 'object') continue;
        if (data.name !== 'pwsh' && data.name !== 'bash') continue;
        if (typeof data.arguments !== 'string') continue;
        let args;
        try {
          args = JSON.parse(data.arguments);
        } catch {
          continue;
        }
        if (args === null || typeof args !== 'object' || typeof args.command !== 'string') continue;
        out.push({
          command: args.command,
          description: typeof args.description === 'string' ? args.description.trim() : ''
        });
      }
      return out;
    }

    /**
     * 这一行显示什么标题：模型写的那句话 → 命令行的可读摘要 → 空串。
     * 原始命令行**永远不当标题**（它只在悬停里备查）；返回空串时由客户端用**界面语言**
     * 拼一句兜底 —— 宿主这边不知道用户界面是中文还是英文。
     */
    titleFor(job) {
      const described = this.jobTitles.get(job.id);
      if (typeof described === 'string' && described.length > 0) return described;
      return commandSummary(job.label);
    }

    /**
     * 从作业输出尾部读进度数字。`readAt` 是纯读：不像 `read()` 那样推进模型的输出游标，
     * 所以面板可以放心地看作业输出。读不到数字返回 undefined（面板退回显示已运行时长）。
     */
    readJobNumbers(job, caller, now) {
      const registry = this.ctx.get('jobs');
      if (registry === undefined || typeof registry.readAt !== 'function') return undefined;
      if (typeof job?.id !== 'string' || caller.length === 0) return undefined;
      const total = finiteNumber(job.output?.total) ?? 0;
      const earliest = finiteNumber(job.output?.earliest) ?? 0;
      const from = Math.max(0, earliest, total - OUTPUT_TAIL_BYTES);
      let slice;
      try {
        slice = registry.readAt(job.id, from, caller);
      } catch {
        return undefined;
      }
      const chunks = Array.isArray(slice?.chunks) ? slice.chunks : [];
      let text = '';
      for (const chunk of chunks) if (typeof chunk?.text === 'string') text += chunk.text;
      if (text.length === 0) return undefined;
      const numbers = parseOutputNumbers(text, this.jobSamples.get(job.id), now);
      if (numbers === undefined) return undefined;
      if (numbers.done !== undefined) this.jobSamples.set(job.id, { at: now, done: numbers.done });
      return numbers;
    }

    /** 缓存不跟着会话列表无限长大：超过上限时把已经不在列表里的作业清掉。 */
    pruneHints(jobs) {
      if (this.jobTitles.size <= 256 && this.jobSamples.size <= 256) return;
      const live = new Set(jobs.map((job) => job?.id));
      for (const map of [this.jobTitles, this.jobSamples]) {
        if (map.size <= 256) continue;
        for (const id of [...map.keys()]) if (!live.has(id)) map.delete(id);
      }
    }

    /**
     * Progress files for one session, newest first. Reading these is free: the
     * files belong to this plugin and no other reader drains them.
     */
    readEntries(sessionId, now) {
      const dir = path.join(this.root, sessionId);
      const out = [];
      for (const dirent of readDir(dir)) {
        if (!dirent.isFile() || !dirent.name.endsWith('.json')) continue;
        let record;
        try {
          record = JSON.parse(fs.readFileSync(path.join(dir, dirent.name), 'utf8'));
        } catch {
          continue;
        }
        if (record === null || typeof record !== 'object') continue;
        const status = typeof record.status === 'string' ? record.status : 'running';
        const updatedAt = finiteNumber(record.updatedAt) ?? finiteNumber(record.startedAt) ?? 0;
        const finishedAt = finiteNumber(record.finishedAt);
        const stale = now - updatedAt > STALE_MS;
        // A live entry whose heartbeat stopped is gone; a finished one is kept
        // for a while so the panel can show how it ended.
        if (status === 'running') {
          if (stale) continue;
        } else if (now - (finishedAt ?? updatedAt) > KEEP_MS) {
          continue;
        }
        out.push({
          key: typeof record.key === 'string' && record.key.length > 0 ? record.key : dirent.name.replace(/\.json$/, ''),
          label: typeof record.label === 'string' && record.label.length > 0 ? record.label : dirent.name,
          status: stale && status === 'running' ? 'lost' : status,
          phase: typeof record.phase === 'string' ? record.phase : '',
          unit: record.unit === 'count' ? 'count' : 'bytes',
          done: finiteNumber(record.done) ?? 0,
          total: finiteNumber(record.total) ?? 0,
          speed: finiteNumber(record.speed) ?? 0,
          eta: finiteNumber(record.eta) ?? null,
          note: typeof record.note === 'string' ? record.note : '',
          jobId: typeof record.jobId === 'string' ? record.jobId : undefined,
          startedAt: finiteNumber(record.startedAt),
          updatedAt,
          finishedAt,
          hasProgress: true
        });
      }
      return out;
    }

    /**
     * Registry snapshots for the session's own owner. `list()` is a pure
     * projection; unlike `read()` it neither drains output nor marks a terminal
     * job reported, so a panel can watch jobs without stealing them from the
     * agent that started them.
     */
    readJobs(sessionId) {
      const registry = this.ctx.get('jobs');
      if (registry === undefined || typeof registry.list !== 'function') return [];
      const owners = [];
      for (const name of ['agents', 'sessions']) {
        let service;
        try {
          service = this.ctx.get(name);
        } catch {
          service = undefined;
        }
        if (service !== undefined && typeof service.list === 'function') {
          try {
            owners.push(...service.list());
          } catch {
            /* a registry that refuses to enumerate is simply not a source */
          }
        }
      }
      const seen = new Set();
      const seenJobs = new Set();
      const out = [];
      for (const owner of owners) {
        if (owner === null || typeof owner !== 'object' || typeof owner.id !== 'string') continue;
        if (owner.id !== sessionId) continue;
        if (seen.has(owner)) continue;
        seen.add(owner);
        try {
          // 注册表的签名是 list(caller?: SessionId)：内部按 job.owner.id === caller 比较。
          // 传 owner 对象永远比不中（字符串 !== 对象），带 owner 的作业会被整批滤掉 —— 2026-10-04
          // 实测：本会话起了 pwsh-36，/api/job/kill 认它属于本会话，而面板一条都拿不到。
          // 官方控制器传的就是字符串：registry.list(request.sessionId)。
          for (const snapshot of registry.list(owner.id)) {
            if (snapshot === null || typeof snapshot !== 'object') continue;
            // 同一个作业会从 agents 与 sessions 两个注册表各返回一次（id 相同、对象不同）。
            // 不按作业 id 去重，面板会把一条作业列两遍、角标计数也会多算（2026-09-20 实测）。
            if (typeof snapshot.id === 'string') {
              if (seenJobs.has(snapshot.id)) continue;
              seenJobs.add(snapshot.id);
            }
            out.push(snapshot);
          }
        } catch {
          /* access is owner-relative; a refusal means "not this owner's job" */
        }
      }
      return out;
    }

    /**
     * 删除本会话**已结束**的进度文件（正在跑的绝不动）。
     * 注册表里的终态作业删不掉（只读投影），前端会自行把它们记入忽略名单。
     */
    async clear(request) {
      const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : '';
      if (!this.isSafeSessionId(sessionId)) return { removed: 0, reason: 'invalid-session' };
      const dir = path.join(this.root, sessionId);
      let removed = 0;
      for (const dirent of readDir(dir)) {
        if (!dirent.isFile() || !dirent.name.endsWith('.json')) continue;
        const file = path.join(dir, dirent.name);
        let status = 'running';
        try {
          const record = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (typeof record?.status === 'string') status = record.status;
        } catch {
          continue;                       // 读不出来就当它不属于我们，不删
        }
        if (status === 'running') continue;
        try {
          fs.rmSync(file, { force: true });
          removed += 1;
        } catch {
          /* 删不掉就留着，下次清除再试 */
        }
      }
      return { removed };
    }

    /**
     * 会话 id 既是目录名又是网络入参，所以设两道闸：不含路径分隔符与 ..，
     * 且必须是当前真实存在的会话 —— 不给路径穿越留缝。
     */
    isSafeSessionId(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
      if (sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('..')) return false;
      let list = [];
      try {
        const sessions = this.ctx.get('sessions');
        if (typeof sessions?.list === 'function') list = sessions.list();
      } catch {
        list = [];
      }
      return list.some((session) => session?.id === sessionId);
    }

    /**
     * Join progress entries with registry jobs. Every row that comes out has to answer
     * 「在做什么 / 到哪了 / 还要多久」：记录的行用生产者写的任务名与数字；注册表作业的行用
     * 模型写的 description 当标题，数字从作业输出里读（读不到就只显示已运行时长）——
     * 原始命令行只进 `command`，留给悬停。
     *
     * 合并的三种依据，从硬到软：
     *   ① 记录自己写了 jobId，或者名称与作业全等；
     *   ② 这个组合是我们**上一轮认领过**的（缓存住，作业跑完、记录也写完终态后仍然是一行）；
     *   ③ 「唯一活作业」自动认领：只有一个还在跑的作业 + 只有一条未配对的活记录时认定同一件事。
     */
    merge(entries, jobs, now, sessionId = '') {
      const tasks = [];
      const byJobId = new Map();
      const byLabel = new Map();
      const byKey = new Map();
      for (const entry of entries) {
        if (entry.jobId) byJobId.set(entry.jobId, entry);
        byLabel.set(entry.label, entry);
        byKey.set(entry.key, entry);
      }
      const matched = new Set();
      const remaining = [];
      for (const job of jobs) {
        const cached = this.pairCache.get(job.id);
        const match = (job.id !== undefined ? byJobId.get(job.id) : undefined)
          ?? byLabel.get(job.label)
          ?? (typeof cached === 'string' ? byKey.get(cached) : undefined);
        if (match === undefined) {
          remaining.push(job);
          continue;
        }
        // The registry is authoritative for status and timing; the producer owns
        // the numbers. A terminal job wins over a stale "running" file.
        matched.add(match);
        this.applyJobFacts(match, job, sessionId, now);
        byJobId.set(job.id, match);
      }
      const claim = this.claimPair(entries, matched, remaining);
      if (claim !== undefined) {
        this.pairCache.set(claim.job.id, claim.entry.key);
        matched.add(claim.entry);
        this.applyJobFacts(claim.entry, claim.job, sessionId, now);
      }
      for (const entry of entries) tasks.push(entry);
      for (const job of remaining) {
        if (claim !== undefined && claim.job.id === job.id) continue;   // 已被记录认领，不再单独出一行
        const numbers = this.readJobNumbers(job, sessionId, now);
        tasks.push({
          key: job.id,
          label: this.titleFor(job),
          command: typeof job.label === 'string' ? job.label : '',
          kind: job.kind,
          status: job.status,
          phase: '',
          unit: numbers?.unit ?? 'count',
          done: numbers?.done ?? 0,
          total: numbers?.total ?? 0,
          speed: numbers?.speed ?? 0,
          eta: numbers?.eta ?? null,
          note: job.detail ?? '',
          jobId: job.id,
          startedAt: job.startedAt,
          updatedAt: now,
          finishedAt: job.finishedAt,
          hasProgress: numbers !== undefined,
          derived: numbers !== undefined
        });
      }
      this.prunePairs(jobs, byKey);
      tasks.sort((left, right) => {
        const live = (task) => (task.status === 'running' || task.status === 'lost' ? 0 : 1);
        if (live(left) !== live(right)) return live(left) - live(right);
        return (right.finishedAt ?? right.startedAt ?? 0) - (left.finishedAt ?? left.startedAt ?? 0);
      });
      return tasks;
    }

    /** 记录的身世 + 作业的状态与时间：命中配对的那一行以注册表为准、以生产者的数字为准。 */
    applyJobFacts(entry, job, sessionId, now) {
      entry.jobId = job.id;
      entry.kind = job.kind;
      entry.command = typeof job.label === 'string' ? job.label : entry.command;
      if (job.status !== undefined && job.status !== 'running') entry.status = job.status;
      if (job.finishedAt !== undefined) entry.finishedAt = job.finishedAt;
      if (job.startedAt !== undefined && entry.startedAt === undefined) entry.startedAt = job.startedAt;
      if (job.detail !== undefined) entry.note = entry.note || job.detail;
      if (!(Number(entry.total) > 0)) {
        // 生产者没给总量时，作业输出里若有数字就补上（面板上至少有个百分比）。
        const numbers = this.readJobNumbers(job, sessionId, now);
        if (numbers !== undefined) {
          entry.unit = numbers.unit;
          entry.done = numbers.done ?? entry.done;
          entry.total = numbers.total ?? entry.total;
          entry.speed = numbers.speed > 0 ? numbers.speed : entry.speed;
          entry.eta = numbers.eta ?? entry.eta;
          entry.hasProgress = true;
          entry.derived = true;
        }
      }
      return entry;
    }

    /**
     * 「唯一活作业」自动认领：本会话恰好只有一个**还在跑**的作业、恰好只有一条未配对且**还在刷
     * 心跳**的记录（它自己也没写 jobId）时，认定两者是同一件事。
     * 任何一条不满足就返回 undefined —— 这条规则只在没有歧义时生效，绝不猜。
     */
    claimPair(entries, matched, remainingJobs) {
      const liveJobs = remainingJobs.filter((job) => job.status === 'running');
      if (liveJobs.length !== 1) return undefined;
      const free = entries.filter((entry) => !matched.has(entry) && entry.jobId === undefined && entry.status === 'running');
      if (free.length !== 1) return undefined;
      return { job: liveJobs[0], entry: free[0] };
    }

    /**
     * 认领过的组合：只有「作业还在注册表里、记录还在目录里」才继续认。
     * 作业 id 会跨进程复用（pwsh-1 这类），过期的缓存会把新记录认到旧作业上，所以必须清。
     */
    prunePairs(jobs, byKey) {
      if (this.pairCache.size === 0) return;
      const liveJobs = new Set(jobs.map((job) => job?.id));
      for (const [jobId, key] of [...this.pairCache]) {
        if (!liveJobs.has(jobId) || !byKey.has(key)) this.pairCache.delete(jobId);
      }
      while (this.pairCache.size > 256) this.pairCache.delete(this.pairCache.keys().next().value);
    }

    /** Names of the registries this plugin actually found (diagnostics only). */
    diagnostics() {
      const present = {};
      for (const name of ['jobs', 'agents', 'sessions']) {
        try {
          const service = this.ctx.get(name);
          present[name] = service === undefined ? 'missing' : typeof service.list === 'function' ? 'listable' : 'present';
        } catch {
          present[name] = 'error';
        }
      }
      return { root: this.root, registries: present };
    }
  };
})();

export { JobProgressService, JobProgressService as default, skillDefinition };
