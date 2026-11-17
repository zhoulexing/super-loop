/**
 * 看板的纯逻辑：状态 → 列、拖拽规则、排序、派发顺序（rank）计算。不依赖 React，便于单测。
 */
import type { InstanceName, Priority, Task, TaskStatus } from '@super-loop/protocol';

export type ColumnKey =
  | 'unassigned'
  | 'queued'
  | 'running'
  | 'approval'
  | 'awaiting'
  | 'failed'
  | 'closed';

export interface Column {
  key: ColumnKey;
  name: string;
  hint: string;
  /** 由系统推进，不能拖入。 */
  locked?: boolean;
}

export const COLUMNS: readonly Column[] = [
  { key: 'unassigned', name: '未分配', hint: '等待分配 Agent（人工或 Router）' },
  { key: 'queued', name: '排队中', hint: '有空闲时自动开始，拖动可调整顺序' },
  { key: 'running', name: '执行中', hint: '系统推进，只能拖去关闭', locked: true },
  { key: 'approval', name: '待审批', hint: '需要你决定', locked: true },
  { key: 'awaiting', name: '等待追问', hint: '本轮完成，会话仍开着' },
  { key: 'failed', name: '失败', hint: '重试、换 Agent 或关闭' },
  { key: 'closed', name: '已关闭', hint: '拖回「等待追问」可重新打开' },
];

const COLUMN_OF: Record<TaskStatus, ColumnKey> = {
  unassigned: 'unassigned',
  pending_approval: 'approval',
  queued: 'queued',
  running: 'running',
  waiting_approval: 'approval',
  awaiting_input: 'awaiting',
  failed: 'failed',
  closed: 'closed',
};

export const columnOf = (status: TaskStatus): ColumnKey => COLUMN_OF[status];

export const STATUS_NAME: Record<ColumnKey, string> = {
  unassigned: '未分配',
  queued: '排队中',
  running: '执行中',
  approval: '待审批',
  awaiting: '等待追问',
  failed: '失败',
  closed: '已关闭',
};

/** 拖拽只表达人的决定：从哪一列可以拖到哪一列。 */
export const ALLOWED: Record<ColumnKey, readonly ColumnKey[]> = {
  unassigned: ['queued', 'closed'],
  queued: ['unassigned', 'queued', 'closed'],
  running: ['closed'],
  approval: ['closed'],
  awaiting: ['queued', 'awaiting', 'closed'],
  failed: ['queued', 'failed', 'closed'],
  closed: ['awaiting'],
};

/** 泳道：'all' 表示不分泳道，'__none' 表示未指定 Agent。 */
export type LaneKey = 'all' | '__none' | InstanceName;
export const NO_AGENT_LANE = '__none';

export const laneOf = (t: Task): LaneKey => t.agent?.agent ?? NO_AGENT_LANE;
const laneAgent = (lane: LaneKey): InstanceName | undefined =>
  lane === 'all' || lane === NO_AGENT_LANE ? undefined : lane;

export function canDrop(t: Task, col: ColumnKey, lane: LaneKey): boolean {
  const from = columnOf(t.status);
  if (!ALLOWED[from].includes(col)) return false;
  const agent = laneAgent(lane);
  if (col === from) {
    if (col === 'queued') return true; // 调整顺序
    return agent !== undefined && agent !== t.agent?.agent; // 同列跨泳道 = 改派
  }
  if (col === 'unassigned' && agent) return false;
  return true;
}

export type DropAction =
  | { kind: 'reorder'; rank: number; priority?: Priority }
  | { kind: 'reassign'; agent: InstanceName }
  | { kind: 'assign'; agent?: InstanceName }
  | { kind: 'unassign' }
  | { kind: 'close' }
  | { kind: 'reopen' }
  | { kind: 'followup'; agent?: InstanceName };

/**
 * 把一次拖放翻译成要执行的动作（可能多个，例如跨泳道拖动排序 = 改派 + 调整顺序）。
 * `queued` 为当前排队列（已排序），`beforeId` 为插入到哪张卡片之前（为空表示末尾）。
 */
export function planDrop(
  t: Task,
  col: ColumnKey,
  lane: LaneKey,
  ctx: { queued: readonly Task[]; beforeId?: string | undefined },
): DropAction[] {
  if (!canDrop(t, col, lane)) return [];
  const from = columnOf(t.status);
  const agent = laneAgent(lane);
  if (col === from) {
    const out: DropAction[] = [];
    if (agent && agent !== t.agent?.agent) out.push({ kind: 'reassign', agent });
    if (col === 'queued') out.push({ kind: 'reorder', ...rankFor(t, ctx.queued, ctx.beforeId) });
    return out;
  }
  if (col === 'closed') return [{ kind: 'close' }];
  if (col === 'awaiting' && from === 'closed') return [{ kind: 'reopen' }];
  if (col === 'unassigned') return [{ kind: 'unassign' }];
  if (col === 'queued' && from === 'unassigned')
    return [{ kind: 'assign', ...(agent ? { agent } : {}) }];
  if (col === 'queued') return [{ kind: 'followup', ...(agent ? { agent } : {}) }];
  return [];
}

/** 派发顺序：优先级升序，同优先级按 rank 升序。 */
export function byDispatchOrder(a: Task, b: Task): number {
  return a.priority - b.priority || a.rank - b.rank || a.id.localeCompare(b.id);
}

/**
 * 把 t 插到 beforeId 之前（为空则末尾）时的新 rank；
 * 优先级跟随相邻卡片（优先下一张），保证排序后确实落在拖放的位置。
 */
export function rankFor(
  t: Task,
  queued: readonly Task[],
  beforeId: string | undefined,
): { rank: number; priority?: Priority } {
  const list = queued.filter((x) => x.id !== t.id).sort(byDispatchOrder);
  let idx = beforeId ? list.findIndex((x) => x.id === beforeId) : list.length;
  if (idx < 0) idx = list.length;
  const prev = list[idx - 1];
  const next = list[idx];
  const priority = (next ?? prev)?.priority ?? t.priority;
  const prevSame = prev?.priority === priority ? prev : undefined;
  const nextSame = next?.priority === priority ? next : undefined;
  const rank =
    prevSame && nextSame
      ? (prevSame.rank + nextSame.rank) / 2
      : nextSame
        ? nextSame.rank - 1
        : prevSame
          ? prevSame.rank + 1
          : t.rank;
  return priority === t.priority ? { rank } : { rank, priority };
}

/** 各列内的显示顺序。 */
export function sortColumn(list: Task[], col: ColumnKey): Task[] {
  if (col === 'queued') return list.sort(byDispatchOrder);
  if (col === 'closed') {
    return list.sort((a, b) =>
      (b.closedAt ?? b.updatedAt).localeCompare(a.closedAt ?? a.updatedAt),
    );
  }
  return list.sort((a, b) => a.priority - b.priority || b.updatedAt.localeCompare(a.updatedAt));
}

export function matchesQuery(t: Task, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  return t.subject.toLowerCase().includes(s) || t.id.toLowerCase().includes(s);
}
