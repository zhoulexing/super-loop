import { z } from 'zod';
import { ErrorPayloadSchema, FileRefSchema, JsonObjectSchema } from './common.js';
import { EnvelopeSchema } from './envelope.js';
import { RunIdSchema, TaskIdSchema, TurnIdSchema } from './ids.js';
import { UsageSchema } from './task.js';

export const AgentCapabilitiesSchema = z.object({
  streaming: z.boolean(),
  /** 支持基于 sessionId 续跑。 */
  resumable: z.boolean(),
  /** 能把工具调用审批交给内核（ctx.awaitApproval）。 */
  toolApproval: z.boolean(),
  /** isolated：每次 Run 一个独立目录 / git worktree。 */
  workspace: z.enum(['none', 'shared', 'isolated']),
  costReporting: z.boolean(),
});
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

/** 会话历史中的一条（之前各轮的输入与回复）。 */
export const ConversationMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

export const AgentRunInputSchema = z.object({
  runId: RunIdSchema,
  taskId: TaskIdSchema,
  /** 本轮内第几次尝试。 */
  attempt: z.number().int().min(1),
  envelope: EnvelopeSchema,
  /** 当前这一轮：首轮 index 为 1。 */
  turn: z.object({ id: TurnIdSchema, index: z.number().int().min(1) }),
  /**
   * 本轮的输入：首轮为渲染后的提示词，之后为人的追问。
   * 支持 resume 的 Agent 带上 resume.sessionId 续跑即可；否则应结合 history 理解上下文。
   */
  prompt: z.string(),
  /** 之前各轮的输入与回复（按时间顺序，不含本轮）。 */
  history: z.array(ConversationMessageSchema),
  /** 已通过插件 optionsSchema 校验的选项。 */
  options: JsonObjectSchema,
  /** 工作目录，同一任务的多轮对话共用（workspaces/<taskId>/work）。 */
  workspace: z.object({ path: z.string().min(1) }).optional(),
  /** 同一任务上一次由同一 Agent 实例产生的会话 ID。 */
  resume: z.object({ sessionId: z.string().min(1) }).optional(),
});
export type AgentRunInput = z.infer<typeof AgentRunInputSchema>;

export const AgentErrorSchema = ErrorPayloadSchema;
export type AgentError = z.infer<typeof AgentErrorSchema>;

const LogEvent = z.object({
  type: z.literal('log'),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
});
const MessageEvent = z.object({
  type: z.literal('message'),
  role: z.enum(['assistant', 'tool']),
  content: z.string(),
});
const ToolCallEvent = z.object({
  type: z.literal('tool_call'),
  callId: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
});
const ToolResultEvent = z.object({
  type: z.literal('tool_result'),
  callId: z.string().min(1),
  ok: z.boolean(),
  summary: z.string().optional(),
});
/** 显式登记产物（通常在 ctx.files.put 之后发出）；Run 结束时内核还会自动扫描 artifacts/ 目录。 */
const ArtifactEvent = z.object({ type: z.literal('artifact') }).extend(FileRefSchema.shape);
const UsageEvent = z.object({ type: z.literal('usage') }).extend(UsageSchema.shape);
const SessionEvent = z.object({ type: z.literal('session'), sessionId: z.string().min(1) });
const HeartbeatEvent = z.object({ type: z.literal('heartbeat') });
const ResultEvent = z.object({
  type: z.literal('result'),
  status: z.enum(['succeeded', 'failed']),
  summary: z.string(),
  output: z.unknown().optional(),
  error: AgentErrorSchema.optional(),
});

/**
 * Agent 回报给内核的事件流。规则：
 * - 必须以且仅以一个 `result` 事件结束；
 * - 长时间无输出时每 ≤15s 发一次 `heartbeat`；
 * - 需要人工审批时调用 `ctx.awaitApproval()`，不通过事件流。
 */
export const AgentEventSchema = z.discriminatedUnion('type', [
  LogEvent,
  MessageEvent,
  ToolCallEvent,
  ToolResultEvent,
  ArtifactEvent,
  UsageEvent,
  SessionEvent,
  HeartbeatEvent,
  ResultEvent,
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type AgentResultEvent = z.infer<typeof ResultEvent>;
