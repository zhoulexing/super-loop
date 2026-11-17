import { isLoopApiError } from '@super-loop/client';
import type { ApprovalId, FileRef, InstanceName, Priority, Task } from '@super-loop/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Confirm, useUi } from '../components/ui.js';
import { loop, qk } from './api.js';
import { agentName } from './format.js';

const short = (s: string) => (s.length > 14 ? `${s.slice(0, 14)}…` : s);

const isActive = (t: Task) => t.status === 'running' || t.status === 'waiting_approval';

export interface SendInput {
  text: string;
  mode?: 'queue' | 'interrupt';
  /** 与当前 Agent 不同则先改派。 */
  agent?: InstanceName | undefined;
  attachments?: FileRef[];
}

/** 看板上所有"人的决定"，统一处理提示、错误与刷新。 */
export function useActions() {
  const ui = useUi();
  const qc = useQueryClient();

  return useMemo(() => {
    const refresh = (t?: Task) => {
      void qc.invalidateQueries({ queryKey: qk.tasks });
      void qc.invalidateQueries({ queryKey: qk.approvals });
      if (t) void qc.invalidateQueries({ queryKey: qk.task(t.id) });
    };
    const run = async (t: Task | undefined, fn: () => Promise<unknown>, ok?: string) => {
      try {
        await fn();
        if (ok) ui.toast(ok);
      } catch (error) {
        const msg = isLoopApiError(error) ? `${error.message}（${error.code}）` : String(error);
        ui.toast(`操作失败：${msg}`);
      } finally {
        refresh(t);
      }
    };
    const switchAgent = async (t: Task, agent: InstanceName | undefined) => {
      if (agent && agent !== t.agent?.agent) await loop.tasks.assign(t.id, { agent });
    };

    const actions = {
      assign: (t: Task, agent: InstanceName) =>
        run(
          t,
          () => loop.tasks.assign(t.id, { agent }),
          t.policy.requireApproval
            ? `已分配给 ${agentName(agent)}，等待执行前审批`
            : `已分配给 ${agentName(agent)}，进入排队`,
        ),
      reassign: (t: Task, agent: InstanceName) =>
        agent === t.agent?.agent
          ? Promise.resolve()
          : run(
              t,
              () => loop.tasks.assign(t.id, { agent }),
              `已改派：${t.agent ? agentName(t.agent.agent) : '未指定'} → ${agentName(agent)}`,
            ),
      unassign: (t: Task) => run(t, () => loop.tasks.unassign(t.id), '已撤回分配'),
      reorder: (t: Task, input: { rank: number; priority?: Priority }) =>
        run(
          t,
          () => loop.tasks.update(t.id, input),
          input.priority !== undefined ? `优先级同步调整为 P${input.priority}` : undefined,
        ),
      reopen: (t: Task) => run(t, () => loop.tasks.reopen(t.id), '已重新打开，可以继续对话'),
      /** 执行中的任务先确认。 */
      close: (t: Task) => {
        const doClose = () => run(t, () => loop.tasks.close(t.id), `已关闭「${short(t.subject)}」`);
        if (!isActive(t)) return doClose();
        ui.openModal(
          <Confirm
            title="中止并关闭？"
            text={`「${t.subject}」正在执行，关闭会立即中止当前这一轮，已产出的文件会保留。`}
            okLabel="中止并关闭"
            onOk={() => void doClose()}
          />,
        );
        return Promise.resolve();
      },
      decide: (t: Task | undefined, approvalId: ApprovalId, grant: boolean) =>
        run(
          t,
          () => loop.approvals.decide(approvalId, { decision: grant ? 'grant' : 'reject' }),
          grant ? '已批准' : '已拒绝',
        ),
      /**
       * 发送消息（输入框 / 追问浮层）：
       * - failed 且内容为空 → 重试（可同时换 Agent）；
       * - unassigned → 先追加消息再分配；
       * - 其它状态 → 必要时改派，再追问（执行中默认排队，interrupt 立即打断）。
       */
      send: (t: Task, input: SendInput) => {
        const text = input.text.trim();
        if (!text && t.status === 'failed') {
          return run(
            t,
            () => loop.tasks.retry(t.id, input.agent ? { agent: input.agent } : {}),
            '已重试，进入排队',
          );
        }
        if (!text) return Promise.resolve();
        const message = {
          content: text,
          mode: input.mode ?? 'queue',
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        };
        if (t.status === 'unassigned') {
          return run(
            t,
            async () => {
              await loop.tasks.sendMessage(t.id, message);
              if (input.agent) await loop.tasks.assign(t.id, { agent: input.agent });
            },
            input.agent ? `已分配给 ${agentName(input.agent)}，进入排队` : '已追加消息',
          );
        }
        const ok =
          input.mode === 'interrupt'
            ? '已中止当前这一轮，新消息开始处理'
            : isActive(t) || t.status === 'pending_approval'
              ? '已排队，本轮结束后发送'
              : t.status === 'queued'
                ? '已追加，作为下一轮排队'
                : t.status === 'closed'
                  ? '已重新打开并追问'
                  : '已追问，新一轮开始排队';
        return run(
          t,
          async () => {
            if (!isActive(t)) await switchAgent(t, input.agent);
            await loop.tasks.sendMessage(t.id, message);
          },
          ok,
        );
      },
    };
    return actions;
  }, [qc, ui]);
}

export type Actions = ReturnType<typeof useActions>;
