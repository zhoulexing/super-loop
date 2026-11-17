import type {
  Approval,
  FileRef,
  InstanceName,
  JournalEvent,
  Run,
  Task,
  TaskDetail,
  Turn,
} from '@super-loop/protocol';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { Actions } from '../lib/actions.js';
import { type AgentInfo, type LiveStep, loop, useTaskDetail, useTrace } from '../lib/api.js';
import { columnOf, STATUS_NAME } from '../lib/board.js';
import {
  agentName,
  ago,
  bytes,
  dur,
  ktok,
  RISK_LABEL,
  sourceLabel,
  tokens,
  until,
} from '../lib/format.js';
import { AgentChip, RoutingNote } from './Card.js';
import { downloadFile, FilePreview } from './FilePreview.js';
import { Icon, useUi } from './ui.js';

type Tab = 'chat' | 'files' | 'runs';

const runMs = (r: Run, now: number) =>
  (r.endedAt ? Date.parse(r.endedAt) : now) - Date.parse(r.startedAt);

const RUN_STATUS: Record<Run['status'], string> = {
  running: '执行中',
  succeeded: '成功',
  failed: '失败',
  timed_out: '超时',
  cancelled: '已中止',
};

/** 一次 Run 的过程（工具调用、中间消息），来自 trace 的 run.event。 */
function stepsOf(events: JournalEvent[], runIds: readonly string[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.type !== 'run.event' || !runIds.includes(e.subject.id)) continue;
    const d = e.data as Record<string, unknown>;
    if (d.type === 'tool_call') {
      const input = d.input && typeof d.input === 'object' ? JSON.stringify(d.input) : '';
      out.push(`${String(d.name)} ${input.length > 120 ? `${input.slice(0, 120)}…` : input}`);
    } else if (d.type === 'tool_result') {
      out.push(`  ↳ ${d.ok ? 'ok' : 'error'}${d.summary ? ` · ${String(d.summary)}` : ''}`);
    } else if (d.type === 'message') {
      const c = String(d.content ?? '');
      out.push(`💬 ${c.length > 120 ? `${c.slice(0, 120)}…` : c}`);
    }
  }
  return out;
}

function FileChips({ files, onPreview }: { files: FileRef[]; onPreview(f: FileRef): void }) {
  if (files.length === 0) return null;
  return (
    <div className="files">
      {files.map((f) => (
        <button key={f.ref} type="button" className="file" onClick={() => onPreview(f)}>
          <Icon name="file" />
          {f.name}
          <span className="mono">{bytes(f.size)}</span>
        </button>
      ))}
    </div>
  );
}

function Steps({ steps, open }: { steps: string[]; open?: boolean }) {
  if (steps.length === 0) return null;
  return (
    <details className="tools" open={open}>
      <summary>
        <Icon name="tool" />
        {steps.length} 个步骤
      </summary>
      <ol>
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
    </details>
  );
}

/** 时间线上的系统提示：改派、重新打开、关闭。 */
function notesOf(events: JournalEvent[], taskId: string): Array<{ at: string; text: string }> {
  const out: Array<{ at: string; text: string }> = [];
  for (const e of events) {
    if (e.subject.id !== taskId) continue;
    const d = (e.data ?? {}) as Record<string, string | undefined>;
    if (e.type === 'task.assigned') {
      out.push({
        at: e.at,
        text: d.previous
          ? `切换 Agent：${agentName(d.previous)} → ${agentName(d.agent ?? '')}（${e.actor}）`
          : `分配给 ${agentName(d.agent ?? '')}（${e.actor}）`,
      });
    } else if (e.type === 'task.reopened') out.push({ at: e.at, text: `重新打开（${e.actor}）` });
    else if (e.type === 'task.closed') {
      const OUT: Record<string, string> = {
        succeeded: '完成',
        failed: '失败',
        cancelled: '取消',
        rejected: '拒绝',
      };
      out.push({
        at: e.at,
        text: `已关闭 · ${OUT[d.outcome ?? ''] ?? d.outcome}${d.reason ? ` · ${d.reason}` : ''}`,
      });
    }
  }
  return out;
}

function Chat(props: {
  detail: TaskDetail;
  events: JournalEvent[];
  agents: AgentInfo[];
  approval: Approval | undefined;
  live: LiveStep | undefined;
  now: number;
  actions: Actions;
  onPreview(f: FileRef): void;
}) {
  const { detail, events, now } = props;
  const t = detail.task;
  const agentOf = (id: string) => props.agents.find((a) => a.id === id);

  const items: Array<{ at: string; node: ReactNode }> = [];
  for (const n of notesOf(events, t.id)) {
    items.push({
      at: n.at,
      node: (
        <div className="note" style={{ textAlign: 'center' }}>
          {n.text}
        </div>
      ),
    });
  }
  for (const turn of detail.turns) {
    const runs = detail.runs.filter((r) => r.turnId === turn.id);
    items.push({
      at: turn.createdAt,
      node: <UserTurn turn={turn} task={t} onPreview={props.onPreview} />,
    });
    const last = runs.at(-1);
    if (turn.status === 'running' && last) {
      const a = agentOf(last.agent);
      const started = Date.parse(last.startedAt);
      items.push({
        at: last.startedAt,
        node: (
          <div className="msg agent">
            <div className="who">
              <span className="ag-dot" style={{ background: a?.color ?? 'var(--fg-3)' }} />
              <b>{a?.name ?? last.agent}</b>
              <span>
                第 {turn.index} 轮 · 第 {last.attempt} 次尝试
              </span>
            </div>
            <Steps steps={stepsOf(events, [last.id])} open />
            <div className="live">
              {t.status === 'waiting_approval' ? (
                <>
                  <Icon name="clock" />
                  <span>等待审批，超时计时已暂停</span>
                </>
              ) : (
                <>
                  <span className="pulse" />
                  <span className="mono">{dur(now - started)}</span>
                  <span className="mono">
                    {props.live?.runId === last.id && props.live.step
                      ? props.live.step
                      : (stepsOf(events, [last.id]).at(-1) ?? '')}
                  </span>
                </>
              )}
            </div>
          </div>
        ),
      });
    } else if (last && turn.status !== 'pending') {
      const a = agentOf(last.agent);
      const ok = turn.status === 'completed';
      const stopped = turn.status === 'interrupted' || turn.status === 'cancelled';
      const files = runs.flatMap((r) => r.artifacts ?? []);
      items.push({
        at: last.endedAt ?? turn.updatedAt,
        node: (
          <div className="msg agent">
            <div className="who">
              <span className="ag-dot" style={{ background: a?.color ?? 'var(--fg-3)' }} />
              <b>{a?.name ?? last.agent}</b>
              <span>
                {stopped ? (
                  turn.status === 'interrupted' ? (
                    '已打断'
                  ) : (
                    '已中止'
                  )
                ) : (
                  <>
                    <span className={ok ? 'outcome-ok' : 'outcome-bad'}>{ok ? '✓' : '✕'}</span>{' '}
                    {dur(runMs(last, now))}
                  </>
                )}
                {runs.length > 1 ? ` · 尝试 ${runs.length} 次` : ''}
              </span>
              <span>{ago(last.endedAt ?? turn.updatedAt, now)}</span>
            </div>
            <Steps
              steps={stepsOf(
                events,
                runs.map((r) => r.id),
              )}
            />
            <div className="bubble">
              {stopped
                ? '（这一轮已被中止）'
                : ok
                  ? (turn.reply ?? last.summary ?? '')
                  : `${last.error?.code ?? 'FAILED'}：${last.error?.message ?? turn.reply ?? ''}`}
            </div>
            <FileChips files={files} onPreview={props.onPreview} />
          </div>
        ),
      });
    }
  }
  items.sort((a, b) => a.at.localeCompare(b.at));

  const retryAt = t.status === 'queued' && t.notBefore ? Date.parse(t.notBefore) : 0;
  return (
    <>
      {props.approval && (
        <ApprovalBanner t={t} approval={props.approval} now={now} actions={props.actions} />
      )}
      {items.map((x, i) => (
        <div key={i} style={{ display: 'contents' }}>
          {x.node}
        </div>
      ))}
      {retryAt > now && (
        <div className="live">
          <Icon name="retry" />
          <span className="mono">
            {t.lastError?.code ?? ''} · {Math.ceil((retryAt - now) / 1000)}s 后第 {t.attempts + 1}/
            {t.policy.maxAttempts} 次尝试
          </span>
        </div>
      )}
    </>
  );
}

function UserTurn({
  turn,
  task,
  onPreview,
}: {
  turn: Turn;
  task: Task;
  onPreview(f: FileRef): void;
}) {
  const queued = turn.status === 'pending' && turn.runIds.length === 0 && turn.index > 1;
  const waiting = queued && (task.status === 'running' || task.status === 'waiting_approval');
  return (
    <div className={`msg user${waiting ? ' pending' : ''}`}>
      <div className="who">
        <span>{waiting ? '排队中 · 本轮结束后处理' : `第 ${turn.index} 轮`}</span>
        <b>{turn.by}</b>
        <span>{ago(turn.createdAt)}</span>
      </div>
      <div className="bubble">{turn.content}</div>
      <FileChips files={turn.attachments ?? []} onPreview={onPreview} />
    </div>
  );
}

function ApprovalBanner(props: { t: Task; approval: Approval; now: number; actions: Actions }) {
  const a = props.approval;
  const detail = (a.detail ?? {}) as { action?: string; request?: unknown };
  const body =
    a.kind === 'tool_call'
      ? JSON.stringify(detail.request ?? {}, null, 2)
      : JSON.stringify(a.detail ?? {}, null, 2);
  return (
    <div className="banner">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span className={`risk ${a.risk}`}>{RISK_LABEL[a.risk]}风险</span>
        <b>{a.kind === 'task_start' ? '执行前审批' : `请求执行 ${detail.action ?? ''}`}</b>
        <span className="note" style={{ marginLeft: 'auto' }}>
          {until(a.expiresAt, props.now)}过期，过期视为拒绝
        </span>
      </div>
      <div>{a.title}</div>
      {body !== '{}' && <pre>{body}</pre>}
      <div className="row" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button
          type="button"
          className="btn sm"
          onClick={() => void props.actions.decide(props.t, a.id, false)}
        >
          拒绝
        </button>
        <button
          type="button"
          className="btn sm primary"
          onClick={() => void props.actions.decide(props.t, a.id, true)}
        >
          批准
        </button>
      </div>
    </div>
  );
}

function Files({ detail, onPreview }: { detail: TaskDetail; onPreview(f: FileRef): void }) {
  const rows = detail.runs.flatMap((r) =>
    (r.artifacts ?? []).map((f) => ({
      f,
      turn: detail.turns.find((x) => x.id === r.turnId)?.index,
    })),
  );
  if (rows.length === 0) {
    return <div className="empty">还没有产物。Agent 写入 artifacts/ 的文件会出现在这里。</div>;
  }
  return (
    <>
      <table className="table">
        <thead>
          <tr>
            <th>文件</th>
            <th>轮次</th>
            <th>大小</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map(({ f, turn }) => (
            <tr key={f.ref}>
              <td>
                <Icon name="file" /> {f.name}
              </td>
              <td>{turn ? `第 ${turn} 轮` : ''}</td>
              <td className="mono">{bytes(f.size)}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button type="button" className="btn sm" onClick={() => onPreview(f)}>
                  预览
                </button>{' '}
                <button type="button" className="btn sm ghost" onClick={() => void downloadFile(f)}>
                  下载
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="note">
        存放在 workspaces/{detail.task.id}/artifacts/&lt;runId&gt;/，任务关闭后按保留期清理。
      </p>
    </>
  );
}

function Runs({ detail, now }: { detail: TaskDetail; now: number }) {
  if (detail.runs.length === 0) return <div className="empty">还没有执行记录。</div>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>轮次</th>
          <th>尝试</th>
          <th>Agent</th>
          <th>状态</th>
          <th>耗时</th>
          <th>用量</th>
          <th>错误</th>
        </tr>
      </thead>
      <tbody>
        {detail.runs.map((r) => (
          <tr key={r.id} title={r.id}>
            <td>第 {detail.turns.find((x) => x.id === r.turnId)?.index ?? '?'} 轮</td>
            <td className="mono">{r.attempt}</td>
            <td>{agentName(r.agent)}</td>
            <td
              className={
                r.status === 'succeeded'
                  ? 'outcome-ok'
                  : r.status === 'running'
                    ? ''
                    : 'outcome-bad'
              }
            >
              {RUN_STATUS[r.status]}
            </td>
            <td className="mono">{dur(runMs(r, now))}</td>
            <td className="mono">{tokens(r.usage) ? ktok(tokens(r.usage)) : ''}</td>
            <td className="mono" title={r.error?.message}>
              {r.error?.code ?? ''}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const HINT: Record<string, string> = {
  unassigned: '选择 Agent 后发送，即完成分配',
  pending_approval: '审批通过后按顺序处理',
  queued: '会作为下一轮排队',
  running: '发送会排到本轮之后；打断会立即中止本轮',
  waiting_approval: '审批完成、本轮结束后处理',
  failed: '留空发送 = 重试；也可以换 Agent',
  closed: '发送会重新打开任务并继续对话',
};

function Composer(props: { t: Task; agents: AgentInfo[]; actions: Actions }) {
  const { t, agents } = props;
  const ui = useUi();
  const [text, setText] = useState('');
  const [agent, setAgent] = useState<string>(
    t.agent?.agent ?? t.candidates?.[0]?.agent ?? agents[0]?.id ?? '',
  );
  const [files, setFiles] = useState<FileRef[]>([]);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // 切换任务时重置
  useEffect(() => {
    setText('');
    setFiles([]);
    setAgent(t.agent?.agent ?? t.candidates?.[0]?.agent ?? agents[0]?.id ?? '');
  }, [t.id]);

  const active = t.status === 'running' || t.status === 'waiting_approval';
  const agentLocked = active || t.status === 'pending_approval';
  const failed = t.status === 'failed';
  const canSend = !busy && (text.trim() !== '' || failed);
  const info = agents.find((a) => a.id === agent);
  const hint =
    t.status === 'awaiting_input'
      ? agent === t.agent?.agent
        ? info?.resumable
          ? '继续当前会话（续跑）'
          : '继续当前会话（带上完整对话历史）'
        : '换 Agent：将带上完整对话历史'
      : (HINT[t.status] ?? '');

  const submit = async (mode: 'queue' | 'interrupt') => {
    if (!canSend) return;
    setBusy(true);
    await props.actions.send(t, {
      text,
      mode,
      ...(agent ? { agent: agent as InstanceName } : {}),
      attachments: files,
    });
    setBusy(false);
    setText('');
    setFiles([]);
  };

  const upload = async (list: FileList | null) => {
    if (!list) return;
    for (const file of Array.from(list)) {
      try {
        const ref = await loop.files.upload(file, {
          name: file.name,
          ...(file.type ? { mime: file.type } : {}),
        });
        setFiles((f) => [...f, ref]);
      } catch (error) {
        ui.toast(`上传失败：${String(error)}`);
      }
    }
    if (fileInput.current) fileInput.current.value = '';
  };

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        void submit('queue');
      }}
    >
      <textarea
        rows={2}
        value={text}
        aria-label="追问"
        placeholder={failed ? '留空直接重试，或写下补充说明…' : '继续追问，或补充要求…'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit('queue');
          }
        }}
      />
      {files.length > 0 && (
        <div className="attach-row">
          {files.map((f) => (
            <span key={f.ref} className="file">
              <Icon name="clip" />
              {f.name}
              <button
                type="button"
                aria-label={`移除 ${f.name}`}
                onClick={() => setFiles((x) => x.filter((y) => y.ref !== f.ref))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="row">
        <label className="note" htmlFor="cAgent">
          Agent
        </label>
        <select
          id="cAgent"
          value={agent}
          disabled={agentLocked}
          onChange={(e) => setAgent(e.target.value)}
        >
          {agents.map((a) => (
            <option key={a.id} value={a.id} disabled={!a.ready}>
              {a.name}
              {a.resumable ? '' : '（不支持续跑）'}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => fileInput.current?.click()}
          title="添加附件"
        >
          <Icon name="clip" />
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => void upload(e.target.files)}
        />
        <span className="hint">{hint}</span>
        {active && (
          <button
            type="button"
            className="btn sm"
            disabled={!text.trim() || busy}
            onClick={() => void submit('interrupt')}
          >
            打断并发送
          </button>
        )}
        <button type="submit" className="btn sm primary" disabled={!canSend}>
          {failed && !text.trim() ? '重试' : '发送'}{' '}
          <span
            className="kbd"
            style={{ color: 'inherit', borderColor: 'currentColor', opacity: 0.7 }}
          >
            ⌘↵
          </span>
        </button>
      </div>
    </form>
  );
}

export function Drawer(props: {
  taskId: string;
  fallback: Task | undefined;
  agents: AgentInfo[];
  approval: Approval | undefined;
  live: LiveStep | undefined;
  now: number;
  actions: Actions;
  onClose(): void;
}) {
  const ui = useUi();
  const [tab, setTab] = useState<Tab>('chat');
  const detailQ = useTaskDetail(props.taskId as Task['id']);
  const detail = detailQ.data;
  const t = detail?.task ?? props.fallback;
  const traceQ = useTrace(t?.traceId);
  const bodyRef = useRef<HTMLDivElement>(null);
  const preview = (f: FileRef) => ui.openModal(<FilePreview file={f} />);

  // 新内容到达时，在底部附近则保持贴底
  const sig = useMemo(
    () =>
      JSON.stringify([
        detail?.turns.length,
        detail?.runs.length,
        t?.status,
        traceQ.data?.length,
        tab,
      ]),
    [detail, t?.status, traceQ.data?.length, tab],
  );
  useEffect(() => {
    const el = bodyRef.current;
    if (el && tab === 'chat') el.scrollTop = el.scrollHeight;
  }, [sig]);

  if (!t) {
    return (
      <aside className="drawer" aria-label="任务详情">
        <div className="d-head">
          <div className="d-titlebox">{detailQ.isError ? '任务不存在或无法加载' : '加载中…'}</div>
          <button className="icon-btn" type="button" aria-label="收起详情" onClick={props.onClose}>
            ×
          </button>
        </div>
      </aside>
    );
  }
  const col = columnOf(t.status);
  const stColor = col === 'closed' ? (t.outcome === 'succeeded' ? 'ok' : 'unassigned') : col;
  const tok = tokens(t.usage);

  return (
    <aside className="drawer" aria-label="任务详情">
      <div className="d-head">
        <div className="d-titlebox">
          <div className="d-meta">
            <span
              className={`statepill st-${col}`}
              style={{ ['--st' as string]: `var(--st-${stColor})` }}
            >
              {STATUS_NAME[col]}
              {t.status === 'pending_approval' ? ' · 执行前' : ''}
            </span>
            <span className="mono">{t.id}</span>
          </div>
          <h2>{t.subject}</h2>
          <div className="d-meta">
            <AgentChip id={t.agent?.agent} agents={props.agents} />
            <span>
              <Icon name="src" />
              {sourceLabel(t.source)}
            </span>
            <span>
              <Icon name="msg" />第 {t.turnCount} 轮
            </span>
            {tok > 0 && (
              <span className="mono">
                <Icon name="tok" />
                {ktok(tok)} tok
              </span>
            )}
            {t.closeOnComplete && <span>完成后自动关闭</span>}
          </div>
          <RoutingNote t={t} />
        </div>
        <div className="tgroup">
          {t.status === 'closed' ? (
            <button type="button" className="btn sm" onClick={() => void props.actions.reopen(t)}>
              重新打开
            </button>
          ) : (
            <button
              type="button"
              className="btn sm danger"
              onClick={() => void props.actions.close(t)}
            >
              关闭任务
            </button>
          )}
        </div>
        <button className="icon-btn" type="button" aria-label="收起详情" onClick={props.onClose}>
          ×
        </button>
      </div>
      <div className="d-tabs" role="tablist">
        {(
          [
            ['chat', '对话'],
            ['files', `产物${t.artifactCount ? ` ${t.artifactCount}` : ''}`],
            ['runs', '执行记录'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="d-body" ref={bodyRef}>
        {!detail ? (
          <p className="note">加载中…</p>
        ) : tab === 'chat' ? (
          <Chat
            detail={detail}
            events={traceQ.data ?? []}
            agents={props.agents}
            approval={props.approval}
            live={props.live}
            now={props.now}
            actions={props.actions}
            onPreview={preview}
          />
        ) : tab === 'files' ? (
          <Files detail={detail} onPreview={preview} />
        ) : (
          <Runs detail={detail} now={props.now} />
        )}
      </div>
      <Composer t={t} agents={props.agents} actions={props.actions} />
    </aside>
  );
}
