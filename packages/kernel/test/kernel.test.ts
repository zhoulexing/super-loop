import {
  type AgentEvent,
  DEFAULT_TASK_POLICY,
  type DeliveryResult,
  type EnvelopeDraft,
  type JournalEventType,
  type PluginDefinition,
  type PluginKind,
  type Store,
  type Task,
  type TaskId,
} from '@super-loop/protocol';
import { newId, sleep } from '@super-loop/shared';
import {
  defineTestAgent,
  defineTestSink,
  defineTestSource,
  MemoryStore,
  makeEnvelope,
  waitFor,
} from '@super-loop/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { Kernel, type KernelConfigInput } from '../src/index.js';

const ok = (summary = 'done'): AgentEvent => ({ type: 'result', status: 'succeeded', summary });

const echo = defineTestAgent(async function* (input) {
  yield { type: 'message', role: 'assistant', content: input.prompt };
  yield ok(`echo: ${input.prompt}`);
});

const kernels: Kernel[] = [];
afterEach(async () => {
  await Promise.all(kernels.splice(0).map((k) => k.stop()));
});

interface Setup {
  agents?: Record<string, PluginDefinition<'agent', unknown>>;
  sinks?: Record<string, PluginDefinition<'sink', unknown>>;
  sources?: Record<string, PluginDefinition<'source', unknown>>;
  store?: Store;
  config?: Partial<KernelConfigInput>;
}

async function setup(s: Setup = {}) {
  const sink = defineTestSink();
  const plugins: Record<string, { use: PluginDefinition<PluginKind, unknown> }> = {};
  for (const [k, v] of Object.entries({
    'echo:default': echo,
    ...s.agents,
    'test:sink': sink,
    ...s.sinks,
    ...s.sources,
  })) {
    plugins[k] = { use: v };
  }
  const store = s.store ?? new MemoryStore();
  const kernel = new Kernel({
    store,
    config: {
      routes: [{ name: 'default', agents: [{ agent: 'echo:default' }] }],
      defaults: {
        sinks: [{ sink: 'test:sink', on: ['started', 'succeeded', 'failed', 'approval_required'] }],
        policy: { backoff: { type: 'fixed', baseMs: 10, maxMs: 10 } },
      },
      ...s.config,
      plugins,
      limits: { tickMs: 10, leaseMs: 5_000, ...s.config?.limits },
    },
  });
  kernels.push(kernel);
  await kernel.start();
  return { kernel, store, sink };
}

const draft = (patch: Partial<EnvelopeDraft> = {}): EnvelopeDraft => ({
  kind: 'task',
  idempotencyKey: newId('event'),
  subject: 'hello',
  payload: null,
  ...patch,
});

async function taskOf(store: Store, envelopeId: string): Promise<Task> {
  const { items } = await store.tasks.list({ where: { envelopeId: envelopeId as never } });
  if (!items[0]) throw new Error('no task');
  return items[0];
}

async function waitStatus(store: Store, taskId: TaskId, statuses: Task['status'][]) {
  return waitFor(
    async () => {
      const t = await store.tasks.get(taskId);
      return t && statuses.includes(t.status) ? t : undefined;
    },
    { message: `task ${taskId} → ${statuses.join('|')}` },
  );
}

async function journalTypes(store: Store): Promise<JournalEventType[]> {
  return (await store.readJournal(1, 10_000)).map((e) => e.type);
}

describe('Kernel 主流程', () => {
  it('提交 → 路由 → 执行 → 成功 → 通知', async () => {
    const { kernel, store, sink } = await setup();
    const { envelopeId, duplicated } = await kernel.submit(draft({ subject: 'say hi' }));
    expect(duplicated).toBe(false);

    const task = await waitStatus(store, (await taskOf(store, envelopeId)).id, ['succeeded']);
    expect(task.attempts).toBe(1);
    const run = await store.runs.get(task.lastRunId as never);
    expect(run).toMatchObject({ status: 'succeeded', summary: 'echo: say hi' });

    await waitFor(() => sink.received.filter((n) => n.trigger === 'succeeded').length === 1);
    expect(sink.received.map((n) => n.trigger)).toEqual(['started', 'succeeded']);
    expect(sink.received[1]?.links.dashboard).toBe(`http://localhost:7300/tasks/${task.id}`);

    await waitFor(async () => {
      const { items } = await store.deliveries.list({ where: { status: 'succeeded' } });
      return items.length === 2;
    });
    const types = await journalTypes(store);
    for (const t of [
      'kernel.started',
      'envelope.received',
      'envelope.routed',
      'task.created',
      'task.queued',
      'run.started',
      'run.event',
      'run.succeeded',
      'task.succeeded',
      'delivery.succeeded',
    ] as const) {
      expect(types).toContain(t);
    }
  });

  it('同一 idempotencyKey 只入队一次', async () => {
    const { kernel, store } = await setup();
    const d = draft({ idempotencyKey: 'same' });
    const a = await kernel.submit(d);
    const b = await kernel.submit(d);
    expect(b).toEqual({ envelopeId: a.envelopeId, duplicated: true });
    expect((await store.tasks.list()).items).toHaveLength(1);
    expect(await journalTypes(store)).toContain('envelope.duplicated');
  });

  it('没有匹配的路由 → envelope.unrouted', async () => {
    const { kernel, store } = await setup({ config: { routes: [] } });
    await kernel.submit(draft());
    expect(await journalTypes(store)).toContain('envelope.unrouted');
    expect((await store.tasks.list()).items).toHaveLength(0);
  });

  it('directives 指定 Agent，并支持扇出', async () => {
    const other = defineTestAgent(async function* () {
      yield ok('other');
    });
    const { kernel, store } = await setup({ agents: { 'other:default': other } });
    const { envelopeId } = await kernel.submit(
      draft({ directives: { agents: [{ agent: 'echo:default' }, { agent: 'other:default' }] } }),
    );
    await waitFor(async () => {
      const { items } = await store.tasks.list({ where: { envelopeId: envelopeId as never } });
      return items.length === 2 && items.every((t) => t.status === 'succeeded');
    });
  });

  it('Run 结束时登记产物（ctx.files 写入的文件）', async () => {
    const writer = defineTestAgent(async function* (input, ctx) {
      await ctx.files.put(`# ${input.prompt}`, { name: 'report.md' });
      yield ok();
    });
    const { kernel, store } = await setup({
      agents: { 'writer:default': writer },
      config: { routes: [{ name: 'r', agents: [{ agent: 'writer:default' }] }] },
    });
    const { envelopeId } = await kernel.submit(draft({ subject: 'weekly' }));
    const task = await waitStatus(store, (await taskOf(store, envelopeId)).id, ['succeeded']);
    const run = await store.runs.get(task.lastRunId as never);
    expect(run?.artifacts).toEqual([
      { ref: `artifact:${run?.id}/report.md`, name: 'report.md', mime: 'text/markdown', size: 8 },
    ]);
    expect(
      new TextDecoder().decode(await kernel.content.read(run?.artifacts?.[0]?.ref as string)),
    ).toBe('# weekly');
  });

  it('按 permissions 提供目录，Run 拿到 work / artifacts 工作区', async () => {
    const seen: Record<string, unknown> = {};
    const dirs = {
      workspace: async (runId: string) => ({
        work: `/ws/${runId}/work`,
        artifacts: `/ws/${runId}/artifacts`,
      }),
      shared: async () => '/home/shared',
      state: async (instance: string) => `/home/state/${instance.replace(':', '/')}`,
      cache: async (plugin: string) => `/home/cache/${plugin}`,
    };
    const base = defineTestAgent(async function* (input, ctx) {
      seen[ctx.instance] = { paths: ctx.paths, workspace: input.workspace };
      yield ok();
    });
    const withPerms = { ...base, name: 'agent-perm', permissions: ['fs:state', 'fs:shared:read'] };
    const store = new MemoryStore();
    const kernel = new Kernel({
      store,
      dirs,
      config: {
        plugins: { 'perm:a': { use: withPerms }, 'plain:a': { use: base } },
        limits: { tickMs: 10 },
      },
    });
    kernels.push(kernel);
    await kernel.start();
    for (const agent of ['perm:a', 'plain:a'] as const) {
      const { envelopeId } = await kernel.submit(draft({ directives: { agents: [{ agent }] } }));
      await waitStatus(store, (await taskOf(store, envelopeId)).id, ['succeeded']);
    }
    const runIdOf = (x: unknown) =>
      (x as { workspace: { path: string } }).workspace.path.split('/')[2];
    const perm = seen['perm:a'] as { paths: Record<string, string> };
    expect(perm.paths).toEqual({
      shared: '/home/shared',
      state: '/home/state/perm/a',
      work: `/ws/${runIdOf(perm)}/work`,
      artifacts: `/ws/${runIdOf(perm)}/artifacts`,
    });
    // 没声明权限的插件只拿到本次 Run 的工作区
    expect(Object.keys((seen['plain:a'] as { paths: object }).paths).sort()).toEqual([
      'artifacts',
      'work',
    ]);
  });

  it('提示词模板渲染 envelope 变量', async () => {
    const { kernel, store } = await setup({
      config: {
        routes: [
          {
            name: 'tpl',
            agents: [{ agent: 'echo:default', prompt: 'Fix: {{envelope.payload.issue}}' }],
          },
        ],
      },
    });
    const { envelopeId } = await kernel.submit(draft({ payload: { issue: '#42' } }));
    const task = await waitStatus(store, (await taskOf(store, envelopeId)).id, ['succeeded']);
    expect((await store.runs.get(task.lastRunId as never))?.summary).toBe('echo: Fix: #42');
  });
});

describe('Kernel 重试与失败', () => {
  it('可重试失败按退避重试后成功', async () => {
    let calls = 0;
    const flaky = defineTestAgent(async function* () {
      calls += 1;
      if (calls === 1) {
        yield {
          type: 'result',
          status: 'failed',
          summary: 'rate limited',
          error: { code: 'RATE_LIMITED', message: 'slow down', retryable: true },
        };
        return;
      }
      yield ok();
    });
    const { kernel, store } = await setup({
      agents: { 'flaky:default': flaky },
      config: { routes: [{ name: 'r', agents: [{ agent: 'flaky:default' }] }] },
    });
    const { envelopeId } = await kernel.submit(draft());
    const task = await waitStatus(store, (await taskOf(store, envelopeId)).id, ['succeeded']);
    expect(task.attempts).toBe(2);
    const runs = (await store.runs.list({ where: { taskId: task.id } })).items;
    expect(runs.map((r) => r.status)).toEqual(['failed', 'succeeded']);
  });

  it('不可重试失败直接进入 dead 并发送失败通知', async () => {
    const bad = defineTestAgent(async function* () {
      yield {
        type: 'result',
        status: 'failed',
        summary: 'bad input',
        error: { code: 'INVALID_INPUT', message: 'nope', retryable: false },
      };
    });
    const { kernel, store, sink } = await setup({
      agents: { 'bad:default': bad },
      config: { routes: [{ name: 'r', agents: [{ agent: 'bad:default' }] }] },
    });
    const { envelopeId } = await kernel.submit(draft());
    const task = await waitStatus(store, (await taskOf(store, envelopeId)).id, ['dead']);
    expect(task.lastError?.code).toBe('INVALID_INPUT');
    await waitFor(() => sink.received.some((n) => n.trigger === 'failed'));
  });

  it('重试耗尽进入 dead', async () => {
    const always = defineTestAgent(async function* () {
      yield {
        type: 'result',
        status: 'failed',
        summary: 'down',
        error: { code: 'UNAVAILABLE', message: 'down', retryable: true },
      };
    });
    const { kernel, store } = await setup({
      agents: { 'down:default': always },
      config: {
        routes: [{ name: 'r', agents: [{ agent: 'down:default' }], policy: { maxAttempts: 3 } }],
      },
    });
    const { envelopeId } = await kernel.submit(draft());
    const task = await waitStatus(store, (await taskOf(store, envelopeId)).id, ['dead']);
    expect(task.attempts).toBe(3);
  });

  it('Agent 不响应取消时，超时仍由内核结算', async () => {
    const hang = defineTestAgent(async function* () {
      await new Promise(() => {}); // 永不结束，也不理会 signal
      yield ok();
    });
    const { kernel, store } = await setup({
      agents: { 'hang:default': hang },
      config: {
        routes: [
          {
            name: 'r',
            agents: [{ agent: 'hang:default' }],
            policy: { timeoutMs: 50, maxAttempts: 1 },
          },
        ],
      },
    });
    const { envelopeId } = await kernel.submit(draft());
    const task = await waitStatus(store, (await taskOf(store, envelopeId)).id, ['dead']);
    expect(task.lastError?.code).toBe('TIMEOUT');
    expect((await store.runs.get(task.lastRunId as never))?.status).toBe('timed_out');
    expect(kernel.activeRuns).toBe(0);
  });

  it('事件流没有 result 视为协议违规；连续崩溃后插件被禁用', async () => {
    const broken = defineTestAgent(async function* () {
      yield { type: 'log', level: 'info', message: 'oops' };
    });
    const { kernel, store } = await setup({
      agents: { 'broken:default': broken },
      config: {
        routes: [{ name: 'r', agents: [{ agent: 'broken:default' }], policy: { maxAttempts: 1 } }],
        limits: { maxPluginCrashes: 2 },
      },
    });
    for (let i = 0; i < 2; i++) {
      const { envelopeId } = await kernel.submit(draft());
      const t = await waitStatus(store, (await taskOf(store, envelopeId)).id, ['dead']);
      expect(t.lastError?.code).toBe('PLUGIN_PROTOCOL_VIOLATION');
    }
    await waitFor(
      () =>
        kernel.plugins.list().find((p) => p.instance === 'broken:default')?.status === 'disabled',
    );
    // 禁用后新任务停留在 queued，等待插件恢复
    const { envelopeId } = await kernel.submit(draft());
    await sleep(50);
    expect((await taskOf(store, envelopeId)).status).toBe('queued');
    expect(await journalTypes(store)).toContain('plugin.disabled');
  });

  it('引用不存在的 Agent → dead（PLUGIN_NOT_FOUND）', async () => {
    const { kernel, store } = await setup();
    const { envelopeId } = await kernel.submit(
      draft({ directives: { agents: [{ agent: 'ghost:x' }] } }),
    );
    const t = await waitStatus(store, (await taskOf(store, envelopeId)).id, ['dead']);
    expect(t.lastError?.code).toBe('PLUGIN_NOT_FOUND');
  });
});

describe('Kernel 并发与取消', () => {
  it('concurrencyKey 相同的任务串行执行', async () => {
    let running = 0;
    let maxRunning = 0;
    const slow = defineTestAgent(async function* () {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await sleep(30);
      running -= 1;
      yield ok();
    });
    const { kernel, store } = await setup({
      agents: { 'slow:default': slow },
      config: {
        routes: [
          { name: 'r', agents: [{ agent: 'slow:default' }], policy: { concurrencyKey: 'repo-a' } },
        ],
      },
    });
    await Promise.all([kernel.submit(draft()), kernel.submit(draft()), kernel.submit(draft())]);
    await waitFor(
      async () => (await store.tasks.list({ where: { status: 'succeeded' } })).items.length === 3,
    );
    expect(maxRunning).toBe(1);
  });

  it('取消运行中的任务', async () => {
    const slow = defineTestAgent(async function* (_input, ctx) {
      await sleep(5_000, ctx.signal);
      yield ok();
    });
    const { kernel, store } = await setup({
      agents: { 'slow:default': slow },
      config: { routes: [{ name: 'r', agents: [{ agent: 'slow:default' }] }] },
    });
    const { envelopeId } = await kernel.submit(draft());
    const task = await waitStatus(store, (await taskOf(store, envelopeId)).id, ['running']);
    await kernel.cancelTask(task.id, 'user:alice');
    const done = await waitStatus(store, task.id, ['cancelled']);
    expect((await store.runs.get(done.lastRunId as never))?.status).toBe('cancelled');
    await expect(kernel.cancelTask(task.id, 'user:alice')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });
});

describe('Kernel 审批', () => {
  it('Agent 工具调用审批：批准后继续，拒绝时 Agent 收到 granted=false', async () => {
    const decisions: boolean[] = [];
    const careful = defineTestAgent(async function* (_input, ctx) {
      const r = await ctx.awaitApproval({
        action: 'git.push',
        title: 'push to main',
        detail: {},
        risk: 'high',
      });
      decisions.push(r.granted);
      yield ok(r.granted ? 'pushed' : 'skipped');
    });
    const { kernel, store, sink } = await setup({
      agents: { 'careful:default': careful },
      config: { routes: [{ name: 'r', agents: [{ agent: 'careful:default' }] }] },
    });

    for (const decision of ['grant', 'reject'] as const) {
      const { envelopeId } = await kernel.submit(draft());
      const task = await waitStatus(store, (await taskOf(store, envelopeId)).id, [
        'waiting_approval',
      ]);
      const approval = await waitFor(async () =>
        (await store.approvals.list({ where: { status: 'pending' } })).items.find(
          (a) => a.subject.id === task.id,
        ),
      );
      expect(approval).toMatchObject({ kind: 'tool_call', risk: 'high' });
      await waitFor(() =>
        sink.received.some((n) => n.trigger === 'approval_required' && n.links.approve),
      );
      await kernel.decideApproval(approval.id, { decision, by: 'user:alice' });
      const done = await waitStatus(store, task.id, ['succeeded']);
      expect((await store.runs.get(done.lastRunId as never))?.summary).toBe(
        decision === 'grant' ? 'pushed' : 'skipped',
      );
    }
    expect(decisions).toEqual([true, false]);
  });

  it('requireApproval：审批通过后才执行，拒绝则 rejected', async () => {
    const { kernel, store } = await setup({
      config: {
        routes: [
          { name: 'r', agents: [{ agent: 'echo:default' }], policy: { requireApproval: true } },
        ],
      },
    });
    const a = await kernel.submit(draft());
    const b = await kernel.submit(draft());
    const ta = await taskOf(store, a.envelopeId);
    const tb = await taskOf(store, b.envelopeId);
    expect(ta.status).toBe('pending_approval');

    const pending = (await store.approvals.list({ where: { status: 'pending' } })).items;
    const approvalOf = (id: string) => pending.find((x) => x.subject.id === id);
    await kernel.decideApproval(approvalOf(ta.id)?.id as never, {
      decision: 'grant',
      by: 'user:alice',
    });
    await kernel.decideApproval(approvalOf(tb.id)?.id as never, {
      decision: 'reject',
      by: 'user:alice',
    });
    await waitStatus(store, ta.id, ['succeeded']);
    await waitStatus(store, tb.id, ['rejected']);
    await expect(
      kernel.decideApproval(approvalOf(ta.id)?.id as never, {
        decision: 'grant',
        by: 'user:alice',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('审批过期视为拒绝', async () => {
    const { kernel, store } = await setup({
      config: {
        routes: [
          { name: 'r', agents: [{ agent: 'echo:default' }], policy: { requireApproval: true } },
        ],
        limits: { approvalTtlMs: 30 },
      },
    });
    const { envelopeId } = await kernel.submit(draft());
    await waitStatus(store, (await taskOf(store, envelopeId)).id, ['rejected']);
    expect(await journalTypes(store)).toContain('approval.expired');
  });
});

describe('Kernel 恢复与投递', () => {
  it('崩溃恢复：遗留的 running Run 按可重试失败结算并重新执行', async () => {
    // 构造上一个进程崩溃后留下的状态：Task 与 Run 都停在 running。
    const store = new MemoryStore();
    const env = makeEnvelope({ source: { plugin: 'kernel', instance: 'manual:api' } });
    const taskId = newId('task');
    const runId = newId('run');
    const at = new Date().toISOString();
    await store.envelopes.put(env);
    await store.tasks.put({
      id: taskId,
      envelopeId: env.id,
      traceId: env.trace.traceId,
      agent: { agent: 'echo:default' },
      sinks: [],
      policy: { ...DEFAULT_TASK_POLICY, backoff: { type: 'fixed', baseMs: 10, maxMs: 10 } },
      priority: 2,
      status: 'running',
      attempts: 1,
      lastRunId: runId,
      createdAt: at,
      updatedAt: at,
    });
    await store.runs.put({
      id: runId,
      taskId,
      attempt: 1,
      agent: 'echo:default',
      status: 'running',
      startedAt: at,
      leaseExpiresAt: at,
    });

    const { store: s } = await setup({ store });
    const done = await waitStatus(s, taskId, ['succeeded']);
    expect(done.attempts).toBe(2);
    const runs = (await s.runs.list({ where: { taskId } })).items;
    expect(runs.map((r) => r.status)).toEqual(['failed', 'succeeded']);
    expect(runs[0]?.error?.code).toBe('KERNEL_RESTARTED');
  });

  it('重启后 Route 按 name 对齐，不会重复', async () => {
    const store = new MemoryStore();
    const first = await setup({ store });
    await first.kernel.stop();
    await setup({ store });
    expect((await store.routes.list()).items).toHaveLength(1);
  });

  it('Sink 失败会重试，最终成功；不可重试的直接 dead', async () => {
    let n = 0;
    const flakySink = defineTestSink((): DeliveryResult => {
      n += 1;
      return n === 1 ? { ok: false, retryable: true, error: 'blip' } : { ok: true };
    });
    const deadSink = defineTestSink(
      (): DeliveryResult => ({ ok: false, retryable: false, error: 'bad' }),
    );
    const { kernel, store } = await setup({
      sinks: { 'flaky:sink': flakySink, 'dead:sink': deadSink },
      config: {
        defaults: {
          sinks: [
            { sink: 'flaky:sink', on: ['succeeded'] },
            { sink: 'dead:sink', on: ['succeeded'] },
          ],
        },
        limits: { delivery: { maxAttempts: 3, backoff: { type: 'fixed', baseMs: 10, maxMs: 10 } } },
      },
    });
    await kernel.submit(draft());
    await waitFor(async () => {
      const all = (await store.deliveries.list()).items;
      const flaky = all.find((d) => d.sink === 'flaky:sink');
      const dead = all.find((d) => d.sink === 'dead:sink');
      return flaky?.status === 'succeeded' && flaky.attempts === 2 && dead?.status === 'dead';
    });
  });

  it('Source 插件 emit 的消息进入 Loop；Agent 可派生子任务且受深度限制', async () => {
    const source = defineTestSource();
    const spawner = defineTestAgent(async function* (input, ctx) {
      try {
        await ctx.spawn({
          kind: 'task',
          idempotencyKey: `child-${input.envelope.id}`,
          subject: 'child',
          payload: null,
        });
        yield ok('spawned');
      } catch (error) {
        yield ok(`blocked: ${(error as { code?: string }).code}`);
      }
    });
    const { store } = await setup({
      sources: { 'feed:main': source },
      agents: { 'spawner:default': spawner },
      config: {
        routes: [{ name: 'r', agents: [{ agent: 'spawner:default' }] }],
        limits: { maxSpawnDepth: 1 },
      },
    });
    const { envelopeId } = await source
      .ctx()
      .emit({ kind: 'event', idempotencyKey: 'e1', subject: 'root', payload: null });
    const root = await store.envelopes.get(envelopeId);
    expect(root?.source).toMatchObject({ plugin: 'source-test', instance: 'feed:main' });

    await waitFor(
      async () => (await store.tasks.list({ where: { status: 'succeeded' } })).items.length === 2,
    );
    const envs = (await store.envelopes.list()).items;
    const child = envs.find((e) => e.subject === 'child');
    expect(child?.trace).toMatchObject({
      parentId: envelopeId,
      depth: 1,
      traceId: root?.trace.traceId,
    });
    const runs = (await store.runs.list()).items.map((r) => r.summary).sort();
    expect(runs).toEqual(['blocked: SPAWN_DEPTH_EXCEEDED', 'spawned']);
  });

  it('停机时中止未完成的 Run，并标记为可重试', async () => {
    const slow = defineTestAgent(async function* (_i, ctx) {
      await sleep(60_000, ctx.signal);
      yield ok();
    });
    const { kernel, store } = await setup({
      agents: { 'slow:default': slow },
      config: {
        routes: [{ name: 'r', agents: [{ agent: 'slow:default' }] }],
        limits: { shutdownGraceMs: 30 },
      },
    });
    const { envelopeId } = await kernel.submit(draft());
    const task = await waitStatus(store, (await taskOf(store, envelopeId)).id, ['running']);
    await kernel.stop();
    const after = await store.tasks.get(task.id);
    expect(after?.status).toBe('queued');
    expect(after?.lastError?.code).toBe('KERNEL_SHUTDOWN');
    expect(kernel.state).toBe('stopped');
  });

  it('配置错误时拒绝启动', async () => {
    expect(
      () => new Kernel({ store: new MemoryStore(), config: { limits: { tickMs: -1 } } }),
    ).toThrow(/invalid kernel config/);
    const k = new Kernel({
      store: new MemoryStore(),
      // biome-ignore lint/suspicious/noTemplateCurlyInString: 测试配置中的 ${env:NAME} 插值语法
      config: { plugins: { 'echo:x': { use: echo, config: { key: '${env:NOPE_NOT_SET}' } } } },
      env: {},
    });
    await expect(k.start()).rejects.toThrow(/NOPE_NOT_SET/);
  });

  it('subscribe 收到提交后的事件', async () => {
    const { kernel } = await setup();
    const seen: string[] = [];
    const off = kernel.subscribe((events) => seen.push(...events.map((e) => e.type)));
    await kernel.submit(draft());
    await waitFor(() => seen.includes('task.succeeded'));
    off();
  });
});
