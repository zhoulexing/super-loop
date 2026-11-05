import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { acquireLock, createFsContent, loadConfig, resolveLayout } from '@super-loop/host';
import { Kernel, type KernelConfigInput } from '@super-loop/kernel';
import { createLogger } from '@super-loop/shared';
import { SqliteStore } from '@super-loop/store-sqlite';
import { createApp } from './app.js';
import { DEFAULT_CONFIG } from './default-config.js';
import { importPlugin } from './plugins.js';

const env = process.env;
const layout = resolveLayout(env);
const logger = createLogger({ name: 'super-loop', file: join(layout.logsDir, 'server.log') });

async function main() {
  const loaded = await loadConfig({ layout, env, defaultConfig: DEFAULT_CONFIG, importPlugin });
  if (loaded.created) logger.info('created default config', { file: layout.configFile });
  for (const w of loaded.warnings) logger.warn(w);

  const releaseLock = await acquireLock(layout.lockFile);
  const store = new SqliteStore({ path: layout.dbFile });
  // 附件写 attachments/，产物与工作区写 workspaces/<runId>/{work,artifacts}/
  const fsContent = createFsContent(layout);
  const kernel = new Kernel({
    store,
    config: loaded.kernel as KernelConfigInput,
    logger,
    content: fsContent,
    dirs: fsContent,
    secrets: loaded.secrets,
  });

  try {
    await kernel.start();
  } catch (error) {
    await store.close();
    await releaseLock();
    throw error;
  }

  const { host, port, token } = loaded.server;
  const server = serve(
    { fetch: createApp({ kernel, token }).fetch, port, hostname: host },
    (info) =>
      logger.info('api listening', {
        url: `http://${host}:${info.port}/api/v1`,
        home: layout.home,
        db: layout.dbFile,
      }),
  );

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info('shutting down', { signal });
    server.close();
    await kernel.stop();
    await store.close();
    await releaseLock();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error) => {
  logger.error('server failed to start', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
