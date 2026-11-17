/**
 * 驱动 DeepSeek Harness：一个长驻的 dsh 子进程 + 一个长驻的 Router 会话。
 * - 会话日志由 DSH 持久化在 <state>/dsh（JSONL），会话 ID 存在插件 kv，重启后 resume 接着用；
 * - 子进程使用 sdk-minimal profile，并用补丁关掉 shell / 文件工具，只留下本插件的 MCP 工具；
 * - SDK 不支持取消单次运行：超时或取消时关闭子进程，下一批重新启动并 resume。
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DeepSeekHarness, type HarnessSession } from '@deepseek-ai/dsh-sdk-client';
import { ErrorCode, type Logger, LoopError, type Usage } from '@super-loop/plugin-sdk';
import type { RouterDshConfig } from './config.js';
import { systemPrompt } from './prompt.js';

export interface DriverRunResult {
  sessionId: string;
  usage: Usage;
}

/** 便于测试替换的最小接口。 */
export interface Driver {
  run(prompt: string, signal: AbortSignal): Promise<DriverRunResult>;
  close(): Promise<void>;
}

export interface DshDriverOptions {
  config: RouterDshConfig;
  /** 插件实例的状态目录（fs:state）。 */
  stateDir: string;
  apiKey: string;
  mcp: { url: string; token: string };
  logger: Logger;
  loadSessionId(): Promise<string | undefined>;
  saveSessionId(id: string): Promise<void>;
}

/** 透传给 dsh 子进程的环境变量（其余一律不带，避免泄露宿主的密钥）。 */
const PASS_ENV = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'SystemRoot',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'all_proxy',
];

const yaml = (value: string) => JSON.stringify(value); // JSON 字符串也是合法的 YAML 标量

/** 生成在 sdk-minimal 之上的 profile 补丁。 */
export function profilePatch(config: RouterDshConfig): string {
  const lines = [
    '# 由 @super-loop/router-dsh 生成，每次启动覆盖。',
    '# 关掉 shell 与文件工具：Router 只能调用 Super Loop 提供的 MCP 工具。',
    ...[
      'persistent-bash',
      'persistent-pwsh',
      'terminal-bash',
      'terminal-pwsh',
      'tool-fs',
      'tool-working-directory',
    ].flatMap((id) => [`- id: ${id}`, '  disabled: true']),
    '- id: system-prompt',
    '  config:',
    '    includeHarnessIdentity: false',
    '    includeRuntimeContext: false',
    `    personaPrefix: ${yaml(systemPrompt(config.instructions))}`,
    '- insert:',
  ];
  if (config.provider !== 'deepseek-official') {
    lines.push(
      '    - id: llm-pi-ai',
      "      name: '@deepseek-ai/dsh-llm-pi-ai'",
      '      config:',
      '        providers:',
      `          ${yaml(config.provider)}:`,
      `            apiKeyEnv: ${config.apiKeySecret}`,
    );
  }
  lines.push(
    '    - id: mcp-superloop',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: superloop',
    '        transport: streamable-http',
    '        url: !!js process.env.SUPER_LOOP_MCP_URL',
    '        headers:',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 这是写进 YAML 的 JS 表达式，由 dsh 求值
    "          Authorization: !!js '`Bearer ${process.env.SUPER_LOOP_MCP_TOKEN}`'",
    '        failOnStartupError: true',
    '',
  );
  return lines.join('\n');
}

function sumUsage(events: readonly unknown[]): Usage {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const e of events) {
    const ev = e as {
      type?: string;
      data?: { usage?: { inputTokens?: unknown; outputTokens?: unknown } };
    };
    if (ev.type !== 'assistant/message') continue;
    const u = ev.data?.usage;
    if (typeof u?.inputTokens === 'number') inputTokens += u.inputTokens;
    if (typeof u?.outputTokens === 'number') outputTokens += u.outputTokens;
  }
  return { inputTokens, outputTokens };
}

export class DshDriver implements Driver {
  readonly #o: DshDriverOptions;
  #harness: DeepSeekHarness | undefined;
  #session: HarnessSession | undefined;

  constructor(options: DshDriverOptions) {
    this.#o = options;
  }

  async #ensureSession(): Promise<HarnessSession> {
    if (this.#session) return this.#session;
    const { config, stateDir, apiKey, mcp, logger } = this.#o;
    const dshHome = join(stateDir, 'dsh');
    // DSH 按工作目录归档会话，保持固定才能 resume
    const work = join(stateDir, 'work');
    await mkdir(dshHome, { recursive: true, mode: 0o700 });
    await mkdir(work, { recursive: true, mode: 0o700 });
    const patch = join(stateDir, 'router.cordis.patch.yml');
    await writeFile(patch, profilePatch(config), { mode: 0o600 });
    await chmod(patch, 0o600);

    const env: NodeJS.ProcessEnv = {};
    for (const k of PASS_ENV) if (process.env[k] !== undefined) env[k] = process.env[k];
    env[config.apiKeySecret] = apiKey;
    env.SUPER_LOOP_MCP_URL = mcp.url;
    env.SUPER_LOOP_MCP_TOKEN = mcp.token;

    const harness = new DeepSeekHarness({
      profile: 'sdk-minimal',
      dshHome,
      patches: [patch],
      processCwd: work,
      cwd: work,
      env,
      provider: config.provider,
      model: config.model,
      initializeTimeoutMs: config.initializeTimeoutMs,
      ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort as never } : {}),
      ...(config.dshBin ? { dshBin: config.dshBin } : {}),
    });
    this.#harness = harness;
    try {
      await harness.start();
    } catch (error) {
      await this.#reset();
      throw new LoopError(
        ErrorCode.UNAVAILABLE,
        `dsh failed to start: ${(error as Error).message}`,
        {
          cause: error,
          retryable: true,
        },
      );
    }
    const saved = await this.#o.loadSessionId();
    if (saved) {
      try {
        this.#session = await harness.resumeSession(saved);
        logger.info('router session resumed', { sessionId: saved });
        return this.#session;
      } catch (error) {
        logger.warn('router session could not be resumed; starting a new one', {
          sessionId: saved,
          error: (error as Error).message,
        });
      }
    }
    this.#session = harness.session();
    return this.#session;
  }

  async run(prompt: string, signal: AbortSignal): Promise<DriverRunResult> {
    if (signal.aborted) throw signal.reason;
    const session = await this.#ensureSession();
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason ?? new LoopError(ErrorCode.CANCELLED, 'cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const result = await Promise.race([session.run(prompt), aborted]);
      await this.#o.saveSessionId(result.sessionId);
      return { sessionId: result.sessionId, usage: sumUsage(result.events) };
    } catch (error) {
      // 取消、超时或子进程异常：关掉子进程，下次重新启动并 resume 同一会话
      await this.#reset();
      if (error instanceof LoopError) throw error;
      throw new LoopError(ErrorCode.UNAVAILABLE, `dsh run failed: ${(error as Error).message}`, {
        cause: error,
        retryable: true,
      });
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  async #reset(): Promise<void> {
    const h = this.#harness;
    this.#harness = undefined;
    this.#session = undefined;
    if (!h) return;
    try {
      await h.close();
    } catch (error) {
      this.#o.logger.warn('dsh close failed', { error: (error as Error).message });
    }
  }

  close(): Promise<void> {
    return this.#reset();
  }
}
