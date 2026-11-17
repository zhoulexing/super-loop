/**
 * 数据层：client 实例、TanStack Query 查询、SSE 实时订阅。
 * 看板只通过 @super-loop/client 访问 Kernel API（AGENTS.md「职责与依赖」）。
 */
import { createClient, type LoopClient, paginate } from '@super-loop/client';
import type {
  Approval,
  JournalEvent,
  PluginWithHealth,
  Task,
  TaskId,
  TaskStatus,
  TraceId,
} from '@super-loop/protocol';
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';

// ───────────────────────────── 连接设置 ─────────────────────────────

const TOKEN_KEY = 'super-loop.token';
const USER_KEY = 'super-loop.user';

function readStorage(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeStorage(key: string, value: string | undefined): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    // 隐私模式等场景下忽略
  }
}

/** 支持 `?token=` 一次性带入（随后从地址栏移除）。 */
function initialToken(): string | undefined {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    writeStorage(TOKEN_KEY, fromUrl);
    url.searchParams.delete('token');
    window.history.replaceState(null, '', url);
    return fromUrl;
  }
  return readStorage(TOKEN_KEY);
}

export const settings = {
  token: initialToken(),
  user: readStorage(USER_KEY) ?? 'me',
};

function makeClient(): LoopClient {
  return createClient({
    ...(settings.token ? { token: settings.token } : {}),
    user: settings.user,
  });
}

export let loop = makeClient();

export function saveSettings(next: { token?: string; user?: string }): void {
  if (next.token !== undefined) {
    settings.token = next.token || undefined;
    writeStorage(TOKEN_KEY, settings.token);
  }
  if (next.user) {
    settings.user = next.user;
    writeStorage(USER_KEY, next.user);
  }
  loop = makeClient();
}

// ───────────────────────────── 查询 ─────────────────────────────

export const OPEN_STATUSES: readonly TaskStatus[] = [
  'unassigned',
  'pending_approval',
  'queued',
  'running',
  'waiting_approval',
  'awaiting_input',
  'failed',
];
const CLOSED_LIMIT = 100;

export const qk = {
  health: ['health'] as const,
  plugins: ['plugins'] as const,
  tasks: ['tasks'] as const,
  approvals: ['approvals'] as const,
  task: (id: TaskId) => ['task', id] as const,
  trace: (id: TraceId) => ['trace', id] as const,
};

export interface BoardData {
  tasks: Task[];
  /** 已关闭的任务只取最近 CLOSED_LIMIT 条。 */
  closedTruncated: boolean;
}

export function useBoard() {
  return useQuery({
    queryKey: qk.tasks,
    queryFn: async (): Promise<BoardData> => {
      const open: Task[] = [];
      for await (const t of paginate((cursor) =>
        loop.tasks.list({ status: OPEN_STATUSES, limit: 500, ...(cursor ? { cursor } : {}) }),
      )) {
        open.push(t);
      }
      const closed = await loop.tasks.list({ status: 'closed', limit: CLOSED_LIMIT });
      return { tasks: [...open, ...closed.items], closedTruncated: !!closed.nextCursor };
    },
  });
}

export function useHealth() {
  return useQuery({
    queryKey: qk.health,
    queryFn: () => loop.health(),
    refetchInterval: 10_000,
  });
}

export function usePlugins() {
  return useQuery({
    queryKey: qk.plugins,
    queryFn: async () => (await loop.plugins.list()).items,
    staleTime: 30_000,
  });
}

export function useRoutes() {
  return useQuery({
    queryKey: ['routes'],
    queryFn: async () => (await loop.routes.list()).items,
    staleTime: 60_000,
  });
}

export interface AgentInfo {
  id: string;
  name: string;
  color: string;
  resumable: boolean;
  ready: boolean;
}

const AGENT_COLORS = ['var(--ag-1)', 'var(--ag-2)', 'var(--ag-3)'];

export function agentsFrom(plugins: readonly PluginWithHealth[] | undefined): AgentInfo[] {
  return (plugins ?? [])
    .filter((p) => p.kind === 'agent')
    .map((p, i) => ({
      id: p.instance,
      name: p.instance.endsWith(':default') ? p.instance.slice(0, -8) : p.instance,
      color: AGENT_COLORS[i % AGENT_COLORS.length] as string,
      resumable: p.capabilities?.resumable ?? false,
      ready: p.status === 'ready',
    }));
}

/** 待审批，按任务 ID 索引。 */
export function usePendingApprovals() {
  return useQuery({
    queryKey: qk.approvals,
    queryFn: async () => {
      const { items } = await loop.approvals.list({ status: 'pending', limit: 500 });
      const byTask = new Map<string, Approval>();
      for (const a of items) if (a.subject.kind === 'task') byTask.set(a.subject.id, a);
      return byTask;
    },
  });
}

export function useTaskDetail(id: TaskId | undefined) {
  return useQuery({
    queryKey: id ? qk.task(id) : ['task', 'none'],
    queryFn: () => loop.tasks.get(id as TaskId),
    enabled: id !== undefined,
  });
}

/** 一条 trace 的全部 Journal 事件（工具调用、Agent 切换等，用于对话时间线）。 */
export function useTrace(traceId: TraceId | undefined) {
  return useQuery({
    queryKey: traceId ? qk.trace(traceId) : ['trace', 'none'],
    queryFn: async () => {
      const out: JournalEvent[] = [];
      let fromSeq = 1;
      for (let page = 0; page < 20; page++) {
        const res = await loop.journal.list({ traceId: traceId as string, fromSeq, limit: 500 });
        out.push(...res.items);
        if (res.items.length < 500 || res.nextFromSeq === undefined) break;
        fromSeq = res.nextFromSeq;
      }
      return out;
    },
    enabled: traceId !== undefined,
  });
}

// ───────────────────────────── 本地实时状态 ─────────────────────────────

export interface LiveStep {
  runId: string;
  startedAt?: number;
  step?: string;
}

interface LiveState {
  connected: boolean;
  /** taskId → 当前 Run 的进度（来自 run.started / run.event）。 */
  steps: Map<string, LiveStep>;
  /** 本轮完成后还没打开看过的任务。 */
  unread: Set<string>;
}

let live: LiveState = { connected: false, steps: new Map(), unread: new Set() };
const listeners = new Set<() => void>();
const emit = (next: Partial<LiveState>) => {
  live = { ...live, ...next };
  for (const l of listeners) l();
};

export function useLive(): LiveState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => live,
  );
}

export function markRead(taskId: string): void {
  if (!live.unread.has(taskId)) return;
  const unread = new Set(live.unread);
  unread.delete(taskId);
  emit({ unread });
}

/** 当前打开的任务（打开中的任务完成时不标记未读）。 */
let openTaskId: string | undefined;
export const setOpenTask = (id: string | undefined) => {
  openTaskId = id;
  if (id) markRead(id);
};

function describeStep(data: Record<string, unknown>): string | undefined {
  switch (data.type) {
    case 'tool_call': {
      const input = data.input as Record<string, unknown> | undefined;
      const arg =
        input && typeof input === 'object'
          ? Object.values(input).find((v) => typeof v === 'string')
          : undefined;
      return `${String(data.name)}${arg ? ` ${String(arg).slice(0, 80)}` : ''}`;
    }
    case 'message':
      return String(data.content ?? '')
        .split('\n')[0]
        ?.slice(0, 80);
    case 'log':
      return String(data.message ?? '').slice(0, 80);
    default:
      return undefined;
  }
}

function applyLive(events: JournalEvent[]): void {
  let steps: Map<string, LiveStep> | undefined;
  let unread: Set<string> | undefined;
  for (const e of events) {
    const data = (e.data ?? {}) as Record<string, unknown>;
    const taskId = typeof data.taskId === 'string' ? data.taskId : undefined;
    if (e.type === 'run.started' && taskId) {
      steps ??= new Map(live.steps);
      steps.set(taskId, { runId: e.subject.id, startedAt: Date.parse(e.at), step: '准备工作区' });
    } else if (e.type === 'run.event' && taskId) {
      const step = describeStep(data);
      if (!step) continue;
      steps ??= new Map(live.steps);
      const prev = steps.get(taskId);
      steps.set(taskId, { ...prev, runId: e.subject.id, step });
    } else if (e.type === 'task.awaiting_input' && e.subject.id !== openTaskId) {
      unread ??= new Set(live.unread);
      unread.add(e.subject.id);
    } else if (
      (e.type === 'task.closed' || e.type === 'task.queued') &&
      live.unread.has(e.subject.id)
    ) {
      unread ??= new Set(live.unread);
      unread.delete(e.subject.id);
    }
  }
  if (steps || unread) emit({ ...(steps ? { steps } : {}), ...(unread ? { unread } : {}) });
}

/** 根据事件决定刷新哪些查询（合并 150ms 内的事件）。 */
function makeInvalidator(qc: QueryClient) {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    for (const key of pending) void qc.invalidateQueries({ queryKey: JSON.parse(key) });
    pending.clear();
  };
  const add = (key: readonly unknown[]) => {
    pending.add(JSON.stringify(key));
    if (timer === undefined) timer = setTimeout(flush, 150);
  };
  return (events: JournalEvent[]) => {
    for (const e of events) {
      const [kind] = e.type.split('.');
      const data = (e.data ?? {}) as Record<string, unknown>;
      if (kind === 'task' || kind === 'envelope') add(qk.tasks);
      if (kind === 'run' && e.type !== 'run.event') add(qk.tasks);
      if (kind === 'approval') {
        add(qk.approvals);
        add(qk.tasks);
      }
      if (kind === 'plugin') {
        add(qk.plugins);
        add(qk.health);
      }
      const taskId = e.subject.kind === 'task' ? e.subject.id : (data.taskId as string | undefined);
      if (taskId) add(qk.task(taskId as TaskId));
      if (e.traceId) add(qk.trace(e.traceId));
    }
  };
}

/** 挂在根组件：订阅 SSE，驱动查询刷新与本地实时状态；重连后全量刷新。 */
export function useLiveEvents(enabled: boolean): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const invalidate = makeInvalidator(qc);
    let opened = false;
    const sub = loop.stream({
      onOpen: () => {
        emit({ connected: true });
        if (opened) void qc.invalidateQueries();
        opened = true;
      },
      onEvent: (e) => {
        applyLive([e]);
        invalidate([e]);
      },
      onError: () => emit({ connected: false }),
    });
    return () => sub.close();
  }, [enabled, qc]);
}
