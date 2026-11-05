import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PluginDefinition, PluginKind, SecretResolver } from '@super-loop/protocol';
import { ErrorCode, interpolateRefs, LoopError } from '@super-loop/shared';
import { z } from 'zod';
import { ensureLayout, type HomeLayout } from './paths.js';
import { createSecretResolver, loadSecrets } from './secrets.js';

/**
 * `~/.super-loop/config.json` 的结构。
 * - `server`：宿主进程自己的配置；
 * - 其余字段原样交给内核（`plugins[].use` 由字符串解析为插件定义），由内核做完整校验。
 */
export const HostConfigFileSchema = z
  .object({
    $schema: z.string().optional(),
    server: z
      .object({
        host: z.string().min(1).default('127.0.0.1'),
        port: z.number().int().min(1).max(65_535).default(7300),
        /** 通知里的链接前缀，默认 http://<host>:<port>。 */
        publicUrl: z.string().url().optional(),
        /** API Token，建议写成 "${secret:API_TOKEN}"。 */
        token: z.string().min(1).optional(),
      })
      .strict()
      .prefault({}),
    plugins: z
      .record(
        z.string(),
        z
          .object({
            /** npm 包名（如 "@super-loop/agent-echo"）或 "file:./plugins/my-agent/index.js"（相对主目录）。 */
            use: z.string().min(1),
            config: z.unknown().optional(),
            enabled: z.boolean().optional(),
          })
          .strict(),
      )
      .default({}),
    routes: z.array(z.unknown()).default([]),
    defaults: z.unknown().optional(),
    limits: z.unknown().optional(),
  })
  .strict();
export type HostConfigFile = z.input<typeof HostConfigFileSchema>;

export interface ServerSettings {
  host: string;
  port: number;
  publicUrl: string;
  token: string | undefined;
}

/** 交给 Kernel 的配置（结构与 KernelConfigInput 一致，此处不依赖 kernel 包）。 */
export interface KernelConfigPayload {
  publicUrl: string;
  plugins: Record<
    string,
    { use: PluginDefinition<PluginKind, unknown>; config?: unknown; enabled?: boolean }
  >;
  routes: unknown[];
  defaults?: unknown;
  limits?: unknown;
}

export interface LoadedConfig {
  layout: HomeLayout;
  server: ServerSettings;
  kernel: KernelConfigPayload;
  secrets: SecretResolver;
  /** 首次启动时自动生成了 config.json。 */
  created: boolean;
  warnings: string[];
}

export type PluginImporter = (specifier: string) => Promise<unknown>;

export interface LoadConfigOptions {
  layout: HomeLayout;
  env?: NodeJS.ProcessEnv;
  /** config.json 不存在时写入的默认配置。 */
  defaultConfig: HostConfigFile;
  /**
   * 解析非 file: 的插件说明符。由宿主应用提供，使解析发生在宿主自己的依赖范围内
   * （通常先查内置插件表，再 `import(specifier)`）。
   */
  importPlugin: PluginImporter;
}

function configError(message: string, cause?: unknown): LoopError {
  return new LoopError(ErrorCode.INVALID_CONFIG, message, { retryable: false, cause });
}

function isPluginDefinition(v: unknown): v is PluginDefinition<PluginKind, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { create?: unknown }).create === 'function' &&
    typeof (v as { kind?: unknown }).kind === 'string'
  );
}

async function resolvePlugin(
  instance: string,
  specifier: string,
  layout: HomeLayout,
  importPlugin: PluginImporter,
): Promise<PluginDefinition<PluginKind, unknown>> {
  let mod: unknown;
  try {
    if (specifier.startsWith('file:')) {
      const path = specifier.slice('file:'.length);
      mod = await import(pathToFileURL(isAbsolute(path) ? path : resolve(layout.home, path)).href);
    } else {
      mod = await importPlugin(specifier);
    }
  } catch (error) {
    throw configError(
      `plugins.${instance}.use: cannot load "${specifier}": ${(error as Error).message}`,
      error,
    );
  }
  const def = (mod as { default?: unknown } | undefined)?.default ?? mod;
  if (!isPluginDefinition(def)) {
    throw configError(
      `plugins.${instance}.use: "${specifier}" does not export a plugin definition`,
    );
  }
  return def;
}

/**
 * 加载主目录配置。优先级：环境变量 > config.json > 内置默认值。
 * 1. 创建目录布局；config.json 不存在则写入默认配置；
 * 2. 读取 secrets.env，替换 `${secret:NAME}` / `${env:NAME}`；
 * 3. 校验结构、应用环境变量覆盖、解析插件。
 */
export async function loadConfig(options: LoadConfigOptions): Promise<LoadedConfig> {
  const { layout, importPlugin } = options;
  const env = options.env ?? process.env;
  await ensureLayout(layout);

  let created = false;
  let text: string;
  try {
    text = await readFile(layout.configFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    text = `${JSON.stringify(options.defaultConfig, null, 2)}\n`;
    await writeFile(layout.configFile, text, { mode: 0o600, flag: 'wx' });
    created = true;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw configError(`${layout.configFile}: invalid JSON: ${(error as Error).message}`, error);
  }

  const secrets = await loadSecrets(layout.secretsFile);
  let interpolated: unknown;
  try {
    interpolated = interpolateRefs(raw, (kind, name) =>
      kind === 'secret' ? (secrets.values[name] ?? env[name]) : env[name],
    );
  } catch (error) {
    throw configError(`${layout.configFile}: ${(error as Error).message}`, error);
  }

  const parsed = HostConfigFileSchema.safeParse(interpolated);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '$'}: ${i.message}`);
    throw configError(`${layout.configFile}:\n  ${issues.join('\n  ')}`);
  }
  const file = parsed.data;

  const port = env.SUPER_LOOP_PORT ? Number(env.SUPER_LOOP_PORT) : file.server.port;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw configError(`SUPER_LOOP_PORT must be a valid port, got "${env.SUPER_LOOP_PORT}"`);
  }
  const host = env.SUPER_LOOP_HOST ?? file.server.host;
  const linkHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  const server: ServerSettings = {
    host,
    port,
    publicUrl: env.SUPER_LOOP_PUBLIC_URL ?? file.server.publicUrl ?? `http://${linkHost}:${port}`,
    token: env.SUPER_LOOP_API_TOKEN ?? file.server.token,
  };

  const plugins: KernelConfigPayload['plugins'] = {};
  for (const [instance, spec] of Object.entries(file.plugins)) {
    plugins[instance] = {
      use: await resolvePlugin(instance, spec.use, layout, importPlugin),
      ...(spec.config === undefined ? {} : { config: spec.config }),
      ...(spec.enabled === undefined ? {} : { enabled: spec.enabled }),
    };
  }

  return {
    layout,
    server,
    kernel: {
      publicUrl: server.publicUrl,
      plugins,
      routes: file.routes,
      ...(file.defaults === undefined ? {} : { defaults: file.defaults }),
      ...(file.limits === undefined ? {} : { limits: file.limits }),
    },
    secrets: createSecretResolver(secrets.values, env),
    created,
    warnings: secrets.warnings,
  };
}
