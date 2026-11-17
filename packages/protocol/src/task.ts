import { z } from 'zod';
import {
  ActorSchema,
  ErrorPayloadSchema,
  FileRefSchema,
  InstanceNameSchema,
  PrioritySchema,
  TimestampSchema,
} from './common.js';
import { AgentBindingSchema, SinkBindingSchema } from './envelope.js';
import {
  EnvelopeIdSchema,
  RouteIdSchema,
  RunIdSchema,
  TaskIdSchema,
  TraceIdSchema,
  TurnIdSchema,
} from './ids.js';
import { TaskPolicySchema } from './route.js';

// ───────────────────────────── Task ─────────────────────────────

/**
 * Task 是一段与 Agent 的**会话**：可以多轮追问、关闭后重新打开。
 * 看板按状态分列：unassigned / queued / running / (pending|waiting)_approval / awaiting_input / failed / closed。
 */
export const TaskStatusSchema = z.enum([
  /** 还没有 Agent：Route 设为手动分配，或没有匹配到任何 Route（triage）。 */
  'unassigned',
  /** 执行前审批（policy.requireApproval）。 */
  'pending_approval',
  'queued',
  'running',
  /** Run 中途等待工具调用审批。 */
  'waiting_approval',
  /** 本轮已完成，等待追问；空闲超过 limits.idleCloseMs 自动关闭。 */
  'awaiting_input',
  /** 重试耗尽或不可重试；可以重试、追问、换 Agent 或关闭。 */
  'failed',
  /** 已关闭，结果见 outcome；可以重新打开。 */
  'closed',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** 关闭时的结果。 */
export const TaskOutcomeSchema = z.enum(['succeeded', 'failed', 'cancelled', 'rejected']);
export type TaskOutcome = z.infer<typeof TaskOutcomeSchema>;

/**
 * Task 状态机。只有内核可以执行迁移。
 * - running → queued：失败重试（带 notBefore 退避），或本轮结束 / 被打断后还有排队的追问。
 * - running → awaiting_input：本轮成功且会话保持打开；closeOnComplete 时直接 → closed。
 * - running → failed：重试耗尽或不可重试错误。
 * - queued → failed：无法开始执行（例如引用的 Agent 不存在）。
 * - closed → awaiting_input / unassigned：重新打开。
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  unassigned: ['queued', 'pending_approval', 'closed'],
  pending_approval: ['queued', 'closed'],
  queued: ['running', 'unassigned', 'failed', 'closed'],
  running: ['awaiting_input', 'queued', 'failed', 'waiting_approval', 'closed'],
  waiting_approval: ['running', 'awaiting_input', 'queued', 'failed', 'closed'],
  awaiting_input: ['queued', 'closed'],
  failed: ['queued', 'closed'],
  closed: ['awaiting_input', 'unassigned'],
};

/** 内核会主动推进的状态（调度、执行、审批中）；其余状态等待人的操作。 */
export const ACTIVE_TASK_STATUSES: readonly TaskStatus[] = [
  'pending_approval',
  'queued',
  'running',
  'waiting_approval',
];

export function isActiveTaskStatus(status: TaskStatus): boolean {
  return ACTIVE_TASK_STATUSES.includes(status);
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

/**
 * 交给 Router 插件自动分配时的状态（只出现在由 Router 处理的 Task 上）：
 * pending 等待下一批 → running 已交给 Router → decided 已决策 / failed 重试耗尽；
 * skipped：Router 决策前人已经手动分配。Task 在决策前保持 unassigned。
 */
export const TaskRoutingStatusSchema = z.enum([
  'pending',
  'running',
  'decided',
  'failed',
  'skipped',
]);
export type TaskRoutingStatus = z.infer<typeof TaskRoutingStatusSchema>;

export const TaskRoutingSchema = z.object({
  router: InstanceNameSchema,
  status: TaskRoutingStatusSchema,
  /** 已交给 Router 的次数。 */
  attempts: z.number().int().nonnegative(),
  /** 失败退避期间不交给 Router。 */
  notBefore: TimestampSchema.optional(),
  /** 当前（或最后一次）所在的批次。 */
  batchId: z.string().optional(),
  /** Router 给出的分配结果：assign 已自动分配，triage 建议人工处理。 */
  action: z.enum(['assign', 'triage']).optional(),
  reason: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  error: ErrorPayloadSchema.optional(),
  decidedAt: TimestampSchema.optional(),
});
export type TaskRouting = z.infer<typeof TaskRoutingSchema>;

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const TaskSchema = z.object({
  id: TaskIdSchema,
  envelopeId: EnvelopeIdSchema,
  traceId: TraceIdSchema,
  /** 冗余自 Envelope，便于列表展示。 */
  subject: z.string(),
  /** 来源实例名，冗余自 Envelope。 */
  source: InstanceNameSchema,
  /** 来自哪条 Route；由 directives 指定或 triage 时为空。 */
  routeId: RouteIdSchema.optional(),
  /** 当前处理的 Agent；unassigned 时为空。 */
  agent: AgentBindingSchema.optional(),
  /** 手动分配时的候选 Agent（来自 Route，含提示词与选项）；为空表示任意 Agent。 */
  candidates: z.array(AgentBindingSchema).optional(),
  /** 交给 Router 插件自动分配的状态。 */
  routing: TaskRoutingSchema.optional(),
  sinks: z.array(SinkBindingSchema),
  policy: TaskPolicySchema,
  priority: PrioritySchema,
  /** 同优先级内的派发顺序，越小越先；看板拖拽排序时修改。 */
  rank: z.number(),
  status: TaskStatusSchema,
  /** 仅 closed 时有值。 */
  outcome: TaskOutcomeSchema.optional(),
  /** 本轮成功后直接关闭（自动化来源默认），否则进入 awaiting_input 等待追问。 */
  closeOnComplete: z.boolean(),
  /** 当前这一轮已开始的 Run 次数；新一轮或手动重试时归零。 */
  attempts: z.number().int().nonnegative(),
  /** 退避期间不调度。 */
  notBefore: TimestampSchema.optional(),
  lastRunId: RunIdSchema.optional(),
  lastError: ErrorPayloadSchema.optional(),
  /** 最近一次成功 Run 的摘要。 */
  lastSummary: z.string().optional(),
  turnCount: z.number().int().nonnegative(),
  artifactCount: z.number().int().nonnegative(),
  /** 所有 Run 的累计用量。 */
  usage: UsageSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  closedAt: TimestampSchema.optional(),
});
export type Task = z.infer<typeof TaskSchema>;

// ───────────────────────────── Turn ─────────────────────────────

/**
 * 会话中的一轮：一条输入（首轮来自 Envelope，之后是人的追问）及处理它的 Run（含重试）。
 * - pending：等待执行（执行中发来的追问会排队）；
 * - interrupted：被"打断并发送"中止；cancelled：任务被关闭时未执行完。
 */
export const TurnStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'interrupted',
  'cancelled',
]);
export type TurnStatus = z.infer<typeof TurnStatusSchema>;

export const TurnSchema = z.object({
  id: TurnIdSchema,
  taskId: TaskIdSchema,
  /** 从 1 开始。 */
  index: z.number().int().min(1),
  /** 输入内容；首轮为渲染后的提示词。 */
  content: z.string(),
  attachments: z.array(FileRefSchema).optional(),
  by: ActorSchema,
  status: TurnStatusSchema,
  runIds: z.array(RunIdSchema),
  /** 最后一次 Run 的摘要（Agent 的回复）。 */
  reply: z.string().optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Turn = z.infer<typeof TurnSchema>;

// ───────────────────────────── Run ─────────────────────────────

export const RunStatusSchema = z.enum(['running', 'succeeded', 'failed', 'timed_out', 'cancelled']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunSchema = z.object({
  id: RunIdSchema,
  taskId: TaskIdSchema,
  turnId: TurnIdSchema,
  /** 本轮内第几次尝试。 */
  attempt: z.number().int().min(1),
  agent: InstanceNameSchema,
  status: RunStatusSchema,
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.optional(),
  /** 租约到期时间；Agent 心跳会续约，过期视为 timed_out。 */
  leaseExpiresAt: TimestampSchema,
  sessionId: z.string().optional(),
  usage: UsageSchema.optional(),
  summary: z.string().optional(),
  output: z.unknown().optional(),
  error: ErrorPayloadSchema.optional(),
  /** Run 结束时登记的产物（workspaces/<taskId>/artifacts/<runId>/ 下的文件）。 */
  artifacts: z.array(FileRefSchema).optional(),
});
export type Run = z.infer<typeof RunSchema>;
