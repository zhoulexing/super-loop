import { z } from 'zod';
import type { AgentCapabilities } from './agent.js';
import type { InstanceName } from './common.js';
import { InstanceNameSchema, PrioritySchema } from './common.js';
import type { AgentBinding, Envelope } from './envelope.js';
import type { TaskId } from './ids.js';
import { TaskIdSchema } from './ids.js';
import type { TaskStatus, Usage } from './task.js';

/**
 * Router 插件的协议：内核把一批待分配的 Task 交给 Router，Router 返回每个 Task 的决策。
 * Router 只做判断，不改状态：决策由内核校验后执行（分配 Agent 或留在"未分配"）。
 */

/** Router 对一个 Task 的决策。 */
export const RouteDecisionSchema = z
  .object({
    taskId: TaskIdSchema,
    /** assign：派给 agent；triage：留给人处理（例如没有合适的 Agent、信息不足）。 */
    action: z.enum(['assign', 'triage']),
    agent: InstanceNameSchema.optional(),
    /** triage 时建议的候选 Agent，显示在看板上。 */
    suggestions: z.array(InstanceNameSchema).max(5).optional(),
    /** 调整优先级（0 最高）。 */
    priority: PrioritySchema.optional(),
    /** 给人看的理由，一两句话。 */
    reason: z.string().min(1).max(500),
    confidence: z.number().min(0).max(1).optional(),
  })
  .refine((d) => d.action !== 'assign' || d.agent !== undefined, {
    message: 'agent is required when action is "assign"',
    path: ['agent'],
  });
export type RouteDecision = z.infer<typeof RouteDecisionSchema>;

/** 可供分配的 Agent。 */
export interface RouterAgentInfo {
  instance: InstanceName;
  plugin: string;
  /** 来自配置 plugins.<instance>.description：这个 Agent 擅长什么。 */
  description?: string;
  capabilities: AgentCapabilities;
}

export interface RouterItem {
  taskId: TaskId;
  envelope: Envelope;
  /** 来自 Route 的候选；为空表示可以派给任意 Agent。 */
  candidates?: AgentBinding[];
}

export interface RouterRequest {
  /** 批次 ID，同一批的重试会换新 ID。 */
  batchId: string;
  items: RouterItem[];
  /** 当前可用（已就绪）的 Agent。 */
  agents: RouterAgentInfo[];
}

export interface RouterResult {
  /** 每个 item 一条；缺少的 item 视为本次失败，稍后重试。 */
  decisions: RouteDecision[];
  usage?: Usage;
}

/** 给 Router 用的只读查询（例如查找相关的历史任务）。 */
export interface RouterTaskSummary {
  id: TaskId;
  subject: string;
  status: TaskStatus;
  source: InstanceName;
  agent?: InstanceName;
  lastSummary?: string;
  updatedAt: string;
}

export interface RouterQueries {
  /** 按标题关键词查找最近的任务（新的在前）。 */
  searchTasks(query: { text?: string; limit?: number }): Promise<RouterTaskSummary[]>;
  getTask(id: TaskId): Promise<RouterTaskSummary | undefined>;
}
