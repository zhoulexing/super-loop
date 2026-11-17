import { z } from 'zod';
import { InstanceNameSchema, LabelsSchema } from './common.js';
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

/**
 * auto：直接派给 agents；manual：进入"未分配"由人分配；
 * router：进入"未分配"并交给 Router 插件判断派给谁（agents 为候选，为空表示任意 Agent）。
 */
export const AssignModeSchema = z.enum(['auto', 'manual', 'router']);
export type AssignMode = z.infer<typeof AssignModeSchema>;

export const RouteSchema = z.object({
  id: RouteIdSchema,
  name: z.string().min(1),
  enabled: z.boolean(),
  /** 越小越先匹配。 */
  order: z.number().int(),
  match: RouteMatchSchema,
  /**
   * auto：按 agents 直接生成 Task 并排队（多个 Agent → 扇出）；
   * manual：生成一个 unassigned Task，agents 作为候选，由人在看板上分配。
   */
  assign: AssignModeSchema,
  agents: z.array(AgentBindingSchema),
  /** assign 为 router 时使用哪个 Router 插件实例；不填用 defaults.router。 */
  router: InstanceNameSchema.optional(),
  sinks: z.array(SinkBindingSchema),
  policy: TaskPolicySchema,
  /** 覆盖默认的 closeOnComplete（见 Directives.closeOnComplete）。 */
  closeOnComplete: z.boolean().optional(),
  /** false 时继续匹配后续 Route（扇出）。 */
  stopOnMatch: z.boolean(),
});
export type Route = z.infer<typeof RouteSchema>;

/**
 * 没有匹配到任何 Route 时：triage → 生成 unassigned Task 等人分配；
 * router → 生成 unassigned Task 并交给 defaults.router 判断；drop → 只记录 envelope.unrouted。
 */
export const UnroutedPolicySchema = z.enum(['triage', 'router', 'drop']);
export type UnroutedPolicy = z.infer<typeof UnroutedPolicySchema>;
