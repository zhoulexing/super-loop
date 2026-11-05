import type { AgentRunInput, Envelope, Notification } from '@super-loop/protocol';
import { newId } from '@super-loop/shared';

export function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    id: newId('envelope'),
    kind: 'task',
    source: { plugin: 'source-manual', instance: 'manual:default' },
    idempotencyKey: `test-${Math.random().toString(36).slice(2)}`,
    receivedAt: '2026-01-01T00:00:00.000Z',
    subject: 'test envelope',
    payload: { hello: 'world' },
    trace: { traceId: newId('trace'), depth: 0 },
    ...overrides,
  };
}

export function makeAgentRunInput(overrides: Partial<AgentRunInput> = {}): AgentRunInput {
  return {
    runId: newId('run'),
    taskId: newId('task'),
    attempt: 1,
    envelope: makeEnvelope(),
    prompt: 'say hello',
    options: {},
    ...overrides,
  };
}

export function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    deliveryId: newId('delivery'),
    trigger: 'succeeded',
    title: 'Task succeeded',
    body: 'All good.',
    links: { dashboard: 'http://localhost:7300/tasks/test' },
    subject: { kind: 'task', id: newId('task') },
    data: {},
    ...overrides,
  };
}

/** 收集异步迭代器的全部元素。 */
export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
