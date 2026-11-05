import { z } from 'zod';
import { LabelsSchema } from './common.js';
import { AgentBindingSchema, EnvelopeKindSchema, SinkBindingSchema } from './envelope.js';
import { RouteIdSchema } from './ids.js';

export const BackoffSchema = z.object({
  type: z.enum(['fixed', 'exponential']),
  baseMs: z.number().int().positive(),
  maxMs: z.number().int().positive(),
});
export type Backoff = z.infer<typeof BackoffSchema>;

export const TaskPolicySchema = z.object({
  /** 单次 Run 超时。 */
  timeoutMs: z.number().int().positive(),
  /** 最大尝试次数（含首次）。 */
  maxAttempts: z.number().int().min(1),
  backoff: BackoffSchema,
  /** 相同 key 的 Task 串行执行（例如同一个仓库）。 */
  concurrencyKey: z.string().optional(),
  /** 执行前需要人工审批。 */
  requireApproval: z.boolean().optional(),
  budget: z
    .object({
      maxCostUsd: z.number().positive().optional(),
      maxTokens: z.number().int().positive().optional(),
    })
    .optional(),
});
export type TaskPolicy = z.infer<typeof TaskPolicySchema>;

export const DEFAULT_TASK_POLICY: TaskPolicy = {
  timeoutMs: 30 * 60_000,
  maxAttempts: 3,
  backoff: { type: 'exponential', baseMs: 5_000, maxMs: 5 * 60_000 },
};

export const JsonPathConditionSchema = z.object({
  /** 点路径，如 `payload.repo.name`（相对 Envelope）。 */
  path: z.string().min(1),
  op: z.enum(['eq', 'in', 'exists', 'regex']),
  value: z.unknown().optional(),
});
export type JsonPathCondition = z.infer<typeof JsonPathConditionSchema>;

/** 声明式匹配条件：所有给出的条件都满足才算命中（AND）。禁止写任意代码。 */
export const RouteMatchSchema = z.object({
  kind: z.array(EnvelopeKindSchema).optional(),
  /** 来源实例名，支持 glob，如 `lark-event:*`。 */
  source: z.array(z.string().min(1)).optional(),
  labels: LabelsSchema.optional(),
  subjectRegex: z.string().optional(),
  jsonPath: z.array(JsonPathConditionSchema).optional(),
});
export type RouteMatch = z.infer<typeof RouteMatchSchema>;

export const RouteSchema = z.object({
  id: RouteIdSchema,
  name: z.string().min(1),
  enabled: z.boolean(),
  /** 越小越先匹配。 */
  order: z.number().int(),
  match: RouteMatchSchema,
  agents: z.array(AgentBindingSchema).min(1),
  sinks: z.array(SinkBindingSchema),
  policy: TaskPolicySchema,
  /** false 时继续匹配后续 Route（扇出）。 */
  stopOnMatch: z.boolean(),
});
export type Route = z.infer<typeof RouteSchema>;
