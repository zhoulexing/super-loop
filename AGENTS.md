# AGENTS.md — Super Loop 架构与开发规范

> 本文件是本仓库的**最高规范**。任何人（包括 AI Agent）在改动代码前必须先读完本文件。
> 规范与代码冲突时，以本文件为准；需要改规范，先改本文件并在 PR 中说明理由。
> `CLAUDE.md` 是指向本文件的软链接，只编辑 `AGENTS.md`。

---

## 1. 项目定位

Super Loop 是一个**常驻运行的 Agent 调度循环**：

- 从多种**消息来源**（主动任务、外部事件、定时任务）接收消息；
- 由一个**稳定的 Loop 内核**统一记录、路由、调度、重试；
- 把消息交给可插拔的 **Agent 插件**处理（Claude Code、Codex、Claude Agent SDK、DeepSeek harness、自定义…）；
- 把处理结果送到**输出/通知通道**（看板、飞书、Webhook、邮件…）；
- 提供一个**看板**看全局；
- 由 **Watchdog** 监控运行状况，发现异常后生成修复方案，**经人审批后**执行自修复。

设计第一原则：**内核小而稳，其它一切皆插件。**

---

## 2. 总体架构

```
                ┌──────────────────────── Sources（插件）────────────────────────┐
                │  manual(API/CLI)   webhook   cron   lark-event   github  ...   │
                └───────────────┬────────────────────────────────────────────────┘
                                │ Envelope
                                ▼
┌──────────────────────────── Loop Kernel（唯一非插件）─────────────────────────────┐
│                                                                                    │
│   Ingest ──► Journal(追加写) ──► Router(Route 规则) ──► Queue ──► Dispatcher         │
│     │            ▲                                                   │             │
│     │ 去重/幂等   │ 所有状态变化都写成事件                               │ lease/超时   │
│     │            │                                                   ▼             │
│     │        Projections(物化视图) ◄──────── Run 事件流 ◄──── AgentHost(隔离执行)   │
│     │            │                                                   │             │
│     │            ▼                                                   ▼             │
│     │      Kernel API (HTTP + SSE)                   Outbox ──► SinkHost           │
│     │                                                                              │
│   Approval Center（Agent 工具审批 + Watchdog 修复审批 共用）                         │
└──────┬───────────────────────────────┬─────────────────────────────┬──────────────┘
       │                               │                             │
       ▼                               ▼                             ▼
  Agents（插件）                  Sinks（插件）                   Watchdog（独立进程）
  claude-code / codex /           dashboard / lark /            Probe → Detector →
  claude-agent-sdk / deepseek /   webhook / email / ...         Incident → Playbook →
  codex-sdk / http-custom                                       Approval → Remediate → Verify
                                       ▲
                                       │
                              Dashboard（Web 看板，读 Kernel API）
```

### 2.1 核心数据流

1. Source 产生 `Envelope`，调用 `kernel.ingest()`。
2. 内核按 `idempotencyKey` 去重，写入 Journal（`envelope.received`）。
3. Router 依据 Envelope 自带的 `directives` 或匹配到的 `Route`，生成一个或多个 `Task`（`task.created`）。
4. Dispatcher 取出 Task，按并发/优先级/配额分配给 AgentHost，创建 `Run`（`run.started`），获得**租约（lease）**。
5. Agent 插件以**事件流**形式回报进度（`run.event`）；需要人工审批的动作走 Approval Center。
6. Run 结束（`run.succeeded | run.failed | run.cancelled | run.timed_out`），按 Task 的重试策略决定重试或进入死信。
7. 结果写入 Outbox，SinkHost 投递到各通知通道（`delivery.*`），投递失败独立重试，不影响 Run 结果。
8. Projections 根据 Journal 维护物化视图，供看板与 API 查询。

---

## 3. 核心概念（统一术语，代码命名必须一致）

| 术语          | 含义                                                                                 |
| ------------- | ------------------------------------------------------------------------------------ |
| `Envelope`    | 一条进入 Loop 的消息，来源可以是任务、事件或定时触发。不可变。                       |
| `Source`      | 消息来源插件，负责产生 Envelope。                                                    |
| `Directives`  | Envelope 上的显式指令：指定 Agent、Sink、优先级等，**优先级高于 Route**。            |
| `Route`       | 路由规则：`match`（条件）→ `agent` + `sinks` + `policy`。可持久化、可在看板上编辑。  |
| `Task`        | 一个 Envelope 被路由到一个 Agent 后形成的待办单元。一个 Envelope 可以扇出多个 Task。 |
| `Run`         | Task 的一次执行尝试。重试会产生新的 Run。                                            |
| `Agent`       | 执行 Task 的插件（Claude Code、Codex 等）。                                          |
| `Sink`        | 输出/通知插件。                                                                      |
| `Delivery`    | 一次向 Sink 的投递记录。                                                             |
| `Journal`     | 追加写的事件日志，**唯一事实来源**。                                                 |
| `Projection`  | 由 Journal 推导出的查询视图（列表、统计、看板）。                                    |
| `Approval`    | 一个需要人做决定的请求（Agent 高危工具调用、Watchdog 修复方案等）。                  |
| `Incident`    | Watchdog 检测到的一次异常。                                                          |
| `Remediation` | 针对 Incident 的修复方案，含风险等级、动作列表、回滚方式。                           |

---

## 4. Monorepo 组织

### 4.1 技术栈（统一，不得私自替换）

- 语言：TypeScript 5.x，`strict: true`，ESM only
- 运行时：Node.js ≥ 22 LTS
- 包管理：pnpm workspaces；任务编排：Turborepo
- Schema / 运行时校验：zod（所有跨边界数据必须有 zod schema）
- 测试：vitest；格式化与 lint：Biome
- 存储：默认 SQLite（Node 内置 `node:sqlite`，零原生依赖），通过 `Store` 接口可替换为 Postgres
- HTTP：Hono；实时推送：SSE
- 看板：React + Vite + TanStack Query
- 版本管理：changesets
- 包作用域：`@super-loop/*`

### 4.2 目录结构

```
super-loop/
├── AGENTS.md                     # 本规范
├── CLAUDE.md -> AGENTS.md        # 软链接
├── pnpm-workspace.yaml           # 工作区 + catalog（统一第三方依赖版本）
├── vitest.config.ts              # 根级测试配置，直接跑各包 src
├── turbo.json
├── tsconfig.base.json
├── biome.json
│
├── packages/                     # 基础库
│   ├── protocol/                 # @super-loop/protocol  所有类型 + zod schema + 事件定义（零依赖）
│   ├── kernel/                   # @super-loop/kernel    Loop 内核（唯一非插件核心）
│   ├── host/                     # @super-loop/host      主目录布局、配置加载、密钥、单实例锁（server/cli/watchdog 共用）
│   ├── plugin-sdk/               # @super-loop/plugin-sdk definePlugin/defineAgent/... 与测试工具
│   ├── store-sqlite/             # @super-loop/store-sqlite 默认存储实现
│   ├── testkit/                  # @super-loop/testkit   内存 Store、假时钟、契约测试套件
│   └── shared/                   # @super-loop/shared    日志、ID、错误、重试等通用工具
│
├── plugins/
│   ├── agent-echo/               # 参考插件：回显 prompt，用于联调，也是新插件的模板
│   ├── source-webhook/           # 通用 HTTP Webhook
│   ├── source-cron/              # 定时任务
│   ├── source-lark-event/        # 飞书事件
│   ├── agent-claude-code/        # Claude Code CLI（headless, stream-json）
│   ├── agent-claude-agent-sdk/   # Claude Agent SDK
│   ├── agent-codex/              # Codex CLI（exec 模式）
│   ├── agent-codex-sdk/          # Codex SDK / harness
│   ├── agent-deepseek/           # DeepSeek harness
│   ├── agent-http/               # 通用：把任务转发给任意 HTTP Agent（自定义 Agent 的最简接入方式）
│   ├── sink-dashboard/           # 写入看板收件箱（默认启用） ✅
│   ├── sink-lark/                # 飞书消息/卡片
│   ├── sink-webhook/
│   ├── sink-email/
│   └── watchdog-playbooks-core/  # Watchdog 内置探针与修复剧本
│
├── apps/
│   ├── server/                   # 宿主进程：装配 kernel + 插件 + HTTP API ✅（内置插件表 src/plugins.ts）
│   ├── dashboard/                # Web 看板
│   ├── watchdog/                 # 独立的 Watchdog 进程
│   └── cli/                      # `sloop` 命令行
│
├── scripts/
│   └── check-deps.ts             # 依赖方向校验（pnpm check:deps）
│
└── docs/
    ├── adr/                      # 架构决策记录，编号 0001-xxx.md
    └── plugins/                  # 插件开发指南
```

### 4.3 依赖方向（强制，CI 校验）

```
protocol ◄── shared ◄── plugin-sdk ◄── plugins/*
    ▲           ▲
    └── kernel ─┘        apps/* 可依赖任何 packages 和 plugins
```

- `protocol` **零运行时依赖**（zod 除外），只放类型、schema、常量与纯函数。
- `kernel` 只依赖 `protocol`、`shared`，**禁止依赖任何插件或具体存储实现**（`Store` 接口定义在 `protocol`）。
- `store-*`、`host` 只依赖 `protocol`、`shared`（`host` 不依赖 kernel，watchdog 也能用）。
- `testkit` 可依赖 `protocol`、`shared`、`plugin-sdk`；任何包都可以把它作为 devDependency。
- `plugins/*` 只能依赖 `protocol`、`shared`、`plugin-sdk`，**插件之间禁止互相依赖**。
- 只有 `apps/*` 能装配插件。`apps/watchdog` 通过 Kernel API（HTTP）与内核通信，**禁止依赖 kernel**，以保证内核挂掉时 Watchdog 依然存活。

### 4.4 包的构建约定

- 每个包的 `exports` 带自定义条件 `"@super-loop/source": "./src/index.ts"`：typecheck 与 vitest 通过该条件直接读源码，**开发与测试无需先 build**。
- `tsconfig.build.json` 关闭该条件，按 `types → dist` 解析，由 turbo 按拓扑顺序 build。
- 第三方依赖版本统一在 `pnpm-workspace.yaml` 的 `catalog` 中维护，包内写 `"catalog:"`。
- 新增包时同时补 `scripts/check-deps.ts` 中的规则，否则检查直接失败。

---

## 5. 协议定义（`@super-loop/protocol`）

以下为规范性的类型轮廓，具体以 zod schema 为准。所有 ID 使用 ULID 并带前缀（`env_`、`task_`、`run_`、`rt_`、`apv_`、`inc_`、`dlv_`）。

### 5.1 Envelope

```ts
export interface Envelope {
  id: EnvelopeId; // env_01H...
  kind: 'task' | 'event' | 'schedule';
  source: { plugin: string; instance: string; ref?: string }; // ref: 原始事件ID等
  idempotencyKey: string; // 同 key 只入队一次
  receivedAt: string; // ISO8601
  subject: string; // 一句话标题，看板显示用
  payload: unknown; // 原始数据，必须可 JSON 序列化
  attachments?: AttachmentRef[]; // 大对象存外部，仅存引用
  labels?: Record<string, string>;
  directives?: Directives; // 显式指定，优先于 Route
  trace: { traceId: TraceId; parentId?: EnvelopeId; depth: number }; // 派生任务由内核填 parentId 与 depth
}

// Source / API 提交的是草稿：不含 id、receivedAt、source、trace，由内核补全。
export type EnvelopeDraft = Omit<Envelope, 'id' | 'receivedAt' | 'source' | 'trace'> & {
  ref?: string;
};

export interface Directives {
  agents?: AgentBinding[]; // 指定处理的 Agent（可多个 → 扇出）
  sinks?: SinkBinding[]; // 指定通知通道
  priority?: 0 | 1 | 2 | 3; // 0 最高
  deadline?: string;
  skipRoutes?: boolean; // true 则不再匹配 Route
}

export interface AgentBinding {
  agent: string; // 插件实例名，如 "claude-code:default"
  prompt?: string; // 模板，可用 {{envelope.subject}} 等变量
  options?: Record<string, unknown>; // 交给 Agent 插件校验
}

export interface SinkBinding {
  sink: string; // 如 "lark:ops-group"
  on: Array<'started' | 'succeeded' | 'failed' | 'approval_required'>;
  template?: string;
}
```

### 5.2 Route

```ts
export interface Route {
  id: RouteId;
  name: string;
  enabled: boolean;
  order: number; // 越小越先匹配
  match: RouteMatch; // 声明式条件，禁止写任意 JS
  agents: AgentBinding[];
  sinks: SinkBinding[];
  policy: TaskPolicy;
  stopOnMatch: boolean; // false 则继续匹配后续 Route（扇出）
}

export interface RouteMatch {
  kind?: Envelope['kind'][];
  source?: string[]; // 支持 glob："lark-event:*"
  labels?: Record<string, string>;
  subjectRegex?: string;
  jsonPath?: Array<{ path: string; op: 'eq' | 'in' | 'exists' | 'regex'; value?: unknown }>;
}

export interface TaskPolicy {
  timeoutMs: number; // 单次 Run 超时
  maxAttempts: number; // 含首次
  backoff: { type: 'fixed' | 'exponential'; baseMs: number; maxMs: number };
  concurrencyKey?: string; // 同 key 串行，例如同一个仓库
  requireApproval?: boolean; // 执行前需人工审批
  budget?: { maxCostUsd?: number; maxTokens?: number };
}
```

### 5.3 状态机

**Task**（定义见 `protocol/src/task.ts` 的 `TASK_TRANSITIONS`）

```
created ──► queued ──► running ──► succeeded
   │           ▲  │       │
   │           │  │       ├─ Run 失败/超时且 attempts < max ──► queued（带 notBefore 退避）
   │           │  │       ├─ Run 失败且重试耗尽 / 不可重试 ──► dead
   │           │  │       └─► waiting_approval ──► running（期间被打断同样 → queued / dead）
   │           │  └─► dead（无法开始执行，例如 Agent 不存在）
   └─► pending_approval（policy.requireApproval）──► queued / rejected（拒绝或过期）
任何非终态 ──► cancelled
```

- 重试时 `attempts` 只在 Run 开始时 +1；可重试由错误的 `retryable` 决定。超时、内核重启（`KERNEL_RESTARTED`）、停机（`KERNEL_SHUTDOWN`）、插件协议违规都按可重试处理。
- 等待审批期间暂停超时计时，也不计租约。

**Run**：`running → succeeded | failed | timed_out | cancelled`。失败与超时是 Run 的状态，Task 据此决定重试或进入 `dead`。

终态：`succeeded | dead | cancelled | rejected`。**状态迁移只能由内核执行**，插件只能上报事件。

### 5.4 Journal 事件

每个事件结构：`{ seq, id, type, at, subject: {kind, id}, data, actor }`。`seq` 全局单调递增。

必须支持的事件类型（新增类型需改 protocol 并升 minor 版本）：

```
envelope.received   envelope.duplicated   envelope.routed   envelope.unrouted
task.created        task.queued           task.cancelled    task.dead
run.started         run.event             run.heartbeat
run.succeeded       run.failed            run.timed_out     run.cancelled
approval.requested  approval.granted      approval.rejected approval.expired
delivery.queued     delivery.succeeded    delivery.failed
plugin.loaded       plugin.crashed        plugin.restarted  plugin.disabled
incident.opened     incident.updated      incident.resolved
remediation.proposed remediation.executed remediation.verified remediation.rolled_back
kernel.started      kernel.stopping       config.changed
```

`actor` 取值：`kernel | plugin:<name> | user:<id> | watchdog`，用于审计。

---

## 6. Loop 内核（`@super-loop/kernel`）

### 6.1 职责边界

内核**只做**：入队与去重、Journal 写入、路由、调度、租约与超时、重试与死信、审批中心、Outbox、插件生命周期管理、Projection、Kernel API。

内核**不做**：任何具体来源/Agent/通知的逻辑、任何 LLM 调用、任何业务判断。出现 `if (plugin === 'claude-code')` 之类代码即违规。

### 6.2 稳定性规则（强制）

1. **Journal 是唯一事实来源**。所有状态变化先写 Journal（同一事务内更新 Projection），再产生副作用。
2. **At-least-once + 幂等**：Envelope 用 `idempotencyKey` 去重；Run 和 Delivery 都有自己的幂等键，插件必须能容忍重复调用。
3. **租约（lease）**：Run 启动时获得租约，Agent 需定期 `heartbeat`；租约过期视为 `timed_out`，由内核回收。
4. **崩溃恢复**：内核重启时扫描所有非终态 Run，租约过期的按失败处理并重试，**不得丢消息**。
5. **插件隔离**：每个 Agent Run 在独立子进程或 `worker_threads` 中执行；插件抛异常、卡死、OOM 不得影响内核主循环。插件连续崩溃 N 次（`limits.maxPluginCrashes`）自动 `disabled` 并产生 Incident。
   > M1 现状：Run 在内核进程内执行，已做到异常捕获、超时与取消由内核单方面结算（Agent 不配合也不会卡住内核）、连续崩溃自动禁用；进程级隔离（防 OOM / 死循环）在 M3 接入子进程类 Agent 时实现。
6. **背压**：队列有全局与按 Agent 的并发上限；超限时入队仍成功（持久化），只是不调度。
7. **一切超时**：内核对插件的每个调用（init、run、deliver、health）都必须带超时。
8. **优雅停机**：收到 SIGTERM 后停止取新任务，等待运行中 Run 至 `shutdownGraceMs`，超时则标记并在下次启动时恢复。
9. **配置热更新**：Route、Sink 绑定可热更新；插件代码变更需重启对应插件实例，不重启内核。
10. **内核 API 向后兼容**：`/api/v1` 发布后只增不改，破坏性变更走 `/api/v2`。

### 6.3 存储接口

接口定义在 `protocol/src/store.ts`，内核只依赖接口；默认实现 `store-sqlite`，测试用 `testkit` 的 `MemoryStore`。

```ts
export interface StoreTx {
  append(events: JournalEventDraft[]): Promise<JournalEvent[]>; // 分配 seq
  envelopes: EnvelopeRepo; // 额外提供 findByIdempotencyKey(sourceInstance, key)
  tasks: Repo<Task>;
  runs: Repo<Run>;
  routes: Repo<Route>;
  approvals: Repo<Approval>;
  deliveries: Repo<Delivery>;
  incidents: Repo<Incident>;
  remediations: Repo<Remediation>;
}
export interface Store extends StoreTx {
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>; // 事件与投影原子写入
  readJournal(fromSeq: number, limit: number): Promise<JournalEvent[]>;
  latestSeq(): Promise<number>;
  kv(namespace: string): KvStore;
  close(): Promise<void>;
}
```

`Repo.list` 统一游标分页，ID 为 ULID，按 ID 排序即按创建时间排序。

文件内容（附件、产物）写 `ContentStore`（见 §11.3），Journal 与数据库只存 `FileRef` 引用，不存文件内容，也不存绝对路径。

---

## 7. 插件体系

### 7.1 统一插件清单

每个插件包必须默认导出 `definePlugin(...)` 的结果：

```ts
import { definePlugin } from '@super-loop/plugin-sdk';
import { z } from 'zod';

export default definePlugin({
  name: 'agent-claude-code',          // 与包名去掉 @super-loop/ 前缀一致
  version: '0.1.0',
  kind: 'agent',                      // 'source' | 'agent' | 'sink' | 'probe' | 'playbook'
  apiVersion: 1,                      // 插件协议版本，内核据此判断兼容
  configSchema: z.object({ ... }),    // 实例配置，内核加载时校验
  permissions: ['fs:workspace', 'process:spawn', 'net:*'], // 声明所需权限
  create(config, ctx) { return { ... } }, // 返回对应 kind 的实现
});
```

同一插件可以有**多个实例**，实例名格式 `<plugin>:<instance>`，例如 `claude-code:repo-a`、`lark:ops-group`。

`ctx`（`PluginContext`）由内核注入，插件只能通过它与外界交互：`logger`、`kv`（插件私有命名空间）、`files`（文件读写，见 §11.3）、`paths`（只包含 permissions 中声明的目录）、`secrets`、`clock`、`signal`（AbortSignal）、`emit`（仅 Source）。**禁止插件直接访问 Store。**

### 7.2 Source 插件

```ts
export interface SourcePlugin {
  start(ctx: SourceContext): Promise<void>; // 开始监听；通过 ctx.emit(envelopeDraft) 推入
  stop(): Promise<void>;
  health(): Promise<HealthStatus>;
  ack?(envelopeId: string): Promise<void>; // 支持确认的来源（如 MQ）
}
```

- 产生 Envelope 时**必须**给出稳定的 `idempotencyKey`（例如来源事件 ID、`cron:<jobId>:<scheduledAt>`）。
- `source-cron` 规范：任务定义 `{ id, cron, timezone, envelope: EnvelopeDraft, misfire: 'skip' | 'fire_once' }`；调度状态存在插件 kv 中，内核重启后按 `misfire` 处理错过的触发。
- **手动提交不是插件**：Kernel API `POST /api/v1/envelopes` 与 CLI `sloop submit` 都调用内核内置入口 `kernel.submit()`，来源固定为虚拟实例 `manual:api`，可直接带 `directives` 指定 Agent 与 Sink。
- Agent 通过 `ctx.spawn()` 派生的消息来源为 `spawn:<plugin>`，继承父消息的 `traceId`，`depth + 1`。

### 7.3 Agent 插件

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
  attempt: number;
  envelope: Envelope;
  prompt: string; // 已渲染的提示词
  options: unknown; // 已通过插件 schema 校验
  workspace?: { path: string };
  resume?: { sessionId: string };
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

- 事件流**必须**以且仅以一个 `result` 事件结束；没有 `result` 就结束视为失败。
- 长时间无输出时每 ≤ 15s 发一次 `heartbeat`（plugin-sdk 提供自动心跳包装）。
- `error` 必须区分 `retryable: boolean`，内核据此决定是否重试（例如限流可重试、参数错误不可重试）。
- 子进程类 Agent（Claude Code、Codex CLI）必须：使用结构化输出模式（stream-json / JSON 事件）解析，禁止解析人类可读文本；必须响应 `ctx.signal` 终止整个进程组。
- 高危工具调用（写主分支、删除文件、外部发布、花钱）必须调用 `await ctx.awaitApproval({ action, title, detail, risk })` 交给内核审批，不得自行放行；审批只有这一个入口，不通过事件流。具体映射在各插件的 `permissionPolicy` 配置中声明。
- 长时间运行的 Agent 用 `plugin-sdk` 的 `withHeartbeat()` 包装事件流；结果用 `succeeded()` / `failed()` / `failedFrom()` 构造。
- Agent 想派生新任务时，调用 `ctx.spawn(envelopeDraft)`，内核自动带上 `trace.parentId`，并受**最大派生深度**（默认 3）限制，防止无限循环。

内置 Agent 插件要求：

| 插件                     | 接入方式                                       | 备注                                                             |
| ------------------------ | ---------------------------------------------- | ---------------------------------------------------------------- |
| `agent-claude-code`      | 子进程 `claude -p --output-format stream-json` | 支持 resume、isolated worktree                                   |
| `agent-claude-agent-sdk` | 进程内调用 Claude Agent SDK                    | 工具审批钩子映射到 `approval_request`                            |
| `agent-codex`            | 子进程 `codex exec --json`                     |                                                                  |
| `agent-codex-sdk`        | Codex SDK / harness                            |                                                                  |
| `agent-deepseek`         | DeepSeek API / harness                         |                                                                  |
| `agent-http`             | 通用 HTTP/SSE 协议                             | 自定义 Agent 的首选接入方式，协议见 `docs/plugins/agent-http.md` |

自定义 Agent 两种方式：①写一个 `kind: 'agent'` 插件；②实现 `agent-http` 协议的任意语言服务。

### 7.4 Sink 插件

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

---

## 8. 审批中心（Approval Center）

Agent 工具审批、Task 执行前审批、Watchdog 修复审批**共用同一套机制**。

```ts
export interface Approval {
  id: ApprovalId;
  kind: 'task_start' | 'tool_call' | 'remediation';
  subject: { kind: string; id: string };
  title: string;
  detail: unknown;
  risk: 'low' | 'medium' | 'high' | 'critical';
  requestedBy: Actor;
  approvers?: string[]; // 不填则任何管理员
  expiresAt: string; // 过期视为拒绝
  status: 'pending' | 'granted' | 'rejected' | 'expired';
  decision?: { by: string; at: string; comment?: string };
}
```

- 所有审批通过看板与已配置的 Sink 同时通知。
- 决策写入 Journal，**不可修改、不可删除**。
- `critical` 级别需要二次确认（看板输入确认文字）。

---

## 9. Watchdog

### 9.1 部署

`apps/watchdog` 是**独立进程**，只通过 Kernel API 和本机进程信息工作。内核不可达本身就是一个 Incident。推荐用 launchd / systemd / pm2 同时守护 server 与 watchdog。

### 9.2 流水线

```
Probe（采集） → Detector（判定） → Incident（去重/聚合） → Playbook（生成 Remediation）
      → Approval（人审） → Execute（执行） → Verify（验证） → Resolve / Rollback
```

内置 Probe：内核存活与 API 延迟、Journal 写入延迟、队列积压与等待时长、卡住的 Run（心跳超时）、各插件 health、错误率/重试率/死信增长、Sink 投递失败率、磁盘与 Blob 目录大小、单 Task 成本超预算。

### 9.3 修复动作与风险分级

| 风险       | 示例动作                                            | 审批                                         |
| ---------- | --------------------------------------------------- | -------------------------------------------- |
| `low`      | 采集诊断信息、重新投递失败通知                      | 可配置为自动执行（默认仍需审批）             |
| `medium`   | 取消卡住的 Run 并重试、重启某插件实例、暂停某 Route | 需审批                                       |
| `high`     | 禁用插件、批量重放死信、重启内核                    | 需审批                                       |
| `critical` | 由 Agent 生成代码补丁并提 PR、修改配置文件          | 需审批 + 二次确认；**只提 PR，永不自动合并** |

规则：

1. 每个 Remediation 必须包含：诊断依据、动作列表、预期效果、**回滚步骤**、验证条件。
2. 执行后必须运行 Verify；验证不通过自动执行回滚并重新打开 Incident。
3. 同一 Incident 的自动修复尝试次数有上限（默认 2），超过则只告警。
4. Watchdog 可以把“诊断这个 Incident”作为一个 Envelope 提交给 Loop（例如交给 Claude Code 分析日志），但生成的方案仍走审批。为防自激，Watchdog 发起的任务带 `labels.origin = watchdog`，其失败**不会**再触发 Watchdog 自修复。
5. Playbook 也是插件（`kind: 'playbook'`），声明它能处理的 Incident 类型。

---

## 10. 看板（`apps/dashboard`）

只读 Kernel API，不直连数据库。必须提供的视图：

1. **总览**：吞吐、成功率、队列深度、运行中 Run、成本、各插件健康。
2. **消息流（Inbox）**：所有 Envelope 时间线，可按来源/标签/状态筛选；点开看完整生命周期（Envelope → Task → Runs → Deliveries）。
3. **Run 详情**：实时事件流（SSE）、工具调用、产物、用量、重试历史；支持取消、重试、续跑。
4. **路由**：Route 列表、可视化编辑、匹配测试（贴一个 Envelope 看会命中哪些规则）。
5. **定时任务**：cron 列表、下次触发时间、手动触发、暂停。
6. **插件**：实例列表、配置（敏感字段脱敏）、健康、启停。
7. **审批**：待审批列表，批准/拒绝/评论。
8. **Watchdog**：Incident、Remediation、执行与回滚记录。
9. **审计**：原始 Journal 浏览器（按 seq / traceId 查）。
10. **手动提交**：表单提交 Envelope，选择 Agent 与 Sink。

### 10.1 Kernel API 约定

- 前缀 `/api/v1`，JSON，字段 camelCase，时间 ISO8601 UTC。
- 列表接口统一游标分页：`?cursor=&limit=`，返回 `{ items, nextCursor }`。
- 错误统一：`{ error: { code, message, details? } }`，`code` 为 `SCREAMING_SNAKE_CASE`。
- 实时：`GET /api/v1/stream?fromSeq=` 以 SSE 推送 Journal 事件，断线可续。
- 鉴权：配置了 `server.token`（或 `SUPER_LOOP_API_TOKEN`）后需要 `Authorization: Bearer <token>`（`/health` 除外）；操作人取自 `x-loop-user` 头，记为 `user:<name>`，所有写操作记录 `actor`。
- 错误码 → HTTP：`INVALID_INPUT` 400、`PERMISSION_DENIED` 403、`NOT_FOUND` 404、`CONFLICT` 409、`SPAWN_DEPTH_EXCEEDED` 422、`UNAVAILABLE` 503、其它 500。

已实现的接口（`apps/server/src/app.ts`）：

| 方法 | 路径                                                         | 说明                                                                                           |
| ---- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| GET  | `/health`                                                    | 内核状态、运行中 Run 数、最新 seq、插件状态                                                    |
| GET  | `/plugins` · `/routes`                                       | 插件实例（含健康检查）、生效的路由                                                             |
| POST | `/envelopes`                                                 | 提交消息；`kind` 默认 `task`，`idempotencyKey` 可省略。新建 201，重复 200 + `duplicated: true` |
| GET  | `/envelopes` · `/envelopes/:id`                              | 消息列表 / 详情（含派生的 Task）                                                               |
| GET  | `/tasks?status=` · `/tasks/:id`                              | 任务列表 / 详情（含 Envelope 与所有 Run）                                                      |
| POST | `/tasks/:id/cancel`                                          | 取消任务（运行中会中止当前 Run）                                                               |
| GET  | `/runs/:id`                                                  | Run 详情与它的事件流                                                                           |
| GET  | `/approvals?status=` · POST `/approvals/:id/decision`        | 审批列表 / 决策 `{ decision: 'grant' \| 'reject', comment? }`                                  |
| GET  | `/deliveries?status=` · `/notifications?sink=`               | 投递记录 / 看板收件箱（默认 `dashboard:default`，新的在前）                                    |
| GET  | `/files?ref=&download=1`                                     | 下载附件 / 产物（不存在 404，非法引用 400）                                                    |
| GET  | `/journal?fromSeq=&traceId=&subjectId=` · `/stream?fromSeq=` | 事件日志查询 / SSE（支持 `Last-Event-ID` 续传，15s 心跳）                                      |

---

## 11. 数据与配置目录

所有运行时文件（配置、密钥、数据库、日志、工作区）都放在**主目录**下，代码仓库里不放任何运行时数据。路径解析统一由 `@super-loop/host` 的 `resolveLayout()` 完成，server / cli / watchdog 必须使用它，**禁止各自拼路径**。

### 11.1 目录布局

```
~/.super-loop/                        主目录，SUPER_LOOP_HOME 可覆盖（权限 0700）
├── config.json                       主配置，首次启动自动生成（0600）
├── secrets.env                       密钥 KEY=VALUE（0600，权限过宽会告警）
│
├── db/loop.db (+ -wal, -shm)         系统状态：只有内核读写，禁止手动修改
│
├── attachments/<YYYY-MM-DD>/<ULID>-<文件名>   外部带进来的附件（Source / API）
├── workspaces/<runId>/               每次 Run 一个
│   ├── work/                         Agent 工作目录（cwd）：git worktree、中间文件，临时
│   └── artifacts/                    交付结果：Run 结束时自动扫描登记为产物
│
├── shared/                           用户维护的共享资料（规范、知识文档），Agent 只读
├── state/<plugin>/<instance>/        插件实例的持久状态（CLI 会话、登录态），跨 Run 保留
├── cache/<plugin>/                   可随时删除的缓存（git 镜像、依赖缓存）
│
├── plugins/                          本地自定义插件，config 中用 "file:./plugins/xxx/index.js" 引用
├── logs/                             server.log、watchdog.log（同时输出到 stdout）
├── run/server.lock                   单实例锁（pid）
└── backups/db/                       数据库快照
```

**分区原则：系统状态与内容分开放**，各自可以独立搬迁、备份与清理。

| 区域                                      | 谁写                              | 丢失影响                       | 备份 / 清理                              |
| ----------------------------------------- | --------------------------------- | ------------------------------ | ---------------------------------------- |
| `db/`                                     | 只有内核                          | Loop 无法启动                  | `VACUUM INTO` 一致性快照到 `backups/db/` |
| `attachments/`、`workspaces/*/artifacts/` | 插件（Agent 可直接写 artifacts/） | 只影响对应记录（API 返回 404） | 普通文件拷贝 / 同步；按保留期清理        |
| `workspaces/*/work/`                      | Agent                             | 无，重跑可重建                 | Run 结束 N 天后删除（保留 artifacts/）   |
| `shared/`                                 | 人                                | 用户资料                       | 用户自己管理，Loop 不删除                |
| `state/`                                  | 插件实例                          | 会话、登录态丢失，无法续跑     | 不自动清理                               |
| `cache/`                                  | 内核 / 插件                       | 无，自动重建                   | 随时可删                                 |

- **一个主目录 = 一套独立的 Loop**（独立的库、配置、锁）。需要多套环境时用不同的 `SUPER_LOOP_HOME`。
- 本地开发：`pnpm dev` 使用仓库内的 `.super-loop-dev/`（已 gitignore），不影响 `~/.super-loop`。
- 测试：一律使用临时目录作为主目录，禁止读写真实的 `~/.super-loop`。
- 上次异常退出留下的锁，如果对应进程已不存在，会被自动清理。

### 11.2 config.json

```jsonc
{
  "server": {
    "host": "127.0.0.1", // 默认只监听本机
    "port": 7300,
    "publicUrl": "https://loop.example.com", // 通知里的链接前缀，默认 http://<host>:<port>
    "token": "${secret:API_TOKEN}" // 设置后 API 需要 Bearer Token
  },
  "plugins": {
    // 实例名 "<plugin>:<instance>" → 插件包名（或 file: 本地路径）+ 插件配置
    "claude-code:default": {
      "use": "@super-loop/agent-claude-code",
      "config": { "model": "claude-opus-5-5" }
    },
    "lark:ops": {
      "use": "@super-loop/sink-lark",
      "config": { "chatId": "${secret:LARK_OPS_CHAT}" }
    },
    "mine:default": { "use": "file:./plugins/my-agent/index.js", "enabled": false }
  },
  "routes": [{ "name": "default", "agents": [{ "agent": "claude-code:default" }] }],
  "defaults": {
    "sinks": [{ "sink": "dashboard:default", "on": ["succeeded", "failed", "approval_required"] }]
  },
  "limits": { "globalConcurrency": 4, "maxSpawnDepth": 3 }
}
```

- 顶层只允许 `server`、`plugins`、`routes`、`defaults`、`limits`（拼错字段直接报错）。除 `server` 外的字段结构与 `KernelConfigInput` 一致，由内核做完整校验。
- `plugins.*.use` 的解析：`file:` 开头的路径相对主目录；其余先查宿主应用的**内置插件表**（`apps/server/src/plugins.ts`），再 `import(包名)`。插件包的默认导出必须是插件定义。
- 默认配置在 `apps/server/src/default-config.ts`，只在 `config.json` 不存在时写入一次，之后以用户文件为准。
- 看板中创建的 Route 存在数据库里；同名时 `config.json` 中的定义会在启动时覆盖数据库中的版本。

### 11.3 文件与目录访问

**文件引用（`FileRef`）**：数据库里只存逻辑地址，读取时再按当前配置的目录解析，所以目录可以整体搬迁。

| 类型 | 引用格式                                  | 实际位置                         |
| ---- | ----------------------------------------- | -------------------------------- |
| 附件 | `attachment:<YYYY-MM-DD>/<ULID>-<文件名>` | `attachments/<日期>/…`           |
| 产物 | `artifact:<runId>/<相对路径>`             | `workspaces/<runId>/artifacts/…` |

**插件怎么写文件**：

- `ctx.files.put(data, { name, mime? })` 的写入位置由上下文决定：插件级上下文（Source 等）写**附件**，Agent 的 Run 上下文写**本次 Run 的产物**。`ctx.files.get(ref)` 两类都能读，Agent 可以读消息带来的附件。
- Agent 也可以直接把文件写进 `ctx.paths.artifacts`（CLI 类 Agent 最方便）。Run 结束时内核自动扫描该目录，结果记在 `Run.artifacts`。
- **想让人看到的东西必须放进 artifacts/**。`work/` 里的任何内容都视为随时会被删除。
- 跨任务传递文件用引用（`artifact:<runId>/…`），不要往共享目录里写，保证来源可追溯。

**目录权限**：插件在 `permissions` 中声明后，才能在 `ctx.paths` 里拿到对应目录。

| 权限                   | `ctx.paths`         | 目录                                                                                |
| ---------------------- | ------------------- | ----------------------------------------------------------------------------------- |
| （Run 上下文总是提供） | `work`、`artifacts` | `workspaces/<runId>/work/`、`…/artifacts/`                                          |
| `fs:shared:read`       | `shared`            | `shared/`（只读）                                                                   |
| `fs:state`             | `state`             | `state/<plugin>/<instance>/`；同一实例的多个 Run 可能同时运行，并发写由插件自己加锁 |
| `fs:cache`             | `cache`             | `cache/<plugin>/`，同一插件的所有实例共用                                           |

**安全约束**（`@super-loop/host` 的 `createFsContent` 实现）：

- 文件名清洗：去掉路径分隔符、`..`、控制字符，最长 200 字符；同名产物自动加序号。
- 引用中的 `..`、空段一律拒绝；读取时校验真实路径，**指向目录外的符号链接返回 `PERMISSION_DENIED`**，也不会被登记为产物。
- 单个文件默认上限 50MB。
- `GET /api/v1/files?ref=` 下载时带 `content-security-policy: sandbox` 与 `nosniff`，防止 Agent 产出的 HTML 在 API 源下执行。

### 11.4 密钥

- 密钥只能用 `${secret:NAME}`（先查 `secrets.env`，再查环境变量）或 `${env:NAME}` 引用，**禁止明文写入 config.json 或提交到仓库**。
- 引用的变量不存在时拒绝启动，错误信息带 JSON 路径（如 `$.plugins.lark:ops.config.chatId: secret LARK_OPS_CHAT is not set`）。
- 插件运行时通过 `ctx.secrets.get(name)` 读取，来源同上。

### 11.5 优先级与环境变量

优先级：**环境变量 > config.json > 内置默认值**。配置在加载时完整校验，校验失败拒绝启动。

| 环境变量                              | 作用                               | 默认                           |
| ------------------------------------- | ---------------------------------- | ------------------------------ |
| `SUPER_LOOP_HOME`                     | 主目录                             | `~/.super-loop`                |
| `SUPER_LOOP_DB_DIR`                   | 数据库目录                         | `$SUPER_LOOP_HOME/db`          |
| `SUPER_LOOP_ATTACHMENTS_DIR`          | 附件目录                           | `$SUPER_LOOP_HOME/attachments` |
| `SUPER_LOOP_WORKSPACES_DIR`           | 工作区目录（含产物）               | `$SUPER_LOOP_HOME/workspaces`  |
| `SUPER_LOOP_HOST` / `SUPER_LOOP_PORT` | 覆盖 `server.host` / `server.port` | `127.0.0.1` / `7300`           |
| `SUPER_LOOP_PUBLIC_URL`               | 覆盖 `server.publicUrl`            | `http://<host>:<port>`         |
| `SUPER_LOOP_API_TOKEN`                | 覆盖 `server.token`                | 无                             |
| `SUPER_LOOP_LOG_LEVEL`                | 日志级别                           | `info`                         |

新增环境变量必须使用 `SUPER_LOOP_` 前缀，并登记到本表和 `turbo.json` 的 `globalEnv`。

---

## 12. 编码规范

### 12.1 TypeScript

- `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 开启。
- 禁止 `any`；确需时用 `unknown` + zod 解析。禁止 `// @ts-ignore`，必要时用 `// @ts-expect-error <原因>`。
- 跨包只通过包的 `exports` 入口导入，禁止深路径 `@super-loop/kernel/src/...`。
- 公共 API 使用具名导出；插件入口唯一默认导出 `definePlugin(...)`。
- 错误使用 `@super-loop/shared` 的 `LoopError(code, message, { cause, retryable })`，禁止抛字符串。
- 所有异步操作接受 `AbortSignal`；禁止无超时的 `await` 外部调用。
- 时间统一通过 `ctx.clock` 获取，禁止在内核/插件中直接 `Date.now()`（便于测试与回放）。
- 日志用结构化 logger（pino），必须带 `traceId` / `runId` 等上下文；禁止 `console.log`（CLI 输出除外）。

### 12.2 命名

- 包名：`@super-loop/<kind>-<name>`（插件），如 `@super-loop/agent-codex`。
- 文件：kebab-case；类型/类：PascalCase；函数/变量：camelCase；常量：SCREAMING_SNAKE_CASE。
- 事件类型：`<subject>.<past_tense_verb>`，如 `run.started`。

### 12.3 测试

- 测试文件放在各包 `test/` 下，命名 `*.test.ts`，由根目录 `vitest.config.ts` 统一运行。
- `kernel` 行覆盖率 ≥ 90%，必须包含：崩溃恢复、租约过期、重复投递、并发上限、重试与死信的测试。
- 每个插件必须通过 `@super-loop/testkit` 提供的**契约测试套件**（`runAgentContractTests` / `runSourceContractTests` / `runSinkContractTests`），参考 `plugins/agent-echo/test`。
- 需要时间的逻辑使用 `testkit` 的 `FakeClock`，需要存储的使用 `MemoryStore`，不要在测试里 mock 内部模块。
- 调用真实外部服务的测试放在 `*.e2e.test.ts`，默认不在 CI 跑，需 `E2E=1`。
- 子进程类 Agent 用录制的输出夹具（fixtures）做单测。

### 12.4 提交与 PR

- Conventional Commits：`feat(kernel): ...`、`fix(agent-codex): ...`，scope 为包名去前缀。
- 改动 `protocol` 或 `kernel` 的 PR 必须：附 changeset、说明兼容性影响；架构级改动需新增 ADR（`docs/adr/`）。
- PR 合并前必须通过 `pnpm check`（= `pnpm lint && pnpm typecheck && pnpm test && pnpm check:deps`）。

### 12.5 版本与兼容

- `protocol` 与插件 `apiVersion`：新增可选字段 → minor；删除/改语义 → major，并在内核中保留旧版本适配至少一个 major 周期。
- Journal 事件结构一旦发布不可修改，只能新增事件类型或可选字段；需要演进时用 `upcaster` 在读取时升级旧事件。

---

## 13. 安全

- Agent 在 `workspaces/<runId>/work/` 中运行（isolated 的 Agent 在其中创建 git worktree），只能拿到 permissions 中声明的目录（§11.3）。
- 插件 `permissions` 声明在加载时展示，未声明的能力（如网络、spawn）在隔离进程中被拒绝（尽力而为，逐步加强）。
- Webhook Source 必须校验签名；所有回调接口防重放（时间戳 + nonce）。
- 看板与日志中密钥、Token 自动脱敏。
- Envelope 来自外部，内容视为**不可信数据**：渲染到 prompt 时需明确标注为外部输入，不得作为系统指令拼接。

---

## 14. 常用命令

```bash
pnpm install
pnpm dev                 # 启动 server（tsx watch，直接跑源码）；M2 起同时启动 dashboard
pnpm --filter @super-loop/server start   # 构建后以 dist 运行
pnpm build               # turbo 按拓扑顺序构建到 dist/
pnpm test                # 单测 + 契约测试（E2E=1 时包含 *.e2e.test.ts）
pnpm lint                # biome check；pnpm format 自动修复
pnpm typecheck
pnpm check:deps          # 校验第 4.3 节的依赖方向
pnpm check               # 以上全部，合并前必跑
pnpm changeset

# pnpm dev 使用仓库内的 .super-loop-dev/ 作为主目录，不会碰 ~/.super-loop；环境变量见 §11.5
curl -XPOST localhost:7300/api/v1/envelopes -H 'content-type: application/json' -d '{"subject":"hello"}'

# 以下为 M2 的 CLI
sloop submit "修复 issue #12" --agent claude-code:default --sink lark:ops
sloop runs ls --status running
sloop approvals ls
sloop replay --from-seq 1000   # 用 Journal 重建 Projection
```

---

## 15. 实施路线（建议）

| 阶段  | 内容                                                                                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 ✅ | 仓库骨架、`protocol`、`shared`、`plugin-sdk`、`testkit`、`agent-echo`、依赖校验                                                                                                 |
| M1 ✅ | `kernel` 最小闭环：ingest → journal → route → dispatch → run → outbox，含重试/超时/租约/取消/审批/崩溃恢复；`store-sqlite`；`sink-dashboard`；`apps/server`（Kernel API + SSE） |
| M2    | `agent-claude-code`、看板（总览/消息流/Run 详情/审批）、CLI                                                                                                                     |
| M3    | `source-cron`、`source-webhook`、`sink-lark`、`agent-codex`、`agent-claude-agent-sdk`、`agent-http`、Agent 进程级隔离                                                           |
| M4    | Watchdog：Probe/Detector/Incident/Playbook + 审批执行与回滚                                                                                                                     |
| M5    | `agent-deepseek`、`agent-codex-sdk`、Postgres Store、成本预算与配额                                                                                                             |

---

## 16. 给 AI Agent 的工作守则

1. 改动前先确认改动属于哪个包，遵守第 4.3 节依赖方向。
2. 不要往 `kernel` 里加任何特定插件逻辑；需要新能力时，先考虑能否用插件 + 通用扩展点实现。
3. 改 `protocol` 前先写清兼容性影响；不要修改已发布的事件结构。
4. 新增插件请从 `plugin-sdk` 模板复制，并让契约测试通过。
5. 不要提交密钥、`.loop/` 运行数据、录制夹具中的敏感信息。
6. 完成后运行第 12.4 节的检查命令，失败时如实报告。
