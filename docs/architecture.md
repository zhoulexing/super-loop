# 消息流、协议与内核机制

工程原则见 [AGENTS.md](../AGENTS.md)。本文维护消息流与状态契约；类型片段为设计轮廓，准确字段和校验以 [protocol 源码](../packages/protocol/src/index.ts) 为准。规划与实现阶段见[路线图](roadmap.md)。

## 总体架构

```
                ┌──────────────────────── Sources（插件）────────────────────────┐
                │  webhook   cron   lark-event   github  ...                    │
                └───────────────┬────────────────────────────────────────────────┘
                                │ Envelope
                                ▼
┌──────────────────────────── Loop Kernel（唯一非插件）─────────────────────────────┐
│                                                                                    │
│   Inbox  ──► Journal(追加写) ──► Router(Route 规则) ──► Queue ──► Dispatcher         │
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

手动 API / CLI 通过内核 `submit()` 进入 Inbox，不属于 Source 插件。图中包含规划能力，当前实现范围见路线图。

### 核心数据流

1. Source 通过 `ctx.emit(envelopeDraft)` 提交消息，由宿主绑定来源身份并调用 `kernel.inbox()`；手动提交 `kernel.submit()` 和 Agent 派生 `ctx.spawn()` 也进入 Inbox。
2. 内核按 `idempotencyKey` 去重，写入 Journal（`envelope.received`）。
3. 内核依据 Envelope 自带的 `directives` 或匹配到的 `Route`（声明式规则，相当于确定性的闸门），生成一个或多个 `Task`（`task.created`）。Route 为手动分配（`assign: manual`）或没有匹配到任何 Route 时，生成一个**未分配**的 Task，由人在看板上选择 Agent；Route 为 `assign: router`（或 `defaults.unrouted: router`）时，未分配的 Task 先交给 **Router 插件**判断派给谁，判断不了再留给人（见 [Router 插件](plugins/README.md#router-插件)）。
4. Dispatcher 取出 Task，按并发/优先级/配额分配给 AgentHost，创建 `Run`（`run.started`），获得**租约（lease）**。
5. Agent 插件以**事件流**形式回报进度（`run.event`）；需要人工审批的动作走 Approval Center。
6. Run 结束（`run.succeeded | run.failed | run.cancelled | run.timed_out`）：成功则本轮完成，Task 进入 `awaiting_input` 等待追问（自动化来源直接 `closed`）；失败按重试策略重试或进入 `failed`。追问会开启新的一轮（Turn），产生新的 Run。
7. 结果写入 Outbox，SinkHost 投递到各通知通道（`delivery.*`），投递失败独立重试，不影响 Run 结果。
8. Projections 根据 Journal 维护物化视图，供看板与 API 查询。

## 核心概念

| 术语          | 含义                                                                                                                        |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `Envelope`    | 一条进入 Loop 的消息，来源可以是任务、事件或定时触发。不可变。                                                              |
| `Inbox`       | 收件箱：统一接收并记录输入消息的内核边界，入口为 `kernel.inbox()`；记录语义见 [Inbox / Outbox](#inbox--outbox-与消息记录)。 |
| `Outbox`      | 发件箱：保存待发送通知及其投递状态，由内核调度 Sink 投递；记录语义见 [Inbox / Outbox](#inbox--outbox-与消息记录)。          |
| `Source`      | 消息来源插件，负责产生 Envelope。                                                                                           |
| `Directives`  | Envelope 上的显式指令：指定 Agent、Sink、优先级等，**优先级高于 Route**。                                                   |
| `Route`       | 路由规则：`match`（条件）→ `agent` + `sinks` + `policy`。可持久化、可在看板上编辑。                                         |
| `Task`        | 一个 Envelope 形成的待办单元，也是与 Agent 的一段**会话**（可多轮追问、关闭后重新打开）。一个 Envelope 可以扇出多个 Task。  |
| `Turn`        | 会话中的一轮：一条输入（首轮来自 Envelope，之后是人的追问）及处理它的 Run。                                                 |
| `Run`         | Turn 的一次执行尝试。重试会产生新的 Run。                                                                                   |
| `Agent`       | 执行 Task 的插件（Claude Code、Codex 等）。                                                                                 |
| `Router`      | 路由插件：把待分配的 Task 批量判断派给哪个 Agent（可以由 LLM / Agent 驱动），只返回决策，由内核校验后执行。                 |
| `Sink`        | 输出/通知插件。                                                                                                             |
| `Delivery`    | 一次向 Sink 的投递记录。                                                                                                    |
| `Journal`     | 追加写的事件日志，**唯一事实来源**。                                                                                        |
| `Projection`  | 由 Journal 推导出的查询视图（列表、统计、看板）。                                                                           |
| `Approval`    | 一个需要人做决定的请求（Agent 高危工具调用、Watchdog 修复方案等）。                                                         |
| `Incident`    | Watchdog 检测到的一次异常。                                                                                                 |
| `Remediation` | 针对 Incident 的修复方案，含风险等级、动作列表、回滚方式。                                                                  |

## 协议与状态机

以下为规范性的类型轮廓，具体以 zod schema 为准。所有 ID 使用 ULID 并带前缀（`env_`、`task_`、`turn_`、`run_`、`rt_`、`apv_`、`inc_`、`dlv_`）。

### Envelope

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
  closeOnComplete?: boolean; // 本轮成功后直接关闭；默认手动提交保持会话，其它来源完成即关闭
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

### Route

```ts
export interface Route {
  id: RouteId;
  name: string;
  enabled: boolean;
  order: number; // 越小越先匹配
  match: RouteMatch; // 声明式条件，禁止写任意 JS
  assign: 'auto' | 'manual' | 'router'; // auto：直接派给 agents（多个则扇出）；manual：进入"未分配"，agents 作为候选；router：交给 Router 插件在 agents 中选择
  agents: AgentBinding[]; // auto 时至少一个；manual / router 时可为空（任意 Agent）
  router?: string; // assign 为 router 时使用的 Router 实例，不填用 defaults.router
  sinks: SinkBinding[];
  policy: TaskPolicy;
  closeOnComplete?: boolean; // 覆盖默认值，见 Directives
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

### 状态机

**Task 是一段会话**（定义见 `protocol/src/task.ts` 的 `TASK_TRANSITIONS`）。看板按状态分列。

```
                 assign                     ┌──────────── 追问 / 重试 ────────────┐
 unassigned ─────────────► queued ──► running ──► awaiting_input ──(空闲 7 天)──► closed
     ▲    └─(requireApproval)─► pending_approval ─┘    │   ▲   │                  │  ▲
     └──── unassign ─────┘      (拒绝/过期 → closed)    │   │   └──── 关闭 ───────►│  │
                                                       │   └─ 本轮结束还有排队的追问 → queued
                     running ⇄ waiting_approval        ├─ 失败且可重试 → queued（notBefore 退避）
                                                       └─ 重试耗尽 / 不可重试 → failed ──► queued（重试 / 追问 / 换 Agent）
 任何状态 ──► closed（执行中会先中止 Run）      closed ──► awaiting_input（有 Agent）/ unassigned（重新打开）
```

| 状态                 | 含义                                                   | 谁推进                     |
| -------------------- | ------------------------------------------------------ | -------------------------- |
| `unassigned`         | 还没有 Agent（手动分配、triage，或等待 Router 判断）   | 人 / Router：分配 Agent    |
| `pending_approval`   | 执行前审批（`policy.requireApproval`）                 | 人：批准 / 拒绝            |
| `queued` / `running` | 排队 / 执行中                                          | 内核                       |
| `waiting_approval`   | Run 中途等待工具调用审批                               | 人                         |
| `awaiting_input`     | 本轮已完成，等待追问                                   | 人：追问 / 关闭            |
| `failed`             | 重试耗尽或不可重试                                     | 人：重试 / 追问 / 换 Agent |
| `closed` + `outcome` | 已关闭：`succeeded \| failed \| cancelled \| rejected` | 人：重新打开               |

- **自动分配**：交给 Router 的 Task 带 `routing` 字段（`pending → running → decided | failed`，人先分配则为 `skipped`），决策前保持 `unassigned`，详见 [Router 插件](plugins/README.md#router-插件)。
- **会话**：每条输入是一个 `Turn`（`pending → running → completed | failed | interrupted | cancelled`），重试与追问都会产生新的 Run。Agent 收到 `turn`、本轮 `prompt` 与之前各轮的 `history`；`resumable` 的 Agent 还会收到同一任务上一次的 `resume.sessionId`。
- **执行中发消息**：默认排队，本轮结束后自动处理；`mode: interrupt` 立即中止当前 Run（错误码 `INTERRUPTED`，不算失败）并处理新消息。
- **完成后**：`closeOnComplete` 为 true（自动化来源默认）直接 `closed`，否则进入 `awaiting_input`；空闲超过 `limits.idleCloseMs`（默认 7 天，0 关闭）自动关闭。
- **重试**：`attempts` 是当前这一轮的尝试次数，只在 Run 开始时 +1，新一轮或手动重试时归零；可重试由错误的 `retryable` 决定。超时、内核重启（`KERNEL_RESTARTED`）、停机（`KERNEL_SHUTDOWN`）、插件协议违规都按可重试处理。
- **派发顺序**：`priority` 升序，同优先级按 `rank` 升序（看板拖拽排序时修改）。
- 等待审批期间暂停超时计时，也不计租约。

**Run**：`running → succeeded | failed | timed_out | cancelled`。失败与超时是 Run 的状态，Task 据此决定重试或进入 `failed`。

**状态迁移只能由内核执行**，插件只能上报事件；人的操作通过 Kernel API 调用内核方法（`assignTask`、`sendMessage`、`retryTask`、`closeTask`、`reopenTask`、`reprioritizeTask`）。

### Journal 事件

每个事件结构：`{ seq, id, type, at, subject: {kind, id}, data, actor }`。`seq` 全局单调递增。

必须支持的事件类型（新增类型需改 protocol 并升 minor 版本）：

```
envelope.received   envelope.duplicated   envelope.routed   envelope.unrouted
routing.requested   routing.decided       routing.failed
task.created        task.assigned         task.unassigned   task.queued       task.reprioritized
task.awaiting_input task.failed           task.closed       task.reopened
turn.added          turn.completed        turn.failed       turn.interrupted  turn.cancelled
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

## 存储接口

接口定义在 `protocol/src/store.ts`，内核只依赖接口；默认实现 `store-sqlite`，测试用 `testkit` 的 `MemoryStore`。

```ts
export interface StoreTx {
  append(events: JournalEventDraft[]): Promise<JournalEvent[]>; // 分配 seq
  envelopes: EnvelopeRepo; // 额外提供 findByIdempotencyKey(sourceInstance, key)
  tasks: Repo<Task>;
  turns: Repo<Turn>;
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

文件内容（附件、产物）写 `ContentStore`（见 [文件与目录访问](runtime.md#文件与目录访问)），Journal 与数据库只存 `FileRef` 引用，不存文件内容，也不存绝对路径。

## Inbox / Outbox 与消息记录

- **统一术语**：输入侧使用 Inbox（收件箱），输出侧使用 Outbox（发件箱）。二者描述消息流向，不表示后进先出的栈；任务顺序遵循 [状态机](#状态机) 的优先级与 rank。处理或投递完成不会因此删除消息记录。
- **Inbox 接收成功**：`kernel.inbox()` 返回前，已在同一事务内保存 Envelope、由路由产生的 Task / 首轮 Turn 和 Journal 事件；返回 `{ envelopeId, duplicated }` 不代表 Agent 已执行或通知已送达。Inbox 当前复用 `envelopes` 存储，不另建一份消息表。
- **新消息**：保存完整 Envelope（附件为引用），记录 `envelope.received`。即使没有匹配的 Route、`defaults.unrouted: drop` 不创建任务，也保留 Envelope 和 `envelope.unrouted`。
- **重复投递**：按来源实例与 `idempotencyKey` 去重；复用原 Envelope，追加 `envelope.duplicated`，不覆盖原内容、不重复创建任务。去重记录不保存本次重复请求的完整正文。
- **未接收的请求**：校验失败、内核不可接收或事务失败时抛错；事务失败回滚。此类请求不保证形成 Envelope 或 Journal 记录，不能把“接收成功有记录”等同于“所有到达网络入口的请求都有记录”。
- **会话追问**：已有 Task 的 `sendMessage()` 按 [状态机](#状态机) 保存 Turn 和 `turn.added`，不为每轮追问新建 Envelope。
- **Outbox**：每次计划向 Sink 发送的通知保存为 Delivery，含通知内容、目标、状态和尝试次数，并记录 `delivery.*` 事件；投递失败独立重试。Outbox 不是从 Inbox 弹出原消息，一条输入可以产生零条或多条通知。
- **查询入口**：Inbox 消息使用 `/api/v1/envelopes`，Outbox 投递使用 `/api/v1/deliveries`，生命周期事件使用 `/api/v1/journal`。`sink-dashboard` 的插件私有通知收件箱是通知落地位置，不是内核 Inbox。

## 审批中心

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

## 调度与恢复约束

1. **租约（lease）**：Run 启动时获得租约，Agent 需定期 `heartbeat`；租约过期视为 `timed_out`，由内核回收。
2. **崩溃恢复**：内核重启时扫描所有非终态 Run，租约过期的按失败处理并重试，**不得丢消息**。
3. **插件隔离**：每个 Agent Run 在独立子进程或 `worker_threads` 中执行；插件抛异常、卡死、OOM 不得影响内核主循环。插件连续崩溃 N 次（`limits.maxPluginCrashes`）自动 `disabled` 并产生 Incident。
   > M1 现状：Run 在内核进程内执行，已做到异常捕获、超时与取消由内核单方面结算（Agent 不配合也不会卡住内核）、连续崩溃自动禁用；进程级隔离（防 OOM / 死循环）在 M3 接入子进程类 Agent 时实现。
4. **背压**：队列有全局与按 Agent 的并发上限；超限时入队仍成功（持久化），只是不调度。
5. **一切超时**：内核对插件的每个调用（init、run、deliver、health）都必须带超时。
6. **优雅停机**：收到 SIGTERM 后停止取新任务，等待运行中 Run 至 `shutdownGraceMs`，超时则标记并在下次启动时恢复。
7. **配置热更新**：Route、Sink 绑定可热更新；插件代码变更需重启对应插件实例，不重启内核。
