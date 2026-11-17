import {
  type Actor,
  type AgentBinding,
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
  type ConversationMessage,
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
  type JournalEvent,
  type JournalEventDraft,
  type JournalEventType,
  type JsonObject,
  type Logger,
  type Priority,
  type RiskLevel,
  type Route,
  type RouteDecision,
  RouteDecisionSchema,
  type RouterItem,
  type RouterPlugin,
  type RouterQueries,
  type RouterTaskSummary,
  type Run,
  type RunId,
  type RunWorkspace,
  type SecretResolver,
  type Store,
  type StoreTx,
  type SubjectRef,
  type Task,
  type TaskId,
  type TaskOutcome,
  type TaskPolicy,
  type TaskRouting,
  type TaskStatus,
  type TraceId,
  type Turn,
  type TurnId,
  type TurnStatus,
  type Usage,
  UsageSchema,
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

export interface InboxOrigin {
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

export interface AssignInput {
  agent: InstanceName;
  /** 不填时沿用候选（Route）里该 Agent 的提示词。 */
  prompt?: string;
  options?: JsonObject;
}

export interface MessageInput {
  content: string;
  attachments?: FileRef[];
  /** queue（默认）：执行中则排队到本轮结束后；interrupt：中止当前 Run 立即处理。 */
  mode?: 'queue' | 'interrupt';
}

export interface ReprioritizeInput {
  priority?: Priority;
  rank?: number;
}

export type JournalListener = (events: JournalEvent[]) => void;

/** API / CLI 手动提交使用的虚拟来源。 */
export const MANUAL_SOURCE = { plugin: 'kernel', instance: 'manual:api' as InstanceName };

const KERNEL_SUBJECT: SubjectRef = { kind: 'kernel', id: 'kernel' };
const IDLE_SCAN_INTERVAL_MS = 60_000;

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
  turnId: TurnId;
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

type TaskPatch = Partial<Omit<Task, 'id' | 'status'>>;
type TaskField = keyof Omit<Task, 'id' | 'status'>;

/** 事务内的写入器：累积 Journal 事件，事务提交前统一 append。 */
class Writer {
  readonly drafts: JournalEventDraft[] = [];

  constructor(
    readonly tx: StoreTx,
    private readonly clock: Clock,
    readonly actor: Actor,
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

const taskSubject = (id: TaskId): SubjectRef => ({ kind: 'task', id });
const turnSubject = (id: TurnId): SubjectRef => ({ kind: 'turn', id });

const summarizeTask = (t: Task): RouterTaskSummary => ({
  id: t.id,
  subject: t.subject,
  status: t.status,
  source: t.source,
  ...(t.agent ? { agent: t.agent.agent } : {}),
  ...(t.lastSummary === undefined ? {} : { lastSummary: t.lastSummary.slice(0, 500) }),
  updatedAt: t.updatedAt,
});

function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!b) return a;
  if (!a) return b;
  const cost =
    a.costUsd !== undefined || b.costUsd !== undefined
      ? { costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0) }
      : {};
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...cost,
  };
}

/**
 * Loop 内核。职责：Inbox 接收去重、Journal、路由、调度、租约与超时、重试、会话（多轮对话）、审批、Outbox、插件生命周期。
 * 不包含任何具体插件逻辑（见 AGENTS.md「职责与依赖」）。
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
  /** 正在路由的批次：Router 实例 → 取消控制 + 完成 Promise（同一实例同时只有一批）。 */
  readonly #routing = new Map<InstanceName, { controller: AbortController; done: Promise<void> }>();
  #interval: ReturnType<typeof setInterval> | undefined;
  #ticking: Promise<void> | undefined;
  #tickAgain = false;
  #lastIdleScan = 0;

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
      this.inbox(draft, { source, actor: `plugin:${source.instance}` }),
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
    for (const r of this.#routing.values()) {
      r.controller.abort(new LoopError(ErrorCode.KERNEL_SHUTDOWN, 'kernel stopping'));
    }
    await Promise.allSettled([...this.#routing.values()].map((r) => r.done));
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

  // ═════════════════════════════ Inbox / 接收 ═════════════════════════════

  /** 手动提交（API / CLI）。 */
  submit(draft: EnvelopeDraft, actor: Actor = 'user:api'): Promise<EmitResult> {
    return this.inbox(draft, { source: MANUAL_SOURCE, actor });
  }

  /** Inbox：统一接收新消息，校验 → 去重 → 入库 → 路由 → 生成 Task；返回时接收事务已提交。 */
  async inbox(draft: EnvelopeDraft, origin: InboxOrigin): Promise<EmitResult> {
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
        router: this.config.defaults.router,
      });
      if (bindings.length === 0) {
        const policy = this.config.defaults.unrouted;
        const router = policy === 'router' ? this.config.defaults.router : undefined;
        w.emit(
          'envelope.unrouted',
          subject,
          { triage: policy !== 'drop', ...(router ? { router } : {}) },
          traceId,
        );
        if (policy !== 'drop') {
          await this.#createTask(w, envelope, {
            sinks: envelope.directives?.sinks ?? [],
            policy: this.#defaultPolicy,
            priority: envelope.directives?.priority ?? this.config.defaults.priority,
            ...(router ? { router } : {}),
          });
        }
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
    const assigned = b.agent !== undefined;
    const requireApproval = assigned && b.policy.requireApproval === true;
    const status: TaskStatus = !assigned
      ? 'unassigned'
      : requireApproval
        ? 'pending_approval'
        : 'queued';
    const task: Task = {
      id: newId('task', this.clock.now()),
      envelopeId: envelope.id,
      traceId: envelope.trace.traceId,
      subject: envelope.subject,
      source: envelope.source.instance,
      ...(b.routeId === undefined ? {} : { routeId: b.routeId }),
      ...(b.agent ? { agent: b.agent } : {}),
      ...(b.candidates?.length ? { candidates: b.candidates } : {}),
      ...(!assigned && b.router
        ? { routing: { router: b.router, status: 'pending' as const, attempts: 0 } }
        : {}),
      sinks: b.sinks,
      policy: b.policy,
      priority: b.priority,
      rank: this.clock.now(),
      status,
      closeOnComplete:
        envelope.directives?.closeOnComplete ??
        b.closeOnComplete ??
        envelope.source.instance !== MANUAL_SOURCE.instance,
      attempts: 0,
      turnCount: 1,
      artifactCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    await w.tx.tasks.put(task);
    const subject = taskSubject(task.id);
    w.emit(
      'task.created',
      subject,
      {
        envelopeId: envelope.id,
        agent: b.agent?.agent,
        routeId: b.routeId,
        priority: b.priority,
        status,
      },
      task.traceId,
    );
    await this.#addTurn(w, task, {
      content: this.#renderPrompt(b.agent, envelope),
      ...(envelope.attachments?.length ? { attachments: envelope.attachments } : {}),
      by: w.actor,
    });
    if (requireApproval) {
      await this.#requestStartApproval(w, task, envelope);
    } else if (assigned) {
      w.emit('task.queued', subject, { reason: 'created' }, task.traceId);
    } else if (task.routing) {
      w.emit(
        'routing.requested',
        subject,
        { router: task.routing.router, candidates: b.candidates?.map((c) => c.agent) },
        task.traceId,
      );
    }
    return task;
  }

  async #requestStartApproval(w: Writer, task: Task, envelope: Envelope): Promise<void> {
    await this.#requestApproval(w, {
      kind: 'task_start',
      task,
      envelope,
      title: `执行任务：${envelope.subject}`,
      detail: { agent: task.agent?.agent },
      risk: 'medium',
      requestedBy: 'kernel',
    });
  }

  async #addTurn(
    w: Writer,
    task: Task,
    input: { content: string; attachments?: FileRef[]; by: Actor; index?: number },
  ): Promise<Turn> {
    const now = this.clock.iso();
    const turn: Turn = {
      id: newId('turn', this.clock.now()),
      taskId: task.id,
      index: input.index ?? task.turnCount,
      content: input.content,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      by: input.by,
      status: 'pending',
      runIds: [],
      createdAt: now,
      updatedAt: now,
    };
    await w.tx.turns.put(turn);
    w.emit(
      'turn.added',
      turnSubject(turn.id),
      { taskId: task.id, index: turn.index, by: input.by },
      task.traceId,
    );
    return turn;
  }

  // ═════════════════════════════ 会话操作（看板 / API） ═════════════════════════════

  /** 分配或改派 Agent。unassigned → queued（或 pending_approval）；queued / awaiting_input / failed 只换 Agent。 */
  async assignTask(taskId: TaskId, input: AssignInput, by: Actor): Promise<Task> {
    const lookup = this.plugins.agent(input.agent);
    if (lookup.status === 'missing' || lookup.status === 'wrong_kind') {
      throw new LoopError(ErrorCode.INVALID_INPUT, `agent ${input.agent} is not configured`, {
        retryable: false,
      });
    }
    const task = await this.#commit(by, async (w) => {
      const t = await this.#mustGetTask(w.tx, taskId);
      if (!['unassigned', 'queued', 'awaiting_input', 'failed'].includes(t.status)) {
        throw new LoopError(ErrorCode.CONFLICT, `cannot assign task in status ${t.status}`);
      }
      // 人在 Router 决策前手动分配：本次路由作废
      const routing =
        t.routing && (t.routing.status === 'pending' || t.routing.status === 'running')
          ? { routing: { ...t.routing, status: 'skipped' as const } }
          : {};
      return this.#assignIn(w, t, input, by, routing);
    });
    this.#nudge();
    return task;
  }

  /** 分配 Agent（事务内）。patch 会和 Agent 一起写入。 */
  async #assignIn(
    w: Writer,
    t: Task,
    input: AssignInput,
    by: Actor,
    patch: TaskPatch = {},
  ): Promise<Task> {
    const candidate = t.candidates?.find((c) => c.agent === input.agent);
    const binding: AgentBinding = {
      agent: input.agent,
      ...((input.prompt ?? candidate?.prompt) === undefined
        ? {}
        : { prompt: (input.prompt ?? candidate?.prompt) as string }),
      ...((input.options ?? candidate?.options) === undefined
        ? {}
        : { options: (input.options ?? candidate?.options) as JsonObject }),
    };
    const previous = t.agent?.agent;
    w.emit('task.assigned', taskSubject(t.id), { agent: input.agent, previous, by }, t.traceId);
    if (t.status !== 'unassigned') {
      return this.#save(w, t, { ...patch, agent: binding });
    }
    // 首轮还没执行过：按新 Agent 的提示词模板重新渲染
    const envelope = await w.tx.envelopes.get(t.envelopeId);
    const first = (await this.#turnsOf(w.tx, t.id)).find((x) => x.index === 1);
    if (envelope && first?.status === 'pending' && first.runIds.length === 0 && binding.prompt) {
      await w.tx.turns.put({
        ...first,
        content: this.#renderPrompt(binding, envelope),
        updatedAt: this.clock.iso(),
      });
    }
    if (t.policy.requireApproval && envelope) {
      const next = await this.#transition(w, t, 'pending_approval', { ...patch, agent: binding });
      await this.#requestStartApproval(w, next, envelope);
      return next;
    }
    const next = await this.#transition(w, t, 'queued', { ...patch, agent: binding });
    w.emit('task.queued', taskSubject(t.id), { reason: 'assigned' }, t.traceId);
    return next;
  }

  /** 排队中的任务退回"未分配"。 */
  async unassignTask(taskId: TaskId, by: Actor): Promise<Task> {
    return this.#commit(by, async (w) => {
      const t = await this.#mustGetTask(w.tx, taskId);
      if (t.status !== 'queued') {
        throw new LoopError(ErrorCode.CONFLICT, `cannot unassign task in status ${t.status}`);
      }
      const next = await this.#transition(w, t, 'unassigned', {}, ['agent', 'notBefore']);
      w.emit('task.unassigned', taskSubject(t.id), { previous: t.agent?.agent, by }, t.traceId);
      return next;
    });
  }

  /**
   * 追问 / 继续对话。
   * - awaiting_input / failed：新增一轮并重新排队；closed：先重新打开；
   * - running / waiting_approval：默认排队到本轮结束后，mode=interrupt 时中止当前 Run；
   * - unassigned / pending_approval / queued：追加到待处理的轮次中。
   */
  async sendMessage(taskId: TaskId, input: MessageInput, by: Actor): Promise<Turn> {
    if (input.content.trim() === '') {
      throw new LoopError(ErrorCode.INVALID_INPUT, 'message content is empty', {
        retryable: false,
      });
    }
    const { turn, interrupt } = await this.#commit(by, async (w) => {
      let t = await this.#mustGetTask(w.tx, taskId);
      if (t.status === 'closed') t = await this.#reopen(w, t, by);
      t = await this.#save(w, t, { turnCount: t.turnCount + 1 });
      const turn = await this.#addTurn(w, t, {
        content: input.content,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        by,
      });
      if (t.status === 'awaiting_input' || t.status === 'failed') {
        await this.#transition(w, t, 'queued', { attempts: 0 }, ['notBefore']);
        w.emit('task.queued', taskSubject(t.id), { reason: 'message', turnId: turn.id }, t.traceId);
      }
      const running = t.status === 'running' || t.status === 'waiting_approval';
      return { turn, interrupt: running && input.mode === 'interrupt' };
    });
    if (interrupt) {
      const active = this.#activeFor(taskId);
      if (active) {
        await this.#abortRun(
          active.runId,
          new LoopError(ErrorCode.INTERRUPTED, `interrupted by ${by}`, { retryable: false }),
        );
      }
    }
    this.#nudge();
    return turn;
  }

  /** 失败的任务重试最后失败的那一轮（可同时换 Agent）。 */
  async retryTask(taskId: TaskId, by: Actor, input: { agent?: InstanceName } = {}): Promise<Task> {
    if (input.agent) await this.assignTask(taskId, { agent: input.agent }, by);
    const task = await this.#commit(by, async (w) => {
      const t = await this.#mustGetTask(w.tx, taskId);
      if (t.status !== 'failed') {
        throw new LoopError(ErrorCode.CONFLICT, `cannot retry task in status ${t.status}`);
      }
      const turns = await this.#turnsOf(w.tx, t.id);
      const failed = turns.filter((x) => x.status === 'failed').at(-1);
      if (failed) await this.#setTurn(w, t, failed, 'pending');
      const next = await this.#transition(w, t, 'queued', { attempts: 0 }, [
        'notBefore',
        'lastError',
      ]);
      w.emit('task.queued', taskSubject(t.id), { reason: 'retry', by }, t.traceId);
      return next;
    });
    this.#nudge();
    return task;
  }

  /** 关闭任务；执行中的 Run 会被中止。 */
  async closeTask(taskId: TaskId, by: Actor, input: { reason?: string } = {}): Promise<Task> {
    const active = this.#activeFor(taskId);
    if (active) {
      await this.#abortRun(
        active.runId,
        new LoopError(ErrorCode.CANCELLED, input.reason ?? `closed by ${by}`, {
          retryable: false,
        }),
      );
      return this.#mustGetTask(this.store, taskId);
    }
    return this.#commit(by, async (w) => {
      const t = await this.#mustGetTask(w.tx, taskId);
      if (t.status === 'closed') {
        throw new LoopError(ErrorCode.CONFLICT, `task ${taskId} is already closed`);
      }
      const outcome: TaskOutcome =
        t.status === 'awaiting_input'
          ? 'succeeded'
          : t.status === 'failed'
            ? 'failed'
            : 'cancelled';
      return this.#close(w, t, outcome, { by, ...(input.reason ? { reason: input.reason } : {}) });
    });
  }

  /** 兼容旧接口：等同于 closeTask。 */
  async cancelTask(taskId: TaskId, by: Actor): Promise<void> {
    await this.closeTask(taskId, by);
  }

  /** 重新打开已关闭的任务：有 Agent → awaiting_input，否则 → unassigned。 */
  async reopenTask(taskId: TaskId, by: Actor): Promise<Task> {
    return this.#commit(by, async (w) => {
      const t = await this.#mustGetTask(w.tx, taskId);
      if (t.status !== 'closed') {
        throw new LoopError(ErrorCode.CONFLICT, `task ${taskId} is not closed`);
      }
      return this.#reopen(w, t, by);
    });
  }

  /** 调整优先级 / 派发顺序（看板拖拽排序）。 */
  async reprioritizeTask(taskId: TaskId, input: ReprioritizeInput, by: Actor): Promise<Task> {
    const task = await this.#commit(by, async (w) => {
      const t = await this.#mustGetTask(w.tx, taskId);
      if (t.status === 'closed') {
        throw new LoopError(ErrorCode.CONFLICT, `task ${taskId} is closed`);
      }
      const patch: TaskPatch = {
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.rank === undefined ? {} : { rank: input.rank }),
      };
      w.emit('task.reprioritized', taskSubject(t.id), { ...patch, by }, t.traceId);
      return this.#save(w, t, patch);
    });
    this.#nudge();
    return task;
  }

  async #reopen(w: Writer, t: Task, by: Actor): Promise<Task> {
    const to: TaskStatus = t.agent ? 'awaiting_input' : 'unassigned';
    const next = await this.#transition(w, t, to, { attempts: 0 }, [
      'outcome',
      'closedAt',
      'notBefore',
    ]);
    w.emit('task.reopened', taskSubject(t.id), { by, status: to }, t.traceId);
    return next;
  }

  /** 关闭任务：作废未执行的轮次与待审批请求。 */
  async #close(
    w: Writer,
    t: Task,
    outcome: TaskOutcome,
    data: Record<string, unknown> = {},
  ): Promise<Task> {
    for (const turn of await this.#turnsOf(w.tx, t.id)) {
      if (turn.status === 'pending') await this.#setTurn(w, t, turn, 'cancelled');
    }
    const { items } = await w.tx.approvals.list({ where: { status: 'pending' }, limit: 500 });
    for (const a of items) {
      if (a.subject.id !== t.id) continue;
      await w.tx.approvals.put({ ...a, status: 'expired' });
      w.emit('approval.expired', { kind: 'approval', id: a.id }, { reason: 'task closed' });
    }
    const next = await this.#transition(w, t, 'closed', { outcome, closedAt: this.clock.iso() }, [
      'notBefore',
    ]);
    w.emit('task.closed', taskSubject(t.id), { outcome, ...data }, t.traceId);
    return next;
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
      await this.#closeIdleTasks();
      if (this.#state === 'running') await this.#dispatchRoutings();
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
      .sort((a, b) => a.priority - b.priority || a.rank - b.rank || a.id.localeCompare(b.id));
    const busyKeys = new Set(
      [...this.#active.values()].map((a) => a.concurrencyKey).filter((k) => k !== undefined),
    );

    for (const task of ready) {
      if (this.#active.size >= limit || this.#state !== 'running') break;
      if (!task.agent) continue; // 不应出现：queued 必有 Agent
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
      const pending = (await this.#turnsOf(w.tx, fresh.id)).find((x) => x.status === 'pending');
      if (pending) await this.#setTurn(w, fresh, pending, 'failed');
      const next = await this.#transition(w, fresh, 'failed', { lastError: error });
      w.emit('task.failed', taskSubject(task.id), { error }, task.traceId);
      const envelope = await w.tx.envelopes.get(task.envelopeId);
      if (envelope) await this.#queueDeliveries(w, next, envelope, { trigger: 'failed', error });
    });
  }

  async #closeIdleTasks(): Promise<void> {
    const idleMs = this.config.limits.idleCloseMs;
    if (idleMs === 0) return;
    const now = this.clock.now();
    if (now - this.#lastIdleScan < Math.min(IDLE_SCAN_INTERVAL_MS, idleMs)) return;
    this.#lastIdleScan = now;
    const { items } = await this.store.tasks.list({
      where: { status: 'awaiting_input' },
      limit: 500,
    });
    for (const t of items) {
      if (Date.parse(t.updatedAt) + idleMs > now) continue;
      await this.#commit('kernel', async (w) => {
        const fresh = await w.tx.tasks.get(t.id);
        if (fresh?.status !== 'awaiting_input' || fresh.updatedAt !== t.updatedAt) return;
        await this.#close(w, fresh, 'succeeded', { reason: 'idle', idleMs });
      });
    }
  }

  // ═════════════════════════════ 路由（Router 插件） ═════════════════════════════

  /** 给 Router 的只读查询。 */
  readonly #routerQueries: RouterQueries = {
    searchTasks: async ({ text, limit }) => {
      const max = Math.min(Math.max(limit ?? 10, 1), 50);
      const q = text?.trim().toLowerCase();
      const { items } = await this.store.tasks.list({ order: 'desc', limit: 200 });
      return items
        .filter((t) => !q || t.subject.toLowerCase().includes(q))
        .slice(0, max)
        .map(summarizeTask);
    },
    getTask: async (id) => {
      const t = await this.store.tasks.get(id);
      return t ? summarizeTask(t) : undefined;
    },
  };

  /** 把等待路由的 Task 按 Router 实例分批交出去；每个实例同时只处理一批。 */
  async #dispatchRoutings(): Promise<void> {
    const now = this.clock.now();
    const { items } = await this.store.tasks.list({ where: { status: 'unassigned' }, limit: 500 });
    const due = new Map<InstanceName, Task[]>();
    for (const t of items) {
      const r = t.routing;
      if (r?.status !== 'pending' || this.#routing.has(r.router)) continue;
      if (r.notBefore !== undefined && Date.parse(r.notBefore) > now) continue;
      due.set(r.router, [...(due.get(r.router) ?? []), t]);
    }
    for (const [router, tasks] of due) {
      const lookup = this.plugins.router(router);
      if (lookup.status === 'disabled') continue; // 等待插件恢复
      const batch = tasks
        .sort((a, b) => a.priority - b.priority || a.rank - b.rank || a.id.localeCompare(b.id))
        .slice(0, this.config.limits.routing.batchSize);
      if (lookup.status !== 'ready') {
        await this.#routingFailed(
          batch.map((t) => t.id),
          undefined,
          {
            code: ErrorCode.PLUGIN_NOT_FOUND,
            message: `router ${router} is not configured (${lookup.status})`,
            retryable: false,
          },
        );
        continue;
      }
      const batchId = newId('routingBatch', now);
      const started = await this.#commit('kernel', async (w) => {
        const out: Task[] = [];
        for (const t of batch) {
          const fresh = await w.tx.tasks.get(t.id);
          const r = fresh?.routing;
          if (fresh?.status !== 'unassigned' || r?.status !== 'pending') continue;
          const { notBefore: _skip, ...rest } = r;
          const routing: TaskRouting = {
            ...rest,
            status: 'running',
            attempts: r.attempts + 1,
            batchId,
          };
          out.push(await this.#save(w, fresh, { routing }));
        }
        return out;
      });
      if (started.length === 0) continue;
      const controller = new AbortController();
      const done = this.#runRouting(
        router,
        lookup.impl,
        batchId,
        started,
        controller.signal,
      ).finally(() => {
        this.#routing.delete(router);
        this.#nudge();
      });
      this.#routing.set(router, { controller, done });
    }
  }

  /** 执行一批路由。不会抛错：失败按重试策略结算。 */
  async #runRouting(
    router: InstanceName,
    impl: RouterPlugin,
    batchId: string,
    tasks: readonly Task[],
    signal: AbortSignal,
  ): Promise<void> {
    const ids = tasks.map((t) => t.id);
    try {
      const items: RouterItem[] = [];
      for (const t of tasks) {
        const envelope = await this.store.envelopes.get(t.envelopeId);
        if (!envelope) continue;
        items.push({
          taskId: t.id,
          envelope,
          ...(t.candidates?.length ? { candidates: t.candidates } : {}),
        });
      }
      const agents = this.plugins.routableAgents();
      const result = await withTimeout(
        (s) =>
          impl.route(
            { batchId, items, agents },
            this.plugins.routerContext(router, { signal: s, query: this.#routerQueries, batchId }),
          ),
        this.config.limits.routing.timeoutMs,
        { label: `${router}.route`, signal },
      );
      this.plugins.recordSuccess(router);
      const decisions = new Map<TaskId, RouteDecision>();
      const raw: unknown[] = Array.isArray(result?.decisions) ? result.decisions : [];
      for (const item of raw) {
        const d = RouteDecisionSchema.safeParse(item);
        if (d.success && !decisions.has(d.data.taskId)) decisions.set(d.data.taskId, d.data);
      }
      const usage = UsageSchema.safeParse(result?.usage);
      const missing: TaskId[] = [];
      for (const t of tasks) {
        const d = decisions.get(t.id);
        if (d) {
          await this.#applyDecision(
            router,
            batchId,
            t.id,
            d,
            usage.success ? usage.data : undefined,
          );
        } else {
          missing.push(t.id);
        }
      }
      if (missing.length > 0) {
        await this.#routingFailed(missing, batchId, {
          code: ErrorCode.PLUGIN_PROTOCOL_VIOLATION,
          message: 'router returned no valid decision for this task',
          retryable: true,
        });
      }
    } catch (error) {
      // 停机：保持 running，下次启动时恢复为 pending
      if (signal.aborted && this.#state !== 'running') return;
      const e = toLoopError(error);
      await this.plugins.recordCrash(router, e, 'route');
      await this.#routingFailed(ids, batchId, { ...e.toPayload(), retryable: e.retryable });
    }
  }

  /** 执行 Router 的决策：合法的 assign 直接分配，否则留在"未分配"并记下理由。 */
  async #applyDecision(
    router: InstanceName,
    batchId: string,
    taskId: TaskId,
    d: RouteDecision,
    usage: Usage | undefined,
  ): Promise<void> {
    const actor: Actor = `plugin:${router}`;
    await this.#commit(actor, async (w) => {
      const t = await w.tx.tasks.get(taskId);
      const r = t?.routing;
      if (
        !t ||
        !r ||
        t.status !== 'unassigned' ||
        r.status !== 'running' ||
        r.batchId !== batchId
      ) {
        return; // 期间已被人分配 / 关闭，或已被新批次接管
      }
      const routable = new Set(this.plugins.routableAgents().map((a) => a.instance));
      const allowed = (agent: InstanceName) =>
        routable.has(agent) &&
        (!t.candidates?.length || t.candidates.some((c) => c.agent === agent));
      let action = d.action;
      let reason = d.reason;
      if (action === 'assign' && !(d.agent && allowed(d.agent))) {
        action = 'triage';
        reason = `Router 选择的 ${d.agent} 不可用或不在候选中（${d.reason}）`;
      }
      const routing: TaskRouting = {
        router,
        status: 'decided',
        attempts: r.attempts,
        batchId,
        action,
        reason,
        ...(d.confidence === undefined ? {} : { confidence: d.confidence }),
        decidedAt: this.clock.iso(),
      };
      const agent = action === 'assign' ? d.agent : undefined;
      const suggestions = (d.suggestions ?? []).filter(allowed);
      w.emit(
        'routing.decided',
        taskSubject(t.id),
        {
          router,
          batchId,
          action,
          reason,
          ...(agent ? { agent } : {}),
          ...(d.confidence === undefined ? {} : { confidence: d.confidence }),
          ...(suggestions.length ? { suggestions } : {}),
          ...(usage ? { batchUsage: usage } : {}),
        },
        t.traceId,
      );
      const patch: TaskPatch = {
        routing,
        ...(d.priority === undefined ? {} : { priority: d.priority }),
      };
      if (agent) {
        await this.#assignIn(w, t, { agent }, actor, patch);
        return;
      }
      // 建议的候选只在 Route 没给候选时使用
      if (!t.candidates?.length && suggestions.length) {
        patch.candidates = suggestions.map((agent) => ({ agent }));
      }
      await this.#save(w, t, patch);
    });
  }

  /**
   * 一批（或未能开始的）路由失败：可重试且未超过次数 → 退避后重新排队；否则 failed，留给人处理。
   * batchId 为空表示没能交给 Router（例如插件不存在），也计一次尝试。
   */
  async #routingFailed(
    taskIds: readonly TaskId[],
    batchId: string | undefined,
    error: ErrorPayload,
  ): Promise<void> {
    const { maxAttempts, backoff } = this.config.limits.routing;
    await this.#commit('kernel', async (w) => {
      for (const id of taskIds) {
        const t = await w.tx.tasks.get(id);
        const r = t?.routing;
        if (!t || !r || t.status !== 'unassigned') continue;
        if (
          batchId === undefined
            ? r.status !== 'pending'
            : r.status !== 'running' || r.batchId !== batchId
        ) {
          continue;
        }
        const attempts = batchId === undefined ? r.attempts + 1 : r.attempts;
        const retrying = error.retryable && attempts < maxAttempts;
        const { notBefore: _skip, ...rest } = r;
        const routing: TaskRouting = retrying
          ? {
              ...rest,
              attempts,
              status: 'pending',
              error,
              notBefore: new Date(
                this.clock.now() + computeBackoffMs(backoff, attempts),
              ).toISOString(),
            }
          : { ...rest, attempts, status: 'failed', error };
        w.emit(
          'routing.failed',
          taskSubject(t.id),
          { router: r.router, ...(batchId ? { batchId } : {}), error, retrying, attempts },
          t.traceId,
        );
        await this.#save(w, t, { routing });
      }
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
    const turns = await this.#turnsOf(this.store, task.id);
    const turn = turns.find((t) => t.status === 'pending');
    if (!turn) {
      // 不应出现：排队中却没有待处理的轮次，退回等待输入
      await this.#commit('kernel', async (w) => {
        const fresh = await w.tx.tasks.get(task.id);
        if (fresh?.status !== 'queued') return;
        await this.#transition(w, fresh, 'closed', {
          outcome: 'succeeded',
          closedAt: this.clock.iso(),
        });
        w.emit('task.closed', taskSubject(task.id), { outcome: 'succeeded', reason: 'no input' });
      });
      return;
    }
    const resume = agent.capabilities.resumable
      ? await this.#lastSession(task.id, instance)
      : undefined;

    const now = this.clock.now();
    const runId = newId('run', now);
    const active: ActiveRun = {
      runId,
      taskId: task.id,
      turnId: turn.id,
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
        const freshTurn = await w.tx.turns.get(turn.id);
        if (fresh?.status !== 'queued' || freshTurn?.status !== 'pending') throw new SkipRun();
        const attempt = fresh.attempts + 1;
        const run: Run = {
          id: runId,
          taskId: fresh.id,
          turnId: turn.id,
          attempt,
          agent: instance,
          status: 'running',
          startedAt: this.clock.iso(),
          leaseExpiresAt: new Date(now + this.config.limits.leaseMs).toISOString(),
        };
        await w.tx.runs.put(run);
        await w.tx.turns.put({
          ...freshTurn,
          status: 'running',
          runIds: [...freshTurn.runIds, runId],
          updatedAt: this.clock.iso(),
        });
        const next = await this.#transition(w, fresh, 'running', {
          attempts: attempt,
          lastRunId: runId,
        });
        w.emit(
          'run.started',
          { kind: 'run', id: runId },
          { taskId: fresh.id, turnId: turn.id, turn: turn.index, attempt, agent: instance },
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
    const history = this.#history(turns, turn.index);
    void this.#execute(active, started, envelope, { turn, history, resume }).catch((error) => {
      this.logger.error('run execution crashed', { runId, error: toLoopError(error).message });
    });
  }

  /** 之前各轮的输入与回复，作为不支持 resume 的 Agent 的上下文。 */
  #history(turns: readonly Turn[], beforeIndex: number): ConversationMessage[] {
    const done = turns
      .filter(
        (t) =>
          t.index < beforeIndex &&
          (t.status === 'completed' || t.status === 'failed' || t.status === 'interrupted'),
      )
      .slice(-this.config.limits.maxHistoryTurns);
    return done.flatMap((t): ConversationMessage[] => [
      { role: 'user', content: t.content },
      ...(t.reply ? [{ role: 'assistant' as const, content: t.reply }] : []),
    ]);
  }

  /** 同一任务上最近一次由该 Agent 实例产生的会话 ID。 */
  async #lastSession(taskId: TaskId, instance: InstanceName): Promise<string | undefined> {
    const { items } = await this.store.runs.list({
      where: { taskId, agent: instance },
      order: 'desc',
      limit: 20,
    });
    return items.find((r) => r.sessionId)?.sessionId;
  }

  #armTimeout(a: ActiveRun): void {
    clearTimeout(a.timer);
    const ms = Math.max(0, a.deadline - this.clock.now());
    a.timer = setTimeout(() => {
      void this.#abortRun(a.runId, new LoopError(ErrorCode.TIMEOUT, `run exceeded timeout`));
    }, ms);
    a.timer.unref?.();
  }

  #renderPrompt(binding: AgentBinding | undefined, envelope: Envelope): string {
    if (binding?.prompt) return renderTemplate(binding.prompt, { envelope });
    const p = envelope.payload;
    if (p === undefined || p === null) return envelope.subject;
    return `${envelope.subject}\n\n${typeof p === 'string' ? p : JSON.stringify(p, null, 2)}`;
  }

  async #execute(
    active: ActiveRun,
    task: Task,
    envelope: Envelope,
    conv: { turn: Turn; history: ConversationMessage[]; resume: string | undefined },
  ): Promise<void> {
    const { agent, instance } = active;
    let options: Record<string, unknown> = task.agent?.options ?? {};
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

    let workspace: RunWorkspace | undefined;
    try {
      workspace = await this.#dirs?.workspace({ taskId: task.id, runId: active.runId });
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
      taskId: task.id,
      workspace,
      signal: active.controller.signal,
      awaitApproval: (request) => this.#awaitApproval(active, request),
      spawn: (draft) =>
        this.inbox(draft, {
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
          turn: { id: conv.turn.id, index: conv.turn.index },
          prompt: conv.turn.content,
          history: conv.history,
          options,
          ...(workspace ? { workspace: { path: workspace.work } } : {}),
          ...(conv.resume ? { resume: { sessionId: conv.resume } } : {}),
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
      active.usage = addUsage(active.usage, {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
      });
    }
    if (event.type === 'session') active.sessionId = event.sessionId;

    await this.#commit(`plugin:${active.instance}`, async (w) => {
      if (event.type !== 'heartbeat') {
        w.emit(
          'run.event',
          { kind: 'run', id: active.runId },
          { ...event, taskId: active.taskId },
          active.traceId,
        );
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

  #activeFor(taskId: TaskId): ActiveRun | undefined {
    return [...this.#active.values()].find((a) => a.taskId === taskId && !a.finalized);
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
        : error.code === ErrorCode.CANCELLED || error.code === ErrorCode.INTERRUPTED
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
    const artifacts = await this.#collectArtifacts(active.taskId, active.runId);
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
  async #collectArtifacts(taskId: TaskId, runId: RunId): Promise<FileRef[]> {
    try {
      return await withTimeout(() => this.content.listArtifacts({ taskId, runId }), 10_000, {
        label: 'listArtifacts',
      });
    } catch (error) {
      this.logger.warn('failed to collect artifacts', { runId, error: toLoopError(error).message });
      return [];
    }
  }

  /**
   * 结算 Run，并据此推进轮次与 Task：
   * - 成功：本轮完成 → 还有排队的追问则继续排队，否则 awaiting_input（或 closeOnComplete → closed）；
   * - 打断：本轮 interrupted → 继续处理排队的追问；
   * - 取消（关闭任务）：→ closed(cancelled)；
   * - 失败：可重试且未耗尽 → 退避后重试本轮，否则 → failed。
   */
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
    const usage = ref.usage ?? run.usage;

    const error = outcome.status === 'succeeded' ? undefined : outcome.error;
    const done: Run = {
      ...run,
      status: outcome.status,
      endedAt: this.clock.iso(),
      summary: outcome.summary,
      ...(usage ? { usage } : {}),
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
        turnId: run.turnId,
        attempt: run.attempt,
        summary: outcome.summary,
        ...(error ? { error } : {}),
        ...(ref.artifacts?.length ? { artifacts: ref.artifacts.map((f) => f.ref) } : {}),
      },
      task.traceId,
    );

    const stats: TaskPatch = {
      artifactCount: task.artifactCount + (ref.artifacts?.length ?? 0),
      ...(addUsage(task.usage, usage) ? { usage: addUsage(task.usage, usage) as Usage } : {}),
    };
    if (task.status === 'closed') {
      await this.#save(w, task, stats);
      return;
    }
    const subject = taskSubject(task.id);
    const envelope = await w.tx.envelopes.get(task.envelopeId);
    const turns = await this.#turnsOf(w.tx, task.id);
    const turn = turns.find((t) => t.id === run.turnId);
    const hasPending = turns.some((t) => t.status === 'pending' && t.id !== run.turnId);

    if (outcome.status === 'succeeded') {
      if (turn) await this.#setTurn(w, task, turn, 'completed', outcome.summary);
      // attempts 保留本轮的尝试次数，下一轮开始时归零
      const patch: TaskPatch = {
        ...stats,
        lastSummary: outcome.summary,
        ...(hasPending ? { attempts: 0 } : {}),
      };
      let next: Task;
      if (hasPending) {
        next = await this.#transition(w, task, 'queued', patch, ['lastError']);
        w.emit('task.queued', subject, { reason: 'next_turn', afterRunId: run.id }, task.traceId);
      } else if (task.closeOnComplete) {
        next = await this.#close(w, { ...task, ...patch }, 'succeeded', { runId: run.id });
      } else {
        next = await this.#transition(w, task, 'awaiting_input', patch, ['lastError']);
        w.emit('task.awaiting_input', subject, { runId: run.id }, task.traceId);
      }
      if (envelope) {
        await this.#queueDeliveries(w, next, envelope, {
          trigger: 'succeeded',
          summary: outcome.summary,
          runId: run.id,
        });
      }
      return;
    }

    const err = outcome.error;
    if (outcome.status === 'cancelled') {
      if (err.code === ErrorCode.INTERRUPTED) {
        if (turn) await this.#setTurn(w, task, turn, 'interrupted');
        const patch: TaskPatch = { ...stats, attempts: 0 };
        if (hasPending) {
          await this.#transition(w, task, 'queued', patch);
          w.emit(
            'task.queued',
            subject,
            { reason: 'interrupted', afterRunId: run.id },
            task.traceId,
          );
        } else {
          await this.#transition(w, task, 'awaiting_input', patch);
          w.emit('task.awaiting_input', subject, { runId: run.id }, task.traceId);
        }
        return;
      }
      if (turn) await this.#setTurn(w, task, turn, 'cancelled');
      await this.#close(w, { ...task, ...stats }, 'cancelled', {
        runId: run.id,
        reason: outcome.summary,
      });
      return;
    }

    if (err.retryable && task.attempts < task.policy.maxAttempts) {
      if (turn) await this.#setTurn(w, task, turn, 'pending');
      const delay = computeBackoffMs(task.policy.backoff, task.attempts);
      const notBefore = new Date(this.clock.now() + delay).toISOString();
      await this.#transition(w, task, 'queued', { ...stats, notBefore, lastError: err });
      w.emit(
        'task.queued',
        subject,
        { reason: 'retry', afterRunId: run.id, notBefore, error: err },
        task.traceId,
      );
      return;
    }
    if (turn) await this.#setTurn(w, task, turn, 'failed', outcome.summary);
    const next = await this.#transition(w, task, 'failed', { ...stats, lastError: err });
    w.emit('task.failed', subject, { runId: run.id, error: err }, task.traceId);
    if (envelope) {
      await this.#queueDeliveries(w, next, envelope, {
        trigger: 'failed',
        summary: outcome.summary,
        error: err,
        runId: run.id,
      });
    }
  }

  async #setTurn(
    w: Writer,
    task: Task,
    turn: Turn,
    status: TurnStatus,
    reply?: string,
  ): Promise<void> {
    await w.tx.turns.put({
      ...turn,
      status,
      ...(reply === undefined ? {} : { reply }),
      updatedAt: this.clock.iso(),
    });
    const type: JournalEventType | undefined =
      status === 'completed'
        ? 'turn.completed'
        : status === 'failed'
          ? 'turn.failed'
          : status === 'interrupted'
            ? 'turn.interrupted'
            : status === 'cancelled'
              ? 'turn.cancelled'
              : undefined;
    if (type) {
      w.emit(type, turnSubject(turn.id), { taskId: task.id, index: turn.index }, task.traceId);
    }
  }

  async #transition(
    w: Writer,
    task: Task,
    to: TaskStatus,
    patch: TaskPatch = {},
    unset: readonly TaskField[] = [],
  ): Promise<Task> {
    if (!canTransitionTask(task.status, to)) {
      throw new LoopError(
        ErrorCode.ILLEGAL_TRANSITION,
        `task ${task.id}: ${task.status} → ${to} is not allowed`,
        { retryable: false },
      );
    }
    return this.#write(w, { ...task, status: to }, patch, unset);
  }

  /** 不改变状态的更新。 */
  #save(w: Writer, task: Task, patch: TaskPatch, unset: readonly TaskField[] = []): Promise<Task> {
    return this.#write(w, task, patch, unset);
  }

  async #write(w: Writer, task: Task, patch: TaskPatch, unset: readonly TaskField[]) {
    const next: Task = { ...task, ...patch, updatedAt: this.clock.iso() };
    for (const k of unset) delete next[k];
    await w.tx.tasks.put(next);
    return next;
  }

  async #mustGetTask(tx: Pick<StoreTx, 'tasks'>, taskId: TaskId): Promise<Task> {
    const t = await tx.tasks.get(taskId);
    if (!t) throw new LoopError(ErrorCode.NOT_FOUND, `task ${taskId} not found`);
    return t;
  }

  /** 任务的全部轮次（按 index 升序）。 */
  async #turnsOf(tx: Pick<StoreTx, 'turns'>, taskId: TaskId): Promise<Turn[]> {
    const turns = await this.#scan((c) => tx.turns.list({ where: { taskId }, limit: 500, ...c }));
    return turns.sort((a, b) => a.index - b.index);
  }

  /** 内核重启后：上次进程遗留的 running Run 一律按可重试失败结算。 */
  async #recover(): Promise<void> {
    const runs = await this.#scan((cursor) =>
      this.store.runs.list({ where: { status: 'running' }, limit: 200, ...cursor }),
    );
    for (const run of runs) {
      const artifacts = await this.#collectArtifacts(run.taskId, run.id);
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
    // 上次停机时正在路由的批次：重新排队（已计过一次尝试）
    const routing = (
      await this.#scan((cursor) =>
        this.store.tasks.list({ where: { status: 'unassigned' }, limit: 200, ...cursor }),
      )
    ).filter((t) => t.routing?.status === 'running');
    for (const t of routing) {
      await this.#commit('kernel', async (w) => {
        const r = t.routing as TaskRouting;
        const error = {
          code: ErrorCode.KERNEL_RESTARTED,
          message: 'kernel restarted while routing was in progress',
          retryable: true,
        };
        w.emit(
          'routing.failed',
          taskSubject(t.id),
          { router: r.router, batchId: r.batchId, error, retrying: true, attempts: r.attempts },
          t.traceId,
        );
        await this.#save(w, t, { routing: { ...r, status: 'pending', error } });
      });
    }
    if (runs.length > 0 || approvals.length > 0 || routing.length > 0) {
      this.logger.warn('recovered after restart', {
        runs: runs.length,
        approvals: approvals.length,
        routing: routing.length,
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
    const subject = taskSubject(task.id);
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
        await this.#close(w, task, 'rejected', { approvalId: approval.id });
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
          assign: rc.assign,
          agents: rc.agents,
          ...(rc.router === undefined ? {} : { router: rc.router }),
          sinks: rc.sinks,
          policy: mergePolicy(this.config.defaults.policy, rc.policy),
          ...(rc.closeOnComplete === undefined ? {} : { closeOnComplete: rc.closeOnComplete }),
          stopOnMatch: rc.stopOnMatch,
        };
        errors.push(...validateRoute(route));
        if (route.assign === 'router') {
          const router = route.router ?? this.config.defaults.router;
          if (!router) {
            errors.push(
              `route "${rc.name}": assign "router" requires route.router or defaults.router`,
            );
          } else if (this.plugins.router(router).status === 'missing') {
            this.logger.warn('route references unknown router', { route: rc.name, router });
          }
        }
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
      if (this.config.defaults.unrouted === 'router' && !this.config.defaults.router) {
        errors.push('defaults.unrouted "router" requires defaults.router');
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
