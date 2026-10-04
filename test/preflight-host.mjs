// test/preflight-host.mjs — 宿主半边：注册表作业的取用契约（2026-10-04）
//
// 为什么要有它：2026-10-04 实测发现宿主半边把 owner **对象**交给了
// `ctx.jobs.list(caller)`，而注册表的签名是 `list(caller?: SessionId)`，
// 内部按 `job.owner.id === caller` 比较 —— 对象永远不等于字符串，
// 带 owner 的作业被整批滤掉。表现是浏览器里 /api/jobProgress/snapshot
// 永远返回空 tasks，而作业其实正在跑（/api/job/kill 认它属于本会话）。
//
// 这个脚本用桩复现同一个契约，把它钉死：
//   ① 桩注册表按官方语义实现（字符串比 owner.id），传对象必须返回空
//   ② JobProgressService.readJobs(sessionId) 必须拿到本会话的作业
//   ③ 不是本会话的 owner 不得被算进来
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

// ── 桩：官方 dsh-jobs-local 的 list 语义（caller 是会话 id 字符串）────────
const makeJob = (id, ownerId, label) => ({
  id,
  kind: 'pwsh',
  label,
  status: 'running',
  owner: { id: ownerId },
  startedAt: 1,
});
const jobOfThisSession = makeJob('pwsh-1', 'session-a', 'probe sleepper');
const jobOfOtherSession = makeJob('pwsh-2', 'session-b', 'other');
const registry = {
  calls: [],
  list(caller) {
    this.calls.push(caller);
    return [jobOfThisSession, jobOfOtherSession].filter((job) => job.owner === undefined || job.owner.id === caller);
  },
};

// ── 桩 ctx：只要 get('jobs'|'agents'|'sessions'|'sessions' 的枚举) ─────────
const ownerA = { id: 'session-a' };
const ctx = {
  logger: { info: () => {} },
  get(name) {
    if (name === 'jobs') return registry;
    if (name === 'agents') return { list: () => [ownerA] };
    if (name === 'sessions') return { list: () => [ownerA, { id: 'session-b' }] };
    return undefined;
  },
};
// 不走构造器：`TypertRemoteService` / cordis `Service` 的构造需要真正的 cordis 运行时
// （`ctx.reflect.provide`），Node 里搭不出来。这里直接拿 lib/index.js 里的**真原型方法**
// 调，只喂它自己会用到的那几个 ctx 口子（get('jobs'|'agents'|'sessions')）—— 被验的
// 仍然是随包发布的那个 readJobs / merge，不是复制品。
const service = Object.create(JobProgressService.prototype);
service.ctx = ctx;
service.root = path.join(here, '..', 'tmp-progress-root');
service.debug = false;

check('注册表按字符串调用才返回作业（这是官方语义）', () => {
  if (registry.list('session-a').length !== 1) throw new Error('桩本身有问题：字符串调用应返回 1 条');
});
check('传 owner 对象给注册表拿不到任何作业（正是旧代码的写法）', () => {
  if (registry.list(ownerA).length !== 0) throw new Error('对象调用竟然命中了，说明桩没在复现官方语义');
});
check('readJobs 拿到了本会话的注册表作业', () => {
  const jobs = service.readJobs('session-a');
  if (jobs.length !== 1) throw new Error(`期望 1 条作业，实际 ${jobs.length} 条`);
  if (jobs[0].id !== jobOfThisSession.id) throw new Error(`作业 id 不对：${jobs[0].id}`);
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
check('merge 把注册表作业并进任务列表（面板能显示纯作业）', () => {
  const now = Date.now();
  const tasks = service.merge([], service.readJobs('session-a'), now);
  if (tasks.length !== 1) throw new Error(`期望合并出 1 条，实际 ${tasks.length} 条`);
  if (tasks[0].label !== jobOfThisSession.label) throw new Error('label 没带上');
  if (tasks[0].status !== 'running') throw new Error('status 没带上');
  if (tasks[0].jobId !== jobOfThisSession.id) throw new Error('jobId 没带上');
  if (tasks[0].hasProgress !== false) throw new Error('纯作业应当标记为没有进度数字');
});

for (const name of passed) console.log(`ok   ${name}`);
if (failed.length > 0) {
  console.error('');
  for (const line of failed) console.error(`FAIL ${line}`);
  console.error(`\n${failed.length} 项不通过`);
  process.exit(1);
}
console.log(`\nALL PASS (${passed.length})`);
