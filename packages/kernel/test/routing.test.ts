import {
  type AgentEvent,
  DEFAULT_TASK_POLICY,
  type EnvelopeDraft,
  type PluginDefinition,
  type PluginKind,
  type RouterRequest,
  type RouterResult,
  type Store,
  type Task,
  type TaskId,
} from '@super-loop/protocol';
import { LoopError, newId, sleep } from '@super-loop/shared';
import {
  defineTestAgent,
  defineTestRouter,
  MemoryStore,
  makeEnvelope,
  waitFor,
} from '@super-loop/testkit';
import { afterEach, describe, expect, it } from 'vitest';
import { Kernel, type KernelConfigInput } from '../src/index.js';

const ok = (summary = 'done'): AgentEvent => ({ type: 'result', status: 'succeeded', summary });
const coder = defineTestAgent(async function* (input) {
  yield ok(`coded: ${input.prompt}`);
});
const writer = defineTestAgent(async function* (input) {
  yield ok(`wrote: ${input.prompt}`);
});

const kernels: Kernel[] = [];
afterEach(async () => {
  await Promise.all(kernels.splice(0).map((k) => k.stop()));
});

type Route = (req: RouterRequest) => RouterResult | Promise<RouterResult>;

async function setup(
  route: Route,
  opts: { config?: Partial<KernelConfigInput>; store?: Store } = {},
) {
  const router = defineTestRouter(route);
  const plugins: Record<
    string,
    { use: PluginDefinition<PluginKind, unknown>; description?: string }
  > = {
    'coder:default': { use: coder, description: '写代码、修 bug' },
    'writer:default': { use: writer, description: '写文章' },
    'router:default': { use: router },
  };
  const store = opts.store ?? new MemoryStore();
  const kernel = new Kernel({
    store,
    config: {
      routes: [],
      defaults: { unrouted: 'router', router: 'router:default' },
      ...opts.config,
      plugins,
      limits: {
        tickMs: 10,
        routing: { backoff: { type: 'fixed', baseMs: 10, maxMs: 10 } },
        ...opts.config?.limits,
      },
    },
  });
  kernels.push(kernel);
  await kernel.start();
  return { kernel, store, router };
}

const draft = (subject: string, patch: Partial<EnvelopeDraft> = {}): EnvelopeDraft => ({
  kind: 'task',
  idempotencyKey: newId('event'),
  subject,
  payload: null,
  ...patch,
});

async function taskOf(store: Store, envelopeId: string): Promise<Task> {
  const { items } = await store.tasks.list({ where: { envelopeId: envelopeId as never } });
  if (!items[0]) throw new Error('no task');
  return items[0];
}

function waitTask(store: Store, id: TaskId, pred: (t: Task) => boolean, message: string) {
  return waitFor(
    async () => {
      const t = await store.tasks.get(id);
      return t && pred(t) ? t : undefined;
    },
    { message },
  );
}

/** 按标题关键词分配的 Router。 */
const bySubject: Route = (req) => ({
  decisions: req.items.map((it) =>
    it.envelope.subject.includes('文章')
      ? {
          taskId: it.taskId,
          action: 'assign',
          agent: 'writer:default',
          reason: '写作类',
          confidence: 0.9,
        }
      : { taskId: it.taskId, action: 'assign', agent: 'coder:default', reason: '代码类' },
  ),
  usage: { inputTokens: 10, outputTokens: 2 },
});

describe('Router 自动分配', () => {
  it('未匹配 Route 的消息交给 Router，按决策分配并执行', async () => {
    const { kernel, store, router } = await setup(bySubject);
    const a = await kernel.submit(draft('修复登录报错'));
    const b = await kernel.submit(draft('写一篇徒步文章'));

    const ta = await waitTask(
      store,
      (await taskOf(store, a.envelopeId)).id,
      (t) => t.status === 'awaiting_input',
      'a done',
    );
    const tb = await waitTask(
      store,
      (await taskOf(store, b.envelopeId)).id,
      (t) => t.status === 'awaiting_input',
      'b done',
    );
    expect(ta.agent?.agent).toBe('coder:default');
    expect(tb.agent?.agent).toBe('writer:default');
    expect(tb.routing).toMatchObject({
      router: 'router:default',
      status: 'decided',
      action: 'assign',
      reason: '写作类',
      confidence: 0.9,
      attempts: 1,
    });

    // Router 收到可用 Agent（含配置里的说明）
    const req = router.requests[0] as RouterRequest;
    expect(req.agents.map((x) => [x.instance, x.description])).toEqual([
      ['coder:default', '写代码、修 bug'],
      ['writer:default', '写文章'],
    ]);
    const events = await store.readJournal(1, 10_000, { subjectId: tb.id });
    const types = events.map((e) => e.type);
    expect(types).toContain('routing.requested');
    expect(types.indexOf('routing.decided')).toBeLessThan(types.indexOf('task.assigned'));
    const decided = events.find((e) => e.type === 'routing.decided');
    expect(decided?.actor).toBe('plugin:router:default');
    expect(decided?.data).toMatchObject({
      agent: 'writer:default',
      batchUsage: { inputTokens: 10 },
    });
  });

  it('同一实例同时只处理一批；期间到达的消息合并成下一批', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const { kernel, store, router } = await setup(async (req) => {
      calls += 1;
      if (calls === 1) await gate;
      return bySubject(req);
    });
    const first = await kernel.submit(draft('任务 1'));
    await waitFor(async () => (router.requests.length === 1 ? true : undefined));
    const rest = [await kernel.submit(draft('任务 2')), await kernel.submit(draft('任务 3'))];
    await sleep(50);
    expect(router.requests).toHaveLength(1); // 第一批没结束前不会开始第二批
    release();
    for (const e of [first, ...rest]) {
      await waitTask(
        store,
        (await taskOf(store, e.envelopeId)).id,
        (t) => t.status === 'awaiting_input',
        'done',
      );
    }
    expect(router.requests.map((r) => r.items.length)).toEqual([1, 2]);
  });

  it('Route assign=router 只能在候选中选择；选了候选外的 Agent → 留在未分配并说明', async () => {
    const { kernel, store } = await setup(
      (req) => ({
        decisions: req.items.map((it) => ({
          taskId: it.taskId,
          action: 'assign',
          agent: 'writer:default',
          reason: '我觉得是写作',
        })),
      }),
      {
        config: {
          routes: [
            {
              name: 'code',
              assign: 'router',
              match: { labels: { team: 'dev' } },
              agents: [{ agent: 'coder:default', prompt: 'DEV: {{envelope.subject}}' }],
            },
          ],
        },
      },
    );
    const e = await kernel.submit(draft('看看这个', { labels: { team: 'dev' } }));
    const t = await waitTask(
      store,
      (await taskOf(store, e.envelopeId)).id,
      (x) => x.routing?.status === 'decided',
      'decided',
    );
    expect(t.status).toBe('unassigned');
    expect(t.routing?.action).toBe('triage');
    expect(t.routing?.reason).toContain('writer:default');
    expect(t.candidates?.map((c) => c.agent)).toEqual(['coder:default']);
  });

  it('候选内的分配会使用 Route 里该 Agent 的提示词模板', async () => {
    const { kernel, store } = await setup(
      (req) => ({
        decisions: req.items.map((it) => ({
          taskId: it.taskId,
          action: 'assign',
          agent: 'coder:default',
          reason: '代码',
        })),
      }),
      {
        config: {
          routes: [
            {
              name: 'code',
              assign: 'router',
              agents: [{ agent: 'coder:default', prompt: 'DEV: {{envelope.subject}}' }],
            },
          ],
        },
      },
    );
    const e = await kernel.submit(draft('修 bug'));
    const t = await waitTask(
      store,
      (await taskOf(store, e.envelopeId)).id,
      (x) => x.status === 'awaiting_input',
      'done',
    );
    expect(t.lastSummary).toBe('coded: DEV: 修 bug');
  });

  it('triage：留给人处理，Router 建议的 Agent 作为候选，并可调整优先级', async () => {
    const { kernel, store } = await setup((req) => ({
      decisions: req.items.map((it) => ({
        taskId: it.taskId,
        action: 'triage',
        suggestions: ['writer:default', 'nobody:default'],
        priority: 0,
        reason: '信息不足',
      })),
    }));
    const e = await kernel.submit(draft('帮我看一下'));
    const t = await waitTask(
      store,
      (await taskOf(store, e.envelopeId)).id,
      (x) => x.routing?.status === 'decided',
      'decided',
    );
    expect(t.status).toBe('unassigned');
    expect(t.priority).toBe(0);
    expect(t.candidates).toEqual([{ agent: 'writer:default' }]); // 不存在的建议被过滤
  });

  it('Router 出错按退避重试；缺少某个 Task 的决策也会重试', async () => {
    let calls = 0;
    const { kernel, store } = await setup((req) => {
      calls += 1;
      if (calls === 1) throw new LoopError('UPSTREAM_ERROR', 'model down', { retryable: true });
      if (calls === 2) return { decisions: [] };
      return bySubject(req);
    });
    const e = await kernel.submit(draft('修 bug'));
    const id = (await taskOf(store, e.envelopeId)).id;
    const t = await waitTask(store, id, (x) => x.status === 'awaiting_input', 'done');
    expect(t.routing).toMatchObject({ status: 'decided', attempts: 3 });
    const failed = (await store.readJournal(1, 10_000, { subjectId: id })).filter(
      (x) => x.type === 'routing.failed',
    );
    expect(failed.map((x) => (x.data as { error: { code: string } }).error.code)).toEqual([
      'UPSTREAM_ERROR',
      'PLUGIN_PROTOCOL_VIOLATION',
    ]);
  });

  it('不可重试的错误或重试耗尽 → routing.failed，任务留在未分配', async () => {
    const { kernel, store } = await setup(() => {
      throw new LoopError('INVALID_INPUT', 'bad', { retryable: false });
    });
    const e = await kernel.submit(draft('x'));
    const t = await waitTask(
      store,
      (await taskOf(store, e.envelopeId)).id,
      (x) => x.routing?.status === 'failed',
      'failed',
    );
    expect(t.status).toBe('unassigned');
    expect(t.routing?.error?.code).toBe('INVALID_INPUT');

    const { kernel: k2, store: s2 } = await setup(
      () => {
        throw new LoopError('UPSTREAM_ERROR', 'down', { retryable: true });
      },
      {
        config: {
          limits: { routing: { maxAttempts: 2, backoff: { type: 'fixed', baseMs: 5, maxMs: 5 } } },
        },
      },
    );
    const e2 = await k2.submit(draft('y'));
    const t2 = await waitTask(
      s2,
      (await taskOf(s2, e2.envelopeId)).id,
      (x) => x.routing?.status === 'failed',
      'exhausted',
    );
    expect(t2.routing?.attempts).toBe(2);
  });

  it('Router 决策前人已手动分配：本次路由作废，Router 的结果被忽略', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { kernel, store, router } = await setup(async (req) => {
      await gate;
      return bySubject(req);
    });
    const e = await kernel.submit(draft('写一篇文章'));
    await waitFor(async () => (router.requests.length === 1 ? true : undefined));
    const id = (await taskOf(store, e.envelopeId)).id;
    await kernel.assignTask(id, { agent: 'coder:default' }, 'user:alice');
    release();
    const t = await waitTask(store, id, (x) => x.status === 'awaiting_input', 'done');
    expect(t.agent?.agent).toBe('coder:default');
    expect(t.routing?.status).toBe('skipped');
    await sleep(30);
    const types = (await store.readJournal(1, 10_000, { subjectId: id })).map((x) => x.type);
    expect(types).not.toContain('routing.decided');
  });

  it('Router 可以通过 ctx.query 查找历史任务', async () => {
    let found: string[] = [];
    const router = defineTestRouter(async (req, ctx) => {
      found = (await ctx.query.searchTasks({ text: '登录' })).map((t) => t.subject);
      return bySubject(req);
    });
    const store = new MemoryStore();
    const kernel = new Kernel({
      store,
      config: {
        plugins: { 'coder:default': { use: coder }, 'router:default': { use: router } },
        defaults: { unrouted: 'router', router: 'router:default' },
        limits: { tickMs: 10 },
      },
    });
    kernels.push(kernel);
    await kernel.start();
    const e = await kernel.submit(draft('登录页白屏'));
    await waitTask(
      store,
      (await taskOf(store, e.envelopeId)).id,
      (x) => x.status === 'awaiting_input',
      'done',
    );
    expect(found).toEqual(['登录页白屏']);
  });

  it('崩溃恢复：上次停在 running 的路由重新排队', async () => {
    const store = new MemoryStore();
    const env = makeEnvelope({
      subject: '写一篇文章',
      source: { plugin: 'kernel', instance: 'manual:api' },
    });
    const id = newId('task');
    const at = new Date().toISOString();
    await store.envelopes.put(env);
    await store.tasks.put({
      id,
      envelopeId: env.id,
      traceId: env.trace.traceId,
      subject: env.subject,
      source: env.source.instance,
      routing: { router: 'router:default', status: 'running', attempts: 1, batchId: 'rtb_old' },
      sinks: [],
      policy: DEFAULT_TASK_POLICY,
      priority: 2,
      rank: 0,
      status: 'unassigned',
      closeOnComplete: false,
      attempts: 0,
      turnCount: 1,
      artifactCount: 0,
      createdAt: at,
      updatedAt: at,
    });
    await store.turns.put({
      id: newId('turn'),
      taskId: id,
      index: 1,
      content: env.subject,
      by: 'user:api',
      status: 'pending',
      runIds: [],
      createdAt: at,
      updatedAt: at,
    });
    const { store: s } = await setup(bySubject, { store });
    const t = await waitTask(s, id, (x) => x.status === 'awaiting_input', 'recovered');
    expect(t.agent?.agent).toBe('writer:default');
    expect(t.routing).toMatchObject({ status: 'decided', attempts: 2 });
  });

  it('配置检查：unrouted=router 或 assign=router 必须指定 Router', async () => {
    const make = (config: KernelConfigInput) => {
      const k = new Kernel({ store: new MemoryStore(), config });
      kernels.push(k);
      return k.start();
    };
    await expect(make({ defaults: { unrouted: 'router' } })).rejects.toThrow(/defaults.router/);
    await expect(make({ routes: [{ name: 'r', assign: 'router' }] })).rejects.toThrow(
      /requires route.router or defaults.router/,
    );
  });
});
