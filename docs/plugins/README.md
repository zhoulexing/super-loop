# 插件开发指南

以 `plugins/agent-echo` 为模板。

## 1. 新建插件包

```bash
cp -r plugins/agent-echo plugins/agent-foo
# 修改 package.json 的 name → @super-loop/agent-foo，description
# 修改 src/index.ts 的 name → 'agent-foo'
pnpm install
```

插件包只能依赖 `@super-loop/protocol`、`@super-loop/shared`、`@super-loop/plugin-sdk`（测试可额外依赖 `@super-loop/testkit`），第三方依赖写 `"catalog:"` 或明确版本。

## 2. 定义插件

```ts
import { defineAgentPlugin, succeeded, withHeartbeat } from '@super-loop/plugin-sdk';
import { z } from 'zod';

export default defineAgentPlugin({
  name: 'agent-foo',
  version: '0.1.0',
  permissions: ['process:spawn', 'fs:state', 'fs:cache'],
  configSchema: z.object({ model: z.string() }),
  create(config, ctx) {
    return {
      capabilities: {
        streaming: true,
        resumable: true,
        toolApproval: true,
        workspace: 'isolated',
        costReporting: true,
      },
      run(input, runCtx) {
        async function* events() {
          // 高危操作先审批
          const { granted } = await runCtx.awaitApproval({
            action: 'git.push',
            title: '推送到 main',
            detail: {},
            risk: 'high',
          });
          // ...
          yield succeeded('done');
        }
        return withHeartbeat(events());
      },
      health: async () => ({ status: 'healthy', checkedAt: ctx.clock.iso() }),
    };
  },
});
```

要点：

- 事件流必须以唯一的 `result` 结束；异常用 `failedFrom(err)` 转换，不要抛出到内核。
- 响应 `runCtx.signal`，取消时尽快结束；子进程要杀整个进程组。
- 时间用 `ctx.clock`，日志用 `ctx.logger`，小状态用 `ctx.kv`，文件用 `ctx.files`，密钥用 `ctx.secrets`。
- 工作目录用 `ctx.paths.work`；交付结果写到 `ctx.paths.artifacts`（或 `ctx.files.put`），Run 结束时自动登记。需要共享资料、持久状态、缓存时，先在 `permissions` 声明 `fs:shared:read` / `fs:state` / `fs:cache`（见 AGENTS.md §11.3）。

## 3. 契约测试

```ts
import { runAgentContractTests } from '@super-loop/testkit';
import plugin from '../src/index.js';

runAgentContractTests({ plugin, config: { model: 'x' } });
```

Source、Sink 分别使用 `runSourceContractTests`、`runSinkContractTests`。

## 4. 合并前

```bash
pnpm check
```
