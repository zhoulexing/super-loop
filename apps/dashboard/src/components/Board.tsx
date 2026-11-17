import type { Approval, Task } from '@super-loop/protocol';
import { type DragEvent, useMemo, useState } from 'react';
import type { Actions } from '../lib/actions.js';
import type { AgentInfo, LiveStep } from '../lib/api.js';
import {
  COLUMNS,
  type ColumnKey,
  canDrop,
  columnOf,
  type LaneKey,
  laneOf,
  matchesQuery,
  NO_AGENT_LANE,
  planDrop,
  sortColumn,
} from '../lib/board.js';
import { Card } from './Card.js';
import { AgentPicker, FollowupPop, MenuPop } from './pops.js';
import { Icon, useUi } from './ui.js';

export interface ViewState {
  agentFilter: ReadonlySet<string>;
  q: string;
  lanes: 'none' | 'agent';
  density: 'detail' | 'compact';
  closedOpen: boolean;
}

interface Drag {
  task: Task;
  hover?: { col: ColumnKey; lane: LaneKey };
  beforeId?: string | undefined;
  /** 插入线画在哪张卡片上。 */
  marker?: { id: string; where: 'before' | 'after' };
}

export function Board(props: {
  tasks: Task[];
  agents: AgentInfo[];
  approvals: Map<string, Approval>;
  steps: Map<string, LiveStep>;
  unread: ReadonlySet<string>;
  view: ViewState;
  concurrency: number | undefined;
  closedTruncated: boolean;
  selectedId: string | undefined;
  now: number;
  actions: Actions;
  onOpen(id: string): void;
  onToggleClosed(): void;
}) {
  const ui = useUi();
  const [drag, setDrag] = useState<Drag | null>(null);
  const { view, actions, agents } = props;

  const visible = useMemo(
    () =>
      props.tasks.filter(
        (t) =>
          (view.agentFilter.size === 0 || view.agentFilter.has(laneOf(t))) &&
          matchesQuery(t, view.q),
      ),
    [props.tasks, view.agentFilter, view.q],
  );
  const queuedAll = useMemo(
    () =>
      sortColumn(
        props.tasks.filter((t) => t.status === 'queued'),
        'queued',
      ),
    [props.tasks],
  );

  const lanes: Array<{ key: LaneKey; name?: string; color?: string }> =
    view.lanes === 'agent'
      ? [
          ...agents.map((a) => ({ key: a.id as LaneKey, name: a.name, color: a.color })),
          { key: NO_AGENT_LANE, name: '未指定 Agent' },
        ]
      : [{ key: 'all' }];

  const running = props.tasks.filter((t) => t.status === 'running').length;

  const onDrop = (col: ColumnKey, lane: LaneKey, e: DragEvent) => {
    if (!drag) return;
    e.preventDefault();
    const { task, beforeId } = drag;
    setDrag(null);
    const plan = planDrop(task, col, lane, { queued: queuedAll, beforeId });
    const { clientX: x, clientY: y } = e;
    void (async () => {
      for (const a of plan) {
        switch (a.kind) {
          case 'reassign':
            await actions.reassign(task, a.agent);
            break;
          case 'reorder':
            await actions.reorder(task, a.priority === undefined ? { rank: a.rank } : a);
            break;
          case 'close':
            await actions.close(task);
            break;
          case 'reopen':
            await actions.reopen(task);
            break;
          case 'unassign':
            await actions.unassign(task);
            break;
          case 'assign':
            if (a.agent) await actions.assign(task, a.agent);
            else
              ui.openPop(
                x,
                y,
                <AgentPicker
                  task={task}
                  agents={agents}
                  title="分配给"
                  onPick={(agent) => void actions.assign(task, agent)}
                />,
              );
            break;
          case 'followup':
            ui.openPop(
              x,
              y,
              <FollowupPop task={task} agents={agents} agent={a.agent} actions={actions} />,
            );
            break;
        }
      }
    })();
  };

  const onDragOver = (col: ColumnKey, lane: LaneKey, e: DragEvent<HTMLDivElement>) => {
    if (!drag || !canDrop(drag.task, col, lane)) return;
    e.preventDefault();
    let beforeId: string | undefined;
    let marker: Drag['marker'];
    if (col === 'queued') {
      const cards = [...e.currentTarget.querySelectorAll<HTMLElement>('.card')].filter(
        (c) => c.dataset.id !== drag.task.id,
      );
      const before = cards.find((c) => {
        const r = c.getBoundingClientRect();
        return e.clientY < r.top + r.height / 2;
      });
      beforeId = before?.dataset.id;
      const last = cards.at(-1);
      marker = before
        ? { id: before.dataset.id as string, where: 'before' }
        : last
          ? { id: last.dataset.id as string, where: 'after' }
          : undefined;
    }
    if (
      drag.hover?.col !== col ||
      drag.hover.lane !== lane ||
      drag.beforeId !== beforeId ||
      drag.marker?.id !== marker?.id
    ) {
      setDrag({ ...drag, hover: { col, lane }, beforeId, ...(marker ? { marker } : {}) });
    }
  };

  const cols = COLUMNS.map((c) =>
    c.key === 'closed' && !view.closedOpen ? '168px' : 'var(--col-w)',
  ).join(' ');

  return (
    <main className="board" aria-label="任务看板">
      <div
        className={`grid${view.density === 'compact' ? ' density-compact' : ''}`}
        style={{ gridTemplateColumns: cols }}
      >
        {COLUMNS.map((c) => {
          const n = visible.filter((t) => columnOf(t.status) === c.key).length;
          return (
            <div
              key={c.key}
              className="colhead"
              style={{ ['--st' as string]: `var(--st-${c.key === 'closed' ? 'ok' : c.key})` }}
              data-colhead={c.key}
            >
              <div className="row">
                <h2>{c.name}</h2>
                <span className="count">
                  {c.key === 'running' && props.concurrency
                    ? `${running}/${props.concurrency}`
                    : c.key === 'closed' && props.closedTruncated
                      ? `${n}+`
                      : n}
                </span>
                {c.locked && (
                  <span className="lock" title="由系统推进">
                    <Icon name="lock" />
                  </span>
                )}
                {c.key === 'closed' && (
                  <button
                    type="button"
                    className="btn sm ghost"
                    style={{ marginLeft: 'auto', padding: '0 6px' }}
                    onClick={props.onToggleClosed}
                  >
                    {view.closedOpen ? '收起' : '展开'}
                  </button>
                )}
              </div>
              <span className="hint">{c.hint}</span>
            </div>
          );
        })}

        {lanes.map((lane) => (
          <LaneRow key={lane.key}>
            {lane.key !== 'all' && (
              <div className="lane">
                {lane.color && <span className="ag-dot" style={{ background: lane.color }} />}
                {lane.name}{' '}
                <span className="mono" style={{ color: 'var(--fg-3)' }}>
                  {visible.filter((t) => laneOf(t) === lane.key).length}
                </span>
              </div>
            )}
            {COLUMNS.map((c) => {
              const list = sortColumn(
                visible.filter(
                  (t) =>
                    columnOf(t.status) === c.key && (lane.key === 'all' || laneOf(t) === lane.key),
                ),
                c.key,
              );
              const dropState = drag
                ? canDrop(drag.task, c.key, lane.key)
                  ? drag.hover?.col === c.key && drag.hover.lane === lane.key
                    ? ' drop-ok drop-hover'
                    : ' drop-ok'
                  : ' drop-no'
                : '';
              return (
                // biome-ignore lint/a11y/noStaticElementInteractions: 拖放目标区域
                <div
                  key={c.key}
                  className={`cell${dropState}`}
                  data-col={c.key}
                  onDragOver={(e) => onDragOver(c.key, lane.key, e)}
                  onDrop={(e) => onDrop(c.key, lane.key, e)}
                >
                  {c.key === 'closed' && !view.closedOpen ? (
                    <ClosedSummary list={list} />
                  ) : list.length === 0 ? (
                    <div className="empty">
                      {c.key === 'unassigned' ? '没有待分配的任务' : '空'}
                    </div>
                  ) : (
                    list.map((t) => (
                      <Card
                        key={t.id}
                        t={t}
                        pos={queuedAll.findIndex((x) => x.id === t.id) + 1}
                        agents={agents}
                        approval={props.approvals.get(t.id)}
                        live={props.steps.get(t.id)}
                        now={props.now}
                        selected={props.selectedId === t.id}
                        unread={props.unread.has(t.id)}
                        dragging={drag?.task.id === t.id}
                        insert={drag?.marker?.id === t.id ? drag.marker.where : undefined}
                        onOpen={() => props.onOpen(t.id)}
                        onMenu={(x, y) =>
                          ui.openPop(
                            x,
                            y,
                            <MenuPop
                              task={t}
                              approval={props.approvals.get(t.id)}
                              agents={agents}
                              actions={actions}
                              at={{ x, y }}
                              onOpen={() => props.onOpen(t.id)}
                            />,
                          )
                        }
                        onDecide={(grant) => {
                          const a = props.approvals.get(t.id);
                          if (a) void actions.decide(t, a.id, grant);
                        }}
                        onDragStart={() => {
                          ui.closePop();
                          setDrag({ task: t });
                        }}
                        onDragEnd={() => setDrag(null)}
                      />
                    ))
                  )}
                </div>
              );
            })}
          </LaneRow>
        ))}
      </div>
    </main>
  );
}

/** 泳道内的单元格直接放进外层 grid（display: contents 等价，避免多一层 DOM）。 */
function LaneRow({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

function ClosedSummary({ list }: { list: Task[] }) {
  if (list.length === 0) return <div className="empty">无</div>;
  const ok = list.filter((t) => t.outcome === 'succeeded').length;
  return (
    <div className="closed-sum">
      <span>最近关闭</span>
      <b>{list.length}</b>
      <span className="outcome-ok">{ok} 成功</span>
      <span>{list.length - ok} 取消 / 拒绝 / 失败</span>
    </div>
  );
}
