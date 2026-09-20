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

    constructor(ctx, config = {}) {
      super(ctx, 'jobProgress');
      __runInitializers(this, _instanceExtraInitializers);
      this.root = config.dir && config.dir.length > 0 ? config.dir : dshHomePath('job-progress');
      this.debug = config.debug === true;
      ctx.logger?.info?.('dsh-job-progress: mounted, progress root ' + this.root);
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
          for (const snapshot of registry.list(owner)) {
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

export { JobProgressService, JobProgressService as default };
