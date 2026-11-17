import agentEcho from '@super-loop/agent-echo';
import { createClient, isLoopApiError } from '@super-loop/client';
import { Kernel, type KernelConfigInput } from '@super-loop/kernel';
import type { JournalEvent, TaskId } from '@super-loop/protocol';
import sinkDashboard from '@super-loop/sink-dashboard';
import { MemoryStore, waitFor } from '@super-loop/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { DEFAULT_CONFIG } from '../src/default-config.js';

const kernels: Kernel[] = [];
afterEach(async () => {
  await Promise.all(kernels.splice(0).map((k) => k.stop()));
});

/** client 直接调用 Hono app（不开端口），覆盖真实的路由、校验与 SSE。 */
async function boot(token?: string) {
  const kernel = new Kernel({
    store: new MemoryStore(),
    config: {
      routes: DEFAULT_CONFIG.routes,
      defaults: DEFAULT_CONFIG.defaults as KernelConfigInput['defaults'],
      plugins: {
        'echo:default': { use: agentEcho, config: { delayMs: 0 } },
        'dashboard:default': { use: sinkDashboard },
      },
      limits: { tickMs: 10 },
    },
  });
  kernels.push(kernel);
  await kernel.start();
  const app = createApp({ kernel, token });
  const fetch = ((input: string | URL | Request, init?: RequestInit) =>
    app.request(input, init)) as typeof globalThis.fetch;
  return { kernel, fetch };
}

describe('@super-loop/client ↔ Kernel API', () => {
  it('提交、对话、关闭、分页与 SSE 实时事件', async () => {
    const { fetch } = await boot('k');
    const loop = createClient({ baseUrl: 'http://loop.test', token: 'k', user: 'alice', fetch });

    const events: JournalEvent[] = [];
    const sub = loop.stream({ fromSeq: 1, onEvent: (e) => events.push(e) });

    const { envelopeId } = await loop.envelopes.submit({ subject: '写周报' });
    const taskId = (await loop.envelopes.get(envelopeId)).tasks[0]?.id as TaskId;
    const statusOf = async () => (await loop.tasks.get(taskId)).task.status;
    await waitFor(async () => (await statusOf()) === 'awaiting_input');

    const file = await loop.files.upload('# 补充', { name: 'note.md' });
    await loop.tasks.sendMessage(taskId, { content: '再加一段', attachments: [file] });
    const detail = await waitFor(async () => {
      const d = await loop.tasks.get(taskId);
      return d.turns.length === 2 && d.task.status === 'awaiting_input' ? d : undefined;
    });
    expect(detail.turns.map((t) => [t.index, t.status, t.by])).toEqual([
      [1, 'completed', 'user:alice'],
      [2, 'completed', 'user:alice'],
    ]);
    const ref = detail.runs.at(-1)?.artifacts?.[0]?.ref as string;
    expect(await (await loop.files.download(ref)).text()).toBe('再加一段');

    await loop.tasks.update(taskId, { priority: 0 });
    expect((await loop.tasks.close(taskId)).outcome).toBe('succeeded');
    const err = await loop.tasks.close(taskId).catch((e) => e);
    expect(isLoopApiError(err) && err.code).toBe('CONFLICT');
    expect((await loop.tasks.list({ status: ['closed', 'failed'] })).items).toHaveLength(1);
    expect((await loop.notifications.list()).items.length).toBeGreaterThan(0);
    expect((await loop.health()).kernel).toBe('running');

    // SSE：收到了从 seq 1 开始的全部事件，且严格递增
    await waitFor(() => events.some((e) => e.type === 'task.closed'));
    expect(events[0]?.seq).toBe(1);
    expect(events.every((e, i) => i === 0 || e.seq > (events[i - 1]?.seq ?? 0))).toBe(true);
    expect(events.map((e) => e.type)).toContain('turn.added');
    sub.close();
    await sub.done;
  });

  it('token 错误时请求与订阅都返回 PERMISSION_DENIED，订阅不再重试', async () => {
    const { fetch } = await boot('k');
    const loop = createClient({ baseUrl: 'http://loop.test', token: 'wrong', fetch });
    await expect(loop.tasks.list()).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      status: 403,
    });
    const codes: string[] = [];
    const sub = loop.stream({ onEvent: () => {}, onError: (e) => codes.push(e.code) });
    await sub.done;
    expect(codes).toEqual(['PERMISSION_DENIED']);
  });
});
