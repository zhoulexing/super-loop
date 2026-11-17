import type {
  ApiPage,
  Approval,
  ApprovalId,
  ApprovalStatus,
  AssignTaskInput,
  CloseTaskInput,
  DecideApprovalInput,
  Delivery,
  DeliveryStatus,
  Envelope,
  EnvelopeDetail,
  EnvelopeId,
  EnvelopeKind,
  FileRef,
  HealthResponse,
  InboxItem,
  JournalEvent,
  JournalPage,
  PluginWithHealth,
  RetryTaskInput,
  Route,
  RunDetail,
  RunId,
  SendMessageInput,
  SubmitEnvelopeInput,
  SubmitEnvelopeResult,
  Task,
  TaskDetail,
  TaskId,
  TaskStatus,
  Turn,
  UpdateTaskInput,
} from '@super-loop/protocol';
import { errorFromResponse, LoopApiError } from './errors.js';
import { SseParser } from './sse.js';

export interface ClientOptions {
  /** 服务地址，如 `http://localhost:7300`。默认空字符串，即与页面同源（看板由 server 托管时）。 */
  baseUrl?: string;
  /** `server.token`，设置后以 `Authorization: Bearer` 发送。 */
  token?: string;
  /** 操作人，以 `x-loop-user` 发送，Journal 中记为 `user:<name>`。 */
  user?: string;
  /** 自定义 fetch（测试、代理）；默认全局 fetch。 */
  fetch?: typeof fetch;
  /** 附加到每个请求的头。 */
  headers?: Record<string, string>;
}

export interface PageQuery {
  cursor?: string;
  limit?: number;
}

export interface TaskListQuery extends PageQuery {
  /** 一个或多个状态。 */
  status?: TaskStatus | readonly TaskStatus[];
}

export interface JournalQuery {
  fromSeq?: number;
  limit?: number;
  traceId?: string;
  subjectId?: string;
}

export interface StreamOptions {
  /** 从这个 seq 开始回放历史再推送实时事件；不填则只推送连接之后的新事件。 */
  fromSeq?: number;
  onEvent(event: JournalEvent): void;
  /** 每次（重新）连接成功时调用。 */
  onOpen?(): void;
  /** 连接失败或中断时调用；`retryInMs` 为空表示不再重试（如鉴权失败）。 */
  onError?(error: LoopApiError, info: { attempt: number; retryInMs?: number }): void;
  signal?: AbortSignal;
  /** 重连退避：从 baseMs 起翻倍，最多 maxMs。默认 1s / 30s。 */
  retry?: { baseMs?: number; maxMs?: number };
}

export interface StreamHandle {
  close(): void;
  /** 最后收到的事件序号（断线重连时据此续传）。 */
  readonly lastSeq: number | undefined;
  /** 订阅彻底结束（close、signal 中止或不可重试的错误）时 resolve。 */
  readonly done: Promise<void>;
}

/** fetch 支持的请求体类型（不依赖 DOM lib）。 */
type RequestBody = NonNullable<RequestInit['body']>;

type QueryValue = string | number | boolean | undefined | readonly string[];

interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** 原始请求体（上传文件），与 body 互斥。 */
  raw?: { data: RequestBody; contentType?: string };
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

const API_PREFIX = '/api/v1';

function queryString(query: Record<string, QueryValue> = {}): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    params.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

const seg = (id: string) => encodeURIComponent(id);

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Super Loop Kernel API 客户端。浏览器与 Node（≥ 18，全局 fetch）通用。
 *
 * ```ts
 * const loop = createClient({ baseUrl: 'http://localhost:7300', user: 'alice' });
 * const { items } = await loop.tasks.list({ status: ['queued', 'running'] });
 * await loop.tasks.sendMessage(taskId, { content: '再看看', mode: 'queue' });
 * const sub = loop.stream({ fromSeq: 1, onEvent: (e) => console.log(e.type) });
 * ```
 */
export class LoopClient {
  readonly baseUrl: string;
  readonly #token: string | undefined;
  readonly #user: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #headers: Record<string, string>;

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
    this.#token = options.token;
    this.#user = options.user;
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== 'function') throw new Error('fetch is not available; pass options.fetch');
    this.#fetch = f.bind(globalThis);
    this.#headers = { ...options.headers };
  }

  /** 拼出完整的 API 地址（不含鉴权信息）。 */
  url(path: string, query?: Record<string, QueryValue>): string {
    return `${this.baseUrl}${API_PREFIX}${path}${queryString(query)}`;
  }

  #baseHeaders(): Record<string, string> {
    return {
      ...this.#headers,
      ...(this.#token ? { authorization: `Bearer ${this.#token}` } : {}),
      ...(this.#user ? { 'x-loop-user': this.#user } : {}),
    };
  }

  async #send(method: string, path: string, opts: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { ...this.#baseHeaders(), ...opts.headers };
    let body: RequestBody | undefined;
    if (opts.raw) {
      body = opts.raw.data;
      if (opts.raw.contentType) headers['content-type'] = opts.raw.contentType;
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers['content-type'] = 'application/json';
    }
    let res: Response;
    try {
      res = await this.#fetch(this.url(path, opts.query), {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      throw new LoopApiError(
        'UNAVAILABLE',
        `cannot reach ${this.baseUrl || 'server'}: ${String(error)}`,
        0,
      );
    }
    if (!res.ok) throw await errorFromResponse(res);
    return res;
  }

  /** 发送请求并解析 JSON 响应。供扩展使用；常用接口请用下面的分组方法。 */
  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.#send(method, path, opts);
    return (await res.json()) as T;
  }

  // ─────────────────────────── 总览 ───────────────────────────

  health(): Promise<HealthResponse> {
    return this.request('GET', '/health');
  }

  readonly plugins = {
    /** 插件实例及其健康检查结果。 */
    list: (): Promise<{ items: PluginWithHealth[] }> => this.request('GET', '/plugins'),
  };

  readonly routes = {
    list: (): Promise<{ items: Route[] }> => this.request('GET', '/routes'),
  };

  // ─────────────────────────── Envelope ───────────────────────────

  readonly envelopes = {
    /** 提交消息；重复的 idempotencyKey 返回 `duplicated: true`。 */
    submit: (input: SubmitEnvelopeInput): Promise<SubmitEnvelopeResult> =>
      this.request('POST', '/envelopes', { body: input }),
    list: (q: PageQuery & { kind?: EnvelopeKind } = {}): Promise<ApiPage<Envelope>> =>
      this.request('GET', '/envelopes', { query: { ...q } }),
    get: (id: EnvelopeId): Promise<EnvelopeDetail> => this.request('GET', `/envelopes/${seg(id)}`),
  };

  // ─────────────────────────── Task（会话） ───────────────────────────

  readonly tasks = {
    /** 新建的在前。 */
    list: (q: TaskListQuery = {}): Promise<ApiPage<Task>> =>
      this.request('GET', '/tasks', {
        query: {
          cursor: q.cursor,
          limit: q.limit,
          status: q.status,
        },
      }),
    /** 任务详情：Envelope、所有 Turn（按轮次升序）与 Run。 */
    get: (id: TaskId): Promise<TaskDetail> => this.request('GET', `/tasks/${seg(id)}`),
    turns: (id: TaskId): Promise<{ items: Turn[] }> =>
      this.request('GET', `/tasks/${seg(id)}/turns`),
    /** 追问；执行中默认排队，`mode: 'interrupt'` 立即打断。已关闭的任务会自动重新打开。 */
    sendMessage: (id: TaskId, input: SendMessageInput): Promise<Turn> =>
      this.request('POST', `/tasks/${seg(id)}/messages`, { body: input }),
    /** 分配或改派 Agent。 */
    assign: (id: TaskId, input: AssignTaskInput): Promise<Task> =>
      this.request('POST', `/tasks/${seg(id)}/assign`, { body: input }),
    /** 排队中的任务退回"未分配"。 */
    unassign: (id: TaskId): Promise<Task> => this.request('POST', `/tasks/${seg(id)}/unassign`),
    /** 重试失败的任务，可同时换 Agent。 */
    retry: (id: TaskId, input: RetryTaskInput = {}): Promise<Task> =>
      this.request('POST', `/tasks/${seg(id)}/retry`, { body: input }),
    /** 关闭；执行中会中止当前 Run。 */
    close: (id: TaskId, input: CloseTaskInput = {}): Promise<Task> =>
      this.request('POST', `/tasks/${seg(id)}/close`, { body: input }),
    reopen: (id: TaskId): Promise<Task> => this.request('POST', `/tasks/${seg(id)}/reopen`),
    /** 调整优先级 / 派发顺序（看板拖拽排序）。 */
    update: (id: TaskId, input: UpdateTaskInput): Promise<Task> =>
      this.request('PATCH', `/tasks/${seg(id)}`, { body: input }),
  };

  readonly runs = {
    /** Run 详情与它的事件流。 */
    get: (id: RunId): Promise<RunDetail> => this.request('GET', `/runs/${seg(id)}`),
  };

  // ─────────────────────────── 审批 / 通知 ───────────────────────────

  readonly approvals = {
    list: (q: PageQuery & { status?: ApprovalStatus } = {}): Promise<ApiPage<Approval>> =>
      this.request('GET', '/approvals', { query: { ...q } }),
    decide: (id: ApprovalId, input: DecideApprovalInput): Promise<Approval> =>
      this.request('POST', `/approvals/${seg(id)}/decision`, { body: input }),
  };

  readonly deliveries = {
    list: (q: PageQuery & { status?: DeliveryStatus } = {}): Promise<ApiPage<Delivery>> =>
      this.request('GET', '/deliveries', { query: { ...q } }),
  };

  readonly notifications = {
    /** 看板收件箱，新的在前；默认 `dashboard:default`。 */
    list: (q: { sink?: string; limit?: number } = {}): Promise<{ items: InboxItem[] }> =>
      this.request('GET', '/notifications', { query: { ...q } }),
  };

  // ─────────────────────────── 文件 ───────────────────────────

  readonly files = {
    /** 上传附件，返回的 FileRef 可放进追问的 attachments 或 Envelope.attachments。 */
    upload: (
      data: Blob | ArrayBuffer | Uint8Array | string,
      meta: { name: string; mime?: string },
    ): Promise<FileRef> =>
      this.request('POST', '/files', {
        query: { name: meta.name },
        raw: {
          data: data as RequestBody,
          contentType:
            meta.mime ??
            (typeof Blob !== 'undefined' && data instanceof Blob && data.type
              ? data.type
              : 'application/octet-stream'),
        },
      }),
    /** 下载附件 / 产物。 */
    download: async (ref: string): Promise<Blob> =>
      (await this.#send('GET', '/files', { query: { ref } })).blob(),
    /**
     * 文件地址（用于 `<a href>` / `<img src>`）。注意：链接不带鉴权头，
     * 配置了 token 时请改用 `download()`。
     */
    url: (ref: string, opts: { download?: boolean } = {}): string =>
      this.url('/files', { ref, download: opts.download ? '1' : undefined }),
  };

  // ─────────────────────────── Journal / 实时 ───────────────────────────

  readonly journal = {
    list: (q: JournalQuery = {}): Promise<JournalPage> =>
      this.request('GET', '/journal', { query: { ...q } }),
  };

  /**
   * 订阅 Journal 事件（SSE）。基于 fetch 实现，因此可以带鉴权头；
   * 断线后按退避自动重连，并用 `Last-Event-ID` 从断点续传，不丢事件。
   */
  stream(options: StreamOptions): StreamHandle {
    const controller = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const signal = controller.signal;
    const baseMs = options.retry?.baseMs ?? 1_000;
    const maxMs = options.retry?.maxMs ?? 30_000;
    let lastSeq: number | undefined;

    const connect = async (): Promise<void> => {
      const query =
        lastSeq === undefined && options.fromSeq !== undefined
          ? { fromSeq: options.fromSeq }
          : undefined;
      const res = await this.#send('GET', '/stream', {
        ...(query ? { query } : {}),
        headers: {
          accept: 'text/event-stream',
          ...(lastSeq === undefined ? {} : { 'last-event-id': String(lastSeq) }),
        },
        signal,
      });
      if (!res.body) throw new LoopApiError('UNAVAILABLE', 'stream has no body', 0);
      options.onOpen?.();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const parser = new SseParser();
      // 不是所有 fetch 实现都会在 abort 时结束响应体，主动取消读取
      const cancel = () => void reader.cancel().catch(() => {});
      signal.addEventListener('abort', cancel, { once: true });
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          for (const msg of parser.push(decoder.decode(value, { stream: true }))) {
            if (msg.event === 'ping' || msg.data === '') continue;
            let event: JournalEvent;
            try {
              event = JSON.parse(msg.data) as JournalEvent;
            } catch {
              continue;
            }
            if (lastSeq !== undefined && event.seq <= lastSeq) continue;
            lastSeq = event.seq;
            try {
              options.onEvent(event);
            } catch (error) {
              // 监听器的异常不影响订阅，异步抛出以便在控制台看到
              queueMicrotask(() => {
                throw error;
              });
            }
          }
        }
      } finally {
        signal.removeEventListener('abort', cancel);
        reader.releaseLock();
      }
    };

    const done = (async () => {
      let attempt = 0;
      while (!signal.aborted) {
        try {
          await connect();
          attempt = 0; // 服务端正常关闭了连接：稍等后重连
          await abortableSleep(baseMs, signal);
        } catch (error) {
          if (signal.aborted) break;
          const err =
            error instanceof LoopApiError
              ? error
              : new LoopApiError('UNAVAILABLE', `stream interrupted: ${String(error)}`, 0);
          attempt += 1;
          if (!err.retryable) {
            options.onError?.(err, { attempt });
            break;
          }
          const retryInMs = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
          options.onError?.(err, { attempt, retryInMs });
          await abortableSleep(retryInMs, signal);
        }
      }
    })();

    return {
      close: () => controller.abort(),
      get lastSeq() {
        return lastSeq;
      },
      done,
    };
  }
}

export function createClient(options: ClientOptions = {}): LoopClient {
  return new LoopClient(options);
}

/**
 * 遍历游标分页的全部结果：
 * `for await (const t of paginate((cursor) => loop.tasks.list({ cursor }))) { ... }`
 */
export async function* paginate<T>(
  fetchPage: (cursor: string | undefined) => Promise<ApiPage<T>>,
): AsyncGenerator<T> {
  let cursor: string | undefined;
  do {
    const page = await fetchPage(cursor);
    yield* page.items;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
}
