import type {
  Approval,
  DeliveryId,
  Envelope,
  ErrorPayload,
  Notification,
  NotificationTrigger,
  SinkBinding,
  Task,
} from '@super-loop/protocol';
import { renderTemplate } from '@super-loop/shared';

export interface NotifyContext {
  trigger: NotificationTrigger;
  task: Task;
  envelope: Envelope;
  publicUrl: string;
  summary?: string;
  error?: ErrorPayload;
  approval?: Approval;
  runId?: string;
}

const TITLE: Record<NotificationTrigger, string> = {
  started: '▶️ 开始处理',
  succeeded: '✅ 处理成功',
  failed: '❌ 处理失败',
  approval_required: '🙋 等待审批',
  incident: '🚨 异常',
};

/** 合并 Task 自带与全局默认的 Sink 绑定，同一 Sink 只保留一个（Task 级优先）。 */
export function sinksFor(
  task: Task,
  defaults: readonly SinkBinding[],
  trigger: NotificationTrigger,
): SinkBinding[] {
  const seen = new Set<string>();
  const out: SinkBinding[] = [];
  for (const b of [...task.sinks, ...defaults]) {
    if (seen.has(b.sink)) continue;
    seen.add(b.sink);
    if ((b.on as readonly string[]).includes(trigger)) out.push(b);
  }
  return out;
}

export function buildNotification(
  deliveryId: DeliveryId,
  binding: SinkBinding,
  c: NotifyContext,
): Notification {
  const base = c.publicUrl.replace(/\/$/, '');
  const lines = [
    `**${c.envelope.subject}**`,
    '',
    `- Agent：\`${c.task.agent.agent}\``,
    `- 尝试：${c.task.attempts}/${c.task.policy.maxAttempts}`,
  ];
  if (c.summary) lines.push(`- 结果：${c.summary}`);
  if (c.error) lines.push(`- 错误：\`${c.error.code}\` ${c.error.message}`);
  if (c.approval) lines.push(`- 审批：${c.approval.title}（风险 ${c.approval.risk}）`);

  const vars = {
    trigger: c.trigger,
    envelope: c.envelope,
    task: c.task,
    summary: c.summary,
    error: c.error,
    approval: c.approval,
  };
  const body = binding.template ? renderTemplate(binding.template, vars) : lines.join('\n');

  return {
    deliveryId,
    trigger: c.trigger,
    title: `${TITLE[c.trigger]}：${c.envelope.subject}`.slice(0, 200),
    body,
    links: {
      dashboard: `${base}/tasks/${c.task.id}`,
      ...(c.approval
        ? {
            approve: `${base}/approvals/${c.approval.id}?decision=grant`,
            reject: `${base}/approvals/${c.approval.id}?decision=reject`,
          }
        : {}),
    },
    subject: c.approval ? { kind: 'approval', id: c.approval.id } : { kind: 'task', id: c.task.id },
    traceId: c.task.traceId,
    data: {
      taskId: c.task.id,
      envelopeId: c.envelope.id,
      ...(c.runId ? { runId: c.runId } : {}),
      ...(c.summary ? { summary: c.summary } : {}),
      ...(c.error ? { error: c.error } : {}),
    },
  };
}
