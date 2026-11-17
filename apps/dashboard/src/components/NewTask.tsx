import { isLoopApiError } from '@super-loop/client';
import type { InstanceName, Priority, Route } from '@super-loop/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { type AgentInfo, loop, qk } from '../lib/api.js';
import { agentName } from '../lib/format.js';
import { useUi } from './ui.js';

type Mode = 'auto' | 'manual' | 'agent';

/** 手动提交 Envelope：按路由 / 先放进未分配 / 指定 Agent。 */
export function NewTask(props: {
  agents: AgentInfo[];
  routes: Route[];
  onCreated(taskId: string | undefined): void;
}) {
  const ui = useUi();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [mode, setMode] = useState<Mode>('auto');
  const [agent, setAgent] = useState(props.agents[0]?.id ?? '');
  const [priority, setPriority] = useState<Priority>(2);
  const [autoClose, setAutoClose] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const firstRoute = props.routes.filter((r) => r.enabled).sort((a, b) => a.order - b.order)[0];
  const routeHint = firstRoute
    ? `（例如 ${firstRoute.name} → ${
        firstRoute.assign === 'manual'
          ? '未分配'
          : firstRoute.agents.map((a) => agentName(a.agent)).join('、')
      }）`
    : '（当前没有路由，会进入「未分配」）';

  const go = async () => {
    if (!title.trim()) {
      setError('请填写标题');
      return;
    }
    setBusy(true);
    try {
      const res = await loop.envelopes.submit({
        subject: title.trim(),
        ...(body.trim() ? { payload: body.trim() } : {}),
        directives: {
          priority,
          ...(autoClose ? { closeOnComplete: true } : {}),
          ...(mode === 'manual' ? { skipRoutes: true } : {}),
          ...(mode === 'agent' && agent ? { agents: [{ agent: agent as InstanceName }] } : {}),
        },
      });
      const detail = await loop.envelopes.get(res.envelopeId);
      void qc.invalidateQueries({ queryKey: qk.tasks });
      ui.closeModal();
      ui.toast(
        mode === 'manual'
          ? '已放进「未分配」'
          : detail.tasks.length > 1
            ? `已提交，扇出为 ${detail.tasks.length} 个任务`
            : '已提交',
      );
      props.onCreated(detail.tasks[0]?.id);
    } catch (e) {
      setError(isLoopApiError(e) ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <form
      style={{ display: 'contents' }}
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void go();
      }}
    >
      <h3>新建任务</h3>
      <label className="f" htmlFor="nTitle">
        标题
        <input
          id="nTitle"
          // biome-ignore lint/a11y/noAutofocus: 弹窗打开后直接输入标题
          autoFocus
          value={title}
          placeholder="例如：修复 issue #31 的分页错误"
          style={error && !title.trim() ? { borderColor: 'var(--st-failed)' } : undefined}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="f" htmlFor="nBody">
        内容
        <textarea
          id="nBody"
          rows={4}
          value={body}
          placeholder="描述你要做的事，Agent 会把它作为第一轮输入"
          onChange={(e) => setBody(e.target.value)}
        />
      </label>
      <div className="f">
        <span className="note">处理方式</span>
        <div className="radios">
          <label>
            <input
              type="radio"
              name="nMode"
              checked={mode === 'auto'}
              onChange={() => setMode('auto')}
            />{' '}
            按路由自动分配{routeHint}
          </label>
          <label>
            <input
              type="radio"
              name="nMode"
              checked={mode === 'manual'}
              onChange={() => setMode('manual')}
            />{' '}
            先放进「未分配」，稍后手动分配
          </label>
          <label>
            <input
              type="radio"
              name="nMode"
              checked={mode === 'agent'}
              onChange={() => setMode('agent')}
            />{' '}
            指定 Agent{' '}
            <select
              style={{ width: 'auto' }}
              value={agent}
              onChange={(e) => {
                setAgent(e.target.value);
                setMode('agent');
              }}
            >
              {props.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <label className="f" htmlFor="nPrio" style={{ flex: 1, minWidth: 140 }}>
          优先级
          <select
            id="nPrio"
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value) as Priority)}
          >
            <option value={0}>P0 紧急</option>
            <option value={1}>P1 高</option>
            <option value={2}>P2 普通</option>
            <option value={3}>P3 低</option>
          </select>
        </label>
        <label
          className="f"
          style={{
            flex: 1,
            minWidth: 180,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingTop: 18,
          }}
        >
          <input
            type="checkbox"
            checked={autoClose}
            onChange={(e) => setAutoClose(e.target.checked)}
          />{' '}
          完成后自动关闭
        </label>
      </div>
      {error && (
        <p className="err-text" style={{ margin: 0 }}>
          {error}
        </p>
      )}
      <div className="row">
        <button type="button" className="btn" onClick={ui.closeModal}>
          取消
        </button>
        <button type="submit" className="btn primary" disabled={busy}>
          提交
        </button>
      </div>
    </form>
  );
}
