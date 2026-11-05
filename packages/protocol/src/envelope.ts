import { z } from 'zod';
import {
  FileRefSchema,
  InstanceNameSchema,
  JsonObjectSchema,
  LabelsSchema,
  PrioritySchema,
  TimestampSchema,
} from './common.js';
import { EnvelopeIdSchema, TraceIdSchema } from './ids.js';

export const EnvelopeKindSchema = z.enum(['task', 'event', 'schedule']);
export type EnvelopeKind = z.infer<typeof EnvelopeKindSchema>;

/** 把 Envelope 交给哪个 Agent 实例处理。 */
export const AgentBindingSchema = z.object({
  agent: InstanceNameSchema,
  /** 提示词模板，可用 {{envelope.subject}}、{{envelope.payload.xxx}} 等变量。 */
  prompt: z.string().optional(),
  /** 交给 Agent 插件自己的 schema 校验。 */
  options: JsonObjectSchema.optional(),
});
export type AgentBinding = z.infer<typeof AgentBindingSchema>;

export const SinkTriggerSchema = z.enum(['started', 'succeeded', 'failed', 'approval_required']);
export type SinkTrigger = z.infer<typeof SinkTriggerSchema>;

/** 结果通知到哪个 Sink 实例。 */
export const SinkBindingSchema = z.object({
  sink: InstanceNameSchema,
  on: z.array(SinkTriggerSchema).min(1),
  template: z.string().optional(),
});
export type SinkBinding = z.infer<typeof SinkBindingSchema>;

/** Envelope 上的显式指令，优先级高于 Route。 */
export const DirectivesSchema = z.object({
  agents: z.array(AgentBindingSchema).optional(),
  sinks: z.array(SinkBindingSchema).optional(),
  priority: PrioritySchema.optional(),
  deadline: TimestampSchema.optional(),
  /** true 则不再匹配 Route，只用 directives。 */
  skipRoutes: z.boolean().optional(),
});
export type Directives = z.infer<typeof DirectivesSchema>;

export const TraceSchema = z.object({
  traceId: TraceIdSchema,
  /** 派生任务的父 Envelope。 */
  parentId: EnvelopeIdSchema.optional(),
  /** 派生深度，根 Envelope 为 0；超过 limits.maxSpawnDepth 将被拒绝。 */
  depth: z.number().int().nonnegative(),
});
export type Trace = z.infer<typeof TraceSchema>;

export const EnvelopeSourceSchema = z.object({
  /** 插件名，如 `source-cron`。 */
  plugin: z.string().min(1),
  /** 实例名，如 `cron:main`。 */
  instance: InstanceNameSchema,
  /** 来源侧的原始引用（事件 ID、消息 ID 等）。 */
  ref: z.string().optional(),
});
export type EnvelopeSource = z.infer<typeof EnvelopeSourceSchema>;

/** 一条进入 Loop 的消息。入库后不可变。 */
export const EnvelopeSchema = z.object({
  id: EnvelopeIdSchema,
  kind: EnvelopeKindSchema,
  source: EnvelopeSourceSchema,
  /** 在同一 source 实例内唯一；重复 key 只入队一次。 */
  idempotencyKey: z.string().min(1),
  receivedAt: TimestampSchema,
  subject: z.string().min(1).max(500),
  payload: z.unknown(),
  attachments: z.array(FileRefSchema).optional(),
  labels: LabelsSchema.optional(),
  directives: DirectivesSchema.optional(),
  trace: TraceSchema,
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

/** Source 插件 / API 提交的草稿，由内核补全 id、receivedAt、source、trace。 */
export const EnvelopeDraftSchema = EnvelopeSchema.omit({
  id: true,
  receivedAt: true,
  source: true,
  trace: true,
}).extend({
  /** 来源侧原始引用，会写入 `source.ref`。 */
  ref: z.string().optional(),
});
export type EnvelopeDraft = z.infer<typeof EnvelopeDraftSchema>;
