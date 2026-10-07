// test/preflight-skill.mjs — 宿主半边把进度协议注册成"会话可见技能"（2026-10-07）
//
// 为什么要有它：2026-10-07 实测发现，本机另一个会话在跑 60 GiB 下载时**根本不知道**
// 这个插件有进度上报（README 与 lib/dsh-progress.mjs 一直都有），因为没有任何东西
// 把这条路放进 agent 会看到的地方 —— 技能目录里没有条目。补法是在插件挂载时把协议
// 注册成一个运行时技能（ctx.skills.register），这个脚本把那份契约钉死：
//   ① 注册的 name / description / whenToUse / content 都在，且正文指向真实的 helper 文件
//   ② 注册发生在 ctx.get('skills') 上，且只发生一次
//   ③ skills 服务缺失时安静跳过（不抛、不注册）
//   ④ 注册抛异常时不把插件拖下来（只记一条 warn）
//   ⑤ 定义带 source（注册表不补这个字段，缺了加载时必抛；2026-10-08 实测）
//   ⑥ 正文写了「任务名当标题」与「下载要带 ETA」这两条用户点名要的规则
//
// 前置与用法跟 test/preflight-host.mjs 一样：
//   node test/preflight-skill.mjs      （需要在 node_modules 里备好 peer 依赖，见该文件注释）
import fs from 'node:fs';
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
let skillDefinition = null;
let importError = null;
try {
  ({ JobProgressService, skillDefinition } = await import(pathToFileURL(hostPath).href));
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

/** 直接拿原型方法跑（构造器要真 cordis 运行时；理由见 preflight-host.mjs）。 */
function makeService(ctx) {
  const service = Object.create(JobProgressService.prototype);
  service.ctx = ctx;
  service.root = path.join(here, '..', 'tmp-progress-root');
  service.debug = false;
  service.helper = '';
  return service;
}

// ── 桩 ctx：记录 get() 与 logger 的调用 ─────────────────────────────────
function makeCtx({ withSkills = true, registerThrows = false } = {}) {
  const calls = { get: [], registered: [], info: [], warn: [], debug: [] };
  const skills = {
    register(skill) {
      if (registerThrows) throw new Error('stub: register refused');
      calls.registered.push(skill);
      return () => {};
    },
  };
  const ctx = {
    get(name) {
      calls.get.push(name);
      if (name === 'skills') return withSkills ? skills : undefined;
      return undefined;
    },
    logger: {
      info: (line) => calls.info.push(String(line)),
      warn: (line) => calls.warn.push(String(line)),
      debug: (line) => calls.debug.push(String(line)),
    },
  };
  return { ctx, calls };
}

// ── ① 正常路径 ────────────────────────────────────────────────────────
const ok = makeCtx();
const service = makeService(ok.ctx);
check('registerSkill 不抛', () => { service.registerSkill(ok.ctx); });
check('确实向 skills 服务注册了一次', () => {
  if (ok.calls.registered.length !== 1) throw new Error(`注册次数 ${ok.calls.registered.length}，期望 1`);
});
check('技能名是本插件名（kebab-case）', () => {
  const skill = ok.calls.registered[0];
  if (skill.name !== 'dsh-job-progress') throw new Error(`name=${JSON.stringify(skill.name)}`);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill.name)) throw new Error('技能名不是合法 kebab-case');
});
check('description / whenToUse / content 都是非空字符串', () => {
  const skill = ok.calls.registered[0];
  for (const field of ['description', 'whenToUse', 'content']) {
    if (typeof skill[field] !== 'string' || skill[field].length === 0) {
      throw new Error(`${field} 缺失或为空（${typeof skill[field]}）`);
    }
  }
});
check('正文写了目录、心跳与「别只打 stdout」三件事', () => {
  const content = ok.calls.registered[0].content;
  for (const needle of ['job-progress', 'DSH_SESSION_ID', 'updatedAt', 'stdout']) {
    if (!content.includes(needle)) throw new Error(`正文里缺少关键信息「${needle}」`);
  }
});
// 2026-10-08 用户点名的两条：下载要开带 ETA 的上报；标题写任务名而不是命令行。
check('正文写了「下载要带 ETA」与「标题写任务名」两条规则', () => {
  const content = ok.calls.registered[0].content;
  for (const needle of ['ETA', 'update(bytesWritten)', 'label 就是面板上的任务名', '不要写整条命令行']) {
    if (!content.includes(needle)) throw new Error(`正文里缺少「${needle}」`);
  }
});
// 注册表（@deepseek-ai/dsh-skill）只补 invocation 与 provider，**不补 source**；加载时
// validateDefinition 会因 source 不是字符串直接抛（dsh-skill/lib/index.js:486）。实测报错：
//   loaded skill "dsh-job-progress" source must be a string
check('定义带非空 source（注册表不补这个字段）', () => {
  const skill = ok.calls.registered[0];
  if (typeof skill.source !== 'string' || skill.source.length === 0) {
    throw new Error(`source=${JSON.stringify(skill.source)}`);
  }
});
check('invocation / provider 留给注册表补默认（不在定义里写死）', () => {
  const skill = ok.calls.registered[0];
  if (skill.invocation !== undefined) throw new Error('自己写了 invocation，会盖掉注册表的默认策略');
  if (skill.provider !== undefined) throw new Error('自己写了 provider');
});
check('注册的定义与导出的 skillDefinition() 是同一份（测试不追手工副本）', () => {
  const built = skillDefinition(service.helper);
  const registered = ok.calls.registered[0];
  for (const field of ['name', 'description', 'whenToUse', 'content', 'source']) {
    if (registered[field] !== built[field]) throw new Error(`${field} 与 skillDefinition() 不一致`);
  }
});
check('helper 为空时仍能构造定义（正文省略「本机插件目录」一段）', () => {
  const bare = skillDefinition('');
  if (typeof bare.content !== 'string' || bare.content.length === 0) throw new Error('content 为空');
  if (bare.content.includes('本机插件目录')) throw new Error('空 helper 时不该出现插件目录段');
  if (bare.metadata.helper !== undefined) throw new Error('空 helper 不该写 metadata.helper');
});
check('正文与 metadata 指向真实的 helper 文件', () => {
  const skill = ok.calls.registered[0];
  const helper = service.helper;
  if (typeof helper !== 'string' || helper.length === 0) throw new Error('helper 路径为空');
  if (!skill.content.includes(helper)) throw new Error('正文里没有 helper 路径');
  if (skill.metadata?.helper !== helper) throw new Error('metadata.helper 与 helper 不一致');
  if (!fs.existsSync(helper)) throw new Error(`helper 文件不存在：${helper}`);
});
check('注册成功会记一条 info（便于日志核对）', () => {
  if (!ok.calls.info.some((line) => line.includes('registered skill'))) {
    throw new Error(`info 日志里没有注册记录：${JSON.stringify(ok.calls.info)}`);
  }
});

// ── ② skills 服务缺失：安静跳过 ────────────────────────────────────────
const bare = makeCtx({ withSkills: false });
check('skills 服务缺失时安静跳过（不抛、不注册）', () => {
  const bareService = makeService(bare.ctx);
  bareService.registerSkill(bare.ctx);
  if (bare.calls.registered.length !== 0) throw new Error('竟然注册了');
});

// ── ③ 注册抛异常：不拖垮插件 ───────────────────────────────────────────
const boom = makeCtx({ registerThrows: true });
check('注册抛异常时只记 warn，不往外抛', () => {
  const boomService = makeService(boom.ctx);
  boomService.registerSkill(boom.ctx);
  if (!boom.calls.warn.some((line) => line.includes('failed'))) {
    throw new Error(`没有 warn 记录：${JSON.stringify(boom.calls.warn)}`);
  }
});

// ── ④ 真服务路径：helper 解析（constructor 里那段） ─────────────────────
check('helper 路径解析成 lib/dsh-progress.mjs 且文件真实存在', () => {
  const helper = fileURLToPath(new URL('../lib/dsh-progress.mjs', import.meta.url));
  if (!helper.endsWith('dsh-progress.mjs')) throw new Error(`路径不对：${helper}`);
  if (!fs.existsSync(helper)) throw new Error(`文件不存在：${helper}`);
});

for (const name of passed) console.log(`ok   ${name}`);
if (failed.length > 0) {
  console.error('');
  for (const line of failed) console.error(`FAIL ${line}`);
  console.error(`\n${failed.length} 项不通过`);
  process.exit(1);
}
console.log(`\nALL PASS (${passed.length})`);
