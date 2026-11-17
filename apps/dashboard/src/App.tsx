import { isLoopApiError } from '@super-loop/client';
import type { Task } from '@super-loop/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Board, type ViewState } from './components/Board.js';
import { Drawer } from './components/Drawer.js';
import { NewTask } from './components/NewTask.js';
import { Icon, useUi } from './components/ui.js';
import { useActions } from './lib/actions.js';
import {
  agentsFrom,
  saveSettings,
  setOpenTask,
  settings,
  useBoard,
  useHealth,
  useLive,
  useLiveEvents,
  usePendingApprovals,
  usePlugins,
  useRoutes,
} from './lib/api.js';
import { NO_AGENT_LANE } from './lib/board.js';

const VIEW_KEY = 'super-loop.view';

function loadView(): Pick<ViewState, 'lanes' | 'density'> {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}');
    return {
      lanes: v.lanes === 'agent' ? 'agent' : 'none',
      density: v.density === 'compact' ? 'compact' : 'detail',
    };
  } catch {
    return { lanes: 'none', density: 'detail' };
  }
}

function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** 当前打开的任务与地址 `/tasks/<id>` 同步（通知里的链接直接打开对应任务）。 */
function useRoutedTask(): [string | undefined, (id: string | undefined) => void] {
  const read = () => /^\/tasks\/(task_[0-9A-Z]{26})/.exec(window.location.pathname)?.[1];
  const [id, setId] = useState<string | undefined>(read);
  useEffect(() => {
    const onPop = () => setId(read());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const set = useCallback((next: string | undefined) => {
    setId(next);
    const path = next ? `/tasks/${next}` : '/';
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
  }, []);
  return [id, set];
}

function TokenGate({ message }: { message: string }) {
  const [token, setToken] = useState('');
  const [user, setUser] = useState(settings.user);
  return (
    <form
      className="gate"
      onSubmit={(e) => {
        e.preventDefault();
        saveSettings({ token, user });
        window.location.reload();
      }}
    >
      <h3>连接 Super Loop</h3>
      <p className="note" style={{ margin: 0 }}>
        {message}。请输入 server 配置的 token（config.json 的 server.token 或
        SUPER_LOOP_API_TOKEN）。
      </p>
      <label className="f" htmlFor="gToken">
        Token
        <input
          id="gToken"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      <label className="f" htmlFor="gUser">
        操作人（记录在审计日志中）
        <input id="gUser" value={user} onChange={(e) => setUser(e.target.value)} />
      </label>
      <div className="row">
        <button type="submit" className="btn primary">
          连接
        </button>
      </div>
    </form>
  );
}

export function App() {
  const ui = useUi();
  const actions = useActions();
  const board = useBoard();
  const health = useHealth();
  const plugins = usePlugins();
  const routes = useRoutes();
  const approvals = usePendingApprovals();
  const live = useLive();
  const now = useNow(1000);
  const [openId, setOpenId] = useRoutedTask();
  const [agentFilter, setAgentFilter] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [closedOpen, setClosedOpen] = useState(false);
  const [view, setView] = useState(loadView);
  const search = useRef<HTMLInputElement>(null);

  const denied = isLoopApiError(board.error) && board.error.code === 'PERMISSION_DENIED';
  useLiveEvents(!denied && board.isSuccess);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(view));
    } catch {
      // 忽略
    }
  }, [view]);
  useEffect(() => setOpenTask(openId), [openId]);

  const agents = useMemo(() => agentsFrom(plugins.data), [plugins.data]);
  const tasks: Task[] = board.data?.tasks ?? [];
  const approvalMap = approvals.data ?? new Map();
  const approvalCount = tasks.filter(
    (t) => t.status === 'pending_approval' || t.status === 'waiting_approval',
  ).length;

  const newTask = useCallback(
    () =>
      ui.openModal(
        <NewTask
          agents={agents}
          routes={routes.data ?? []}
          onCreated={(id) => {
            if (id) setOpenId(id);
          }}
        />,
      ),
    [ui, agents, routes.data, setOpenId],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        search.current?.focus();
        return;
      }
      if (ui.hasOverlay) return;
      const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '');
      if (e.key === 'Escape' && openId && !typing) setOpenId(undefined);
      if (!typing && !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        newTask();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ui.hasOverlay, openId, setOpenId, newTask]);

  if (denied) return <TokenGate message="需要鉴权" />;

  const h = health.data;
  const running = tasks.filter((t) => t.status === 'running').length;
  const pill = health.isError ? (
    <>
      <span className="dot down" />
      无法连接内核
    </>
  ) : !h ? (
    <>
      <span className="dot wait" />
      连接中…
    </>
  ) : (
    <>
      <span
        className={`dot${h.kernel !== 'running' ? ' paused' : live.connected ? '' : ' wait'}`}
      />
      {h.kernel === 'running' ? '运行中' : h.kernel}
      {' · 执行中 '}
      <span className="mono">
        {running}/{h.concurrency}
      </span>
      {!live.connected && ' · 实时连接中断，重连中'}
    </>
  );

  const fallback = tasks.find((t) => t.id === openId);

  return (
    <>
      <header className="top">
        <div className="brand">
          <b>Super Loop</b>
          <span>任务看板</span>
        </div>
        <span className="pill">{pill}</span>
        <div className="spacer" />
        <label className="search" htmlFor="q">
          <Icon name="search" />
          <input
            id="q"
            ref={search}
            type="search"
            placeholder="搜索标题或 ID"
            autoComplete="off"
            value={q}
            onChange={(e) => setQ(e.target.value.trim())}
          />
          <span className="kbd">⌘K</span>
        </label>
        <button
          className="btn"
          type="button"
          onClick={() => {
            const head = document.querySelector<HTMLElement>('[data-colhead="approval"]');
            head?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
            head?.classList.remove('flash');
            void head?.offsetWidth;
            head?.classList.add('flash');
          }}
        >
          待审批 {approvalCount > 0 && <span className="badge">{approvalCount}</span>}
        </button>
        <button className="btn primary" type="button" onClick={newTask}>
          <Icon name="plus" />
          新建任务
        </button>
      </header>

      <div className="toolbar">
        <div className="tgroup">
          <span className="tlabel">Agent</span>
          {[
            ...agents.map((a) => ({ id: a.id, name: a.name, color: a.color })),
            { id: NO_AGENT_LANE, name: '未指定', color: '' },
          ].map((a) => (
            <button
              key={a.id}
              type="button"
              className="chip"
              aria-pressed={agentFilter.has(a.id)}
              onClick={() =>
                setAgentFilter((s) => {
                  const n = new Set(s);
                  if (n.has(a.id)) n.delete(a.id);
                  else n.add(a.id);
                  return n;
                })
              }
            >
              {a.color && <span className="ag-dot" style={{ background: a.color }} />}
              {a.name}
            </button>
          ))}
        </div>
        <div className="tgroup">
          <span className="tlabel">泳道</span>
          <fieldset className="seg" aria-label="泳道" style={{ margin: 0, padding: 0 }}>
            {(
              [
                ['none', '无'],
                ['agent', '按 Agent'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                aria-pressed={view.lanes === k}
                onClick={() => setView((v) => ({ ...v, lanes: k }))}
              >
                {label}
              </button>
            ))}
          </fieldset>
        </div>
        <div className="tgroup">
          <span className="tlabel">密度</span>
          <fieldset className="seg" aria-label="密度" style={{ margin: 0, padding: 0 }}>
            {(
              [
                ['detail', '详细'],
                ['compact', '紧凑'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                aria-pressed={view.density === k}
                onClick={() => setView((v) => ({ ...v, density: k }))}
              >
                {label}
              </button>
            ))}
          </fieldset>
        </div>
        <span className="note">
          拖动卡片表达你的决定：分配、调整顺序、追问、重新打开或关闭。按 N 新建任务。
        </span>
      </div>

      <div className="workspace">
        {board.isPending ? (
          <p className="loading">加载中…</p>
        ) : board.isError ? (
          <p className="loading err-text">加载失败：{String(board.error)}</p>
        ) : (
          <Board
            tasks={tasks}
            agents={agents}
            approvals={approvalMap}
            steps={live.steps}
            unread={live.unread}
            view={{ ...view, agentFilter, q, closedOpen }}
            concurrency={h?.concurrency}
            closedTruncated={board.data.closedTruncated}
            selectedId={openId}
            now={now}
            actions={actions}
            onOpen={setOpenId}
            onToggleClosed={() => setClosedOpen((v) => !v)}
          />
        )}
        {openId && (
          <Drawer
            key={openId}
            taskId={openId}
            fallback={fallback}
            agents={agents}
            approval={approvalMap.get(openId)}
            live={live.steps.get(openId)}
            now={now}
            actions={actions}
            onClose={() => setOpenId(undefined)}
          />
        )}
      </div>
    </>
  );
}
