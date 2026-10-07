// test/preflight-progress.mjs — 生产者侧（lib/dsh-progress.mjs）的契约
//
// 为什么要有它：技能正文告诉 agent「下载要用能算出 ETA 的上报」，而这个承诺是
// lib/dsh-progress.mjs 给的 —— 模块接口在**同一个进程里连续 update()** 才推得出速度与
// ETA；CLI 每次调用都是新进程，只能靠 --speed 传进来。2026-10-08 之前 update() 里
// ETA 是在赋 extra **之前**算的，于是 `set --speed` 只写出速度、ETA 恒为 null，正文里
// 「给了 --speed 就会顺带算出 ETA」这句话不成立。这个脚本把两边都钉住。
//
// 用法：node test/preflight-progress.mjs   （无外部依赖，CI 里也能跑）
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { progressDir, track } from '../lib/dsh-progress.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const helper = path.join(here, '..', 'lib', 'dsh-progress.mjs');
const node = process.execPath;

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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 试验目录建在仓库里（.gitignore 已排除 tmp-*/），跑完删掉。
const root = fs.mkdtempSync(path.join(here, '..', 'tmp-progress-'));
const session = 'preflight';
const dir = path.join(root, session);
const read = (key) => JSON.parse(fs.readFileSync(path.join(dir, `${key}.json`), 'utf8'));
// 子进程的输出**不能走管道**：本机沙箱下 Node 的 spawn/exec 一用默认的 piped stdio 就
// EPERM（命名管道开不了）。改成把 stdout/stderr 都接到文件描述符上（不是管道），
// 于是本地与 CI 里行为一致。
const cli = (...args) => {
  const out = path.join(root, 'cli-output.txt');
  const fd = fs.openSync(out, 'w');
  try {
    const result = spawnSync(node, [helper, ...args], { stdio: ['ignore', fd, fd] });
    return { status: result.status, error: result.error, output: fs.readFileSync(out, 'utf8') };
  } finally {
    fs.closeSync(fd);
  }
};

try {
  // ── ① 目录解析 ──────────────────────────────────────────────────────
  check('progressDir 用 --dir 与 --session 拼出 <dir>/<session>', () => {
    const got = progressDir({ dir: root, session });
    if (got !== dir) throw new Error(`得到 ${got}`);
  });

  // ── ② 模块接口：落盘字段 ─────────────────────────────────────────────
  const t = track({ dir: root, session, key: 'mod', label: '下载 anima_5B 模型', total: 1200000, unit: 'bytes' });
  check('track() 立刻写下一条 running 记录', () => {
    const record = read('mod');
    if (record.label !== '下载 anima_5B 模型') throw new Error(`label=${record.label}`);
    if (record.total !== 1200000 || record.done !== 0) throw new Error(`total/done=${record.total}/${record.done}`);
    if (record.status !== 'running') throw new Error(`status=${record.status}`);
    if (record.unit !== 'bytes') throw new Error(`unit=${record.unit}`);
    if (!Number.isFinite(record.updatedAt) || !Number.isFinite(record.startedAt)) throw new Error('缺时间戳');
  });

  // ── ③ 同一个进程里连续 update()：速度与 ETA 都算得出来 ────────────────
  // 两次采样都留够 0.4 秒（速度是按相邻两次调用的间隔算的，采样太快它不更新）。
  await sleep(450);
  t.update(30000);
  await sleep(450);
  t.update(60000);
  check('连续 update() 给出速度与 ETA', () => {
    const record = read('mod');
    if (!(record.speed > 0)) throw new Error(`speed=${record.speed}`);
    if (!(record.eta > 0)) throw new Error(`eta=${record.eta}`);
    const expected = Math.round((record.total - record.done) / record.speed);
    if (record.eta !== expected) throw new Error(`eta=${record.eta}，按速度算应为 ${expected}`);
  });

  // ── ④ 原子写：不留 .tmp ──────────────────────────────────────────────
  check('原子写：目录里不留 .tmp 文件', () => {
    const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
    if (leftovers.length > 0) throw new Error(`残留 ${leftovers.join(', ')}`);
  });

  // ── ⑤ 终态 ─────────────────────────────────────────────────────────
  t.finish('done');
  check('finish(done) 写终态、补齐 done、清掉 ETA', () => {
    const record = read('mod');
    if (record.status !== 'done') throw new Error(`status=${record.status}`);
    if (record.done !== 1200000) throw new Error(`done=${record.done}`);
    if (record.eta !== null) throw new Error(`eta=${record.eta}`);
    if (!Number.isFinite(record.finishedAt)) throw new Error('缺 finishedAt');
  });
  check('finish(failed, note) 保留失败原因', () => {
    track({ dir: root, session, key: 'bad', label: '校验 x', total: 10 }).finish('failed', 'sha256 mismatch');
    const record = read('bad');
    if (record.status !== 'failed') throw new Error(`status=${record.status}`);
    if (record.note !== 'sha256 mismatch') throw new Error(`note=${record.note}`);
  });

  // ── ⑥ CLI：--speed 必须一起给出 ETA（2026-10-08 修） ──────────────────
  const set = cli('set', '--dir', root, '--session', session, '--key', 'cli', '--label', '下载 x', '--total', '100', '--done', '40', '--speed', '10');
  check('CLI set 退出码 0', () => {
    if (set.status !== 0) throw new Error(`status=${set.status} error=${set.error} output=${set.output}`);
  });
  check('CLI set --speed 同时写出速度与 ETA', () => {
    const record = read('cli');
    if (record.speed !== 10) throw new Error(`speed=${record.speed}`);
    if (record.eta !== 6) throw new Error(`eta=${record.eta}（(100-40)/10 应为 6）`);
    if (record.label !== '下载 x') throw new Error(`label=${record.label}`);
    if (record.status !== 'running') throw new Error(`status=${record.status}`);
  });
  check('CLI 二次 set 沿用同一份记录（total/startedAt 不丢）', () => {
    const before = read('cli');
    cli('set', '--dir', root, '--session', session, '--key', 'cli', '--done', '70', '--speed', '10');
    const after = read('cli');
    if (after.total !== 100) throw new Error(`total=${after.total}`);
    if (after.startedAt !== before.startedAt) throw new Error('startedAt 变了');
    if (after.eta !== 3) throw new Error(`eta=${after.eta}（(100-70)/10 应为 3）`);
  });
  check('CLI done 收尾', () => {
    cli('done', '--dir', root, '--session', session, '--key', 'cli');
    const record = read('cli');
    if (record.status !== 'done' || record.done !== 100) throw new Error(`status=${record.status} done=${record.done}`);
  });
  check('CLI dir 打印记录目录', () => {
    const result = cli('dir', '--dir', root, '--session', session);
    if (result.status !== 0) throw new Error(`status=${result.status} error=${result.error}`);
    if (!result.output.includes(session)) throw new Error(`stdout=${JSON.stringify(result.output)}`);
  });
  check('CLI clear 只删指到的 key', () => {
    cli('clear', '--dir', root, '--session', session, '--key', 'cli');
    if (fs.existsSync(path.join(dir, 'cli.json'))) throw new Error('cli.json 还在');
    if (!fs.existsSync(path.join(dir, 'mod.json'))) throw new Error('顺手删掉了别的记录');
  });
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

for (const name of passed) console.log(`ok   ${name}`);
if (failed.length > 0) {
  console.error('');
  for (const line of failed) console.error(`FAIL ${line}`);
  console.error(`\n${failed.length} 项不通过`);
  process.exit(1);
}
console.log(`\nALL PASS (${passed.length})`);
