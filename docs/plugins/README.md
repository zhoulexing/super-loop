# 插件开发指南

以 [`agent-echo`](../../plugins/agent-echo/src/index.ts) 为模板。工程依赖边界见 [AGENTS.md](../../AGENTS.md#职责与依赖)，接口以 [plugin.ts](../../packages/protocol/src/plugin.ts) 为准。

## 新建插件包

```bash
cp -r plugins/agent-echo plugins/agent-foo
# 修改 package.json 的 name → @super-loop/agent-foo，description
# 修改 src/index.ts 的 name → 'agent-foo'
pnpm install
```

第三方依赖写 `"catalog:"` 或明确版本，构建约定见[开发指南](../development.md#包的构建约定)。

## 定义插件

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

示例中的执行、取消和产物契约见下文「Agent 插件」；文件能力见[文件与目录访问](../runtime.md#文件与目录访问)。

## 契约测试

```ts
import { runAgentContractTests } from '@super-loop/testkit';
import plugin from '../src/index.js';

runAgentContractTests({ plugin, config: { model: 'x' } });
```

Source、Sink 分别使用 `runSourceContractTests`、`runSinkContractTests`。

## 合并前

```bash
pnpm check
```

## 插件契约

### 统一插件清单

每个插件包必须默认导出 `definePlugin(...)` 的结果：

```ts
import { definePlugin } from '@super-loop/plugin-sdk';
import { z } from 'zod';

export default definePlugin({
  name: 'agent-claude-code',          // 与包名去掉 @super-loop/ 前缀一致
  version: '0.1.0',
  kind: 'agent',                      // 'source' | 'agent' | 'sink' | 'router' | 'probe' | 'playbook'
  apiVersion: 1,                      // 插件协议版本，内核据此判断兼容
  configSchema: z.object({ ... }),    // 实例配置，内核加载时校验
  permissions: ['fs:workspace', 'process:spawn', 'net:*'], // 声明所需权限
  create(config, ctx) { return { ... } }, // 返回对应 kind 的实现
});
```

同一插件可以有**多个实例**，实例名格式 `<plugin>:<instance>`，例如 `claude-code:repo-a`、`lark:ops-group`。

插件权限声明在加载时展示，实例只能获得所声明的目录与能力。运行隔离属于逐步落地的约束，当前能力边界见[调度与恢复约束](../architecture.md#调度与恢复约束)。

`ctx`（`PluginContext`）由内核注入，插件只能通过它与外界交互：`logger`、`kv`（插件私有命名空间）、`files`（文件读写，见 [文件与目录访问](../runtime.md#文件与目录访问)）、`paths`（只包含 permissions 中声明的目录）、`secrets`、`clock`、`signal`（AbortSignal）、`emit`（仅 Source）。**禁止插件直接访问 Store。**

### Source 插件

```ts
export interface SourcePlugin {
  start(ctx: SourceContext): Promise<void>; // 开始监听；通过 ctx.emit(envelopeDraft) 推入
  stop(): Promise<void>;
  health(): Promise<HealthStatus>;
  ack?(envelopeId: string, ref?: string): Promise<void>; // 支持确认的来源（如 MQ）
}
```

- `start()` 完成监听初始化后应返回，不能等待整个监听生命周期；持续监听由插件管理，`stop()` 负责收敛。
- `ctx.emit()` 的接收与去重语义见 [Inbox / Outbox](../architecture.md#inbox--outbox-与消息记录)。`ack()` 当前仅有接口声明，内核尚未调用，不应依赖自动 ACK。
- 产生 Envelope 时**必须**给出稳定的 `idempotencyKey`（例如来源事件 ID、`cron:<jobId>:<scheduledAt>`）。
- Webhook Source 必须校验签名；所有回调接口用时间戳与 nonce 防重放。
- `source-cron` 规范：任务定义 `{ id, cron, timezone, envelope: EnvelopeDraft, misfire: 'skip' | 'fire_once' }`；调度状态存在插件 kv 中，内核重启后按 `misfire` 处理错过的触发。
- **手动提交不是插件**：Kernel API `POST /api/v1/envelopes` 与 CLI `sloop submit` 都调用内核内置入口 `kernel.submit()`，来源固定为虚拟实例 `manual:api`，可直接带 `directives` 指定 Agent 与 Sink。
- Agent 通过 `ctx.spawn()` 派生的消息来源为 `spawn:<plugin>`，继承父消息的 `traceId`，`depth + 1`。

### Agent 插件

```ts
export interface AgentPlugin {
  capabilities: AgentCapabilities;
  run(input: AgentRunInput, ctx: AgentRunContext): AsyncIterable<AgentEvent>;
  cancel?(runId: string): Promise<void>; // 不实现则内核直接杀进程
  health(): Promise<HealthStatus>;
}

export interface AgentCapabilities {
  streaming: boolean;
  resumable: boolean; // 支持基于 sessionId 续跑
  toolApproval: boolean; // 能把工具调用审批交给内核
  workspace: 'none' | 'shared' | 'isolated'; // isolated: 每次 Run 一个独立目录/git worktree
  costReporting: boolean;
}

export interface AgentRunInput {
  runId: string;
  taskId: string;
  attempt: number; // 本轮内第几次尝试
  envelope: Envelope;
  turn: { id: string; index: number }; // 首轮 index 为 1
  prompt: string; // 本轮输入：首轮为渲染后的提示词，之后为人的追问
  history: Array<{ role: 'user' | 'assistant'; content: string }>; // 之前各轮（最多 limits.maxHistoryTurns 轮）
  options: unknown; // 已通过插件 schema 校验
  workspace?: { path: string }; // 同一任务的多轮共用 workspaces/<taskId>/work
  resume?: { sessionId: string }; // 同一任务上一次由该 Agent 实例产生的会话
}

export type AgentEvent =
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { type: 'message'; role: 'assistant' | 'tool'; content: string }
  | { type: 'tool_call'; name: string; input: unknown; callId: string }
  | { type: 'tool_result'; callId: string; ok: boolean; summary?: string }
  | { type: 'artifact'; ref: string; name: string; mime: string; size: number } // 显式登记产物
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: 'session'; sessionId: string } // 用于 resume
  | { type: 'heartbeat' }
  | {
      type: 'result';
      status: 'succeeded' | 'failed';
      summary: string;
      output?: unknown;
      error?: AgentError;
    };
```

规则：

- 事件流**必须**以且仅以一个 `result` 事件结束；没有 `result` 就结束视为失败。`result.summary` 作为本轮的回复显示在看板对话里。
- 支持续跑的 Agent 发出 `session` 事件并声明 `resumable: true`，后续轮次会收到 `resume.sessionId`；不支持的 Agent 应结合 `history` 理解上下文。
- 长时间无输出时每 ≤ 15s 发一次 `heartbeat`（plugin-sdk 提供自动心跳包装）。
- `error` 必须区分 `retryable: boolean`，内核据此决定是否重试（例如限流可重试、参数错误不可重试）。
- 子进程类 Agent（Claude Code、Codex CLI）必须：使用结构化输出模式（stream-json / JSON 事件）解析，禁止解析人类可读文本；必须响应 `ctx.signal` 终止整个进程组。
- 高危工具调用（写主分支、删除文件、外部发布、花钱）必须调用 `await ctx.awaitApproval({ action, title, detail, risk })` 交给内核审批，不得自行放行；审批只有这一个入口，不通过事件流。具体映射在各插件的 `permissionPolicy` 配置中声明。
- 长时间运行的 Agent 用 `plugin-sdk` 的 `withHeartbeat()` 包装事件流；结果用 `succeeded()` / `failed()` / `failedFrom()` 构造。
- Agent 想派生新任务时，调用 `ctx.spawn(envelopeDraft)`，内核自动带上 `trace.parentId`，并受**最大派生深度**（默认 3）限制，防止无限循环。

规划中的 Agent 接入要求（当前实现范围见[路线图](../roadmap.md)）：

| 插件                     | 接入方式                                       | 备注                                                               |
| ------------------------ | ---------------------------------------------- | ------------------------------------------------------------------ |
| `agent-claude-code`      | 子进程 `claude -p --output-format stream-json` | 支持 resume、isolated worktree                                     |
| `agent-claude-agent-sdk` | 进程内调用 Claude Agent SDK                    | 工具审批钩子映射到 `approval_request`                              |
| `agent-codex`            | 子进程 `codex exec --json`                     |                                                                    |
| `agent-codex-sdk`        | Codex SDK / harness                            |                                                                    |
| `agent-deepseek`         | DeepSeek API / harness                         |                                                                    |
| `agent-http`             | 通用 HTTP/SSE 协议                             | 自定义 Agent 的首选接入方式，协议待设计，见[路线图](../roadmap.md) |

自定义 Agent 当前可实现 `kind: 'agent'` 插件；通过 `agent-http` 接入任意语言服务是规划方案，协议尚待实现。

### Sink 插件

```ts
export interface SinkPlugin {
  deliver(n: Notification, ctx: SinkContext): Promise<DeliveryResult>;
  health(): Promise<HealthStatus>;
}

export interface Notification {
  deliveryId: string; // 幂等键
  trigger: 'started' | 'succeeded' | 'failed' | 'approval_required' | 'incident';
  title: string;
  body: string; // 已渲染的 Markdown
  links: { dashboard: string; approve?: string; reject?: string };
  subject: { kind: 'task' | 'run' | 'approval' | 'incident'; id: string };
  data: unknown;
}
```

- 投递失败由内核按 Outbox 策略重试，Sink 只需返回 `{ ok: false, retryable }`。
- `sink-dashboard` 默认对所有 Task 生效，保证**任何结果至少在看板可见**。
- 支持交互的 Sink（如飞书卡片按钮）把审批回调转发到 `POST /api/v1/approvals/:id/decision`，必须带签名校验。

### Router 插件

规则（Route）处理确定的情况，Router 处理"需要理解内容才能决定派给谁"的情况。设计见 [ADR 0003](../adr/0003-router-plugin.md)。

```ts
export interface RouterPlugin {
  route(request: RouterRequest, ctx: RouterContext): Promise<RouterResult>;
  health(): Promise<HealthStatus>;
}

export interface RouterRequest {
  batchId: string; // rtb_…，同一批的重试会换新 ID
  items: Array<{ taskId: string; envelope: Envelope; candidates?: AgentBinding[] }>;
  agents: RouterAgentInfo[]; // 当前就绪的 Agent：instance、plugin、description（来自 plugins.<instance>.description）、capabilities
}

export interface RouterResult {
  decisions: RouteDecision[]; // 每个 item 一条；缺少的视为失败，稍后重试
  usage?: Usage;
}

export interface RouteDecision {
  taskId: string;
  action: 'assign' | 'triage'; // triage：留给人处理
  agent?: string; // assign 时必填
  suggestions?: string[]; // triage 时建议的 Agent，Route 没给候选时作为候选显示
  priority?: 0 | 1 | 2 | 3;
  reason: string; // 给人看的理由
  confidence?: number; // 0 ~ 1
}

// ctx 额外提供只读查询：ctx.query.searchTasks({ text, limit }) / ctx.query.getTask(id)
```

规则：

- **决策不改状态**。Router 只返回决策，状态迁移由内核执行：合法的 `assign`（Agent 已就绪、在候选内）直接分配并排队，否则降级为 `triage` 并写明原因；Task 在决策前一直是 `unassigned`，看板显示"分配中"。
- **按批处理**：内核按 Router 实例把待路由的 Task 分批（`limits.routing.batchSize`，默认 10），同一实例同时只处理一批，期间到达的消息进入下一批。
- **重试与兜底**：每批有超时（`limits.routing.timeoutMs`，默认 120s）；出错或缺少决策按 `limits.routing.backoff` 退避重试，最多 `limits.routing.maxAttempts` 次（默认 3），之后 `routing.status = failed`，任务留在"未分配"等人处理，**不会丢消息**。
- **人优先**：Router 决策前人已手动分配时，本次路由作废（`routing.status = skipped`），Router 的结果被忽略。
- **崩溃恢复**：重启时把停在 `running` 的路由重新排队（记 `routing.failed`，错误码 `KERNEL_RESTARTED`）。
- Router 收到的 Envelope 是外部数据：渲染进提示词时必须标注为不可信输入（[安全与权限](../../AGENTS.md#安全与权限)）。
- Router 自己的会话 / 记忆属于插件内部状态，放在 `state/<plugin>/<instance>/`；决策本身以 `routing.decided` 事件进入 Journal（`actor` 为 `plugin:<router 实例>`）。

`router-dsh`（内置）：

- 通过 `@deepseek-ai/dsh-sdk-client` 启动一个 `dsh --profile sdk-minimal` 子进程，用生成的补丁（`state/…/router.cordis.patch.yml`）关掉 shell 与文件工具，只挂载插件在 127.0.0.1 上提供的 MCP 工具（`route_decide`、`search_tasks`、`get_task`，随机 Bearer token）。
- 一个实例一个长驻会话：DSH 把会话日志存在 `state/router-dsh/<instance>/dsh/`，会话 ID 存在插件 kv，重启后 `resumeSession` 继续同一个会话。SDK 不支持取消单次运行，超时 / 取消时关闭子进程，下一批重新启动并恢复会话。
- 配置：`provider`（默认 `openai`，`deepseek-official` 走 DSH 内置 DeepSeek 适配器，其它走 pi-ai 厂商目录）、`model`（默认 `gpt-5.4-mini`）、`apiKeySecret`（默认 `OPENAI_API_KEY`，按 [密钥](../runtime.md#密钥) 解析）、`reasoningEffort`、`instructions`（团队补充的分配规则）、`maxPayloadChars`、`maxReminders`、`dshBin`。
- 子进程只拿到 PATH / HOME / 语言 / 代理等白名单环境变量和所需的 API Key。
- `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-sdk-client` 必须锁定同一个精确版本（客户端会校验）；升级当作单独的变更处理并跑 `E2E=1` 测试。
