import {
  type Actor,
  type AgentEvent,
  AgentEventSchema,
  type AgentPlugin,
  type AgentResultEvent,
  type Approval,
  type ApprovalId,
  type ApprovalOutcome,
  type ApprovalRequest,
  ApprovalRequestSchema,
  type Clock,
  type ContentStore,
  canTransitionTask,
  type Delivery,
  type DeliveryResult,
  DeliveryResultSchema,
  type DirectoryProvider,
  type EmitResult,
  type Envelope,
  type EnvelopeDraft,
  EnvelopeDraftSchema,
  type ErrorPayload,
  type FileRef,
  type InstanceName,
  isTerminalTaskStatus,
  type JournalEvent,
  type JournalEventDraft,
  type JournalEventType,
  type Logger,
  type RiskLevel,
  type Route,
  type Run,
  type RunId,
  type SecretResolver,
  type Store,
  type StoreTx,
  type SubjectRef,
  type Task,
  type TaskId,
  type TaskPolicy,
  type TaskStatus,
  type TraceId,
  type Usage,
} from '@super-loop/protocol';
import {
  computeBackoffMs,
  createMemoryContentStore,
  ErrorCode,
  LoopError,
  newId,
  noopLogger,
  renderTemplate,
  systemClock,
  toLoopError,
  withTimeout,
} from '@super-loop/shared';
import { type KernelConfig, type KernelConfigInput, mergePolicy, resolveConfig } from './config.js';
import { buildNotification, type NotifyContext, sinksFor } from './notify.js';
import { PluginHost, type PluginHostEvent } from './plugin-host.js';
import { type ResolvedBinding, resolveBindings, validateRoute } from './router.js';

export type KernelState = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';

export interface KernelOptions {
  store: Store;
  config: KernelConfigInput;
  clock?: Clock;
  logger?: Logger;
  /** 附件与产物存储，默认内存实现。 */
  content?: ContentStore;
  /** 工作区与共享/状态/缓存目录；不提供时 Run 没有工作区。 */
  dirs?: DirectoryProvider;
  secrets?: SecretResolver;
  /** `${env:NAME}` 插值与默认密钥来源，默认 process.env。 */
  env?: NodeJS.ProcessEnv;
}

export interface IngestOrigin {
  source: { plugin: string; instance: InstanceName };
  actor: Actor;
  /** 由 Agent 派生时的父 Envelope。 */
  parent?: Envelope;
}

export interface ApprovalDecisionInput {
  decision: 'grant' | 'reject';
  by: Actor;
  comment?: string;
}

export type JournalListener = (events: JournalEvent[]) => void;

/** API / CLI 手动提交使用的虚拟来源。 */
export const MANUAL_SOURCE = { plugin: 'kernel', instance: 'manual:api' as InstanceName };

const KERNEL_SUBJECT: SubjectRef = { kind: 'kernel', id: 'kernel' };

type RunOutcome =
  | { status: 'succeeded'; summary: string; output?: unknown }
  | { status: 'failed' | 'timed_out' | 'cancelled'; summary: string; error: ErrorPayload };

const RUN_EVENT: Record<RunOutcome['status'], JournalEventType> = {
  succeeded: 'run.succeeded',
  failed: 'run.failed',
  timed_out: 'run.timed_out',
  cancelled: 'run.cancelled',
};

interface ActiveRun {
  runId: RunId;
  taskId: TaskId;
  traceId: TraceId;
  instance: InstanceName;
  agent: AgentPlugin;
  controller: AbortController;
  finalized: boolean;
  concurrencyKey: string | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** 超时截止时间（ms）；等待审批期间暂停。 */
  deadline: number;
  remainingMs: number;
  waitingApproval: ApprovalId | undefined;
  usage: Usage | undefined;
  sessionId: string | undefined;
  lastLeaseRefresh: number;
}

interface ApprovalWaiter {
  runId: RunId;
  resolve(outcome: ApprovalOutcome): void;
}

/** 事务内的写入器：累积 Journal 事件，事务提交前统一 append。 */
class Writer {
  readonly drafts: JournalEventDraft[] = [];

  constructor(
    readonly tx: StoreTx,
    private readonly clock: Clock,
    private readonly actor: Actor,
  ) {}

  emit(type: JournalEventType, subject: SubjectRef, data: unknown, traceId?: TraceId): void {
    this.drafts.push({
      id: newId('event', this.clock.now()),
      type,
      at: this.clock.iso(),
      subject,
      actor: this.actor,
      ...(traceId === undefined ? {} : { traceId }),
      data,
    });
  }
}

/** 用来中止 startRun 事务的哨兵（任务已被他处修改）。 */
class SkipRun extends Error {}

/**
 * Loop 内核。职责：入队去重、Journal、路由、调度、租约与超时、重试与死信、审批、Outbox、插件生命周期。
 * 不包含任何具体插件逻辑（见 AGENTS.md §6）。
 */
export class Kernel {
  readonly store: Store;
  readonly config: KernelConfig;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly plugins: PluginHost;
  readonly content: ContentStore;
  readonly #dirs: DirectoryProvider | undefined;

  #state: KernelState = 'idle';
  #routes: Route[] = [];
  #defaultPolicy: TaskPolicy;
  readonly #listeners = new Set<JournalListener>();
  readonly #active = new Map<RunId, ActiveRun>();
  readonly #approvalWaiters = new Map<ApprovalId, ApprovalWaiter>();
  readonly #inflightDeliveries = new Set<string>();
  #interval: ReturnType<typeof setInterval> | undefined;
  #ticking: Promise<void> | undefined;
  #tickAgain = false;

  constructor(options: KernelOptions) {
    this.store = options.store;
    this.config = resolveConfig(options.config);
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? noopLogger;
    this.#defaultPolicy = mergePolicy(this.config.defaults.policy);
    this.content = options.content ?? createMemoryContentStore();
    this.#dirs = options.dirs;
    const env = options.env ?? process.env;
    this.plugins = new PluginHost({
      config: this.config,
      store: this.store,
      clock: this.clock,
      logger: this.logger,
      content: this.content,
      dirs: options.dirs,
      secrets: options.secrets ?? { get: async (name) => env[name] },
      env,
      onEvent: (e) => this.#onPluginEvent(e),
    });
  }

  get state(): KernelState {
    return this.#state;
  }

  get routes(): readonly Route[] {
    return this.#routes;
  }

  get activeRuns(): number {
    return this.#active.size;
  }

  /** 订阅提交后的 Journal 事件（SSE 推送用）。返回取消订阅函数。 */
  subscribe(listener: JournalListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // ═════════════════════════════ 生命周期 ═════════════════════════════

  async start(): Promise<void> {
    if (this.#state !== 'idle') throw new LoopError(ErrorCode.CONFLICT, `kernel is ${this.#state}`);
    this.#state = 'starting';
    await this.plugins.load();
    await this.#syncRoutes();
    await this.#recover();
    await this.#commit('kernel', async (w) => {
      w.emit('kernel.started', KERNEL_SUBJECT, {
        pid: process.pid,
        plugins: this.plugins.list().length,
        routes: this.#routes.length,
      });
    });
    this.#state = 'running';
    await this.plugins.startSources((source, draft) =>
      this.ingest(draft, { source, actor: `plugin:${source.instance}` }),
    );
    this.#interval = setInterval(() => this.#nudge(), this.config.limits.tickMs);
    this.#interval.unref?.();
    this.#nudge();
    this.logger.info('kernel started', { routes: this.#routes.length });
  }

  /** 优雅停机：停止取新任务，等待运行中的 Run，超时后中止并在下次启动时重试。 */
  async stop(): Promise<void> {
    if (this.#state !== 'running') return;
    this.#state = 'stopping';
    clearInterval(this.#interval);
    await this.#ticking;
    await this.#commit('kernel', async (w) => {
      w.emit('kernel.stopping', KERNEL_SUBJECT, { activeRuns: this.#active.size });
    });
    const deadline = Date.now() + this.config.limits.shutdownGraceMs;
    while (this.#active.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    for (const runId of [...this.#active.keys()]) {
      await this.#abortRun(
        runId,
        new LoopError(ErrorCode.KERNEL_SHUTDOWN, 'kernel stopped before run finished'),
      );
    }
    await this.plugins.stopAll();
    this.#state = 'stopped';
    this.logger.info('kernel stopped');
  }

  // ═════════════════════════════ 入口 ═════════════════════════════

  /** 手动提交（API / CLI）。 */
  submit(draft: EnvelopeDraft, actor: Actor = 'user:api'): Promise<EmitResult> {
    return this.ingest(draft, { source: MANUAL_SOURCE, actor });
  }

  /** 所有消息的统一入口：校验 → 去重 → 入库 → 路由 → 生成 Task。 */
  async ingest(draft: EnvelopeDraft, origin: IngestOrigin): Promise<EmitResult> {
    if (this.#state !== 'running' && this.#state !== 'starting') {
      throw new LoopError(ErrorCode.UNAVAILABLE, `kernel is ${this.#state}`);
    }
    const parsed = EnvelopeDraftSchema.safeParse(draft);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '$'}: ${i.message}`);
      throw new LoopError(ErrorCode.INVALID_INPUT, `invalid envelope: ${issues.join('; ')}`, {
        retryable: false,
        details: { issues },
      });
    }
    const d = parsed.data;
    const parent = origin.parent;
    const depth = parent ? parent.trace.depth + 1 : 0;
    if (depth > this.config.limits.maxSpawnDepth) {
      throw new LoopError(
        ErrorCode.SPAWN_DEPTH_EXCEEDED,
        `spawn depth ${depth} exceeds limit ${this.config.limits.maxSpawnDepth}`,
        { retryable: false },
      );
    }

    const result = await this.#commit(origin.actor, async (w) => {
      const existing = await w.tx.envelopes.findByIdempotencyKey(
        origin.source.instance,
        d.idempotencyKey,
      );
      if (existing) {
        w.emit(
          'envelope.duplicated',
          { kind: 'envelope', id: existing.id },
          { idempotencyKey: d.idempotencyKey, source: origin.source.instance },
          existing.trace.traceId,
        );
        return { envelopeId: existing.id, duplicated: true };
      }

      const { ref, ...rest } = d;
      const envelope: Envelope = {
        ...rest,
        id: newId('envelope', this.clock.now()),
        receivedAt: this.clock.iso(),
        source: { ...origin.source, ...(ref === undefined ? {} : { ref }) },
        trace: {
          traceId: parent?.trace.traceId ?? newId('trace', this.clock.now()),
          depth,
          ...(parent ? { parentId: parent.id } : {}),
        },
      };
      await w.tx.envelopes.put(envelope);
      const subject: SubjectRef = { kind: 'envelope', id: envelope.id };
      const traceId = envelope.trace.traceId;
      w.emit(
        'envelope.received',
        subject,
        { kind: envelope.kind, subject: envelope.subject, source: envelope.source.instance },
        traceId,
      );

      const bindings = resolveBindings(envelope, this.#routes, {
        policy: this.#defaultPolicy,
        priority: this.config.defaults.priority,
      });
      if (bindings.length === 0) {
        w.emit('envelope.unrouted', subject, {}, traceId);
        return { envelopeId: envelope.id, duplicated: false };
      }
      w.emit(
        'envelope.routed',
        subject,
        {
          tasks: bindings.length,
          routes: [...new Set(bindings.map((b) => b.routeId).filter(Boolean))],
          viaDirectives: bindings.every((b) => b.routeId === undefined),
        },
        traceId,
      );
      for (const b of bindings) await this.#createTask(w, envelope, b);
      return { envelopeId: envelope.id, duplicated: false };
    });
    this.#nudge();
    return result;
  }

  async #createTask(w: Writer, envelope: Envelope, b: ResolvedBinding): Promise<Task> {
    const now = this.clock.iso();
    const requireApproval = b.policy.requireApproval === true;
    const task: Task = {
      id: newId('task', this.clock.now()),
      envelopeId: envelope.id,
      traceId: envelope.trace.traceId,
      ...(b.routeId === undefined ? {} : { routeId: b.routeId }),
      agent: b.agent,
      sinks: b.sinks,
      policy: b.policy,
      priority: b.priority,
      status: requireApproval ? 'pending_approval' : 'queued',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    await w.tx.tasks.put(task);
    const subject: SubjectRef = { kind: 'task', id: task.id };
    w.emit(
      'task.created',
      subject,
      { envelopeId: envelope.id, agent: b.agent.agent, routeId: b.routeId, priority: b.priority },
      task.traceId,
    );
    if (requireApproval) {
      await this.#requestApproval(w, {
        kind: 'task_start',
        task,
        envelope,
        title: `执行任务：${envelope.subject}`,
        detail: { agent: b.agent.agent },
        risk: 'medium',
        requestedBy: 'kernel',
      });
    } else {
      w.emit('task.queued', subject, { reason: 'created' }, task.traceId);
    }
    return task;
  }

  // ═════════════════════════════ 调度循环 ═════════════════════════════

  /** 触发一次调度（合并并发触发）。 */
  #nudge(): void {
    if (this.#state !== 'running' && this.#state !== 'stopping') return;
    if (this.#ticking) {
      this.#tickAgain = true;
      return;
    }
    this.#ticking = this.tick().finally(() => {
      this.#ticking = undefined;
      if (this.#tickAgain) {
        this.#tickAgain = false;
        this.#nudge();
      }
    });
  }

  /** 执行一轮调度。通常由内部定时器驱动，测试可直接调用。 */
  async tick(): Promise<void> {
    try {
      await this.#expireLeases();
      await this.#expireApprovals();
      if (this.#state === 'running') await this.#dispatchTasks();
      await this.#dispatchDeliveries();
    } catch (error) {
      this.logger.error('tick failed', { error: toLoopError(error).message });
    }
  }

  async #dispatchTasks(): Promise<void> {
    const limit = this.config.limits.globalConcurrency;
    if (this.#active.size >= limit) return;
    const now = this.clock.now();
    const { items } = await this.store.tasks.list({ where: { status: 'queued' }, limit: 500 });
    const ready = items
      .filter((t) => t.notBefore === undefined || Date.parse(t.notBefore) <= now)
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    const busyKeys = new Set(
      [...this.#active.values()].map((a) => a.concurrencyKey).filter((k) => k !== undefined),
    );

    for (const task of ready) {
      if (this.#active.size >= limit || this.#state !== 'running') break;
      const key = task.policy.concurrencyKey;
      if (key !== undefined && busyKeys.has(key)) continue;
      const agent = this.plugins.agent(task.agent.agent);
      if (agent.status === 'disabled') continue; // 等待插件恢复
      if (agent.status !== 'ready') {
        await this.#failWithoutRun(task, {
          code: ErrorCode.PLUGIN_NOT_FOUND,
          message: `agent ${task.agent.agent} is not configured (${agent.status})`,
          retryable: false,
        });
        continue;
      }
      if (key !== undefined) busyKeys.add(key);
      await this.#startRun(task, agent.impl, agent.instance);
    }
  }

  async #failWithoutRun(task: Task, error: ErrorPayload): Promise<void> {
    await this.#commit('kernel', async (w) => {
      const fresh = await w.tx.tasks.get(task.id);
      if (fresh?.status !== 'queued') return;
      const next = await this.#transition(w, fresh, 'dead', { lastError: error });
      w.emit('task.dead', { kind: 'task', id: task.id }, { error }, task.traceId);
      const envelope = await w.tx.envelopes.get(task.envelopeId);
      if (envelope) await this.#queueDeliveries(w, next, envelope, { trigger: 'failed', error });
    });
  }

  // ═════════════════════════════ Run 执行 ═════════════════════════════

  async #startRun(task: Task, agent: AgentPlugin, instance: InstanceName): Promise<void> {
    const envelope = await this.store.envelopes.get(task.envelopeId);
    if (!envelope) {
      await this.#failWithoutRun(task, {
        code: ErrorCode.NOT_FOUND,
        message: `envelope ${task.envelopeId} not found`,
        retryable: false,
      });
      return;
    }
    const now = this.clock.now();
    const runId = newId('run', now);
    const active: ActiveRun = {
      runId,
      taskId: task.id,
      traceId: task.traceId,
      instance,
      agent,
      controller: new AbortController(),
      finalized: false,
      concurrencyKey: task.policy.concurrencyKey,
      timer: undefined,
      deadline: now + task.policy.timeoutMs,
      remainingMs: task.policy.timeoutMs,
      waitingApproval: undefined,
      usage: undefined,
      sessionId: undefined,
      lastLeaseRefresh: now,
    };
    this.#active.set(runId, active); // 先占用并发槽

    let started: Task;
    try {
      started = await this.#commit('kernel', async (w) => {
        const fresh = await w.tx.tasks.get(task.id);
        if (fresh?.status !== 'queued') throw new SkipRun();
        const attempt = fresh.attempts + 1;
        const run: Run = {
          id: runId,
          taskId: fresh.id,
          attempt,
          agent: instance,
          status: 'running',
          startedAt: this.clock.iso(),
          leaseExpiresAt: new Date(now + this.config.limits.leaseMs).toISOString(),
        };
        await w.tx.runs.put(run);
        const next = await this.#transition(w, fresh, 'running', {
          attempts: attempt,
          lastRunId: runId,
        });
        w.emit(
          'run.started',
          { kind: 'run', id: runId },
          { taskId: fresh.id, attempt, agent: instance },
          fresh.traceId,
        );
        await this.#queueDeliveries(w, next, envelope, { trigger: 'started', runId });
        return next;
      });
    } catch (error) {
      this.#active.delete(runId);
      if (error instanceof SkipRun) return;
      throw error;
    }

    this.#armTimeout(active);
    void this.#execute(active, started, envelope).catch((error) => {
      this.logger.error('run execution crashed', { runId, error: toLoopError(error).message });
    });
  }

  #armTimeout(a: ActiveRun): void {
    clearTimeout(a.timer);
    const ms = Math.max(0, a.deadline - this.clock.now());
    a.timer = setTimeout(() => {
      void this.#abortRun(a.runId, new LoopError(ErrorCode.TIMEOUT, `run exceeded timeout`));
    }, ms);
    a.timer.unref?.();
  }

  #renderPrompt(task: Task, envelope: Envelope): string {
    if (task.agent.prompt) return renderTemplate(task.agent.prompt, { envelope, task });
    const p = envelope.payload;
    if (p === undefined || p === null) return envelope.subject;
    return `${envelope.subject}\n\n${typeof p === 'string' ? p : JSON.stringify(p, null, 2)}`;
  }

  async #execute(active: ActiveRun, task: Task, envelope: Envelope): Promise<void> {
    const { agent, instance } = active;
    let options: Record<string, unknown> = task.agent.options ?? {};
    if (agent.optionsSchema) {
      const parsed = agent.optionsSchema.safeParse(options);
      if (!parsed.success) {
        await this.#finishRun(active, {
          status: 'failed',
          summary: 'invalid agent options',
          error: {
            code: ErrorCode.INVALID_INPUT,
            message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
            retryable: false,
          },
        });
        return;
      }
      options = parsed.data;
    }

    let workspace: Awaited<ReturnType<DirectoryProvider['workspace']>> | undefined;
    try {
      workspace = await this.#dirs?.workspace(active.runId);
    } catch (error) {
      const err = toLoopError(error, ErrorCode.UNAVAILABLE);
      await this.#finishRun(active, {
        status: 'failed',
        summary: `failed to prepare workspace: ${err.message}`,
        error: { ...err.toPayload(), retryable: true },
      });
      return;
    }

    const ctx = this.plugins.runContext(instance, {
      runId: active.runId,
      workspace,
      signal: active.controller.signal,
      awaitApproval: (request) => this.#awaitApproval(active, request),
      spawn: (draft) =>
        this.ingest(draft, {
          source: { plugin: 'kernel', instance: `spawn:${instance.split(':')[0]}` as InstanceName },
          actor: `plugin:${instance}`,
          parent: envelope,
        }),
    });

    let result: AgentResultEvent | undefined;
    try {
      const stream = agent.run(
        {
          runId: active.runId,
          taskId: task.id,
          attempt: task.attempts,
          envelope,
          prompt: this.#renderPrompt(task, envelope),
          options,
          ...(workspace ? { workspace: { path: workspace.work } } : {}),
        },
        ctx,
      );
      for await (const raw of stream) {
        if (active.finalized) break;
        const parsed = AgentEventSchema.safeParse(raw);
        if (!parsed.success) {
          throw new LoopError(
            ErrorCode.PLUGIN_PROTOCOL_VIOLATION,
            `invalid agent event: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
            { retryable: true },
          );
        }
        if (parsed.data.type === 'result') {
          result = parsed.data;
          break;
        }
        await this.#onAgentEvent(active, parsed.data);
      }
      if (active.finalized) return;
      if (!result) {
        throw new LoopError(
          ErrorCode.PLUGIN_PROTOCOL_VIOLATION,
          'agent event stream ended without a result event',
          { retryable: true },
        );
      }
    } catch (error) {
      if (active.finalized) return; // 已被超时 / 取消 / 停机处理
      const err = toLoopError(error, ErrorCode.AGENT_FAILED);
      await this.plugins.recordCrash(instance, err, 'run');
      await this.#finishRun(active, {
        status: 'failed',
        summary: err.message,
        error: { ...err.toPayload(), retryable: true },
      });
      return;
    }

    this.plugins.recordSuccess(instance);
    await this.#finishRun(
      active,
      result.status === 'succeeded'
        ? {
            status: 'succeeded',
            summary: result.summary,
            ...(result.output === undefined ? {} : { output: result.output }),
          }
        : {
            status: 'failed',
            summary: result.summary,
            error: result.error ?? {
              code: ErrorCode.AGENT_FAILED,
              message: result.summary,
              retryable: false,
            },
          },
    );
  }

  async #onAgentEvent(
    active: ActiveRun,
    event: Exclude<AgentEvent, AgentResultEvent>,
  ): Promise<void> {
    const now = this.clock.now();
    const refreshLease = now - active.lastLeaseRefresh > this.config.limits.leaseMs / 4;
    if (event.type === 'heartbeat' && !refreshLease) return;
    if (event.type === 'usage') {
      const prev = active.usage;
      const cost = (prev?.costUsd ?? 0) + (event.costUsd ?? 0);
      active.usage = {
        inputTokens: (prev?.inputTokens ?? 0) + event.inputTokens,
        outputTokens: (prev?.outputTokens ?? 0) + event.outputTokens,
        ...(prev?.costUsd !== undefined || event.costUsd !== undefined ? { costUsd: cost } : {}),
      };
    }
    if (event.type === 'session') active.sessionId = event.sessionId;

    await this.#commit(`plugin:${active.instance}`, async (w) => {
      if (event.type !== 'heartbeat') {
        w.emit('run.event', { kind: 'run', id: active.runId }, event, active.traceId);
      }
      if (refreshLease || event.type === 'usage' || event.type === 'session') {
        const run = await w.tx.runs.get(active.runId);
        if (run?.status !== 'running') return;
        await w.tx.runs.put({
          ...run,
          leaseExpiresAt: new Date(now + this.config.limits.leaseMs).toISOString(),
          ...(active.usage ? { usage: active.usage } : {}),
          ...(active.sessionId ? { sessionId: active.sessionId } : {}),
        });
        active.lastLeaseRefresh = now;
      }
    });
  }

  /** 中止一个运行中的 Run，并立即按错误类型结算（不等待 Agent 配合）。 */
  async #abortRun(runId: RunId, error: LoopError): Promise<void> {
    const active = this.#active.get(runId);
    if (!active || active.finalized) return;
    active.controller.abort(error);
    if (active.agent.cancel) {
      void withTimeout(() => active.agent.cancel?.(runId) ?? Promise.resolve(), 5_000).catch(
        () => {},
      );
    }
    const status =
      error.code === ErrorCode.TIMEOUT
        ? 'timed_out'
        : error.code === ErrorCode.CANCELLED
          ? 'cancelled'
          : 'failed';
    await this.#finishRun(active, { status, summary: error.message, error: error.toPayload() });
  }

  async #finishRun(active: ActiveRun, outcome: RunOutcome): Promise<void> {
    if (active.finalized) return;
    active.finalized = true;
    clearTimeout(active.timer);
    this.#active.delete(active.runId);
    for (const [id, waiter] of this.#approvalWaiters) {
      if (waiter.runId === active.runId) {
        this.#approvalWaiters.delete(id);
        waiter.resolve({ approvalId: id, granted: false, comment: 'run ended' });
      }
    }
    const artifacts = await this.#collectArtifacts(active.runId);
    try {
      await this.#commit('kernel', (w) => this.#settleRun(w, { ...active, artifacts }, outcome));
    } catch (error) {
      this.logger.error('failed to settle run', {
        runId: active.runId,
        error: toLoopError(error).message,
      });
    }
    this.#nudge();
  }

  /** 扫描本次 Run 的产物目录（在事务外执行 IO）。失败只记日志，不影响结算。 */
  async #collectArtifacts(runId: RunId): Promise<FileRef[]> {
    try {
      return await withTimeout(() => this.content.listArtifacts(runId), 10_000, {
        label: 'listArtifacts',
      });
    } catch (error) {
      this.logger.warn('failed to collect artifacts', { runId, error: toLoopError(error).message });
      return [];
    }
  }

  /** 结算 Run，并据此推进 Task：成功 / 取消 / 重试（退避）/ 死信。 */
  async #settleRun(
    w: Writer,
    ref: {
      runId: RunId;
      taskId: TaskId;
      usage?: Usage | undefined;
      sessionId?: string | undefined;
      artifacts?: FileRef[] | undefined;
    },
    outcome: RunOutcome,
  ): Promise<void> {
    const run = await w.tx.runs.get(ref.runId);
    const task = await w.tx.tasks.get(ref.taskId);
    if (!run || !task || run.status !== 'running') return;

    const error = outcome.status === 'succeeded' ? undefined : outcome.error;
    const done: Run = {
      ...run,
      status: outcome.status,
      endedAt: this.clock.iso(),
      summary: outcome.summary,
      ...(ref.usage ? { usage: ref.usage } : {}),
      ...(ref.sessionId ? { sessionId: ref.sessionId } : {}),
      ...(outcome.status === 'succeeded' && outcome.output !== undefined
        ? { output: outcome.output }
        : {}),
      ...(error ? { error } : {}),
      ...(ref.artifacts?.length ? { artifacts: ref.artifacts } : {}),
    };
    await w.tx.runs.put(done);
    w.emit(
      RUN_EVENT[outcome.status],
      { kind: 'run', id: run.id },
      {
        taskId: task.id,
        attempt: run.attempt,
        summary: outcome.summary,
        ...(error ? { error } : {}),
        ...(ref.artifacts?.length ? { artifacts: ref.artifacts.map((f) => f.ref) } : {}),
      },
      task.traceId,
    );

    if (isTerminalTaskStatus(task.status)) return;
    const subject: SubjectRef = { kind: 'task', id: task.id };
    const envelope = await w.tx.envelopes.get(task.envelopeId);

    if (outcome.status === 'succeeded') {
      const next = await this.#transition(w, task, 'succeeded');
      w.emit('task.succeeded', subject, { runId: run.id, summary: outcome.summary }, task.traceId);
      if (envelope) {
        await this.#queueDeliveries(w, next, envelope, {
          trigger: 'succeeded',
          summary: outcome.summary,
          runId: run.id,
        });
      }
      return;
    }
    if (outcome.status === 'cancelled') {
      await this.#transition(w, task, 'cancelled');
      w.emit('task.cancelled', subject, { runId: run.id, reason: outcome.summary }, task.traceId);
      return;
    }

    const err = outcome.error;
    if (err.retryable && task.attempts < task.policy.maxAttempts) {
      const delay = computeBackoffMs(task.policy.backoff, task.attempts);
      const notBefore = new Date(this.clock.now() + delay).toISOString();
      await this.#transition(w, task, 'queued', { notBefore, lastError: err });
      w.emit(
        'task.queued',
        subject,
        { reason: 'retry', afterRunId: run.id, notBefore, error: err },
        task.traceId,
      );
      return;
    }
    const next = await this.#transition(w, task, 'dead', { lastError: err });
    w.emit('task.dead', subject, { runId: run.id, error: err }, task.traceId);
    if (envelope) {
      await this.#queueDeliveries(w, next, envelope, {
        trigger: 'failed',
        summary: outcome.summary,
        error: err,
        runId: run.id,
      });
    }
  }

  async #transition(
    w: Writer,
    task: Task,
    to: TaskStatus,
    patch: Partial<Omit<Task, 'id' | 'status'>> = {},
  ): Promise<Task> {
    if (!canTransitionTask(task.status, to)) {
      throw new LoopError(
        ErrorCode.ILLEGAL_TRANSITION,
        `task ${task.id}: ${task.status} → ${to} is not allowed`,
        { retryable: false },
      );
    }
    const next: Task = { ...task, ...patch, status: to, updatedAt: this.clock.iso() };
    await w.tx.tasks.put(next);
    return next;
  }

  /** 内核重启后：上次进程遗留的 running Run 一律按可重试失败结算。 */
  async #recover(): Promise<void> {
    const runs = await this.#scan((cursor) =>
      this.store.runs.list({ where: { status: 'running' }, limit: 200, ...cursor }),
    );
    for (const run of runs) {
      const artifacts = await this.#collectArtifacts(run.id);
      await this.#commit('kernel', (w) =>
        this.#settleRun(
          w,
          { runId: run.id, taskId: run.taskId, artifacts },
          {
            status: 'failed',
            summary: 'kernel restarted while run was in progress',
            error: {
              code: ErrorCode.KERNEL_RESTARTED,
              message: 'kernel restarted while run was in progress',
              retryable: true,
            },
          },
        ),
      );
    }
    // 工具调用审批依附于已不存在的 Run，直接作废。
    const approvals = await this.#scan((cursor) =>
      this.store.approvals.list({
        where: { status: 'pending', kind: 'tool_call' },
        limit: 200,
        ...cursor,
      }),
    );
    for (const a of approvals) {
      await this.#commit('kernel', async (w) => {
        await w.tx.approvals.put({ ...a, status: 'expired' });
        w.emit('approval.expired', { kind: 'approval', id: a.id }, { reason: 'kernel restarted' });
      });
    }
    if (runs.length > 0 || approvals.length > 0) {
      this.logger.warn('recovered after restart', {
        runs: runs.length,
        approvals: approvals.length,
      });
    }
  }

  async #scan<T extends { id: string }>(
    page: (cursor: { cursor?: string }) => Promise<{ items: T[]; nextCursor?: string }>,
  ): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    do {
      const res = await page(cursor === undefined ? {} : { cursor });
      out.push(...res.items);
      cursor = res.nextCursor;
    } while (cursor !== undefined);
    return out;
  }

  async #expireLeases(): Promise<void> {
    const now = this.clock.now();
    const { items } = await this.store.runs.list({ where: { status: 'running' }, limit: 500 });
    for (const run of items) {
      if (Date.parse(run.leaseExpiresAt) > now) continue;
      const active = this.#active.get(run.id);
      if (active?.waitingApproval) continue; // 等待审批期间不计租约
      if (active) {
        await this.#abortRun(
          run.id,
          new LoopError(ErrorCode.TIMEOUT, 'run lease expired (no heartbeat from agent)'),
        );
      }
    }
  }

  // ═════════════════════════════ 审批 ═════════════════════════════

  async #requestApproval(
    w: Writer,
    input: {
      kind: Approval['kind'];
      task: Task;
      envelope: Envelope;
      title: string;
      detail: unknown;
      risk: RiskLevel;
      requestedBy: Actor;
      timeoutMs?: number | undefined;
    },
  ): Promise<Approval> {
    const now = this.clock.now();
    const approval: Approval = {
      id: newId('approval', now),
      kind: input.kind,
      subject: { kind: 'task', id: input.task.id },
      title: input.title,
      detail: input.detail,
      risk: input.risk,
      requestedBy: input.requestedBy,
      requestedAt: this.clock.iso(),
      expiresAt: new Date(
        now + (input.timeoutMs ?? this.config.limits.approvalTtlMs),
      ).toISOString(),
      status: 'pending',
    };
    await w.tx.approvals.put(approval);
    w.emit(
      'approval.requested',
      { kind: 'approval', id: approval.id },
      { kind: approval.kind, taskId: input.task.id, title: approval.title, risk: approval.risk },
      input.task.traceId,
    );
    await this.#queueDeliveries(w, input.task, input.envelope, {
      trigger: 'approval_required',
      approval,
    });
    return approval;
  }

  async #awaitApproval(active: ActiveRun, request: ApprovalRequest): Promise<ApprovalOutcome> {
    const req = ApprovalRequestSchema.parse(request);
    if (active.finalized) {
      throw new LoopError(ErrorCode.CANCELLED, 'run already finished', { retryable: false });
    }
    const approval = await this.#commit(`plugin:${active.instance}`, async (w) => {
      const task = await w.tx.tasks.get(active.taskId);
      const envelope = task ? await w.tx.envelopes.get(task.envelopeId) : undefined;
      if (!task || !envelope) throw new LoopError(ErrorCode.NOT_FOUND, 'task not found');
      const a = await this.#requestApproval(w, {
        kind: 'tool_call',
        task,
        envelope,
        title: req.title,
        detail: { action: req.action, runId: active.runId, request: req.detail },
        risk: req.risk,
        requestedBy: `plugin:${active.instance}`,
        timeoutMs: req.timeoutMs,
      });
      await this.#transition(w, task, 'waiting_approval');
      return a;
    });

    // 等待期间暂停超时计时
    active.waitingApproval = approval.id;
    active.remainingMs = Math.max(0, active.deadline - this.clock.now());
    clearTimeout(active.timer);

    return new Promise<ApprovalOutcome>((resolve) => {
      this.#approvalWaiters.set(approval.id, {
        runId: active.runId,
        resolve: (outcome) => {
          active.waitingApproval = undefined;
          active.lastLeaseRefresh = this.clock.now();
          if (!active.finalized) {
            active.deadline = this.clock.now() + active.remainingMs;
            this.#armTimeout(active);
          }
          resolve(outcome);
        },
      });
    });
  }

  /** 人工审批决定（看板 / API / 交互式 Sink 回调）。 */
  async decideApproval(id: ApprovalId, input: ApprovalDecisionInput): Promise<Approval> {
    const granted = input.decision === 'grant';
    const decided = await this.#commit(input.by, async (w) => {
      const a = await w.tx.approvals.get(id);
      if (!a) throw new LoopError(ErrorCode.NOT_FOUND, `approval ${id} not found`);
      if (a.status !== 'pending') {
        throw new LoopError(ErrorCode.CONFLICT, `approval ${id} is already ${a.status}`);
      }
      const next: Approval = {
        ...a,
        status: granted ? 'granted' : 'rejected',
        decision: {
          decision: input.decision,
          by: input.by,
          at: this.clock.iso(),
          ...(input.comment === undefined ? {} : { comment: input.comment }),
        },
      };
      await w.tx.approvals.put(next);
      w.emit(
        granted ? 'approval.granted' : 'approval.rejected',
        { kind: 'approval', id },
        { by: input.by, comment: input.comment },
      );
      await this.#applyApproval(w, next, granted);
      return next;
    });
    this.#resolveWaiter(id, granted, input.comment);
    this.#nudge();
    return decided;
  }

  async #applyApproval(w: Writer, approval: Approval, granted: boolean): Promise<void> {
    const task = await w.tx.tasks.get(approval.subject.id as TaskId);
    if (!task) return;
    const subject: SubjectRef = { kind: 'task', id: task.id };
    if (approval.kind === 'task_start' && task.status === 'pending_approval') {
      if (granted) {
        await this.#transition(w, task, 'queued');
        w.emit(
          'task.queued',
          subject,
          { reason: 'approved', approvalId: approval.id },
          task.traceId,
        );
      } else {
        await this.#transition(w, task, 'rejected');
        w.emit('task.rejected', subject, { approvalId: approval.id }, task.traceId);
      }
    }
    if (approval.kind === 'tool_call' && task.status === 'waiting_approval') {
      await this.#transition(w, task, 'running');
      const runId = (approval.detail as { runId?: RunId } | undefined)?.runId;
      const run = runId ? await w.tx.runs.get(runId) : undefined;
      if (run?.status === 'running') {
        await w.tx.runs.put({
          ...run,
          leaseExpiresAt: new Date(this.clock.now() + this.config.limits.leaseMs).toISOString(),
        });
      }
    }
  }

  #resolveWaiter(id: ApprovalId, granted: boolean, comment?: string): void {
    const waiter = this.#approvalWaiters.get(id);
    if (!waiter) return;
    this.#approvalWaiters.delete(id);
    waiter.resolve({ approvalId: id, granted, ...(comment === undefined ? {} : { comment }) });
  }

  async #expireApprovals(): Promise<void> {
    const now = this.clock.now();
    const { items } = await this.store.approvals.list({ where: { status: 'pending' }, limit: 500 });
    for (const a of items) {
      if (Date.parse(a.expiresAt) > now) continue;
      await this.#commit('kernel', async (w) => {
        const fresh = await w.tx.approvals.get(a.id);
        if (fresh?.status !== 'pending') return;
        const next: Approval = { ...fresh, status: 'expired' };
        await w.tx.approvals.put(next);
        w.emit('approval.expired', { kind: 'approval', id: a.id }, { expiresAt: a.expiresAt });
        await this.#applyApproval(w, next, false);
      });
      this.#resolveWaiter(a.id, false, 'approval expired');
    }
  }

  // ═════════════════════════════ 取消 ═════════════════════════════

  async cancelTask(taskId: TaskId, by: Actor): Promise<void> {
    const task = await this.store.tasks.get(taskId);
    if (!task) throw new LoopError(ErrorCode.NOT_FOUND, `task ${taskId} not found`);
    if (isTerminalTaskStatus(task.status)) {
      throw new LoopError(ErrorCode.CONFLICT, `task ${taskId} is already ${task.status}`);
    }
    const active = [...this.#active.values()].find((a) => a.taskId === taskId);
    if (active) {
      await this.#abortRun(
        active.runId,
        new LoopError(ErrorCode.CANCELLED, `cancelled by ${by}`, { retryable: false }),
      );
      return;
    }
    await this.#commit(by, async (w) => {
      const fresh = await w.tx.tasks.get(taskId);
      if (!fresh || isTerminalTaskStatus(fresh.status)) return;
      await this.#transition(w, fresh, 'cancelled');
      w.emit('task.cancelled', { kind: 'task', id: taskId }, { by }, fresh.traceId);
    });
  }

  // ═════════════════════════════ Outbox / 投递 ═════════════════════════════

  async #queueDeliveries(
    w: Writer,
    task: Task,
    envelope: Envelope,
    ctx: Omit<NotifyContext, 'task' | 'envelope' | 'publicUrl'>,
  ): Promise<void> {
    for (const binding of sinksFor(task, this.config.defaults.sinks, ctx.trigger)) {
      const id = newId('delivery', this.clock.now());
      const notification = buildNotification(id, binding, {
        ...ctx,
        task,
        envelope,
        publicUrl: this.config.publicUrl,
      });
      const now = this.clock.iso();
      const delivery: Delivery = {
        id,
        sink: binding.sink,
        trigger: ctx.trigger,
        subject: notification.subject,
        status: 'queued',
        attempts: 0,
        notification,
        createdAt: now,
        updatedAt: now,
      };
      await w.tx.deliveries.put(delivery);
      w.emit(
        'delivery.queued',
        { kind: 'delivery', id },
        { sink: binding.sink, trigger: ctx.trigger, taskId: task.id },
        task.traceId,
      );
    }
  }

  async #dispatchDeliveries(): Promise<void> {
    const now = this.clock.now();
    const { items } = await this.store.deliveries.list({ where: { status: 'queued' }, limit: 200 });
    for (const d of items) {
      if (this.#inflightDeliveries.has(d.id)) continue;
      if (d.notBefore !== undefined && Date.parse(d.notBefore) > now) continue;
      const sink = this.plugins.sink(d.sink);
      if (sink.status === 'disabled') continue;
      this.#inflightDeliveries.add(d.id);
      void this.#deliver(d, sink).finally(() => this.#inflightDeliveries.delete(d.id));
    }
  }

  async #deliver(d: Delivery, sink: ReturnType<PluginHost['sink']>): Promise<void> {
    let result: DeliveryResult;
    if (sink.status !== 'ready') {
      result = { ok: false, retryable: false, error: `sink ${d.sink} is not configured` };
    } else {
      try {
        const raw = await withTimeout(
          () => sink.impl.deliver(d.notification, sink.ctx),
          this.config.limits.pluginCallTimeoutMs,
          { label: `${d.sink}.deliver` },
        );
        const parsed = DeliveryResultSchema.safeParse(raw);
        result = parsed.success
          ? parsed.data
          : { ok: false, retryable: true, error: 'sink returned an invalid DeliveryResult' };
      } catch (error) {
        const err = toLoopError(error);
        result = { ok: false, retryable: true, error: err.message };
      }
    }

    const { maxAttempts, backoff } = this.config.limits.delivery;
    await this.#commit('kernel', async (w) => {
      const fresh = await w.tx.deliveries.get(d.id);
      if (fresh?.status !== 'queued') return;
      const attempts = fresh.attempts + 1;
      const subject: SubjectRef = { kind: 'delivery', id: d.id };
      const traceId = d.notification.traceId;
      const base = { ...fresh, attempts, updatedAt: this.clock.iso() };
      if (result.ok) {
        await w.tx.deliveries.put({
          ...base,
          status: 'succeeded',
          ...(result.externalId === undefined ? {} : { externalId: result.externalId }),
        });
        w.emit('delivery.succeeded', subject, { sink: d.sink, attempts }, traceId);
        return;
      }
      if (result.retryable && attempts < maxAttempts) {
        const notBefore = new Date(
          this.clock.now() + computeBackoffMs(backoff, attempts),
        ).toISOString();
        await w.tx.deliveries.put({ ...base, lastError: result.error, notBefore });
        w.emit(
          'delivery.failed',
          subject,
          { sink: d.sink, attempts, error: result.error, notBefore },
          traceId,
        );
        return;
      }
      await w.tx.deliveries.put({ ...base, status: 'dead', lastError: result.error });
      w.emit('delivery.dead', subject, { sink: d.sink, attempts, error: result.error }, traceId);
    });
  }

  // ═════════════════════════════ 配置 / 内部 ═════════════════════════════

  /** 把配置中的 Route 同步进存储（按 name 对齐 ID），再加载全部 Route。 */
  async #syncRoutes(): Promise<void> {
    const existing = await this.#scan((c) => this.store.routes.list({ limit: 500, ...c }));
    const byName = new Map(existing.map((r) => [r.name, r]));
    const errors: string[] = [];
    await this.#commit('kernel', async (w) => {
      for (const [i, rc] of this.config.routes.entries()) {
        const prev = byName.get(rc.name);
        const route: Route = {
          id: prev?.id ?? newId('route', this.clock.now()),
          name: rc.name,
          enabled: rc.enabled,
          order: rc.order ?? i * 10,
          match: rc.match,
          agents: rc.agents,
          sinks: rc.sinks,
          policy: mergePolicy(this.config.defaults.policy, rc.policy),
          stopOnMatch: rc.stopOnMatch,
        };
        errors.push(...validateRoute(route));
        for (const a of route.agents) {
          if (this.plugins.agent(a.agent).status === 'missing') {
            this.logger.warn('route references unknown agent', { route: rc.name, agent: a.agent });
          }
        }
        if (prev && JSON.stringify(prev) === JSON.stringify(route)) continue;
        await w.tx.routes.put(route);
        w.emit(
          'route.upserted',
          { kind: 'route', id: route.id },
          { name: route.name, source: 'config' },
        );
      }
      if (errors.length > 0) {
        throw new LoopError(ErrorCode.INVALID_CONFIG, errors.join('; '), { retryable: false });
      }
    });
    this.#routes = await this.#scan((c) => this.store.routes.list({ limit: 500, ...c }));
  }

  async #onPluginEvent(e: PluginHostEvent): Promise<void> {
    await this.#commit('kernel', async (w) => {
      w.emit(e.type, { kind: 'plugin', id: e.instance }, e.data);
    });
    if (e.type !== 'plugin.loaded') {
      this.logger.warn(e.type, { instance: e.instance, ...e.data });
    }
  }

  async #commit<T>(actor: Actor, fn: (w: Writer) => Promise<T>): Promise<T> {
    const { result, events } = await this.store.transaction(async (tx) => {
      const w = new Writer(tx, this.clock, actor);
      const result = await fn(w);
      const events = w.drafts.length > 0 ? await tx.append(w.drafts) : [];
      return { result, events };
    });
    if (events.length > 0) {
      for (const listener of this.#listeners) {
        try {
          listener(events);
        } catch (error) {
          this.logger.warn('journal listener failed', { error: String(error) });
        }
      }
    }
    return result;
  }
}
