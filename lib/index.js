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
  '让长任务（下载、编码、批处理）在 DSH 的任务面板里显示进度、速度与剩余时间：写一个 JSON 记录即可，不需要装任何东西。';

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
  '  - 好：下载 anima_5B 模型（6.6 GB） · 转码 4 个视频到 1080p · 安装 PyTorch CUDA 12.4',
  '  - 不要写整条命令行、不要写 URL、不要写一长串参数 —— 面板一行放不下，会被截断成一串',
  '    看不出在干什么的符号，用户还得自己猜。',
  '  - 下载类顺便带上体积或来源（「下载 anima_5B 模型 6.6 GB · HuggingFace」），一眼知道在等什么。',
  '  - 后台作业自己也会在面板上占一行，名字是它的命令行（工具写死的，改不了）。想让任务名取代',
  '    那一行：作业起来后先写一条带 --jobId <作业 id> 的记录，之后一律用同一个 --key 更新',
  '    （CLI 与 track({ resume: true }) 都会继承 jobId），面板上就只剩一行、名字是任务名。',
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
      const tasks = this.merge(entries, jobs, now);
      return {
        sessionId,
        now,
        tasks,
        debug: this.debug ? { ...this.diagnostics(), entries: entries.length, jobs: jobs.length } : undefined
      };
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

    /** Join progress entries with registry jobs, keyed by job id then label. */
    merge(entries, jobs, now) {
      const tasks = [];
      const byJobId = new Map();
      const byLabel = new Map();
      for (const entry of entries) {
        if (entry.jobId) byJobId.set(entry.jobId, entry);
        byLabel.set(entry.label, entry);
        tasks.push(entry);
      }
      for (const job of jobs) {
        const match = (job.id !== undefined ? byJobId.get(job.id) : undefined) ?? byLabel.get(job.label);
        if (match !== undefined) {
          // The registry is authoritative for status and timing; the producer owns
          // the numbers. A terminal job wins over a stale "running" file.
          match.jobId = job.id;
          match.kind = job.kind;
          if (job.status !== undefined && job.status !== 'running') match.status = job.status;
          if (job.finishedAt !== undefined) match.finishedAt = job.finishedAt;
          if (job.startedAt !== undefined && match.startedAt === undefined) match.startedAt = job.startedAt;
          if (job.detail !== undefined) match.note = match.note || job.detail;
          byJobId.set(job.id, match);
          continue;
        }
        tasks.push({
          key: job.id,
          label: job.label,
          kind: job.kind,
          status: job.status,
          phase: '',
          unit: 'count',
          done: 0,
          total: 0,
          speed: 0,
          eta: null,
          note: job.detail ?? '',
          jobId: job.id,
          startedAt: job.startedAt,
          updatedAt: job.finishedAt ?? job.startedAt ?? now,
          finishedAt: job.finishedAt,
          hasProgress: false
        });
      }
      tasks.sort((left, right) => {
        const live = (task) => (task.status === 'running' || task.status === 'lost' ? 0 : 1);
        if (live(left) !== live(right)) return live(left) - live(right);
        return (right.finishedAt ?? right.startedAt ?? 0) - (left.finishedAt ?? left.startedAt ?? 0);
      });
      return tasks;
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
