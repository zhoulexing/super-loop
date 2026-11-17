/**
 * Kernel HTTP API（/api/v1）的请求与响应结构，server 与 @super-loop/client 共用。
 * 请求体用 zod schema（server 校验），响应是纯类型。只增不改，破坏性变更走 /api/v2。
 */
import { z } from 'zod';
import type { AgentCapabilities } from './agent.js';
import type { Approval } from './approval.js';
import {
  FileRefSchema,
  type HealthStatus,
  type InstanceName,
  InstanceNameSchema,
  JsonObjectSchema,
  PrioritySchema,
} from './common.js';
import { type Envelope, EnvelopeDraftSchema, EnvelopeKindSchema } from './envelope.js';
import type { EnvelopeId, TurnId } from './ids.js';
import type { JournalEvent } from './journal.js';
import type { PluginKind } from './plugin.js';
import type { Route } from './route.js';
import type { Notification } from './sink.js';
import type { Run, Task, Turn } from './task.js';

// ───────────────────────────── 请求体 ─────────────────────────────

/** POST /envelopes：kind 默认 task，idempotencyKey 与 payload 可省略。 */
export const SubmitEnvelopeSchema = EnvelopeDraftSchema.extend({
  kind: EnvelopeKindSchema.default('task'),
  idempotencyKey: z.string().min(1).optional(),
  payload: z.unknown().optional(),
});
export type SubmitEnvelopeInput = z.input<typeof SubmitEnvelopeSchema>;

/** POST /tasks/:id/messages */
export const SendMessageSchema = z.object({
  content: z.string().min(1).max(100_000),
  /** queue（默认）：执行中则排到本轮之后；interrupt：中止当前 Run 立即处理。 */
  mode: z.enum(['queue', 'interrupt']).default('queue'),
  attachments: z.array(FileRefSchema).max(20).optional(),
});
export type SendMessageInput = z.input<typeof SendMessageSchema>;

/** POST /tasks/:id/assign */
export const AssignTaskSchema = z.object({
  agent: InstanceNameSchema,
  prompt: z.string().optional(),
  options: JsonObjectSchema.optional(),
});
export type AssignTaskInput = z.input<typeof AssignTaskSchema>;

/** POST /tasks/:id/retry */
export const RetryTaskSchema = z.object({ agent: InstanceNameSchema.optional() });
export type RetryTaskInput = z.input<typeof RetryTaskSchema>;

/** POST /tasks/:id/close */
export const CloseTaskSchema = z.object({ reason: z.string().max(2_000).optional() });
export type CloseTaskInput = z.input<typeof CloseTaskSchema>;

/** PATCH /tasks/:id */
export const UpdateTaskSchema = z
  .object({ priority: PrioritySchema.optional(), rank: z.number().finite().optional() })
  .refine((v) => v.priority !== undefined || v.rank !== undefined, 'priority or rank is required');
export type UpdateTaskInput = z.input<typeof UpdateTaskSchema>;

/** POST /approvals/:id/decision */
export const DecideApprovalSchema = z.object({
  decision: z.enum(['grant', 'reject']),
  comment: z.string().max(2_000).optional(),
});
export type DecideApprovalInput = z.input<typeof DecideApprovalSchema>;

// ───────────────────────────── 响应 ─────────────────────────────

/** 列表接口统一的游标分页。 */
export interface ApiPage<T> {
  items: T[];
  nextCursor?: string;
}

/** 错误响应：`{ error: { code, message, details? } }`。 */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export type PluginStatus = 'ready' | 'disabled' | 'failed';

export interface PluginInfo {
  instance: InstanceName;
  plugin: string;
  version: string;
  kind: PluginKind;
  status: PluginStatus;
  crashes: number;
  error?: string;
  /** 配置中的说明（plugins.<instance>.description），Router 据此判断 Agent 擅长什么。 */
  description?: string;
  /** 仅 Agent 插件且已就绪时提供。 */
  capabilities?: AgentCapabilities;
}

export interface PluginWithHealth extends PluginInfo {
  health: HealthStatus;
}

export interface HealthResponse {
  status: 'ok' | 'degraded';
  kernel: 'idle' | 'starting' | 'running' | 'stopping' | 'stopped';
  activeRuns: number;
  /** 全局并发上限（limits.globalConcurrency）。 */
  concurrency: number;
  latestSeq: number;
  plugins: PluginInfo[];
}

export interface SubmitEnvelopeResult {
  envelopeId: EnvelopeId;
  duplicated: boolean;
}

export interface EnvelopeDetail {
  envelope: Envelope;
  tasks: Task[];
}

export interface TaskDetail {
  task: Task;
  envelope?: Envelope;
  runs: Run[];
  /** 按 index 升序。 */
  turns: Turn[];
}

export interface RunDetail {
  run: Run;
  /** 该 Run 的 Journal 事件（含 run.event）。 */
  events: JournalEvent[];
}

export interface JournalPage {
  items: JournalEvent[];
  nextFromSeq?: number;
}

/** 看板收件箱中的一条通知（sink-dashboard 写入）。 */
export interface InboxItem extends Notification {
  receivedAt: string;
  read: boolean;
}

export type { Approval, Route, TurnId };
