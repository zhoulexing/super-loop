/**
 * @super-loop/router-dsh：用 DeepSeek Harness（@deepseek-ai/dsh-sdk-client）做 Router。
 *
 * 一个插件实例 = 一个长驻的 dsh 子进程 + 一个长驻、可恢复的 Router 会话：
 * - 内核每批交来若干待分配的 Task，插件把它们写成一条消息发给会话；
 * - 模型通过本插件提供的 MCP 工具（route_decide / search_tasks / get_task）查询并提交决策；
 * - 会话日志由 DSH 存在 state/<instance>/dsh，会话 ID 存在插件 kv，重启后继续同一个会话。
 */
import {
  defineRouterPlugin,
  ErrorCode,
  LoopError,
  type PluginContext,
  type RouterContext,
  type RouterPlugin,
  type RouterRequest,
  type RouterResult,
} from '@super-loop/plugin-sdk';
import { Batch, routerTools } from './batch.js';
import { type RouterDshConfig, RouterDshConfigSchema } from './config.js';
import { type Driver, DshDriver } from './driver.js';
import { type RunningMcpServer, startMcpServer } from './mcp-server.js';
import { batchPrompt, reminderPrompt } from './prompt.js';

export { type RouterDshConfig, RouterDshConfigSchema } from './config.js';
export { type Driver, type DriverRunResult, profilePatch } from './driver.js';
export { batchPrompt, systemPrompt } from './prompt.js';

const SESSION_KEY = 'session';

export interface RouterDshDeps {
  /** 测试用：替换真实的 dsh 驱动。 */
  driver?: (mcp: RunningMcpServer) => Driver | Promise<Driver>;
}

/** 构造插件实现（导出给测试注入假的驱动）。 */
export function createRouterDsh(
  config: RouterDshConfig,
  ctx: PluginContext,
  deps: RouterDshDeps = {},
): RouterPlugin {
  let current: Batch | undefined;
  let mcp: RunningMcpServer | undefined;
  let driver: Driver | undefined;
  let lastError: string | undefined;
  let lastOk: string | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  async function ensureDriver(): Promise<Driver> {
    if (driver) return driver;
    mcp ??= await startMcpServer({
      name: 'superloop',
      version: '0.1.0',
      instructions: 'Super Loop 的路由工具：用 route_decide 提交每个任务的分配决策。',
      tools: routerTools(() => current),
    });
    if (deps.driver) {
      driver = await deps.driver(mcp);
      return driver;
    }
    const stateDir = ctx.paths.state;
    if (!stateDir) {
      throw new LoopError(ErrorCode.INVALID_CONFIG, 'router-dsh needs the fs:state directory', {
        retryable: false,
      });
    }
    const apiKey = await ctx.secrets.get(config.apiKeySecret);
    if (!apiKey) {
      throw new LoopError(
        ErrorCode.INVALID_CONFIG,
        `secret ${config.apiKeySecret} is not set (secrets.env or environment)`,
        { retryable: false },
      );
    }
    driver = new DshDriver({
      config,
      stateDir,
      apiKey,
      mcp,
      logger: ctx.logger,
      loadSessionId: () => ctx.kv.get<string>(SESSION_KEY),
      saveSessionId: (id) => ctx.kv.set(SESSION_KEY, id),
    });
    return driver;
  }

  async function routeBatch(request: RouterRequest, rctx: RouterContext): Promise<RouterResult> {
    const d = await ensureDriver();
    const batch = new Batch(request, rctx.query);
    current = batch;
    const usage = { inputTokens: 0, outputTokens: 0 };
    try {
      let prompt = batchPrompt(request, config.maxPayloadChars);
      for (let round = 0; round <= config.maxReminders; round += 1) {
        const r = await d.run(prompt, rctx.signal);
        usage.inputTokens += r.usage.inputTokens;
        usage.outputTokens += r.usage.outputTokens;
        const missing = batch.missing();
        if (missing.length === 0) break;
        prompt = reminderPrompt(missing);
      }
      lastOk = ctx.clock.iso();
      lastError = undefined;
      return { decisions: batch.decisions(), usage };
    } catch (error) {
      lastError = (error as Error).message;
      throw error;
    } finally {
      current = undefined;
    }
  }

  return {
    route(request, rctx) {
      // 内核保证同一实例同时只有一批；这里再串行一次，避免工具读到别的批次
      const next = queue.then(() => routeBatch(request, rctx));
      queue = next.catch(() => undefined);
      return next;
    },
    async health() {
      const checkedAt = ctx.clock.iso();
      if (lastError) return { status: 'degraded' as const, checkedAt, message: lastError };
      return {
        status: 'healthy' as const,
        checkedAt,
        details: {
          provider: config.provider,
          model: config.model,
          started: driver !== undefined,
          ...(lastOk ? { lastOk } : {}),
        },
      };
    },
    async dispose() {
      await driver?.close();
      await mcp?.close();
      driver = undefined;
      mcp = undefined;
    },
  };
}

export default defineRouterPlugin({
  name: 'router-dsh',
  version: '0.1.0',
  description: '用 DeepSeek Harness 驱动一个长驻、可恢复的 Router 会话，把消息分派给合适的 Agent',
  permissions: ['fs:state', 'process:spawn', 'net:*'],
  configSchema: RouterDshConfigSchema,
  create: (config, ctx) => createRouterDsh(config, ctx),
});
