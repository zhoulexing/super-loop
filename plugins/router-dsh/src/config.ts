import { z } from 'zod';

export const RouterDshConfigSchema = z.object({
  /**
   * 模型路由（DeepSeek Harness 的 provider）。`deepseek-official` 走 DSH 内置的 DeepSeek 适配器，
   * 其它值（openai、anthropic、deepseek、openrouter…）走 pi-ai 的厂商目录。
   */
  provider: z.string().min(1).default('openai'),
  model: z.string().min(1).default('gpt-5.4-mini'),
  /** 推理强度，取值由所选模型决定（如 low / medium / high）；不填用模型默认值。 */
  reasoningEffort: z.string().min(1).optional(),
  /** API Key 的密钥名：先查 secrets.env，再查环境变量；也作为 dsh 子进程里的环境变量名。 */
  apiKeySecret: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .default('OPENAI_API_KEY'),
  /** 追加给 Router 的分配规则（团队约定、Agent 分工等）。 */
  instructions: z.string().max(8_000).optional(),
  /** 每条消息的 payload 最多带多少字符给模型。 */
  maxPayloadChars: z.number().int().positive().max(50_000).default(4_000),
  /** 一批没有给全决策时，最多再提醒几次。 */
  maxReminders: z.number().int().nonnegative().max(3).default(1),
  /** dsh 子进程完成握手的超时。 */
  initializeTimeoutMs: z.number().int().positive().default(60_000),
  /** 指定 dsh 可执行文件（JS 入口）；不填用随插件安装的 @deepseek-ai/dsh。 */
  dshBin: z.string().min(1).optional(),
});

export type RouterDshConfig = z.output<typeof RouterDshConfigSchema>;
