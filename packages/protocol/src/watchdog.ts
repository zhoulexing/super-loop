import { z } from 'zod';
import { JsonObjectSchema, LabelsSchema, RiskLevelSchema, TimestampSchema } from './common.js';
import { ApprovalIdSchema, IncidentIdSchema, RemediationIdSchema } from './ids.js';

// 注意：Watchdog 相关协议在 M4 前为 experimental，可能调整。

export const ProbeSampleSchema = z.object({
  metric: z.string().min(1),
  value: z.number(),
  labels: LabelsSchema.optional(),
  at: TimestampSchema,
});
export type ProbeSample = z.infer<typeof ProbeSampleSchema>;

export const IncidentSeveritySchema = z.enum(['info', 'warning', 'error', 'critical']);
export type IncidentSeverity = z.infer<typeof IncidentSeveritySchema>;

export const IncidentStatusSchema = z.enum(['open', 'mitigating', 'resolved']);
export type IncidentStatus = z.infer<typeof IncidentStatusSchema>;

export const IncidentSchema = z.object({
  id: IncidentIdSchema,
  /** 异常类型，如 `run.stuck`、`queue.backlog`、`plugin.unhealthy`。 */
  type: z.string().min(1),
  /** 用于去重聚合：相同 fingerprint 的异常合并为一个 Incident。 */
  fingerprint: z.string().min(1),
  severity: IncidentSeveritySchema,
  status: IncidentStatusSchema,
  title: z.string().min(1),
  detail: JsonObjectSchema,
  occurrences: z.number().int().min(1),
  remediationAttempts: z.number().int().nonnegative(),
  openedAt: TimestampSchema,
  updatedAt: TimestampSchema,
  resolvedAt: TimestampSchema.optional(),
});
export type Incident = z.infer<typeof IncidentSchema>;

export const RemediationActionSchema = z.object({
  /** 动作类型，如 `run.cancel`、`plugin.restart`、`route.disable`、`patch.propose`。 */
  type: z.string().min(1),
  params: JsonObjectSchema,
  risk: RiskLevelSchema,
});
export type RemediationAction = z.infer<typeof RemediationActionSchema>;

export const RemediationStatusSchema = z.enum([
  'proposed',
  'approved',
  'rejected',
  'executing',
  'verifying',
  'succeeded',
  'rolled_back',
  'failed',
]);
export type RemediationStatus = z.infer<typeof RemediationStatusSchema>;

export const RemediationSchema = z.object({
  id: RemediationIdSchema,
  incidentId: IncidentIdSchema,
  /** 生成该方案的 playbook 实例名。 */
  playbook: z.string().min(1),
  /** 取所有动作中的最高风险。 */
  risk: RiskLevelSchema,
  diagnosis: z.string().min(1),
  expectedOutcome: z.string().min(1),
  actions: z.array(RemediationActionSchema).min(1),
  /** 每个方案都必须给出回滚步骤（可为空数组表示无副作用）。 */
  rollback: z.array(RemediationActionSchema),
  verify: z.object({
    description: z.string().min(1),
    timeoutMs: z.number().int().positive(),
  }),
  status: RemediationStatusSchema,
  approvalId: ApprovalIdSchema.optional(),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Remediation = z.infer<typeof RemediationSchema>;
