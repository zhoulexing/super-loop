import type { JournalEvent } from '@super-loop/protocol';
import { describe, expect, it } from 'vitest';
import { createClient, LoopApiError, paginate, SseParser } from '../src/index.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** 记录请求并按顺序返回预设响应的假 fetch。 */
function fakeFetch(responses: Array<Response | (() => Response) | Error>) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({
      url: String(input),
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string>) },
      body: init.body,
    });
    const next = responses.shift();
    if (next === undefined) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const event = (seq: number): JournalEvent =>
  ({
    seq,
    id: `evt_${seq}`,
    type: 'task.queued',
    at: '2026-11-05T00:00:00.000Z',
    subject: { kind: 'task', id: 'task_x' },
    actor: 'kernel',
    data: {},
  }) as unknown as JournalEvent;

/** 逐块输出文本的 SSE 响应。 */
function sse(chunks: string[]) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

const frame = (e: JournalEvent) => `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

describe('LoopClient 请求', () => {
  it('拼接地址、查询参数、鉴权头与 JSON 请求体', async () => {
    const { fetch, calls } = fakeFetch([
      json({ items: [] }),
      json({ id: 'turn_1', index: 2 }, 201),
    ]);
    const loop = createClient({ baseUrl: 'http://h:7300/', token: 't0k', user: 'alice', fetch });

    await loop.tasks.list({ status: ['queued', 'running'], limit: 20 });
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: 'http://h:7300/api/v1/tasks?limit=20&status=queued%2Crunning',
      headers: { authorization: 'Bearer t0k', 'x-loop-user': 'alice' },
    });

    const turn = await loop.tasks.sendMessage('task_a/b' as never, { content: 'hi' });
    expect(turn.index).toBe(2);
    expect(calls[1]).toMatchObject({
      method: 'POST',
      url: 'http://h:7300/api/v1/tasks/task_a%2Fb/messages',
      headers: { 'content-type': 'application/json' },
      body: '{"content":"hi"}',
    });
    // 文件地址
    expect(loop.files.url('artifact:t/r/a b.md', { download: true })).toBe(
      'http://h:7300/api/v1/files?ref=artifact%3At%2Fr%2Fa+b.md&download=1',
    );
  });

  it('默认同源：baseUrl 为空时使用相对地址', async () => {
    const { fetch, calls } = fakeFetch([json({ status: 'ok' })]);
    await createClient({ fetch }).health();
    expect(calls[0]?.url).toBe('/api/v1/health');
  });

  it('上传文件发送原始字节与 MIME', async () => {
    const { fetch, calls } = fakeFetch([json({ ref: 'attachment:x', name: 'a.md' }, 201)]);
    await createClient({ fetch }).files.upload('# hi', { name: 'a.md', mime: 'text/markdown' });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: '/api/v1/files?name=a.md',
      headers: { 'content-type': 'text/markdown' },
      body: '# hi',
    });
  });

  it('错误统一转成 LoopApiError', async () => {
    const { fetch } = fakeFetch([
      json({ error: { code: 'CONFLICT', message: 'already closed', details: { a: 1 } } }, 409),
      new Response('bad gateway', { status: 502, statusText: 'Bad Gateway' }),
      new TypeError('fetch failed'),
    ]);
    const loop = createClient({ fetch });
    const e1 = await loop.tasks.close('task_x' as never).catch((e) => e);
    expect(e1).toBeInstanceOf(LoopApiError);
    expect(e1).toMatchObject({
      code: 'CONFLICT',
      status: 409,
      details: { a: 1 },
      retryable: false,
    });
    await expect(loop.health()).rejects.toMatchObject({
      code: 'INTERNAL',
      status: 502,
      retryable: true,
    });
    await expect(loop.health()).rejects.toMatchObject({ code: 'UNAVAILABLE', status: 0 });
  });

  it('paginate 按游标遍历全部结果', async () => {
    const pages = [{ items: [1, 2], nextCursor: 'c1' }, { items: [3] }];
    const seen: Array<string | undefined> = [];
    const out: number[] = [];
    for await (const n of paginate(async (cursor) => {
      seen.push(cursor);
      return pages.shift() as { items: number[]; nextCursor?: string };
    })) {
      out.push(n);
    }
    expect(out).toEqual([1, 2, 3]);
    expect(seen).toEqual([undefined, 'c1']);
  });
});

describe('SseParser', () => {
  it('跨块拼接、CRLF、注释与多行 data', () => {
    const p = new SseParser();
    expect(p.push('id: 1\r\nevent: a\r\nda')).toEqual([]);
    expect(p.push('ta: x\r\n\r\n: comment\n\ndata: l1\ndata: l2\n\n')).toEqual([
      { id: '1', event: 'a', data: 'x' },
      { id: '1', event: 'message', data: 'l1\nl2' },
    ]);
  });
});

describe('LoopClient.stream', () => {
  it('回放 + 实时事件；断线后带 Last-Event-ID 续传，跳过重复与 ping', async () => {
    const { fetch, calls } = fakeFetch([
      sse([frame(event(1)), `${frame(event(2)).slice(0, 10)}`, frame(event(2)).slice(10)]),
      sse(['event: ping\ndata: \n\n', frame(event(2)), frame(event(3))]),
      () => new Response(new ReadableStream(), { headers: {} }), // 挂起，直到 close
    ]);
    const seen: number[] = [];
    let opens = 0;
    const sub = createClient({ fetch, token: 'k' }).stream({
      fromSeq: 1,
      onEvent: (e) => seen.push(e.seq),
      onOpen: () => {
        opens += 1;
      },
      retry: { baseMs: 1 },
    });
    await expect.poll(() => seen).toEqual([1, 2, 3]);
    await expect.poll(() => opens).toBe(3);
    sub.close();
    await sub.done;

    expect(sub.lastSeq).toBe(3);
    expect(calls[0]?.url).toBe('/api/v1/stream?fromSeq=1');
    expect(calls[0]?.headers).toMatchObject({
      accept: 'text/event-stream',
      authorization: 'Bearer k',
    });
    expect(calls[1]?.url).toBe('/api/v1/stream'); // 续传时不再带 fromSeq
    expect(calls[1]?.headers['last-event-id']).toBe('2');
    expect(calls[2]?.headers['last-event-id']).toBe('3');
  });

  it('网络错误按退避重试；鉴权失败不再重试', async () => {
    const { fetch } = fakeFetch([
      new TypeError('ECONNREFUSED'),
      json({ error: { code: 'PERMISSION_DENIED', message: 'bad token' } }, 403),
    ]);
    const errors: Array<[string, number | undefined]> = [];
    const sub = createClient({ fetch }).stream({
      onEvent: () => {},
      onError: (e, info) => errors.push([e.code, info.retryInMs]),
      retry: { baseMs: 1 },
    });
    await sub.done;
    expect(errors).toEqual([
      ['UNAVAILABLE', 1],
      ['PERMISSION_DENIED', undefined],
    ]);
  });
});
