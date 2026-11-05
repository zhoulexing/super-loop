import { z } from 'zod';
import { ActorSchema, RiskLevelSchema, SubjectRefSchema, TimestampSchema } from './common.js';
import { ApprovalIdSchema } from './ids.js';

export const ApprovalKindSchema = z.enum(['task_start', 'tool_call', 'remediation']);
export type ApprovalKind = z.infer<typeof ApprovalKindSchema>;

export const ApprovalStatusSchema = z.enum(['pending', 'granted', 'rejected', 'expired']);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const ApprovalDecisionSchema = z.object({
  decision: z.enum(['grant', 'reject']),
  by: ActorSchema,
  at: TimestampSchema,
  comment: z.string().optional(),
});
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/** Agent 工具审批、Task 执行前审批、Watchdog 修复审批共用。 */
export const ApprovalSchema = z.object({
  id: ApprovalIdSchema,
  kind: ApprovalKindSchema,
  subject: SubjectRefSchema,
  title: z.string().min(1),
  detail: z.unknown(),
  risk: RiskLevelSchema,
  requestedBy: ActorSchema,
  /** 不填则任何管理员可审批。 */
  approvers: z.array(z.string()).optional(),
  requestedAt: TimestampSchema,
  /** 过期视为拒绝。 */
  expiresAt: TimestampSchema,
  status: ApprovalStatusSchema,
  decision: ApprovalDecisionSchema.optional(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

/** Agent 在 Run 中发起的审批请求。 */
export const ApprovalRequestSchema = z.object({
  action: z.string().min(1),
  title: z.string().min(1),
  detail: z.unknown(),
  risk: RiskLevelSchema,
  timeoutMs: z.number().int().positive().optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export const ApprovalOutcomeSchema = z.object({
  approvalId: ApprovalIdSchema,
  granted: z.boolean(),
  comment: z.string().optional(),
});
export type ApprovalOutcome = z.infer<typeof ApprovalOutcomeSchema>;
