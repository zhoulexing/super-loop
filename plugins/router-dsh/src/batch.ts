/**
 * 一批路由的状态，以及暴露给模型的 MCP 工具。
 * 模型通过 route_decide 提交决策；这里先做一遍校验，错误直接返回给模型让它改正，
 * 内核收到结果后还会再校验一次。
 */
import {
  type InstanceName,
  type RouteDecision,
  RouteDecisionSchema,
  type RouterQueries,
  type RouterRequest,
  type TaskId,
} from '@super-loop/plugin-sdk';
import { z } from 'zod';
import { defineMcpTool, type McpTool } from './mcp-server.js';

export class Batch {
  readonly #request: RouterRequest;
  readonly #decisions = new Map<TaskId, RouteDecision>();
  readonly #routable: Set<InstanceName>;

  constructor(
    request: RouterRequest,
    readonly query: RouterQueries,
  ) {
    this.#request = request;
    this.#routable = new Set(request.agents.map((a) => a.instance));
  }

  get id(): string {
    return this.#request.batchId;
  }

  missing(): TaskId[] {
    return this.#request.items.map((i) => i.taskId).filter((id) => !this.#decisions.has(id));
  }

  decisions(): RouteDecision[] {
    return [...this.#decisions.values()];
  }

  /** 校验并记录一条决策，返回错误说明（合法时返回 undefined）。 */
  decide(raw: unknown): string | undefined {
    const parsed = RouteDecisionSchema.safeParse(raw);
    if (!parsed.success) {
      return parsed.error.issues.map((i) => `${i.path.join('.') || '$'}: ${i.message}`).join('; ');
    }
    const d = parsed.data;
    const item = this.#request.items.find((i) => i.taskId === d.taskId);
    if (!item) return `${d.taskId} 不在本批中`;
    const allowed = (agent: InstanceName) =>
      this.#routable.has(agent) &&
      (!item.candidates?.length || item.candidates.some((c) => c.agent === agent));
    if (d.action === 'assign' && d.agent && !allowed(d.agent)) {
      return item.candidates?.length
        ? `${d.agent} 不在 ${d.taskId} 的候选中（候选：${item.candidates.map((c) => c.agent).join('、')}）`
        : `${d.agent} 不是可用的 Agent`;
    }
    const suggestions = d.suggestions?.filter(allowed);
    const { suggestions: _drop, ...rest } = d;
    this.#decisions.set(d.taskId, suggestions?.length ? { ...rest, suggestions } : rest);
    return undefined;
  }
}

const DecisionInput = z.object({
  taskId: z.string().describe('任务 ID（task_ 开头）'),
  action: z.enum(['assign', 'triage']).describe('assign 派给 agent；triage 留给人处理'),
  agent: z.string().optional().describe('action 为 assign 时必填：可用 Agent 的实例名'),
  suggestions: z.array(z.string()).max(5).optional().describe('triage 时建议的 Agent'),
  priority: z.number().int().min(0).max(3).optional().describe('调整优先级，0 最高；一般不填'),
  reason: z.string().describe('给人看的理由，一两句话'),
  confidence: z.number().min(0).max(1).optional().describe('把握程度 0~1'),
});

/** 工具在调用时读取当前批次；没有批次时直接报错。 */
export function routerTools(current: () => Batch | undefined): McpTool[] {
  const need = (): Batch => {
    const b = current();
    if (!b) throw new Error('当前没有正在处理的批次');
    return b;
  };
  return [
    defineMcpTool({
      name: 'route_decide',
      description:
        '提交本批任务的路由决策。可以一次提交多条；返回已记录的数量、无效的决策和仍缺决策的任务。',
      input: z.object({ decisions: z.array(DecisionInput).min(1).max(50) }),
      async call({ decisions }) {
        const batch = need();
        const errors: string[] = [];
        let recorded = 0;
        for (const d of decisions) {
          const error = batch.decide(d);
          if (error) errors.push(`- ${d.taskId}：${error}`);
          else recorded += 1;
        }
        const missing = batch.missing();
        const lines = [`已记录 ${recorded} 条决策。`];
        if (errors.length) lines.push(`以下决策无效，请改正后重新提交：\n${errors.join('\n')}`);
        lines.push(
          missing.length ? `仍缺决策：${missing.join('、')}` : '本批已全部完成，不需要再回复。',
        );
        return { text: lines.join('\n'), isError: errors.length > 0 && recorded === 0 };
      },
    }),
    defineMcpTool({
      name: 'search_tasks',
      description: '按标题关键词查找最近的任务（新的在前），可参考同类任务以前交给了哪个 Agent。',
      input: z.object({
        text: z.string().max(200).optional().describe('标题关键词，不填返回最近的任务'),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      async call(args) {
        const tasks = await need().query.searchTasks({
          ...(args.text === undefined ? {} : { text: args.text }),
          limit: args.limit ?? 10,
        });
        return { text: tasks.length ? JSON.stringify(tasks) : '没有找到相关任务' };
      },
    }),
    defineMcpTool({
      name: 'get_task',
      description: '查看一个任务的状态、处理它的 Agent 和最近一次结果摘要。',
      input: z.object({ taskId: z.string() }),
      async call({ taskId }) {
        const t = await need().query.getTask(taskId as TaskId);
        return t ? { text: JSON.stringify(t) } : { text: `任务 ${taskId} 不存在`, isError: true };
      },
    }),
  ];
}
