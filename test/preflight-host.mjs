// test/preflight-host.mjs — 宿主半边：注册表作业的取用契约 + 「每行都要回答三问」
//
// 两段历史都钉在这里：
//   ① 2026-10-04：把 owner **对象**交给 `ctx.jobs.list(caller)`，而注册表的签名是
//      `list(caller?: SessionId)`，内部按 `job.owner.id === caller` 比较 —— 对象永远不等于
//      字符串，带 owner 的作业被整批滤掉（面板上只有自己写进度文件的任务）。
//   ② 2026-10-13：作业行的标题就是它的命令行（工具写死 `label: args.command`），面板上于是
//      出现「一串命令 + 没有数字」的行，用户看不出在做什么、到哪了、还要多久。现在作业行必须补齐：
//      标题 = 那次工具调用时模型写的 description（会话日志尾部就能读到），
//      数字 = 作业输出尾部的进度（curl / aria2 / pip 都会打印），读不到就只显示已运行时长；
//      原始命令行只进 `command` 字段（客户端拿它做悬停），**任何情况下都不再当标题**。
//
// 用法：node test/preflight-host.mjs
//
// 前置：lib/index.js 的三个 peer 依赖在仓库里没有 node_modules（包用 link:
// 装进 profile 时由宿主侧的解析提供）。要在 Node 里跑这个脚本，先把它们连同
// 传递依赖拷进本包的 node_modules（已被 .gitignore 排除，不进仓库、不需要提交）：
//
//   $app = '<DSH 安装目录>\resources\app\node_modules'
//   $dst = '<本仓库>\node_modules\@deepseek-ai'
//   mkdir $dst
//   foreach ($p in 'cordis','cosmokit','dsh-brand','dsh-home-paths','dsh-typert-protocol','schemastery') {
//     Copy-Item -Recurse -Force "$app\@deepseek-ai\$p" $dst
//   }
//
// 缺依赖时本脚本报「宿主半边可被导入」失败并退出码 1（不是静默跳过）。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const hostPath = path.join(here, '..', 'lib', 'index.js');

const passed = [];
const failed = [];
const check = (name, fn) => {
  try {
    fn();
    passed.push(name);
  } catch (error) {
    failed.push(`${name} — ${error?.message ?? error}`);
  }
};

let JobProgressService = null;
let importError = null;
try {
  ({ JobProgressService } = await import(pathToFileURL(hostPath).href));
} catch (error) {
  importError = error;
}
check('宿主半边可被导入（peer 依赖解析得到）', () => { if (importError) throw importError; });
if (importError) {
  for (const name of passed) console.log(`ok   ${name}`);
  console.error('');
  for (const line of failed) console.error(`FAIL ${line}`);
  console.error(`\n${failed.length} 项不通过（导入失败，后续检查跳过）`);
  process.exit(1);
}

// ── 桩：官方 dsh-jobs-local 的 list / readAt 语义 ────────────────────────
const COMMAND_DL = 'C:\\Program Files\\nodejs\\node.exe "C:\\dl\\chunk-dl.mjs" --url https://example.com/big.bin --out big.bin';
const COMMAND_HOST = 'powershell -NoProfile -Command "node C:\\dl\\other.mjs --url http://x"';
const makeJob = (id, ownerId, label, extra = {}) => ({
  id,
  kind: 'pwsh',
  label,
  status: 'running',
  owner: { id: ownerId },
  startedAt: 1,
  output: { total: 0, earliest: 0 },
  ...extra
});
const jobOfThisSession = makeJob('pwsh-1', 'session-a', COMMAND_DL);
const jobOfOtherSession = makeJob('pwsh-2', 'session-b', 'other');
const jobNoDescription = makeJob('pwsh-3', 'session-a', COMMAND_HOST);
const jobWithOutput = makeJob('pwsh-4', 'session-a', 'curl.exe -L https://example.com/f.bin -o f.bin');
const jobNothing = makeJob('pwsh-5', 'session-a', '');
const allJobs = [jobOfThisSession, jobOfOtherSession, jobNoDescription, jobWithOutput, jobNothing];
const slices = new Map();
const registry = {
  calls: [],
  reads: [],
  list(caller) {
    this.calls.push(caller);
    return allJobs.filter((job) => job.owner === undefined || job.owner.id === caller);
  },
  readAt(id, from, caller) {
    this.reads.push({ id, from, caller });
    return slices.get(id) ?? { chunks: [], next: 0, lossy: false };
  }
};
const sliceOf = (text) => ({ chunks: [{ at: 0, text }], next: text.length, lossy: false });

// ── 桩：会话日志（tool/call 事件里带着模型为这次调用写的那句话）──────────
const events = [
  { seq: 0, type: 'turn/start', data: { turn: 1 } },
  {
    seq: 1,
    type: 'tool/call',
    data: {
      callId: 'c1',
      name: 'pwsh',
      arguments: JSON.stringify({ command: COMMAND_DL, description: '下载 anima_5B 模型（6.6 GB）', run_in_background: true })
    }
  },
  {
    seq: 2,
    type: 'tool/call',
    data: { callId: 'c2', name: 'pwsh', arguments: JSON.stringify({ command: COMMAND_HOST, description: '' }) }
  }
];
const sessionA = {
  id: 'session-a',
  seq: events.length,
  snapshotEvents(from = 0, to = events.length) { return events.slice(from, to); }
};

// ── 桩 ctx：只要 get('jobs'|'agents'|'sessions') ────────────────────────
const ownerA = { id: 'session-a' };
const ctx = {
  logger: { info: () => {}, warn: () => {}, debug: () => {} },
  get(name) {
    if (name === 'jobs') return registry;
    if (name === 'agents') return { list: () => [ownerA] };
    if (name === 'sessions') return { list: () => [ownerA, { id: 'session-b' }], get: (id) => (id === 'session-a' ? sessionA : undefined) };
    return undefined;
  }
};
// 不走构造器：`TypertRemoteService` / cordis `Service` 的构造需要真正的 cordis 运行时
// （`ctx.reflect.provide`），Node 里搭不出来。这里直接拿 lib/index.js 里的**真原型方法**
// 调，只喂它自己会用到的那几个 ctx 口子 —— 被验的仍然是随包发布的那几个方法，不是复制品。
const service = Object.create(JobProgressService.prototype);
service.ctx = ctx;
service.root = path.join(here, '..', 'tmp-progress-root');
service.debug = false;
service.helper = '';
service.jobTitles = new Map();
service.jobSamples = new Map();
service.pairCache = new Map();

const snapshot = (now) => {
  const jobs = service.readJobs('session-a');
  service.describeJobs('session-a', jobs);
  return service.merge([], jobs, now, 'session-a');
};
const taskOf = (tasks, id) => tasks.find((task) => task.jobId === id);

// ── ① 注册表语义（2026-10-04 的老契约，别回归）──────────────────────────
check('注册表按字符串调用才返回作业（这是官方语义）', () => {
  if (registry.list('session-a').length !== 4) throw new Error('桩本身有问题：字符串调用应返回 4 条');
});
check('传 owner 对象给注册表拿不到任何作业（正是旧代码的写法）', () => {
  if (registry.list(ownerA).length !== 0) throw new Error('对象调用竟然命中了，说明桩没在复现官方语义');
});
check('readJobs 拿到了本会话的注册表作业', () => {
  const jobs = service.readJobs('session-a');
  if (jobs.length !== 4) throw new Error(`期望 4 条作业，实际 ${jobs.length} 条`);
  if (!jobs.some((job) => job.id === jobOfThisSession.id)) throw new Error('没拿到本会话的作业');
});
check('别的会话的作业一条都不进来', () => {
  const jobs = service.readJobs('session-a');
  if (jobs.some((job) => job.id === jobOfOtherSession.id)) throw new Error('混进了别的会话的作业');
});
check('readJobs 传的是会话 id 字符串，不是对象', () => {
  const last = registry.calls[registry.calls.length - 1];
  if (typeof last !== 'string') throw new Error(`注册表收到的是 ${typeof last}，应当是 string`);
  if (last !== 'session-a') throw new Error(`注册表收到的是 ${JSON.stringify(last)}`);
});

// ── ② 标题：在做什么（2026-10-13 新契约）──────────────────────────────
check('作业行的标题取那次工具调用时模型写的那句话', () => {
  const task = taskOf(snapshot(Date.now()), jobOfThisSession.id);
  if (task === undefined) throw new Error('本会话的作业没进任务列表');
  if (task.label !== '下载 anima_5B 模型（6.6 GB）') throw new Error(`label=${JSON.stringify(task.label)}`);
});
check('原始命令行只进 command 字段，绝不再当标题', () => {
  const task = taskOf(snapshot(Date.now()), jobOfThisSession.id);
  if (task.command !== COMMAND_DL) throw new Error('command 字段没带上原始命令行');
  if (task.label === task.command) throw new Error('标题仍然是命令行');
});
check('拿不到那句 description 时退到命令摘要，且摘要不含整条命令', () => {
  const task = taskOf(snapshot(Date.now()), jobNoDescription.id);
  if (typeof task.label !== 'string' || task.label.length === 0) throw new Error('没有兜底标题');
  if (task.label === COMMAND_HOST) throw new Error('兜底退成了整条命令');
  if (task.label.includes('--url')) throw new Error(`摘要里带了参数：${task.label}`);
  if (task.label.length > 48) throw new Error(`摘要太长：${task.label.length}`);
});
check('标题给不出时宿主留空，交给客户端用界面语言兜底（宿主不编标题）', () => {
  const task = taskOf(snapshot(Date.now()), jobNothing.id);
  if (task.label !== '') throw new Error(`宿主不该自己编标题，实际 label=${JSON.stringify(task.label)}`);
  if (task.command !== '') throw new Error(`command=${JSON.stringify(task.command)}`);
});

// ── ③ 数字：到哪了 / 还要多久（从作业输出尾部读）──────────────────────
check('输出里只有百分比时按 percent 呈现（不编分母）', () => {
  slices.set(jobWithOutput.id, sliceOf('downloading... 45%'));
  service.jobSamples.delete(jobWithOutput.id);
  const task = taskOf(snapshot(Date.now()), jobWithOutput.id);
  if (task.hasProgress !== true || task.derived !== true) throw new Error('没有标成「据输出估算」');
  if (task.unit !== 'percent') throw new Error(`unit=${task.unit}`);
  if (task.done !== 45 || task.total !== 100) throw new Error(`done/total=${task.done}/${task.total}`);
});
check('输出里有已下载/总量 + 速率 + ETA 时全部带上', () => {
  slices.set(jobWithOutput.id, sliceOf('f.bin 1.2 GB/2.7 GB [12.3 MB/s] ETA 00:12'));
  service.jobSamples.delete(jobWithOutput.id);
  const task = taskOf(snapshot(Date.now()), jobWithOutput.id);
  if (Math.round(task.done) !== 1200000000) throw new Error(`done=${task.done}`);
  if (Math.round(task.total) !== 2700000000) throw new Error(`total=${task.total}`);
  if (Math.round(task.speed) !== 12300000) throw new Error(`speed=${task.speed}`);
  if (task.eta !== 12) throw new Error(`eta=${task.eta}（输出里写了 ETA 00:12，应当用它）`);
});
check('输出只给百分比时，两次采样自己算速度与剩余', () => {
  const base = Date.now();
  slices.set(jobWithOutput.id, sliceOf('45%'));
  service.jobSamples.delete(jobWithOutput.id);
  taskOf(snapshot(base), jobWithOutput.id);
  slices.set(jobWithOutput.id, sliceOf('60%'));
  const task = taskOf(snapshot(base + 2000), jobWithOutput.id);
  if (Math.abs(task.speed - 7.5) > 1.2) throw new Error(`speed=${task.speed}（15% / 2s 应当接近 7.5）`);
  if (!(task.eta > 0)) throw new Error(`eta=${task.eta}`);
});
check('输出里没有数字时如实标成「未上报进度」，不编数字', () => {
  slices.set(jobWithOutput.id, sliceOf('nothing to see here\n'));
  service.jobSamples.delete(jobWithOutput.id);
  const task = taskOf(snapshot(Date.now()), jobWithOutput.id);
  if (task.hasProgress !== false) throw new Error('竟然标成了有进度');
  if (task.done !== 0 || task.total !== 0 || task.speed !== 0 || task.eta !== null) throw new Error('编出了数字');
});
check('读输出用的是 readAt（纯读），且带的是本会话 id', () => {
  const last = registry.reads[registry.reads.length - 1];
  if (last === undefined) throw new Error('一次都没读过输出');
  if (last.caller !== 'session-a') throw new Error(`caller=${JSON.stringify(last.caller)}`);
  if (!Number.isSafeInteger(last.from) || last.from < 0) throw new Error(`from=${last.from}`);
});

// ── ④ 记录与作业配对时：标题用记录的，数字也以记录为准 ──────────────────
check('配对到记录的作业：标题用记录的任务名，command 仍保留', () => {
  const record = {
    key: 'dl', label: '下载 anima_5B 模型', status: 'running', phase: 'download',
    unit: 'bytes', done: 5e8, total: 2.7e9, speed: 1e7, eta: 220, note: '',
    jobId: jobOfThisSession.id, startedAt: 1, updatedAt: Date.now(), hasProgress: true
  };
  registry.reads.length = 0;
  const tasks = service.merge([record], service.readJobs('session-a'), Date.now(), 'session-a');
  const task = tasks[0];
  if (task.label !== '下载 anima_5B 模型') throw new Error(`label=${task.label}`);
  if (task.command !== COMMAND_DL) throw new Error('没有把命令行留给悬停');
  if (task.done !== 5e8 || task.total !== 2.7e9) throw new Error('数字被改动了');
  if (registry.reads.some((read) => read.id === jobOfThisSession.id)) throw new Error('生产者已经给了总量，不该再去读输出');
});

// ── ⑤ 「唯一活作业」自动认领（2026-10-13）──────────────────────────────
// 同一件事本来就可能出两行：生产者写了记录、作业又在面板上单独占一行。规则只在没有歧义时合并。
const liveRecord = (key, label) => ({
  key, label, status: 'running', phase: 'download', unit: 'bytes',
  done: 5e8, total: 2.7e9, speed: 1e7, eta: 220, note: '',
  startedAt: 1, updatedAt: Date.now(), hasProgress: true
});
const jobRow = (id, label, status = 'running') => ({
  id, kind: 'pwsh', label, status, owner: { id: 'session-a' }, startedAt: 1,
  output: { total: 0, earliest: 0 },
  ...(status === 'running' ? {} : { finishedAt: 2 })
});
const reset = () => { service.pairCache.clear(); service.jobTitles.clear(); service.jobSamples.clear(); };

check('唯一活作业 + 唯一活记录 → 合成一行（名字与数字取记录，状态与命令取作业）', () => {
  reset();
  const tasks = service.merge([liveRecord('dl-a', '下载 anima_5B 模型')], [jobRow('pwsh-101', 'node dl.mjs --url https://x')], Date.now(), 'session-a');
  if (tasks.length !== 1) throw new Error(`应当合成 1 行，实际 ${tasks.length} 行`);
  if (tasks[0].label !== '下载 anima_5B 模型') throw new Error(`label=${tasks[0].label}`);
  if (tasks[0].jobId !== 'pwsh-101') throw new Error('没有把作业身份并进来');
  if (tasks[0].command !== 'node dl.mjs --url https://x') throw new Error('command 没留给悬停');
  if (tasks[0].done !== 5e8 || tasks[0].total !== 2.7e9) throw new Error('数字没有以记录为准');
});
check('有两个活作业时不认领（保持原样）', () => {
  reset();
  const tasks = service.merge([liveRecord('dl-b', '下载 B')], [jobRow('pwsh-102', 'node a.mjs'), jobRow('pwsh-103', 'node b.mjs')], Date.now(), 'session-a');
  if (tasks.length !== 3) throw new Error(`应当 3 行（1 记录 + 2 作业），实际 ${tasks.length} 行`);
  const record = tasks.find((task) => task.key === 'dl-b');
  if (record === undefined || record.jobId !== undefined) throw new Error('记录不该被认领');
});
check('有两条未配对的活记录时不认领', () => {
  reset();
  const tasks = service.merge([liveRecord('dl-c', '下载 C'), liveRecord('dl-d', '下载 D')], [jobRow('pwsh-104', 'node c.mjs')], Date.now(), 'session-a');
  if (tasks.length !== 3) throw new Error(`应当 3 行，实际 ${tasks.length} 行`);
});
check('记录自己写了 jobId（指向别处）时不认领', () => {
  reset();
  const pinned = { ...liveRecord('dl-e', '下载 E'), jobId: 'pwsh-999' };
  const tasks = service.merge([pinned], [jobRow('pwsh-105', 'node e.mjs')], Date.now(), 'session-a');
  if (tasks.length !== 2) throw new Error(`应当 2 行，实际 ${tasks.length} 行`);
});
check('认领过的组合会记住：作业跑完、记录写下终态后仍然只有一行', () => {
  reset();
  const now = Date.now();
  const first = service.merge([liveRecord('dl-f', '下载 F')], [jobRow('pwsh-106', 'node f.mjs')], now, 'session-a');
  if (first.length !== 1) throw new Error('第一轮没有认领');
  const later = service.merge(
    [{ ...liveRecord('dl-f', '下载 F'), status: 'done', finishedAt: 3 }],
    [jobRow('pwsh-106', 'node f.mjs', 'completed')],
    now + 1000,
    'session-a'
  );
  if (later.length !== 1) throw new Error(`终态后应当仍是 1 行，实际 ${later.length} 行`);
  if (later[0].label !== '下载 F') throw new Error(`label=${later[0].label}`);
  if (later[0].status !== 'completed') throw new Error(`status=${later[0].status}（注册表是权威）`);
});
check('作业从注册表消失后清掉那段记忆（作业 id 会复用，别认错人）', () => {
  service.merge([{ ...liveRecord('dl-f', '下载 F'), status: 'done', finishedAt: 3 }], [], Date.now(), 'session-a');
  if (service.pairCache.size !== 0) throw new Error(`缓存没清干净：${service.pairCache.size}`);
});

for (const name of passed) console.log(`ok   ${name}`);
if (failed.length > 0) {
  console.error('');
  for (const line of failed) console.error(`FAIL ${line}`);
  console.error(`\n${failed.length} 项不通过`);
  process.exit(1);
}
console.log(`\nALL PASS (${passed.length})`);
