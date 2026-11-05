import { z } from 'zod';
import {
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
} from './ids.js';
import { TaskPolicySchema } from './route.js';

// ───────────────────────────── Task ─────────────────────────────

export const TaskStatusSchema = z.enum([
  'created',
  'pending_approval',
  'queued',
  'running',
  'waiting_approval',
  'succeeded',
  'dead',
  'cancelled',
  'rejected',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * Task 状态机。只有内核可以执行迁移。
 * - running → queued：本次 Run 失败且还有重试次数（带 notBefore 退避）。
 * - running → dead：重试耗尽或不可重试错误。
 * - waiting_approval：Run 中途等待人工审批（工具调用等），期间超时或被打断同样走重试/失败。
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  created: ['queued', 'pending_approval', 'cancelled'],
  pending_approval: ['queued', 'rejected', 'cancelled'],
  // queued → dead：无法开始执行（例如引用的 Agent 不存在）
  queued: ['running', 'dead', 'cancelled'],
  running: ['succeeded', 'queued', 'dead', 'waiting_approval', 'cancelled'],
  // 等待审批期间也可能超时、被打断（重试或失败）
  waiting_approval: ['running', 'queued', 'dead', 'cancelled'],
  succeeded: [],
  dead: [],
  cancelled: [],
  rejected: [],
};

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  'succeeded',
  'dead',
  'cancelled',
  'rejected',
];

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_TASK_STATUSES.includes(status);
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export const TaskSchema = z.object({
  id: TaskIdSchema,
  envelopeId: EnvelopeIdSchema,
  traceId: TraceIdSchema,
  /** 来自哪条 Route；由 directives 直接指定时为空。 */
  routeId: RouteIdSchema.optional(),
  agent: AgentBindingSchema,
  sinks: z.array(SinkBindingSchema),
  policy: TaskPolicySchema,
  priority: PrioritySchema,
  status: TaskStatusSchema,
  /** 已开始的 Run 次数。 */
  attempts: z.number().int().nonnegative(),
  /** 退避期间不调度。 */
  notBefore: TimestampSchema.optional(),
  lastRunId: RunIdSchema.optional(),
  lastError: ErrorPayloadSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Task = z.infer<typeof TaskSchema>;

// ───────────────────────────── Run ─────────────────────────────

export const RunStatusSchema = z.enum(['running', 'succeeded', 'failed', 'timed_out', 'cancelled']);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const RunSchema = z.object({
  id: RunIdSchema,
  taskId: TaskIdSchema,
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
  /** Run 结束时登记的产物（workspaces/<runId>/artifacts/ 下的文件）。 */
  artifacts: z.array(FileRefSchema).optional(),
});
export type Run = z.infer<typeof RunSchema>;
