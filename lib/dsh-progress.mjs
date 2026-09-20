#!/usr/bin/env node
/**
 * dsh-progress — the producer side of the dsh-job-progress protocol.
 *
 * A long-running producer (a downloader, an encoder, a batch job, anything that
 * runs inside an agent's shell) writes its progress as a small JSON file in the
 * session's progress directory. The plugin's host half reads that directory and
 * the web GUI renders it next to the background job. Nothing polls the job's
 * stdout — that stream is incremental and belongs to the model — so this file is
 * the only channel that costs the reader nothing.
 *
 * The directory is derived from the environment every agent shell already has:
 *   DSH_HOME       (e.g. C:\Users\me\.dsh)   → <DSH_HOME>/job-progress
 *   DSH_SESSION_ID (e.g. session-abc…)       → <DSH_HOME>/job-progress/<session>
 * Both may be overridden with --dir / DSH_JOB_PROGRESS_DIR.
 *
 * File contract (one file per task, key = file name):
 *   {
 *     "label": "anima_5B.safetensors",  // shown in the panel
 *     "done": 12345678,                 // units completed
 *     "total": 66000000,                // units total (0 when unknown)
 *     "unit": "bytes" | "count",        // how to render the numbers
 *     "speed": 12500000,                // units/second (optional)
 *     "eta": 5,                         // seconds remaining (optional)
 *     "phase": "download",              // download | merge | verify | custom
 *     "status": "running",              // running | done | failed
 *     "note": "",                       // free text shown on failure
 *     "jobId": "bash-3",                // optional: pin to a registry job
 *     "updatedAt": 1758000000000        // ms epoch; readers age entries out
 *   }
 *
 * Any language can write that file; this module is the JavaScript convenience
 * layer plus a CLI:
 *
 *   import { track } from 'dsh-job-progress/progress';
 *   const t = track({ label: 'model.safetensors', total: 66000000 });
 *   t.update(bytes);
 *   t.phase('verify');
 *   t.finish('done');
 *
 *   node dsh-progress.mjs set --label model.safetensors --done 12 --total 100
 *   node dsh-progress.mjs done  --key model.safetensors
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Readers treat an entry whose heartbeat stopped as gone. */
export const HEARTBEAT_MS = 5000;

/** Resolve the progress directory for one session from the environment. */
export function progressDir(opts = {}) {
  const explicit = opts.dir || process.env.DSH_JOB_PROGRESS_DIR;
  const base = explicit || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'job-progress');
  const session = opts.session || process.env.DSH_SESSION_ID || 'unscoped';
  return path.join(base, session);
}

function slugify(value, fallback = 'task') {
  const cleaned = String(value ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : fallback;
}

function writeAtomic(file, record) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record));
  fs.renameSync(tmp, file);
}

/**
 * Track one task. Every call rewrites the task's JSON file atomically, so a
 * reader never observes a half-written record.
 *
 * @param options - `{ label, total, unit, key, jobId, dir, session }`.
 * @returns a handle with `update`, `phase`, `finish`, and its `file` path.
 */
export function track(options = {}) {
  const dir = progressDir(options);
  fs.mkdirSync(dir, { recursive: true });
  const label = options.label || options.key || 'task';
  const key = slugify(options.key || label);
  const file = path.join(dir, `${key}.json`);
  // `resume` continues an existing record instead of starting a new one. The CLI
  // needs it because `set` and `done` are two separate processes: without it the
  // second invocation would publish a fresh, zeroed record and lose the numbers.
  let seed = null;
  if (options.resume === true) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed !== null && typeof parsed === 'object') seed = parsed;
    } catch {
      /* no previous record — start one */
    }
  }
  const record = {
    label,
    key,
    unit: options.unit === 'count' || seed?.unit === 'count' ? 'count' : 'bytes',
    total: Number(options.total) || Number(seed?.total) || 0,
    done: options.done !== undefined ? Number(options.done) || 0 : Number(seed?.done) || 0,
    speed: 0,
    eta: null,
    phase: options.phase || seed?.phase || 'running',
    status: 'running',
    note: '',
    pid: process.pid,
    ...(options.jobId ? { jobId: options.jobId } : seed?.jobId ? { jobId: seed.jobId } : {}),
    startedAt: Number(seed?.startedAt) || Date.now(),
    updatedAt: Date.now(),
  };
  let lastBytes = 0;
  let lastAt = Date.now();
  let stopped = false;

  const flush = () => {
    record.updatedAt = Date.now();
    try {
      writeAtomic(file, record);
    } catch {
      /* reporting must never break the work it reports on */
    }
  };
  flush();

  // Heartbeat: a producer that stalls (or dies) stops refreshing `updatedAt`,
  // which is how the panel tells "slow" from "gone".
  const beat = setInterval(() => {
    if (!stopped) flush();
  }, HEARTBEAT_MS);
  if (typeof beat.unref === 'function') beat.unref();

  return {
    file,
    record,
    update(done, extra = {}) {
      const now = Date.now();
      const dt = (now - lastAt) / 1000;
      if (dt >= 0.4) {
        record.speed = Math.max(0, (Number(done) - lastBytes) / dt);
        lastBytes = Number(done);
        lastAt = now;
      }
      record.done = Number(done) || 0;
      record.eta = record.total > 0 && record.speed > 0 ? Math.round((record.total - record.done) / record.speed) : null;
      Object.assign(record, extra);
      flush();
      return this;
    },
    phase(phase, extra = {}) {
      record.phase = phase;
      Object.assign(record, extra);
      flush();
      return this;
    },
    finish(status = 'done', note = '') {
      stopped = true;
      clearInterval(beat);
      record.status = status === 'failed' ? 'failed' : 'done';
      record.phase = record.status;
      record.note = note || '';
      record.eta = null;
      if (record.status === 'done' && record.total > 0) record.done = record.total;
      record.finishedAt = Date.now();
      flush();
      return file;
    },
  };
}

function parseArgv(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq > 0) out[token.slice(2, eq)] = token.slice(eq + 1);
    else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[token.slice(2)] = true;
      else {
        out[token.slice(2)] = next;
        i += 1;
      }
    }
  }
  return out;
}

function main(argv) {
  const args = parseArgv(argv);
  const command = args._[0] || 'set';
  const opts = { dir: args.dir, session: args.session, key: args.key, label: args.label, jobId: args.jobId };
  if (command === 'dir') {
    process.stdout.write(`${progressDir(opts)}\n`);
    return 0;
  }
  if (command === 'clear') {
    const dir = progressDir(opts);
    let removed = 0;
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        if (args.key && name !== `${slugify(args.key)}.json`) continue;
        fs.rmSync(path.join(dir, name), { force: true });
        removed += 1;
      }
    }
    process.stdout.write(`cleared ${removed}\n`);
    return 0;
  }
  const handle = track({
    ...opts,
    resume: true,
    total: args.total,
    done: args.done,
    unit: args.unit,
    phase: args.phase,
  });
  if (command === 'done' || command === 'failed') {
    handle.finish(command === 'done' ? 'done' : 'failed', args.note);
  } else {
    handle.update(args.done ?? 0, args.speed ? { speed: Number(args.speed) } : {});
  }
  process.stdout.write(`${handle.file}\n`);
  return 0;
}

// `pathToFileURL` — not string concatenation — because a Windows path yields
// `file:///C:/…` (three slashes) and a hand-built URL silently never matches.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}

export default { track, progressDir };
