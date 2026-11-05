import { type Kernel, pluginKvNamespace } from '@super-loop/kernel';
import {
  type Actor,
  ApprovalStatusSchema,
  DeliveryStatusSchema,
  EnvelopeDraftSchema,
  EnvelopeKindSchema,
  type JournalEvent,
  TaskStatusSchema,
} from '@super-loop/protocol';
import { ErrorCode, isId, isLoopError, LoopError, newId } from '@super-loop/shared';
import { INBOX_PREFIX, type InboxItem } from '@super-loop/sink-dashboard';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { z } from 'zod';

export interface AppOptions {
  kernel: Kernel;
  /** 设置后所有 /api 请求（除 health）需要 `Authorization: Bearer <token>`。 */
  token?: string | undefined;
}

const STATUS_BY_CODE: Record<string, ContentfulStatusCode> = {
  [ErrorCode.INVALID_INPUT]: 400,
  [ErrorCode.PERMISSION_DENIED]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.SPAWN_DEPTH_EXCEEDED]: 422,
  [ErrorCode.UNAVAILABLE]: 503,
};

/** API 提交时 kind / idempotencyKey / payload 可省略。 */
const SubmitSchema = EnvelopeDraftSchema.extend({
  kind: EnvelopeKindSchema.default('task'),
  idempotencyKey: z.string().min(1).optional(),
  payload: z.unknown().optional(),
});

const DecisionSchema = z.object({
  decision: z.enum(['grant', 'reject']),
  comment: z.string().max(2_000).optional(),
});

function badRequest(message: string, details?: Record<string, unknown>): never {
  throw new LoopError(ErrorCode.INVALID_INPUT, message, {
    retryable: false,
    ...(details ? { details } : {}),
  });
}

function notFound(what: string): never {
  throw new LoopError(ErrorCode.NOT_FOUND, `${what} not found`, { retryable: false });
}

function page(c: Context): { limit: number; cursor?: string } {
  const limit = Number(c.req.query('limit') ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) badRequest('limit must be 1..500');
  const cursor = c.req.query('cursor');
  return cursor ? { limit, cursor } : { limit };
}

function enumQuery<T extends string>(
  c: Context,
  name: string,
  schema: z.ZodType<T>,
): T | undefined {
  const raw = c.req.query(name);
  if (raw === undefined) return undefined;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) badRequest(`invalid ${name}: ${raw}`);
  return parsed.data;
}

async function json(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return badRequest('request body must be JSON');
  }
}

function actorOf(c: Context): Actor {
  const user = c.req.header('x-loop-user');
  if (user === undefined) return 'user:api';
  if (!/^[\w.@-]{1,64}$/.test(user)) badRequest('invalid x-loop-user header');
  return `user:${user}`;
}

/** Kernel HTTP API v1（AGENTS.md §10.1）。只增不改，破坏性变更走 /api/v2。 */
export function createApp({ kernel, token }: AppOptions): Hono {
  const { store } = kernel;
  const app = new Hono();

  app.onError((error, c) => {
    if (isLoopError(error)) {
      const status = STATUS_BY_CODE[error.code] ?? 500;
      return c.json(
        { error: { code: error.code, message: error.message, details: error.details } },
        status,
      );
    }
    kernel.logger.error('unhandled api error', { error: String(error) });
    return c.json({ error: { code: ErrorCode.INTERNAL, message: 'internal error' } }, 500);
  });
  app.notFound((c) =>
    c.json({ error: { code: ErrorCode.NOT_FOUND, message: 'route not found' } }, 404),
  );

  const api = new Hono();

  api.use('*', async (c, next) => {
    if (
      token &&
      c.req.path !== '/api/v1/health' &&
      c.req.header('authorization') !== `Bearer ${token}`
    ) {
      throw new LoopError(ErrorCode.PERMISSION_DENIED, 'missing or invalid token', {
        retryable: false,
      });
    }
    await next();
  });

  // ─────────────────────────── 总览 ───────────────────────────

  api.get('/health', async (c) =>
    c.json({
      status: kernel.state === 'running' ? 'ok' : 'degraded',
      kernel: kernel.state,
      activeRuns: kernel.activeRuns,
      latestSeq: await store.latestSeq(),
      plugins: kernel.plugins.list(),
    }),
  );

  api.get('/plugins', async (c) => {
    const items = await Promise.all(
      kernel.plugins
        .list()
        .map(async (p) => ({ ...p, health: await kernel.plugins.health(p.instance) })),
    );
    return c.json({ items });
  });

  api.get('/routes', (c) => c.json({ items: kernel.routes }));

  // ─────────────────────────── Envelope ───────────────────────────

  api.post('/envelopes', async (c) => {
    const parsed = SubmitSchema.safeParse(await json(c));
    if (!parsed.success) badRequest('invalid envelope', { issues: parsed.error.issues });
    const { idempotencyKey, payload, ...rest } = parsed.data;
    const result = await kernel.submit(
      {
        ...rest,
        idempotencyKey: idempotencyKey ?? `api:${newId('event')}`,
        payload: payload ?? null,
      },
      actorOf(c),
    );
    return c.json(result, result.duplicated ? 200 : 201);
  });

  api.get('/envelopes', async (c) => {
    const kind = enumQuery(c, 'kind', EnvelopeKindSchema);
    return c.json(
      await store.envelopes.list({
        ...page(c),
        order: 'desc',
        ...(kind ? { where: { kind } } : {}),
      }),
    );
  });

  api.get('/envelopes/:id', async (c) => {
    const id = c.req.param('id');
    const envelope = isId('envelope', id) ? await store.envelopes.get(id) : undefined;
    if (!envelope) notFound('envelope');
    const tasks = await store.tasks.list({ where: { envelopeId: envelope.id }, limit: 100 });
    return c.json({ envelope, tasks: tasks.items });
  });

  // ─────────────────────────── Task / Run ───────────────────────────

  api.get('/tasks', async (c) => {
    const status = enumQuery(c, 'status', TaskStatusSchema);
    return c.json(
      await store.tasks.list({
        ...page(c),
        order: 'desc',
        ...(status ? { where: { status } } : {}),
      }),
    );
  });

  api.get('/tasks/:id', async (c) => {
    const id = c.req.param('id');
    const task = isId('task', id) ? await store.tasks.get(id) : undefined;
    if (!task) notFound('task');
    const [envelope, runs] = await Promise.all([
      store.envelopes.get(task.envelopeId),
      store.runs.list({ where: { taskId: task.id }, limit: 100 }),
    ]);
    return c.json({ task, envelope, runs: runs.items });
  });

  api.post('/tasks/:id/cancel', async (c) => {
    const id = c.req.param('id');
    if (!isId('task', id)) notFound('task');
    await kernel.cancelTask(id, actorOf(c));
    return c.json({ ok: true }, 202);
  });

  api.get('/runs/:id', async (c) => {
    const id = c.req.param('id');
    const run = isId('run', id) ? await store.runs.get(id) : undefined;
    if (!run) notFound('run');
    const events = await store.readJournal(1, 2_000, { subjectId: run.id });
    return c.json({ run, events });
  });

  // ─────────────────────────── 审批 ───────────────────────────

  api.get('/approvals', async (c) => {
    const status = enumQuery(c, 'status', ApprovalStatusSchema);
    return c.json(
      await store.approvals.list({
        ...page(c),
        order: 'desc',
        ...(status ? { where: { status } } : {}),
      }),
    );
  });

  api.post('/approvals/:id/decision', async (c) => {
    const id = c.req.param('id');
    if (!isId('approval', id)) notFound('approval');
    const parsed = DecisionSchema.safeParse(await json(c));
    if (!parsed.success) badRequest('invalid decision', { issues: parsed.error.issues });
    const approval = await kernel.decideApproval(id, {
      decision: parsed.data.decision,
      by: actorOf(c),
      ...(parsed.data.comment === undefined ? {} : { comment: parsed.data.comment }),
    });
    return c.json(approval);
  });

  // ─────────────────────────── 通知 ───────────────────────────

  api.get('/deliveries', async (c) => {
    const status = enumQuery(c, 'status', DeliveryStatusSchema);
    return c.json(
      await store.deliveries.list({
        ...page(c),
        order: 'desc',
        ...(status ? { where: { status } } : {}),
      }),
    );
  });

  /** 看板收件箱（sink-dashboard 实例写入的通知），按时间倒序。 */
  api.get('/notifications', async (c) => {
    const sink = c.req.query('sink') ?? 'dashboard:default';
    const { limit } = page(c);
    const all = await store.kv(pluginKvNamespace(sink)).list<InboxItem>(INBOX_PREFIX);
    return c.json({
      items: all
        .map((e) => e.value)
        .reverse()
        .slice(0, limit),
    });
  });

  // ─────────────────────────── 文件 ───────────────────────────

  /** 下载附件或产物：`GET /files?ref=artifact:run_xxx/report.md`。不存在返回 404。 */
  api.get('/files', async (c) => {
    const ref = c.req.query('ref');
    if (!ref) badRequest('ref is required');
    const meta = await kernel.content.stat(ref);
    if (!meta) notFound('file');
    const data = await kernel.content.read(ref);
    const download = c.req.query('download') === '1';
    return c.body(data as Uint8Array<ArrayBuffer>, 200, {
      'content-type': meta.mime,
      'content-length': String(meta.size),
      'x-content-type-options': 'nosniff',
      // 产物来自 Agent，不允许在 API 源下以 HTML 渲染执行
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
    });
  });

  // ─────────────────────────── Journal ───────────────────────────

  api.get('/journal', async (c) => {
    const fromSeq = Number(c.req.query('fromSeq') ?? 1);
    if (!Number.isInteger(fromSeq) || fromSeq < 1) badRequest('fromSeq must be a positive integer');
    const traceId = c.req.query('traceId');
    const subjectId = c.req.query('subjectId');
    const items = await store.readJournal(fromSeq, page(c).limit, {
      ...(traceId ? { traceId } : {}),
      ...(subjectId ? { subjectId } : {}),
    });
    const last = items.at(-1);
    return c.json({ items, ...(last ? { nextFromSeq: last.seq + 1 } : {}) });
  });

  /** SSE：先回放 fromSeq 之后的历史事件，再推送实时事件；断线后带 Last-Event-ID 续传。 */
  api.get('/stream', (c) => {
    const resume = Number(c.req.header('last-event-id') ?? Number.NaN);
    const fromSeq = Number.isInteger(resume) ? resume + 1 : Number(c.req.query('fromSeq') ?? 0);
    return streamSSE(c, async (stream) => {
      let last = Number.isInteger(fromSeq) && fromSeq > 0 ? fromSeq - 1 : await store.latestSeq();
      const queue: JournalEvent[] = [];
      let wake: (() => void) | undefined;
      let closed = false;
      const off = kernel.subscribe((events) => {
        queue.push(...events);
        wake?.();
      });
      stream.onAbort(() => {
        closed = true;
        off();
        wake?.();
      });
      const send = (e: JournalEvent) =>
        stream.writeSSE({ id: String(e.seq), event: e.type, data: JSON.stringify(e) });

      for (;;) {
        const batch = await store.readJournal(last + 1, 500);
        for (const e of batch) {
          await send(e);
          last = e.seq;
        }
        if (batch.length < 500) break;
      }
      while (!closed) {
        queue.sort((a, b) => a.seq - b.seq);
        while (queue.length > 0) {
          const e = queue.shift() as JournalEvent;
          if (e.seq <= last) continue;
          await send(e);
          last = e.seq;
        }
        const timedOut = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(true), 15_000);
          wake = () => {
            clearTimeout(timer);
            resolve(false);
          };
        });
        wake = undefined;
        if (timedOut && !closed) await stream.writeSSE({ event: 'ping', data: '' });
      }
    });
  });

  app.route('/api/v1', api);
  return app;
}
