/**
 * agent-echo：参考 Agent 插件。
 * 把渲染后的 prompt 原样回显，用于联调内核与作为新插件的模板。
 */
import {
  type AgentEvent,
  defineAgentPlugin,
  ErrorCode,
  failed,
  healthy,
  LoopError,
  sleep,
  succeeded,
  withHeartbeat,
} from '@super-loop/plugin-sdk';
import { z } from 'zod';

const ConfigSchema = z.object({
  /** 回显前等待的毫秒数，用于模拟长任务。 */
  delayMs: z.number().int().nonnegative().default(0),
  /** 心跳间隔。 */
  heartbeatMs: z.number().int().positive().default(15_000),
});

const OptionsSchema = z.object({
  /** 为 true 时模拟一次可重试失败。 */
  fail: z.boolean().optional(),
});

export default defineAgentPlugin({
  name: 'agent-echo',
  version: '0.1.0',
  description: 'Echo the rendered prompt back. For testing and as a plugin template.',
  permissions: [],
  configSchema: ConfigSchema,
  create(config, ctx) {
    return {
      capabilities: {
        streaming: true,
        resumable: false,
        toolApproval: false,
        workspace: 'none',
        costReporting: false,
      },
      optionsSchema: OptionsSchema,

      run(input, runCtx) {
        async function* events(): AsyncGenerator<AgentEvent> {
          yield {
            type: 'log',
            level: 'info',
            message: `echo run ${input.runId} attempt ${input.attempt}`,
          };
          try {
            if (config.delayMs > 0) await sleep(config.delayMs, runCtx.signal);
          } catch {
            yield failed({ code: ErrorCode.CANCELLED, message: 'run cancelled', retryable: false });
            return;
          }
          const options = OptionsSchema.parse(input.options);
          if (options.fail) {
            yield failed(new LoopError(ErrorCode.UNAVAILABLE, 'simulated failure').toPayload());
            return;
          }
          yield { type: 'message', role: 'assistant', content: input.prompt };
          // 演示产物：写入 workspaces/<taskId>/artifacts/<runId>/echo.txt，并显式登记
          const file = await runCtx.files.put(input.prompt, {
            name: 'echo.txt',
            mime: 'text/plain',
          });
          yield { type: 'artifact', ...file };
          yield {
            type: 'usage',
            inputTokens: input.prompt.length,
            outputTokens: input.prompt.length,
          };
          yield succeeded(`echoed ${input.prompt.length} chars`, { echo: input.prompt });
        }
        return withHeartbeat(events(), { intervalMs: config.heartbeatMs });
      },

      async health() {
        return healthy(ctx.clock.iso());
      },
    };
  },
});
