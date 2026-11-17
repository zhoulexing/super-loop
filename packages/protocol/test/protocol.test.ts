import { describe, expect, it } from 'vitest';
import {
  AgentEventSchema,
  canTransitionTask,
  EnvelopeDraftSchema,
  EnvelopeSchema,
  InstanceNameSchema,
  JOURNAL_EVENT_TYPES,
  PluginManifestSchema,
  TASK_TRANSITIONS,
  TaskStatusSchema,
} from '../src/index.js';

const ULID = '01JABCDEFGHJKMNPQRSTVWXYZ0';

describe('envelope', () => {
  const envelope = {
    id: `env_${ULID}`,
    kind: 'event',
    source: { plugin: 'source-webhook', instance: 'webhook:github', ref: 'delivery-1' },
    idempotencyKey: 'github:delivery-1',
    receivedAt: '2026-11-04T08:00:00.000Z',
    subject: 'push to main',
    payload: { ref: 'refs/heads/main' },
    directives: {
      agents: [{ agent: 'claude-code:default', prompt: 'review {{envelope.subject}}' }],
      sinks: [{ sink: 'lark:ops', on: ['succeeded', 'failed'] }],
    },
    trace: { traceId: `trc_${ULID}`, depth: 0 },
  };

  it('解析合法 Envelope', () => {
    expect(EnvelopeSchema.parse(envelope)).toEqual(envelope);
  });

  it('拒绝错误前缀的 ID 与非法实例名', () => {
    expect(EnvelopeSchema.safeParse({ ...envelope, id: `task_${ULID}` }).success).toBe(false);
    expect(InstanceNameSchema.safeParse('ClaudeCode').success).toBe(false);
    expect(InstanceNameSchema.safeParse('claude-code:default').success).toBe(true);
  });

  it('草稿不需要 id/receivedAt/source/trace', () => {
    const draft = { kind: 'task', idempotencyKey: 'k1', subject: 's', payload: null };
    expect(EnvelopeDraftSchema.parse(draft)).toEqual(draft);
  });
});

describe('task state machine', () => {
  it('每个状态都有迁移定义', () => {
    for (const status of TaskStatusSchema.options) expect(TASK_TRANSITIONS[status]).toBeDefined();
  });

  it('除 closed 外都能关闭，closed 只能重新打开', () => {
    for (const status of TaskStatusSchema.options) {
      if (status === 'closed') continue;
      expect(canTransitionTask(status, 'closed')).toBe(true);
    }
    expect(TASK_TRANSITIONS.closed).toEqual(['awaiting_input', 'unassigned']);
  });

  it('失败重试回到 queued；未分配不能直接执行；追问从 awaiting_input 回到 queued', () => {
    expect(canTransitionTask('running', 'queued')).toBe(true);
    expect(canTransitionTask('unassigned', 'running')).toBe(false);
    expect(canTransitionTask('awaiting_input', 'queued')).toBe(true);
    expect(canTransitionTask('failed', 'queued')).toBe(true);
  });
});

describe('agent events', () => {
  it('解析各类事件并拒绝未知类型', () => {
    expect(AgentEventSchema.safeParse({ type: 'heartbeat' }).success).toBe(true);
    expect(
      AgentEventSchema.safeParse({ type: 'usage', inputTokens: 1, outputTokens: 2 }).success,
    ).toBe(true);
    expect(
      AgentEventSchema.safeParse({
        type: 'result',
        status: 'failed',
        summary: 'x',
        error: { code: 'RATE_LIMITED', message: 'slow down', retryable: true },
      }).success,
    ).toBe(true);
    expect(AgentEventSchema.safeParse({ type: 'approval_request' }).success).toBe(false);
  });
});

describe('journal & plugin manifest', () => {
  it('事件类型命名为 <subject>.<verb> 且不重复', () => {
    expect(new Set(JOURNAL_EVENT_TYPES).size).toBe(JOURNAL_EVENT_TYPES.length);
    for (const t of JOURNAL_EVENT_TYPES) expect(t).toMatch(/^[a-z]+\.[a-z_]+$/);
  });

  it('校验插件清单与权限', () => {
    const base = { name: 'agent-x', version: '0.1.0', kind: 'agent', apiVersion: 1 };
    expect(
      PluginManifestSchema.safeParse({ ...base, permissions: ['net:*', 'process:spawn'] }).success,
    ).toBe(true);
    expect(PluginManifestSchema.safeParse({ ...base, permissions: ['root'] }).success).toBe(false);
  });
});
