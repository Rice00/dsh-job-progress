/**
 * dsh-job-progress — client half.
 *
 * A floating ball in the conversation window. It appears only when this session
 * has something to watch, carries the live task count, can be dragged anywhere
 * (the position is remembered), and expands into the task panel on click.
 * The panel can clear what has already finished.
 *
 * Hand-written against the module-loader contract (no bundler step): the shell
 * evaluates this file, the factory receives `require`, and the exported `apply`
 * runs with the client root context.
 */
window.__ModuleLoader__.load({
  id: 'dsh-job-progress',
  factory: (require) => {
    // 模块加载器契约：factory 收到 require，必须返回 module.exports。下面两行不能省 ——
    // 2026-09-20 就是漏了它们：客户端半边一加载就抛 ReferenceError: exports is not defined，
    // 渲染层的插件图随之崩掉、界面起不来，而宿主半边照常挂载、日志里一条异常都没有。
    const module = { exports: {} };
    const exports = module.exports;
    const React = require('react');
    const h = React.createElement;
    const NS = 'jobProgress';
    const POLL_MS = 2000;
    const POLL_IDLE_MS = 10000;
    const EMPTY = [];
    const BALL = 56;
    const PANEL_W = 340;
    const PANEL_MAX_H = 420;
    const POS_KEY = 'dsh-job-progress:pos';
    const DISMISS_PREFIX = 'dsh-job-progress:dismissed:';

    /** 球里的图标：鲸鱼娘「吃白饭的底气」表情包的方形版，缩到 144px 后内联。      *  内联而不是走宿主路由 —— 客户端半边是每次刷新页面重载的，换图不用重启 DSH；      *  代价是 client.js 多了几十 KB（要换成大图/动图再改走宿主路由）。 */     const ICON_DATA = 'data:image/jpeg;base64,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';

    /** The connection service, bound in `apply` (module scope keeps the row simple). */
    let connection = null;

    // 存储三件套：预检（Node 里没有 localStorage）与隐私模式都必须安静降级。
    function readStore(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    }
    function writeStore(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* 存不下就不存：位置与已清除记录都只是便利，不是正确性 */
      }
    }
    function readJson(key, fallback) {
      const raw = readStore(key);
      if (raw === null) return fallback;
      try {
        const value = JSON.parse(raw);
        return value ?? fallback;
      } catch {
        return fallback;
      }
    }
    function viewport() {
      const w = typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 1280;
      const h = typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 800;
      return { w, h };
    }

    const zh = {
      'count.live': '{count} 个任务进行中',
      'count.total': '{count} 个任务',
      'list.aria': '本会话的任务进度',
      'ball.title': '本会话的长任务与进度（可拖动）',
      'status.running': '进行中',
      'status.lost': '已失联',
      'status.done': '完成',
      'status.failed': '失败',
      'status.completed': '完成',
      'status.killed': '已取消',
      'status.stopping': '停止中',
      'phase.merging': '合并中',
      'phase.verifying': '校验中',
      'empty': '本会话暂无长任务',
      'clear.button': '清除已完成',
      'clear.hint': '{count} 项已完成',
      'clear.none': '没有已完成的任务',
      'clear.done': '已清除 {count} 项',
      'clear.failed': '清除失败：宿主未就绪'
    };
    const en = {
      'count.live': '{count} running',
      'count.total': '{count} task(s)',
      'list.aria': 'Task progress for this session',
      'ball.title': 'Long-running tasks and their progress (draggable)',
      'status.running': 'running',
      'status.lost': 'lost',
      'status.done': 'done',
      'status.failed': 'failed',
      'status.completed': 'done',
      'status.killed': 'cancelled',
      'status.stopping': 'stopping',
      'phase.merging': 'merging',
      'phase.verifying': 'verifying',
      'empty': 'No long-running tasks in this session',
      'clear.button': 'Clear finished',
      'clear.hint': '{count} finished',
      'clear.none': 'Nothing finished yet',
      'clear.done': 'Cleared {count}',
      'clear.failed': 'Clear failed: host not ready'
    };
    const fallbackT = (key, params) => {
      const template = zh[key] ?? key;
      if (params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''));
    };

    const CSS = [
      '.djp-root{position:fixed;inset:0;pointer-events:none;z-index:9000}',
      '.djp-root>*{pointer-events:auto}',
      '.djp-ball{position:fixed;box-sizing:border-box;width:56px;height:56px;display:flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:50%;cursor:grab;touch-action:none;color:#fff;background:linear-gradient(150deg,#3d8bf0,#1b4fa0);box-shadow:0 0 0 2px rgba(255,255,255,.92),0 0 0 3px rgba(18,30,58,.28),0 6px 18px rgba(18,38,84,.34)}',
      '.djp-ball:hover{filter:brightness(1.07)}',
      '.djp-ball:active{cursor:grabbing}',
      '.djp-ball:focus-visible{outline:2px solid #7fb0ff;outline-offset:2px}',
      '.djp-icon{display:block;width:100%;height:100%;object-fit:cover;border-radius:50%;pointer-events:none;-webkit-user-drag:none}',
      '.djp-badge{position:absolute;top:-5px;right:-5px;box-sizing:border-box;width:19px;height:19px;border-radius:50%;background:#395590;color:#fff;font-size:10.5px;line-height:19px;text-align:center;font-variant-numeric:tabular-nums;box-shadow:0 0 0 2px rgba(255,255,255,.9)}',
      '.djp-panel{position:fixed;z-index:9001;box-sizing:border-box;width:340px;display:flex;flex-direction:column;gap:6px;overflow:auto;padding:8px;border-radius:14px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-elevation-prominent)}',
      '.djp-row{display:flex;flex-direction:column;gap:5px;box-sizing:border-box;width:100%;padding:7px 8px;border-radius:8px;color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:17px}',
      '.djp-rowSettled{color:var(--dsw-alias-label-tertiary)}',
      '.djp-head{display:flex;align-items:center;gap:7px}',
      '.djp-dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}',
      '.djp-dot-running{background:#2f7de1}',
      '.djp-dot-done{background:#2f9e6b}',
      '.djp-dot-failed{background:#c9433a}',
      '.djp-dot-lost{background:#a8a8a8}',
      '.djp-label{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-family:var(--dsw-font-mono)}',
      '.djp-status{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.djp-bar{position:relative;height:4px;overflow:hidden;border-radius:2px;background:var(--dsw-alias-fill-l2)}',
      '.djp-barFill{position:absolute;top:0;left:0;height:100%;border-radius:2px;background:#2f7de1}',
      '.djp-barFill-done{background:#2f9e6b}',
      '.djp-barFill-failed{background:#c9433a}',
      '.djp-meta{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.djp-note{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
      '.djp-foot{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 8px 6px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.djp-hint{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.djp-clear{flex:none;padding:5px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:0 0;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;font-size:12px}',
      '.djp-clear:hover:enabled{background:var(--dsw-alias-fill-l2)}',
      '.djp-clear:disabled{opacity:.45;cursor:default}'
    ].join('');

    function injectStyles() {
      if (typeof document === 'undefined') return;
      const tagId = 'dsh-job-progress/styles';
      if (document.querySelector(`style[data-plugin-css="${tagId}"]`) !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-job-progress';
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    function formatBytes(value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return '0B';
      if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)}GB`;
      if (n >= 1048576) return `${(n / 1048576).toFixed(1)}MB`;
      if (n >= 1024) return `${(n / 1024).toFixed(0)}KB`;
      return `${Math.round(n)}B`;
    }

    function formatDuration(ms) {
      const total = Math.max(0, Math.floor(Number(ms) / 1000));
      const seconds = total % 60;
      const minutes = Math.floor(total / 60) % 60;
      const hours = Math.floor(total / 3600);
      if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`;
      if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`;
      return `${seconds}s`;
    }

    function percent(task) {
      if (Number(task.total) > 0) return Math.max(0, Math.min(100, Math.round((Number(task.done) / Number(task.total)) * 100)));
      if (task.status === 'done' || task.status === 'completed') return 100;
      return null;
    }

    function isLive(task) {
      return task.status === 'running' || task.status === 'stopping';
    }

    /** 显示层兜底去重：宿主已按作业 id 去重，这里防的是多来源重叠（旧宿主 / 多个进度目录）。 */
    function dedupe(tasks) {
      const seen = new Set();
      const out = [];
      for (const task of tasks) {
        const key = String(task.key ?? task.jobId ?? task.label ?? '');
        if (key.length > 0) {
          if (seen.has(key)) continue;
          seen.add(key);
        }
        out.push(task);
      }
      return out.length === tasks.length ? tasks : out;
    }

    /**
     * 忽略名单的键。作业 id 是 <kind>-N、按进程从 1 计数，重启后新作业会又叫 pwsh-1；
     * 所以键里必须带上 startedAt，否则上一轮的忽略记录会把新作业误挡在面板外
     * （2026-09-20 实测：重启后新起的 pwsh-1 被旧记录挡住）。
     */
    function dismissKey(task) {
      return String(task.jobId ?? task.key ?? task.label ?? '') + '@' + String(task.startedAt ?? 0);
    }

    function statusText(task, t) {
      if (task.status === 'running' && task.phase === 'merging') return t('phase.merging');
      if (task.status === 'running' && task.phase === 'verifying') return t('phase.verifying');
      if (task.status === 'running') return t('status.running');
      if (task.status === 'lost') return t('status.lost');
      const known = t(`status.${task.status}`);
      return known === `status.${task.status}` ? String(task.status ?? '') : known;
    }

    /** Ask the host for this session's merged task list. */
    async function queryProgress(sessionId) {
      if (connection === null || sessionId === undefined) return null;
      try {
        const result = await connection.rpc.call('/api', 'jobProgress/snapshot', {
          args: { request: { sessionId } }
        });
        if (result !== null && typeof result === 'object' && result.ok === true) return result.value;
        return null;
      } catch {
        return null;
      }
    }

    /** Delete the finished progress files of this session (running ones are never touched). */
    async function clearProgress(sessionId) {
      if (connection === null || sessionId === undefined) return null;
      try {
        const result = await connection.rpc.call('/api', 'jobProgress/clear', {
          args: { request: { sessionId } }
        });
        if (result !== null && typeof result === 'object' && result.ok === true) return result.value;
        return null;
      } catch {
        return null;
      }
    }

    /** 球的位置：记住上次拖到哪，但每次都要按当前视口夹紧（窗口可能变小了）。 */
    function loadPosition() {
      const { w, h } = viewport();
      const saved = readJson(POS_KEY, null);
      const fallback = { x: w - BALL - 24, y: Math.max(8, Math.round(h * 0.62)) };
      if (saved === null || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) return fallback;
      return {
        x: Math.min(Math.max(8, saved.x), Math.max(8, w - BALL - 8)),
        y: Math.min(Math.max(8, saved.y), Math.max(8, h - BALL - 8))
      };
    }

    /** One row: label, status, progress bar, numbers, elapsed time. */
    function Row(props) {
      const task = props.task;
      const t = props.t;
      const now = props.now;
      const live = isLive(task);
      const pct = percent(task);
      const elapsedMs = live ? now - (task.startedAt ?? now) : (task.finishedAt ?? task.updatedAt ?? now) - (task.startedAt ?? now);
      const numbers = [];
      if (task.hasProgress && pct !== null) numbers.push(`${pct}%`);
      if (task.hasProgress && Number(task.total) > 0) {
        numbers.push(task.unit === 'count' ? `${task.done}/${task.total}` : `${formatBytes(task.done)}/${formatBytes(task.total)}`);
      }
      if (live && Number(task.speed) > 0) numbers.push(task.unit === 'count' ? `${Number(task.speed).toFixed(1)}/s` : `${formatBytes(task.speed)}/s`);
      if (live && Number(task.eta) > 0) numbers.push(`剩${formatDuration(Number(task.eta) * 1000)}`);
      numbers.push(formatDuration(elapsedMs));
      return h('li', { className: live ? 'djp-row' : 'djp-row djp-rowSettled' },
        h('div', { className: 'djp-head' },
          h('span', { className: `djp-dot djp-dot-${task.status}` }),
          h('span', { className: 'djp-label', title: task.label }, String(task.label ?? '')),
          h('span', { className: 'djp-status' }, statusText(task, t))
        ),
        task.hasProgress && pct !== null
          ? h('div', { className: 'djp-bar' },
            h('div', {
              className: task.status === 'done' || task.status === 'completed' ? 'djp-barFill djp-barFill-done' : task.status === 'failed' ? 'djp-barFill djp-barFill-failed' : 'djp-barFill',
              style: { width: `${pct}%` }
            }))
          : null,
        h('div', { className: 'djp-meta' }, numbers.join(' · ')),
        task.note ? h('div', { className: 'djp-note', title: task.note }, task.note) : null
      );
    }

    function JobProgressAction(props) {
      const sessionId = props.sessionId;
      const useSessions = props.useSessions;
      const t = props.t ?? fallbackT;
      const jobs = useSessions((state) => (state.jobsBySession ?? {})[sessionId]) ?? EMPTY;
      const [tasks, setTasks] = React.useState(EMPTY);
      const [open, setOpen] = React.useState(false);
      const [now, setNow] = React.useState(() => Date.now());
      const [pos, setPos] = React.useState(() => loadPosition());
      const [flash, setFlash] = React.useState('');
      const [dismissed, setDismissed] = React.useState(() => new Set(readJson(DISMISS_PREFIX + sessionId, [])));
      const rootRef = React.useRef(null);
      const dragRef = React.useRef(null);
      const jobCount = jobs.length;

      React.useEffect(() => {
        let alive = true;
        let timer = null;
        const pull = async () => {
          const value = await queryProgress(sessionId);
          if (!alive || value === null) return;
          setTasks(dedupe(Array.isArray(value.tasks) ? value.tasks : EMPTY));
        };
        pull();
        timer = setInterval(pull, jobCount > 0 ? POLL_MS : POLL_IDLE_MS);
        return () => {
          alive = false;
          if (timer !== null) clearInterval(timer);
        };
      }, [sessionId, jobCount]);

      React.useEffect(() => {
        if (!open) return undefined;
        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
      }, [open]);

      // flash 只活 4 秒，之后回到「N 项已完成」的常规提示       React.useEffect(() => {         if (flash === '') return undefined;         const timer = setTimeout(() => setFlash(''), 4000);         return () => clearTimeout(timer);       }, [flash]);

      React.useEffect(() => {
        if (!open) return undefined;
        const onPointer = (event) => {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false);
        };
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onPointer, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
          document.removeEventListener('pointerdown', onPointer, true);
          document.removeEventListener('keydown', onKey, true);
        };
      }, [open]);

      // 终态作业在注册表里删不掉（只读投影），所以「清除」把它们记进本地忽略名单。
      const visible = React.useMemo(() => dedupe(tasks).filter((task) => {
        if (isLive(task)) return true;
        const id = dismissKey(task);
        return !dismissed.has(id);
      }), [tasks, dismissed]);

      const onPointerDown = (event) => {
        if (typeof event.button === 'number' && event.button !== 0) return;
        dragRef.current = { id: event.pointerId, sx: event.clientX, sy: event.clientY, ox: pos.x, oy: pos.y, moved: false };
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          /* 捕获失败不影响拖动本身 */
        }
      };
      const onPointerMove = (event) => {
        const drag = dragRef.current;
        if (drag === null || drag.id !== event.pointerId) return;
        const dx = event.clientX - drag.sx;
        const dy = event.clientY - drag.sy;
        if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
        drag.moved = true;
        const { w, h } = viewport();
        const next = {
          x: Math.min(Math.max(8, drag.ox + dx), Math.max(8, w - BALL - 8)),
          y: Math.min(Math.max(8, drag.oy + dy), Math.max(8, h - BALL - 8))
        };
        setPos(next);
        writeStore(POS_KEY, JSON.stringify(next));
      };
      const onPointerUp = (event) => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (drag === null || drag.moved) return;      // 拖动过就不算点击
        setOpen((current) => !current);
      };

      const clearFinished = async () => {
        const finished = visible.filter((task) => !isLive(task));
        const result = await clearProgress(sessionId);
        if (result === null) {
          // 宿主没应答（旧宿主 / 未重启 / RPC 不可达）时绝不能报成功：2026-09-20 实测踩到 ——
          // 宿主还是旧版、没有 clear 端点（404），界面照样报「已清除 3 项」并把行藏了，
          // 而磁盘上一个文件都没少。看不见的谎报比看得见的失败更坏。
          setFlash(t('clear.failed'));
          return;
        }
        const next = new Set(dismissed);
        for (const task of finished) next.add(dismissKey(task));
        setDismissed(next);
        writeStore(DISMISS_PREFIX + sessionId, JSON.stringify([...next].slice(-200)));
        const value = await queryProgress(sessionId);
        if (value !== null) setTasks(dedupe(Array.isArray(value.tasks) ? value.tasks : EMPTY));
        // 清除成功后不报数（按用户要求）：hint 会自然回到「没有已完成的任务」。
      };

      // 判据一：有可见任务就亮相（进度数字随后到）。
      // 判据二：镜像里还有「没被清除掉的」作业 —— 用作业 id + startedAt 去比忽略名单，
      // 这样新起的作业立刻就可见，而清除之后球会真的消失（2026-09-20 实测两处都踩过：
      // 只按 jobCount 判会让清除后球赖着不走；只按 visible 判则 RPC 慢时球根本不出现）。
      const hasUndismissedJob = jobs.some((job) => !dismissed.has(dismissKey({ jobId: job.id, startedAt: job.startedAt })));
      if (visible.length === 0 && !hasUndismissedJob) return null;

      const liveCount = visible.filter(isLive).length;
      const finishedCount = visible.length - liveCount;
      const { w: vw, h: vh } = viewport();
      const panelLeft = Math.min(Math.max(8, pos.x + BALL - PANEL_W), Math.max(8, vw - PANEL_W - 8));
      const openUpward = pos.y > vh * 0.45;
      const panelStyle = openUpward
        ? { left: panelLeft, bottom: Math.max(8, vh - pos.y + 12), maxHeight: Math.min(PANEL_MAX_H, Math.max(160, pos.y - 24)) }
        : { left: panelLeft, top: Math.min(vh - 160, pos.y + BALL + 12), maxHeight: Math.min(PANEL_MAX_H, Math.max(160, vh - pos.y - BALL - 24)) };

      return h('div', { className: 'djp-root', ref: rootRef },
        h('button', {
          type: 'button',
          className: 'djp-ball',
          style: { left: pos.x, top: pos.y },
          title: t('ball.title'),
          'aria-label': t('list.aria'),
          'aria-expanded': open,
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              setOpen((current) => !current);
            }
          }
        },
          h('img', { className: 'djp-icon', src: ICON_DATA, alt: '', draggable: false }),
          liveCount > 0 ? h('span', { className: 'djp-badge', title: t('count.live', { count: liveCount }) }, liveCount > 9 ? '9+' : String(liveCount)) : null
        ),
        open
          ? h('div', { className: 'djp-panel', style: panelStyle, role: 'dialog', 'aria-label': t('list.aria') },
            h('div', { className: 'djp-foot' },
              h('span', { className: 'djp-hint', title: flash || t('clear.hint', { count: finishedCount }) },
                flash !== '' ? flash : finishedCount > 0 ? t('clear.hint', { count: finishedCount }) : t('clear.none')),
              h('button', {
                type: 'button',
                className: 'djp-clear',
                disabled: finishedCount === 0,
                onClick: clearFinished
              }, t('clear.button'))
            ),
            h('ul', { className: 'djp-list', style: { display: 'flex', flexDirection: 'column', gap: 4, margin: 0, padding: 0, listStyle: 'none' } },
              visible.length === 0
                ? h('li', { className: 'djp-row djp-rowSettled' }, t('empty'))
                : visible.map((task) => h(Row, { key: task.key ?? task.label, task, t, now })))
          )
          : null
      );
    }

    /** Required client services: session store, slot registry, locale, RPC carrier. */
    const inject = ['sessions', 'slots', 'locale', 'connection'];

    /** Client plugin body: dictionaries, styles, then the floating ball. */
    function apply(ctx) {
      connection = ctx.connection ?? null;
      ctx.effect(() => injectStyles(), 'dsh-job-progress: styles');
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-job-progress: dictionaries');
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'job-progress',
        order: 21,
        locale: NS
      }, JobProgressAction));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
