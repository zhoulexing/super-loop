import agentEcho from '@super-loop/agent-echo';
import { Kernel, type KernelConfigInput } from '@super-loop/kernel';
import sinkDashboard from '@super-loop/sink-dashboard';
import { MemoryStore, waitFor } from '@super-loop/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { DEFAULT_CONFIG } from '../src/default-config.js';

const kernels: Kernel[] = [];
afterEach(async () => {
  await Promise.all(kernels.splice(0).map((k) => k.stop()));
});

async function boot(token?: string) {
  const kernel = new Kernel({
    store: new MemoryStore(),
    config: {
      routes: DEFAULT_CONFIG.routes,
      defaults: DEFAULT_CONFIG.defaults as KernelConfigInput['defaults'],
      // 测试里去掉 echo 的模拟延迟
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
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  return { kernel, call, app };
}

describe('Kernel API', () => {
  it('端到端：提交 → echo 执行 → 成功 → 看板收件箱', async () => {
    const { call, app } = await boot();
    const submitted = await call(
      'POST',
      '/envelopes',
      { subject: '帮我总结今天的待办', payload: { items: 3 } },
      { 'x-loop-user': 'alice' },
    );
    expect(submitted.status).toBe(201);
    const envelopeId = submitted.body.envelopeId as string;

    const detail = await call('GET', `/envelopes/${envelopeId}`);
    const taskId = (detail.body.tasks as Array<{ id: string }>)[0]?.id as string;
    expect(taskId).toMatch(/^task_/);

    const task = await waitFor(async () => {
      const r = await call('GET', `/tasks/${taskId}`);
      return (r.body.task as { status: string }).status === 'succeeded' ? r.body : undefined;
    });
    const run = (task.runs as Array<{ id: string; summary: string }>)[0];
    expect(run?.summary).toMatch(/^echoed/);

    // echo 写了一个产物，可以通过 /files 下载
    const artifacts = (task.runs as Array<{ artifacts?: Array<{ ref: string; name: string }> }>)[0]
      ?.artifacts;
    expect(artifacts?.map((a) => a.name)).toEqual(['echo.txt']);
    const file = await app.request(
      `/api/v1/files?ref=${encodeURIComponent(artifacts?.[0]?.ref ?? '')}`,
    );
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('text/plain');
    expect(await file.text()).toContain('帮我总结今天的待办');
    expect((await call('GET', `/files?ref=${encodeURIComponent('artifact:../x')}`)).status).toBe(
      400,
    );

    const runDetail = await call('GET', `/runs/${run?.id}`);
    expect((runDetail.body.events as Array<{ type: string }>).map((e) => e.type)).toContain(
      'run.succeeded',
    );

    const inbox = await waitFor(async () => {
      const r = await call('GET', '/notifications');
      const items = r.body.items as Array<{ trigger: string }>;
      return items.some((n) => n.trigger === 'succeeded') ? items : undefined;
    });
    expect(inbox[0]?.trigger).toBe('succeeded'); // 最新的在前

    const journal = await call(
      'GET',
      `/journal?traceId=${(task.task as { traceId: string }).traceId}`,
    );
    expect((journal.body.items as Array<{ actor: string }>)[0]?.actor).toBe('user:alice');
  });

  it('幂等提交返回 200 + duplicated', async () => {
    const { call } = await boot();
    const a = await call('POST', '/envelopes', { subject: 'x', idempotencyKey: 'k' });
    const b = await call('POST', '/envelopes', { subject: 'x', idempotencyKey: 'k' });
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body).toEqual({ envelopeId: a.body.envelopeId, duplicated: true });
  });

  it('统一错误格式', async () => {
    const { call } = await boot();
    expect(await call('POST', '/envelopes', { subject: '' })).toMatchObject({
      status: 400,
      body: { error: { code: 'INVALID_INPUT' } },
    });
    expect((await call('GET', '/tasks/nope')).status).toBe(404);
    expect((await call('GET', '/tasks?status=bogus')).status).toBe(400);
    expect((await call('GET', '/no-such-route')).body).toMatchObject({
      error: { code: 'NOT_FOUND' },
    });
  });

  it('配置 token 后需要鉴权（health 除外）', async () => {
    const { call } = await boot('s3cret');
    expect((await call('GET', '/health')).status).toBe(200);
    expect((await call('GET', '/tasks')).status).toBe(403);
    expect(
      (await call('GET', '/tasks', undefined, { authorization: 'Bearer s3cret' })).status,
    ).toBe(200);
  });

  it('health 与 plugins 返回插件状态', async () => {
    const { call } = await boot();
    const health = await call('GET', '/health');
    expect(health.body).toMatchObject({ status: 'ok', kernel: 'running' });
    const plugins = await call('GET', '/plugins');
    expect(
      (plugins.body.items as Array<{ instance: string; health: { status: string } }>).map((p) => [
        p.instance,
        p.health.status,
      ]),
    ).toEqual([
      ['echo:default', 'healthy'],
      ['dashboard:default', 'healthy'],
    ]);
  });
});
