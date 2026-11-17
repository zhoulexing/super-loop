import type { Approval, InstanceName, Task } from '@super-loop/protocol';
import { useState } from 'react';
import type { Actions } from '../lib/actions.js';
import type { AgentInfo } from '../lib/api.js';
import { useUi } from './ui.js';

const short = (s: string) => (s.length > 14 ? `${s.slice(0, 14)}…` : s);

/** 选择 Agent：候选在前。 */
export function AgentPicker(props: {
  task: Task;
  agents: AgentInfo[];
  title: string;
  onPick(agent: InstanceName): void;
}) {
  const ui = useUi();
  const candidates = props.task.candidates?.map((c) => c.agent) ?? [];
  const order = [
    ...candidates,
    ...props.agents.map((a) => a.id as InstanceName).filter((id) => !candidates.includes(id)),
  ];
  return (
    <>
      <h4>{props.title}</h4>
      {order.map((id) => {
        const a = props.agents.find((x) => x.id === id);
        return (
          <button
            key={id}
            type="button"
            className="opt"
            disabled={a ? !a.ready : false}
            onClick={() => {
              ui.closePop();
              props.onPick(id);
            }}
          >
            <span className="ag-dot" style={{ background: a?.color ?? 'var(--fg-3)' }} />
            {a?.name ?? id}
            {candidates.includes(id) && <small>候选</small>}
            {id === props.task.agent?.agent && <small>当前</small>}
            {a && !a.ready && <small>不可用</small>}
          </button>
        );
      })}
      {order.length === 0 && <p className="note">还没有配置任何 Agent。</p>}
    </>
  );
}

/** 开始新一轮：追问内容（失败时留空 = 重试）+ 选择 Agent。 */
export function FollowupPop(props: {
  task: Task;
  agents: AgentInfo[];
  agent?: InstanceName | undefined;
  actions: Actions;
}) {
  const ui = useUi();
  const [text, setText] = useState('');
  const [agent, setAgent] = useState<string>(
    props.agent ?? props.task.agent?.agent ?? props.agents[0]?.id ?? '',
  );
  const failed = props.task.status === 'failed';
  const go = () => {
    if (!text.trim() && !failed) return;
    ui.closePop();
    void props.actions.send(props.task, {
      text,
      ...(agent ? { agent: agent as InstanceName } : {}),
    });
  };
  return (
    <>
      <h4>开始新一轮</h4>
      <textarea
        rows={3}
        value={text}
        placeholder={failed ? '追问内容（留空 = 直接重试）' : '追问内容'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) go();
        }}
      />
      <label className="note" htmlFor="fuAgent">
        Agent
      </label>
      <select id="fuAgent" value={agent} onChange={(e) => setAgent(e.target.value)}>
        {props.agents.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
      <div className="row">
        <button type="button" className="btn sm ghost" onClick={ui.closePop}>
          取消
        </button>
        <button
          type="button"
          className="btn sm primary"
          disabled={!failed && !text.trim()}
          onClick={go}
        >
          {failed && !text.trim() ? '重试' : '开始'}
        </button>
      </div>
    </>
  );
}

/** 卡片的 ⋯ 菜单。 */
export function MenuPop(props: {
  task: Task;
  approval: Approval | undefined;
  agents: AgentInfo[];
  actions: Actions;
  at: { x: number; y: number };
  onOpen(): void;
}) {
  const ui = useUi();
  const { task: t, actions, agents } = props;
  const picker = (title: string, onPick: (a: InstanceName) => void) =>
    ui.openPop(
      props.at.x,
      props.at.y,
      <AgentPicker task={t} agents={agents} title={title} onPick={onPick} />,
    );
  const items: Array<[string, () => void, string?]> = [];
  const st = t.status;
  if (st === 'unassigned')
    items.push(['分配给…', () => picker('分配给', (a) => actions.assign(t, a))]);
  if (st === 'queued') {
    items.push(['改派给…', () => picker('改派给', (a) => actions.reassign(t, a))]);
    items.push(['撤回分配', () => void actions.unassign(t)]);
  }
  if (props.approval) {
    const id = props.approval.id;
    items.push(['批准', () => void actions.decide(t, id, true)]);
    items.push(['拒绝', () => void actions.decide(t, id, false)]);
  }
  if (st === 'awaiting_input' || st === 'failed') {
    items.push([
      st === 'failed' ? '重试 / 追问…' : '追问…',
      () =>
        ui.openPop(
          props.at.x,
          props.at.y,
          <FollowupPop task={t} agents={agents} actions={actions} />,
        ),
    ]);
    items.push(['换 Agent…', () => picker('改派给', (a) => actions.reassign(t, a))]);
  }
  items.push(['打开详情', props.onOpen]);
  if (st !== 'closed') {
    items.push([
      st === 'running' || st === 'waiting_approval' ? '中止并关闭' : '关闭任务',
      () => void actions.close(t),
      'danger',
    ]);
  } else {
    items.push(['重新打开', () => void actions.reopen(t)]);
  }
  return (
    <>
      <h4>{short(t.subject)}</h4>
      {items.map(([label, fn, cls]) => (
        <button
          key={label}
          type="button"
          className={`opt ${cls ?? ''}`}
          onClick={() => {
            ui.closePop();
            fn();
          }}
        >
          {label}
        </button>
      ))}
    </>
  );
}
