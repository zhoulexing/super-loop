import type { HostConfigFile } from '@super-loop/host';

/**
 * 首次启动时写入 ~/.super-loop/config.json 的默认配置。
 * 之后以用户目录下的文件为准，这里的修改不会覆盖已有文件。
 */
export const DEFAULT_CONFIG = {
  server: { host: '127.0.0.1', port: 7300 },
  plugins: {
    'echo:default': { use: '@super-loop/agent-echo', config: { delayMs: 1_000 } },
    'dashboard:default': { use: '@super-loop/sink-dashboard' },
  },
  routes: [{ name: 'default-echo', agents: [{ agent: 'echo:default' }] }],
  defaults: {
    // 任何结果至少在看板可见（AGENTS.md §7.4）
    sinks: [
      { sink: 'dashboard:default', on: ['started', 'succeeded', 'failed', 'approval_required'] },
    ],
  },
} satisfies HostConfigFile;
