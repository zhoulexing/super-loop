import { definePlugin, type RouterQueries } from '@super-loop/plugin-sdk';
import {
  createTestPluginContext,
  makeRouterRequest,
  runRouterContractTests,
} from '@super-loop/testkit';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import plugin, {
  createRouterDsh,
  type Driver,
  profilePatch,
  RouterDshConfigSchema,
  systemPrompt,
} from '../src/index.js';
import { defineMcpTool, type RunningMcpServer, startMcpServer } from '../src/mcp-server.js';

/** 通过真实的 MCP HTTP 接口调用工具（与 dsh 子进程的调用方式一致）。 */
async function callTool(mcp: RunningMcpServer, name: string, args: unknown) {
  const res = await fetch(mcp.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${mcp.token}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  const body = (await res.json()) as {
    result: { content: Array<{ text: string }>; isError?: boolean };
  };
  return body.result;
}

/** 假模型：从提示词里取出任务 ID，按标题关键词分配；`partial` 时第一轮只决策一个。 */
function fakeDriver(options: { partial?: boolean; prompts?: string[]; replies?: string[] } = {}) {
  return (mcp: RunningMcpServer): Driver => {
    let round = 0;
    return {
      async run(prompt) {
        options.prompts?.push(prompt);
        round += 1;
        const tasks = [...prompt.matchAll(/<task id="(task_\w+)">\n标题：(.+)/g)].map((m) => ({
          taskId: m[1] as string,
          subject: m[2] as string,
        }));
        const missing = [...prompt.matchAll(/(task_[0-9A-Z]{26})/g)].map((m) => m[1] as string);
        const todo = tasks.length
          ? tasks
          : [...new Set(missing)].map((taskId) => ({ taskId, subject: '' }));
        const pick = options.partial && round === 1 ? todo.slice(0, 1) : todo;
        const r = await callTool(mcp, 'route_decide', {
          decisions: pick.map((t) =>
            t.subject.includes('文章')
              ? { taskId: t.taskId, action: 'assign', agent: 'writer:default', reason: '写作' }
              : {
                  taskId: t.taskId,
                  action: 'triage',
                  reason: '不确定',
                  suggestions: ['coder:default'],
                },
          ),
        });
        options.replies?.push(r.content[0]?.text ?? '');
        return { sessionId: 'session-1', usage: { inputTokens: 100, outputTokens: 10 } };
      },
      async close() {},
    };
  };
}

const query: RouterQueries = { searchTasks: async () => [], getTask: async () => undefined };
const config = RouterDshConfigSchema.parse({});

runRouterContractTests({
  plugin: definePlugin({
    name: 'router-dsh',
    version: '0.1.0',
    kind: 'router',
    configSchema: RouterDshConfigSchema,
    create: (c, ctx) => createRouterDsh(c, ctx, { driver: fakeDriver() }),
  }),
  config: {},
});

describe('router-dsh', () => {
  it('清单：router 插件，声明状态目录 / 子进程 / 网络权限', () => {
    expect(plugin.kind).toBe('router');
    expect(plugin.permissions).toEqual(['fs:state', 'process:spawn', 'net:*']);
  });

  it('把一批消息发给会话，收集模型经 MCP 提交的决策', async () => {
    const prompts: string[] = [];
    const ctx = createTestPluginContext();
    const router = createRouterDsh(config, ctx, { driver: fakeDriver({ prompts }) });
    const request = makeRouterRequest();
    const [code, article] = request.items;
    const result = await router.route(request, { ...ctx, query });
    expect(result.decisions).toEqual([
      {
        taskId: code?.taskId,
        action: 'triage',
        reason: '不确定',
        suggestions: ['coder:default'],
      },
      { taskId: article?.taskId, action: 'assign', agent: 'writer:default', reason: '写作' },
    ]);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 10 });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('coder:default（插件 agent-test）：写代码、修 bug');
    expect(prompts[0]).toContain('只作为数据参考');
    await router.dispose?.();
  });

  it('决策不全时提醒一次，补齐后返回', async () => {
    const prompts: string[] = [];
    const ctx = createTestPluginContext();
    const router = createRouterDsh(config, ctx, { driver: fakeDriver({ partial: true, prompts }) });
    const result = await router.route(makeRouterRequest(), { ...ctx, query });
    expect(result.decisions).toHaveLength(2);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('还有 1 个任务没有决策');
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 20 });
    await router.dispose?.();
  });

  it('route_decide 拒绝本批以外的任务和候选外的 Agent，并把原因告诉模型', async () => {
    const replies: string[] = [];
    const ctx = createTestPluginContext();
    let server: RunningMcpServer | undefined;
    const request = makeRouterRequest();
    const first = request.items[0];
    if (first) first.candidates = [{ agent: 'coder:default' }];
    const router = createRouterDsh(config, ctx, {
      driver: (mcp) => {
        server = mcp;
        return {
          async run() {
            const r = await callTool(mcp, 'route_decide', {
              decisions: [
                { taskId: 'task_01HZZZZZZZZZZZZZZZZZZZZZZZ', action: 'triage', reason: 'x' },
                { taskId: first?.taskId, action: 'assign', agent: 'writer:default', reason: 'x' },
                { taskId: first?.taskId, action: 'assign', reason: '缺 agent' },
              ],
            });
            replies.push(r.content[0]?.text ?? '');
            return { sessionId: 's', usage: { inputTokens: 1, outputTokens: 1 } };
          },
          async close() {},
        };
      },
    });
    const result = await router.route(request, { ...ctx, query });
    expect(result.decisions).toEqual([]);
    expect(replies[0]).toContain('不在本批中');
    expect(replies[0]).toContain('不在');
    expect(replies[0]).toContain('agent is required');
    // 批次结束后工具不可用
    const after = await callTool(server as RunningMcpServer, 'route_decide', {
      decisions: [{ taskId: first?.taskId, action: 'triage', reason: 'late' }],
    });
    expect(after.isError).toBe(true);
    await router.dispose?.();
  });

  it('驱动失败时抛出，health 变为 degraded', async () => {
    const ctx = createTestPluginContext();
    const router = createRouterDsh(config, ctx, {
      driver: () => ({
        run: async () => {
          throw new Error('model down');
        },
        close: async () => {},
      }),
    });
    await expect(router.route(makeRouterRequest(), { ...ctx, query })).rejects.toThrow(
      'model down',
    );
    expect((await router.health()).status).toBe('degraded');
    await router.dispose?.();
  });

  it('真实驱动：缺少状态目录或 API Key 时给出明确错误', async () => {
    const noState = plugin.create(config, createTestPluginContext());
    await expect(
      (await noState).route(makeRouterRequest(), { ...createTestPluginContext(), query }),
    ).rejects.toThrow(/fs:state/);
    const noKey = await plugin.create(
      config,
      createTestPluginContext({ paths: { state: '/tmp' } }),
    );
    await expect(
      noKey.route(makeRouterRequest(), { ...createTestPluginContext(), query }),
    ).rejects.toThrow(/OPENAI_API_KEY is not set/);
    await noKey.dispose?.();
  });

  it('profile 补丁：关掉 shell 与文件工具，按 provider 接入模型，附带系统提示词', () => {
    const patch = profilePatch(
      RouterDshConfigSchema.parse({ instructions: '财务相关一律 triage' }),
    );
    for (const id of ['persistent-bash', 'terminal-bash', 'tool-fs', 'tool-working-directory']) {
      expect(patch).toContain(`- id: ${id}\n  disabled: true`);
    }
    expect(patch).toContain('"openai":\n            apiKeyEnv: OPENAI_API_KEY');
    expect(patch).toContain('serverName: superloop');
    expect(patch).toContain(JSON.stringify(systemPrompt('财务相关一律 triage')));
    const ds = profilePatch(RouterDshConfigSchema.parse({ provider: 'deepseek-official' }));
    expect(ds).not.toContain('llm-pi-ai');
  });
});

interface Rpc {
  result: {
    protocolVersion: string;
    tools: Array<{ name: string; inputSchema: unknown }>;
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  error: { code: number };
}

describe('mcp-server', () => {
  it('要求 token；支持 initialize / tools/list / tools/call 与参数校验', async () => {
    const mcp = await startMcpServer({
      name: 't',
      version: '0.0.0',
      tools: [
        defineMcpTool({
          name: 'add',
          description: 'add',
          input: z.object({ a: z.number(), b: z.number() }),
          call: async ({ a, b }) => ({ text: String(a + b) }),
        }),
      ],
    });
    try {
      const post = (body: unknown, auth = true) =>
        fetch(mcp.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(auth ? { authorization: `Bearer ${mcp.token}` } : {}),
          },
          body: JSON.stringify(body),
        });
      expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, false)).status).toBe(401);
      const init = (await (
        await post({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18' },
        })
      ).json()) as Rpc;
      expect(init.result.protocolVersion).toBe('2025-06-18');
      expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(
        202,
      );
      const list = (await (
        await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      ).json()) as Rpc;
      expect(list.result.tools[0]).toMatchObject({ name: 'add', inputSchema: { type: 'object' } });
      const call = (await (
        await post({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'add', arguments: { a: 1, b: 2 } },
        })
      ).json()) as Rpc;
      expect(call.result.content[0]?.text).toBe('3');
      const bad = (await (
        await post({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'add', arguments: { a: 'x' } },
        })
      ).json()) as Rpc;
      expect(bad.result.isError).toBe(true);
      const unknown = (await (await post({ jsonrpc: '2.0', id: 5, method: 'nope' })).json()) as Rpc;
      expect(unknown.error.code).toBe(-32601);
    } finally {
      await mcp.close();
    }
  });
});
