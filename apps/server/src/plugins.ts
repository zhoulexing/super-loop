/**
 * 内置插件表：config.json 里 `use` 写包名时，先在这里查找。
 * 新增内置插件：在 package.json 加依赖，并在此登记。
 * 不在表里的说明符会尝试 `import(specifier)`（从本应用的依赖中解析）。
 */
import agentEcho from '@super-loop/agent-echo';
import type { PluginImporter } from '@super-loop/host';
import routerDsh from '@super-loop/router-dsh';
import sinkDashboard from '@super-loop/sink-dashboard';

export const BUILTIN_PLUGINS: Readonly<Record<string, unknown>> = {
  '@super-loop/agent-echo': agentEcho,
  '@super-loop/router-dsh': routerDsh,
  '@super-loop/sink-dashboard': sinkDashboard,
};

export const importPlugin: PluginImporter = async (specifier) =>
  BUILTIN_PLUGINS[specifier] ?? import(specifier);
