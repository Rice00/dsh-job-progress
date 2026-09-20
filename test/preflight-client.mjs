// test/preflight-client.mjs — 不装插件也能验客户端半边（2026-09-20）
//
// 为什么要有它：客户端半边只在浏览器里跑，它的错误只出现在**渲染层 console**，
// 而那份 console 不落盘（本机日志目录里只有 host 与 main 两份）。后果是
// 「插件把界面搞坏了」只能等重启后靠肉眼发现 —— 2026-09-20 就是这么栽的：
// factory 里引用了 exports/module 却没声明（真·bug），宿主半边却挂载正常、
// 日志里一条异常都没有，于是整场排查只能对着空白猜。
//
// 这个脚本用桩把模块加载器的契约在 Node 里复现一遍，任何一条不成立就非零退出：
//   ① 顶层必须只调用 window.__ModuleLoader__.load(...)
//   ② id 必须等于包名；factory 必须能被调用并返回 exports
//   ③ exports.apply / exports.inject 必须存在
//   ④ apply(ctx) 必须不抛，且确实注册到预期槽位
//   ⑤ 组件函数必须能跑（有任务时不返回 null，无任务时返回 null）
//
// 用法：node test/preflight-client.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath = path.join(here, '..', 'lib', 'client.js');
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));

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

// ── 复现模块加载器：它只做一件事，把模块描述对象交给执行器 ──────────────
let loaded = null;
globalThis.window = { __ModuleLoader__: { load: (mod) => { loaded = mod; } } };

let importError = null;
try {
  await import(pathToFileURL(clientPath).href);
} catch (error) {
  importError = error;
}
check('模块可被导入', () => { if (importError) throw importError; });
check('顶层调用了 __ModuleLoader__.load', () => { if (loaded === null) throw new Error('load 从未被调用'); });
check('id 与包名一致', () => {
  if (loaded?.id !== pkg.name) throw new Error(`id=${JSON.stringify(loaded?.id)}，包名=${pkg.name}`);
});
check('声明了 web 平台与 client 注入', () => {
  const client = pkg.dsh?.client;
  if (client?.platform !== 'web') throw new Error('dsh.client.platform 必须是 web');
  if (!Array.isArray(client?.inject) || client.inject.length === 0) throw new Error('dsh.client.inject 不能为空');
});
check('package.json 暴露了 ./client 入口', () => {
  if (pkg.exports?.['./client'] === undefined) throw new Error('exports["./client"] 缺失');
});

// ── 最小 React 桩：够让模块体与组件体各跑一遍 ────────────────────────────
const reactShim = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
};
const requireStub = (name) => {
  if (name === 'react') return reactShim;
  throw new Error(`客户端半边不该 require ${JSON.stringify(name)}（除 react 外都应收敛掉）`);
};

let mod = null;
check('factory 可执行并返回 exports', () => {
  mod = loaded.factory(requireStub);
  if (!mod) throw new Error('factory 没有返回 exports');
});
check('exports.apply 是函数', () => { if (typeof mod?.apply !== 'function') throw new Error('缺少 apply'); });
check('exports.inject 是数组', () => { if (!Array.isArray(mod?.inject)) throw new Error('缺少 inject'); });

// ── apply(ctx) 与组件渲染 ───────────────────────────────────────────────
const registered = [];
const ctxStub = {
  effect: (fn) => { fn(); return () => {}; },
  locale: { register: () => () => {} },
  connection: { rpc: { call: async () => ({ ok: true, value: { tasks: [] } }) } },
  slots: {
    inject: (_name, fn) => { fn(); },
    register: (spec, component) => { registered.push({ spec, component }); return () => {}; },
  },
};
check('apply(ctx) 不抛', () => { mod.apply(ctxStub); });
check('注册到会话头部槽位', () => {
  if (!registered.some((entry) => entry.spec?.name === 'conversation.session.header.actions')) {
    throw new Error('未注册 conversation.session.header.actions');
  }
});
check('有任务时组件不返回 null', () => {
  const component = registered[0].component;
  const useSessions = (select) => select({
    jobsBySession: { 'session-x': [{ id: 'bash-1', kind: 'pwsh', label: 'x', status: 'running', startedAt: Date.now() }] },
  });
  const tree = component({ sessionId: 'session-x', useSessions, t: (key) => key });
  if (tree === null || tree === undefined) throw new Error('有任务时应当渲染出节点');
});
check('无任务时组件返回 null', () => {
  const component = registered[0].component;
  const useSessions = (select) => select({ jobsBySession: {} });
  const tree = component({ sessionId: 'session-y', useSessions, t: (key) => key });
  if (tree !== null) throw new Error('无任务的会话不应渲染任何东西');
});

for (const name of passed) console.log(`ok   ${name}`);
if (failed.length > 0) {
  console.error('');
  for (const line of failed) console.error(`FAIL ${line}`);
  console.error(`\n${failed.length} 项不通过`);
  process.exit(1);
}
console.log(`\nALL PASS (${passed.length})`);
