# ADR 0003：Router 插件——由 LLM / Agent 判断任务派给谁

- 状态：已采纳
- 日期：2026-11-05

## 背景

现在的路由完全是声明式规则（Route 的 `match`）。规则适合确定的情况（某个来源、某个标签），
但很多消息需要理解内容才能决定交给谁（"订单页偶发 500"给程序员，"写一篇公众号文章"给写手）。
参考 DeepSeek super-agent 原型：在 Worker 之上有一个专门做分配的 Router 层，它本身也是一个 Agent 会话，
先由确定性的闸门过滤，再由模型判断。

## 决策

1. **新增插件类型 `router`**（`RouterPlugin.route(request, ctx) → { decisions, usage }`）。内核不做任何 LLM 调用，
   判断逻辑全部在插件里；插件之间仍不互相依赖。
2. **规则是闸门，Router 是补充**：`directives` 与 Route 先匹配；Route `assign: router` 或 `defaults.unrouted: router`
   的消息才交给 Router（`route.router` / `defaults.router` 指定实例）。
3. **不新增实体**：消息照常生成 `unassigned` Task，Task 上带 `routing`（`pending → running → decided | failed`，人先分配则
   `skipped`）。看板天然能显示"分配中"，崩溃恢复只需扫描 Task，人随时可以接管。
4. **决策不改状态**：Router 只返回决策，内核校验后执行。合法的 `assign`（Agent 已就绪、在 Route 候选内）直接分配；
   否则降级为 `triage` 并写明原因。`triage` 可带 `suggestions`，作为候选显示给人。
5. **按批、单飞、可重试**：同一 Router 实例同时只处理一批（`limits.routing.batchSize`），每批有超时；出错或缺少决策
   按退避重试，最多 `maxAttempts` 次，之后留给人处理。新增事件 `routing.requested / routing.decided / routing.failed`。
6. **只读查询**：`RouterContext.query` 提供 `searchTasks` / `getTask`，Router 可以参考同类任务以前交给了谁；插件仍不能访问 Store。
7. **Agent 说明**：插件实例配置增加 `description`，随 `/plugins` 返回，也随 `RouterRequest.agents` 交给 Router。
8. **首个实现 `router-dsh`**：基于 `@deepseek-ai/dsh-sdk-client`（next 0.2.2-rc.1）。

## router-dsh 的设计

- **运行时**：插件启动一个 `dsh --profile sdk-minimal` 子进程（JSON-RPC over stdio），用生成的 profile 补丁关掉
  shell / 文件 / 工作目录工具，只挂载插件提供的 MCP 工具。进程级隔离，插件挂掉不影响内核。
- **工具**：插件在 127.0.0.1 上起一个最小的 MCP（Streamable HTTP，JSON 响应）服务端，随机 Bearer token，
  提供 `route_decide`（提交决策，就地校验并把错误返回给模型改正）、`search_tasks`、`get_task`。工具代码运行在
  插件进程里、用 zod 定义，不需要写 cordis 插件，也不需要放宽依赖规则。
- **会话**：一个实例一个长驻会话（模型能记住之前的批次），DSH 自己把会话日志持久化在
  `state/router-dsh/<instance>/dsh/`（JSONL），会话 ID 存插件 kv，重启后 `resumeSession`。
  DSH 按工作目录归档会话，所以子进程的 cwd 固定为 `state/…/work`。上下文增长由 sdk-minimal 自带的压缩处理。
- **决策来源**：只认 `route_decide` 的参数，不解析模型的回复文本（SDK 的 `finalResponse` 不保证只对应一次输入）。
  一批没给全决策时提醒一次（`maxReminders`）。
- **取消**：SDK 没有取消单次运行的请求；超时 / 取消时关闭子进程，下一批重新启动并 resume。
- **模型**：`provider` 默认 `openai`（走 DSH 的 pi-ai 适配器），`deepseek-official` 走内置 DeepSeek 适配器；
  Key 通过 `apiKeySecret` 解析后只注入子进程，子进程只拿到白名单环境变量。

## 实测（2026-11-05，gpt-5.4-mini）

- 子进程冷启动约 0.4～1s；一批 2～3 条消息约 7～10s（含 2～3 次模型调用），每批约 1～2k 输入 token。
- 真实 server 上：报错排查 → 程序员，写文章 → 写手，"帮我看看这个" → triage 并给出候选；重启 server 后恢复同一会话。

## 备选与取舍

- **pi（`pi-ai` / `pi-agent-core` / `pi-durable`）**：更轻，但会话持久化要么自己做，要么用实验性的 `pi-durable`
  （自带任务 / 重试 / 调度，和内核重复）。
- **OpenAI Agents SDK**：多 Agent 框架，概念与内核重叠；非 OpenAI 模型要经 AI SDK 适配器；默认把 tracing 上报 OpenAI。
- **DeepSeek Harness 桌面端**：版本随应用自动更新、路径不是公开接口、服务器上没有，不作为依赖。
- 选 DSH SDK 的代价：依赖较重（约 580 个包）、版本处于 rc / alpha，需要锁定精确版本，升级时跑 `E2E=1` 测试。
  Router 接口与实现无关，以后可以换成其它实现而不改内核。

## 兼容性

- `protocol`：新增 `PluginKind` 值 `router`、`AssignMode` 值 `router`、`UnroutedPolicy` 值 `router`、`Route.router`、
  `Task.routing`、ID 前缀 `rtb`、三个 Journal 事件类型——都是新增，旧数据与旧事件不受影响。
- `kernel`：新增配置 `defaults.router`、`limits.routing`、`plugins.<instance>.description`；`assign: router` 必须能解析到 Router 实例，否则拒绝启动。
