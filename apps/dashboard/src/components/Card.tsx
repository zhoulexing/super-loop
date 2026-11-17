import type { Approval, Task } from '@super-loop/protocol';
import type { ReactNode } from 'react';
import type { AgentInfo, LiveStep } from '../lib/api.js';
import { columnOf } from '../lib/board.js';
import {
  agentName,
  ago,
  dur,
  ktok,
  RISK_LABEL,
  sourceLabel,
  tokens,
  until,
} from '../lib/format.js';
import { Icon } from './ui.js';

export function AgentChip({ id, agents }: { id: string | undefined; agents: AgentInfo[] }) {
  if (!id) {
    return (
      <span>
        <Icon name="bot" />
        <span style={{ color: 'var(--fg-3)' }}>未指定</span>
      </span>
    );
  }
  const a = agents.find((x) => x.id === id);
  return (
    <span>
      <span className="ag-dot" style={{ background: a?.color ?? 'var(--fg-3)' }} />
      {a?.name ?? id}
    </span>
  );
}

/** Router 自动分配的说明；人已手动分配（skipped）时不显示。 */
export function routingText(t: Task): string | undefined {
  const r = t.routing;
  if (!r) return undefined;
  const router = agentName(r.router);
  const conf = r.confidence === undefined ? '' : `（把握 ${Math.round(r.confidence * 100)}%）`;
  switch (r.status) {
    case 'pending':
    case 'running':
      return `${router} 正在判断派给谁…`;
    case 'decided':
      return r.action === 'assign'
        ? `由 ${router} 分配：${r.reason ?? ''}${conf}`
        : `${router} 建议人工处理：${r.reason ?? ''}${conf}`;
    case 'failed':
      return `${router} 路由失败，等待人工分配：${r.error?.message ?? ''}`;
    case 'skipped':
      return undefined;
  }
}

export function RoutingNote({ t }: { t: Task }) {
  const text = routingText(t);
  if (!text) return null;
  return (
    <p className="routing-note">
      <Icon name="bot" />
      <span>{text}</span>
    </p>
  );
}

const OUTCOME: Record<string, [string, 'check' | 'x', string]> = {
  succeeded: ['outcome-ok', 'check', '成功'],
  failed: ['outcome-bad', 'x', '失败'],
  cancelled: ['', 'x', '已取消'],
  rejected: ['', 'x', '已拒绝'],
};

function StateLine(props: {
  t: Task;
  pos: number;
  approval: Approval | undefined;
  live: LiveStep | undefined;
  agents: AgentInfo[];
  now: number;
}): ReactNode {
  const { t, approval, live, now } = props;
  switch (columnOf(t.status)) {
    case 'unassigned':
      if (t.routing?.status === 'pending' || t.routing?.status === 'running') {
        return (
          <>
            <span className="pulse" />
            <span className="txt">{agentName(t.routing.router)} 分配中…</span>
          </>
        );
      }
      if (t.routing?.status === 'decided' || t.routing?.status === 'failed') {
        return (
          <span className="txt" title={routingText(t)}>
            {t.routing.status === 'failed' ? '自动分配失败' : `Router：${t.routing.reason ?? ''}`}
          </span>
        );
      }
      return t.candidates?.length ? (
        <span className="txt">
          候选：
          {t.candidates
            .map((c) => props.agents.find((a) => a.id === c.agent)?.name ?? c.agent)
            .join('、')}
        </span>
      ) : (
        <span className="txt" style={{ color: 'var(--fg-3)' }}>
          没有匹配的路由
        </span>
      );
    case 'queued': {
      const retryAt = t.notBefore ? Date.parse(t.notBefore) : 0;
      if (retryAt > now) {
        return (
          <>
            <Icon name="retry" />
            <span className="txt mono">
              {Math.ceil((retryAt - now) / 1000)}s 后重试 · 第 {t.attempts + 1}/
              {t.policy.maxAttempts} 次
            </span>
          </>
        );
      }
      return (
        <>
          <Icon name="queue" />
          <span className="txt">
            排第 {props.pos} 位{t.turnCount > 1 ? ` · 第 ${t.turnCount} 轮` : ''}
          </span>
        </>
      );
    }
    case 'running': {
      const started = live?.startedAt ?? Date.parse(t.updatedAt);
      return (
        <>
          <span className="pulse" />
          <span className="mono">{dur(now - started)}</span>
          <Icon name="tool" />
          <span className="txt mono" title={live?.step}>
            {live?.step ?? '执行中…'}
          </span>
        </>
      );
    }
    case 'approval':
      if (!approval) return <span className="txt">等待审批…</span>;
      return (
        <>
          <span className={`risk ${approval.risk}`}>{RISK_LABEL[approval.risk]}风险</span>
          <span className="txt mono" title={approval.title}>
            {approval.kind === 'task_start'
              ? '执行前审批'
              : String((approval.detail as { action?: string })?.action ?? approval.title)}
          </span>
          <span style={{ marginLeft: 'auto', color: 'var(--fg-3)' }} className="mono">
            {until(approval.expiresAt, now)}过期
          </span>
        </>
      );
    case 'awaiting':
      return (
        <>
          <Icon name="msg" />
          <span className="txt">{t.lastSummary ?? ''}</span>
        </>
      );
    case 'failed':
      return (
        <>
          <code>{t.lastError?.code ?? 'FAILED'}</code>
          <span className="txt">{t.lastError?.message ?? ''}</span>
        </>
      );
    case 'closed': {
      const [cls, icon, label] = OUTCOME[t.outcome ?? ''] ?? ['', 'x', '已关闭'];
      return (
        <>
          <span className={cls} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icon name={icon} />
            {label}
          </span>
          <span className="txt" style={{ marginLeft: 'auto', color: 'var(--fg-3)' }}>
            {ago(t.closedAt ?? t.updatedAt, now)}
          </span>
        </>
      );
    }
  }
}

export interface CardProps {
  t: Task;
  pos: number;
  agents: AgentInfo[];
  approval: Approval | undefined;
  live: LiveStep | undefined;
  now: number;
  selected: boolean;
  unread: boolean;
  dragging: boolean;
  insert: 'before' | 'after' | undefined;
  onOpen(): void;
  onMenu(x: number, y: number): void;
  onDecide(grant: boolean): void;
  onDragStart(): void;
  onDragEnd(): void;
}

export function Card(p: CardProps) {
  const { t } = p;
  const col = columnOf(t.status);
  const tok = tokens(t.usage);
  const cls = [
    'card',
    `st-${col}`,
    t.status === 'closed' && t.outcome === 'succeeded' ? 'ok' : '',
    p.unread ? 'unread' : '',
    p.selected ? 'selected' : '',
    p.dragging ? 'dragging' : '',
    p.insert === 'before' ? 'ins-before' : p.insert === 'after' ? 'ins-after' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    // biome-ignore lint/a11y/useSemanticElements: 卡片内含按钮，不能用 <button> 包裹
    <div
      className={cls}
      data-id={t.id}
      draggable
      tabIndex={0}
      role="button"
      aria-label={t.subject}
      onClick={p.onOpen}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          p.onOpen();
        }
      }}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', t.id);
        p.onDragStart();
      }}
      onDragEnd={p.onDragEnd}
    >
      <div className="c-top">
        {t.priority <= 1 && <span className={`prio p${t.priority}`}>P{t.priority}</span>}
        <span className="c-id">{t.id.slice(-6)}</span>
        <button
          type="button"
          className="c-menu"
          aria-label="更多操作"
          onClick={(e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            p.onMenu(r.right - 280, r.bottom + 4);
          }}
        >
          <Icon name="dots" />
        </button>
      </div>
      <h3 className="c-title">{t.subject}</h3>
      <div className="c-meta">
        <AgentChip id={t.agent?.agent} agents={p.agents} />
        <span className="src">
          <Icon name="src" />
          {sourceLabel(t.source)}
        </span>
      </div>
      <div className="c-state">
        <StateLine
          t={t}
          pos={p.pos}
          approval={p.approval}
          live={p.live}
          agents={p.agents}
          now={p.now}
        />
      </div>
      {col !== 'closed' && (
        <div className="c-foot">
          <span title="对话轮次">
            <Icon name="msg" />第 {t.turnCount} 轮
          </span>
          {t.artifactCount > 0 && (
            <span title="产物">
              <Icon name="clip" />
              {t.artifactCount}
            </span>
          )}
          {tok > 0 && (
            <span title="用量" className="mono">
              <Icon name="tok" />
              {ktok(tok)}
            </span>
          )}
          <span style={{ marginLeft: 'auto' }}>{ago(t.updatedAt, p.now)}</span>
        </div>
      )}
      {p.approval && (
        <div className="c-actions">
          <button
            type="button"
            className="btn sm"
            onClick={(e) => {
              e.stopPropagation();
              p.onDecide(false);
            }}
          >
            拒绝
          </button>
          <button
            type="button"
            className="btn sm primary"
            onClick={(e) => {
              e.stopPropagation();
              p.onDecide(true);
            }}
          >
            批准
          </button>
        </div>
      )}
    </div>
  );
}
