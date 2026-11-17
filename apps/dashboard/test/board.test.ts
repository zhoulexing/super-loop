import type { Task } from '@super-loop/protocol';
import { describe, expect, it } from 'vitest';
import { canDrop, columnOf, planDrop, rankFor, sortColumn } from '../src/lib/board.js';
import { agentName, ago, sourceLabel } from '../src/lib/format.js';

let n = 0;
function task(patch: Partial<Task> = {}): Task {
  n += 1;
  return {
    id: `task_01JABCDEFGHJKMNPQRSTV${String(n).padStart(5, '0')}` as Task['id'],
    envelopeId: 'env_01JABCDEFGHJKMNPQRSTVWXYZ0',
    traceId: 'trc_01JABCDEFGHJKMNPQRSTVWXYZ0',
    subject: `t${n}`,
    source: 'manual:api',
    sinks: [],
    policy: { timeoutMs: 1, maxAttempts: 3, backoff: { type: 'fixed', baseMs: 1, maxMs: 1 } },
    priority: 2,
    rank: n * 10,
    status: 'queued',
    closeOnComplete: false,
    attempts: 0,
    turnCount: 1,
    artifactCount: 0,
    createdAt: '2026-11-05T00:00:00.000Z',
    updatedAt: '2026-11-05T00:00:00.000Z',
    ...patch,
  };
}

describe('看板规则', () => {
  it('状态映射到列：两种审批合并为「待审批」', () => {
    expect(columnOf('pending_approval')).toBe('approval');
    expect(columnOf('waiting_approval')).toBe('approval');
    expect(columnOf('awaiting_input')).toBe('awaiting');
  });

  it('执行中只能拖去关闭；已关闭只能拖回等待追问；同列跨泳道 = 改派', () => {
    const running = task({ status: 'running', agent: { agent: 'echo:default' } });
    expect(canDrop(running, 'closed', 'all')).toBe(true);
    expect(canDrop(running, 'queued', 'all')).toBe(false);
    const closed = task({ status: 'closed' });
    expect(canDrop(closed, 'awaiting', 'all')).toBe(true);
    expect(canDrop(closed, 'queued', 'all')).toBe(false);
    const awaiting = task({ status: 'awaiting_input', agent: { agent: 'echo:default' } });
    expect(canDrop(awaiting, 'awaiting', 'all')).toBe(false);
    expect(canDrop(awaiting, 'awaiting', 'echo:default')).toBe(false);
    expect(canDrop(awaiting, 'awaiting', 'codex:default')).toBe(true);
    // 指定了 Agent 的泳道不能放进「未分配」
    const q = task({ agent: { agent: 'echo:default' } });
    expect(canDrop(q, 'unassigned', 'codex:default')).toBe(false);
    expect(canDrop(q, 'unassigned', '__none')).toBe(true);
  });

  it('planDrop：未分配 → 排队（无泳道时弹选择），等待追问 → 排队（弹追问）', () => {
    const u = task({ status: 'unassigned' });
    expect(planDrop(u, 'queued', 'all', { queued: [] })).toEqual([{ kind: 'assign' }]);
    expect(planDrop(u, 'queued', 'codex:default', { queued: [] })).toEqual([
      { kind: 'assign', agent: 'codex:default' },
    ]);
    const a = task({ status: 'awaiting_input', agent: { agent: 'echo:default' } });
    expect(planDrop(a, 'queued', 'all', { queued: [] })).toEqual([{ kind: 'followup' }]);
    expect(planDrop(a, 'closed', 'all', { queued: [] })).toEqual([{ kind: 'close' }]);
    expect(planDrop(task({ status: 'closed' }), 'awaiting', 'all', { queued: [] })).toEqual([
      { kind: 'reopen' },
    ]);
    expect(planDrop(task({ status: 'running' }), 'queued', 'all', { queued: [] })).toEqual([]);
  });

  it('排队内拖动：rank 取相邻卡片中间值，跨优先级时同步优先级', () => {
    const a = task({ rank: 10 });
    const b = task({ rank: 20 });
    const c = task({ rank: 30 });
    const p1 = task({ rank: 5, priority: 1 });
    const q = [a, b, c, p1];
    expect(rankFor(c, q, a.id)).toEqual({ rank: 9 });
    expect(rankFor(c, q, b.id)).toEqual({ rank: 15 });
    expect(rankFor(a, q, undefined)).toEqual({ rank: 31 });
    // 拖到 P1 卡片之前 → 变成 P1，排在它前面
    expect(rankFor(b, q, p1.id)).toEqual({ rank: 4, priority: 1 });
    // 同列拖动 + 跨泳道 → 改派 + 调整顺序
    expect(
      planDrop({ ...c, agent: { agent: 'echo:default' } }, 'queued', 'codex:default', {
        queued: q,
        beforeId: b.id,
      }),
    ).toEqual([
      { kind: 'reassign', agent: 'codex:default' },
      { kind: 'reorder', rank: 15 },
    ]);
  });

  it('各列排序：排队按派发顺序，已关闭按关闭时间倒序', () => {
    const x = task({ priority: 3, rank: 1 });
    const y = task({ priority: 0, rank: 99 });
    expect(sortColumn([x, y], 'queued').map((t) => t.id)).toEqual([y.id, x.id]);
    const old = task({ status: 'closed', closedAt: '2026-11-01T00:00:00.000Z' });
    const recent = task({ status: 'closed', closedAt: '2026-11-04T00:00:00.000Z' });
    expect(sortColumn([old, recent], 'closed').map((t) => t.id)).toEqual([recent.id, old.id]);
  });
});

describe('格式化', () => {
  it('相对时间、来源与 Agent 名称', () => {
    const now = Date.parse('2026-11-05T12:00:00.000Z');
    expect(ago('2026-11-05T11:59:50.000Z', now)).toBe('刚刚');
    expect(ago('2026-11-05T11:30:00.000Z', now)).toBe('30 分钟前');
    expect(ago('2026-11-03T12:00:00.000Z', now)).toBe('2 天前');
    expect(sourceLabel('manual:api')).toBe('手动提交');
    expect(sourceLabel('cron:daily')).toBe('定时 · daily');
    expect(sourceLabel('spawn:agent-echo')).toBe('派生 · agent-echo');
    expect(agentName('claude-code:default')).toBe('claude-code');
    expect(agentName('claude-code:repo-a')).toBe('claude-code:repo-a');
  });
});
