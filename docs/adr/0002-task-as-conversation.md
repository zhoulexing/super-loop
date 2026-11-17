# ADR 0002：Task 改为会话模型，支持手动分配

- 状态：已采纳
- 日期：2026-11-05

## 背景

看板原型（七列状态看板 + 对话抽屉）要求：任务可以手动拖拽分配 Agent、执行中或结束后可以继续追问、可以关闭和重新打开。
原模型里 Task 是一次性的（`succeeded | dead | cancelled | rejected` 都是终态），没有匹配 Route 的消息直接丢弃，做不到这些。

## 决策

1. **Task = 一段会话**。状态改为 `unassigned / pending_approval / queued / running / waiting_approval / awaiting_input / failed / closed`，
   关闭原因放在 `outcome`（`succeeded | failed | cancelled | rejected`）。没有真正的终态：`closed` 可以重新打开。
2. **新增 `Turn` 实体**：每条输入（首轮来自 Envelope，之后是人的追问）一轮，重试与追问都产生新的 Run。
   Agent 收到 `turn`、本轮 `prompt` 与 `history`；支持续跑的 Agent 收到同一任务上一次的 `resume.sessionId`。
3. **执行中发消息默认排队**，本轮结束后自动处理；`interrupt` 模式中止当前 Run（`INTERRUPTED`，不算失败）。
4. **完成后是否关闭**由 `closeOnComplete` 决定：Directives / Route 可显式指定；默认手动提交保持会话，自动化来源（定时、事件、派生）完成即关闭。
   `awaiting_input` 空闲超过 `limits.idleCloseMs`（默认 7 天）自动关闭。
5. **分配模式**：Route 增加 `assign: auto | manual`；manual 生成一个 `unassigned` Task，agents 作为候选。
   没有匹配 Route 的消息按 `defaults.unrouted`（默认 `triage`）进入未分配，不再丢弃。
6. **工作区按任务**：`workspaces/<taskId>/{work, artifacts/<runId>}`，多轮对话共用工作目录；产物引用改为 `artifact:<taskId>/<runId>/<path>`。
7. 派发顺序：`priority` 升序，同优先级按 `rank`（看板拖拽排序）升序。

## 影响

- 破坏性变更：Task 状态、Journal 事件（删除 `task.succeeded / task.dead / task.cancelled / task.rejected`，新增 `task.assigned / awaiting_input / failed / closed / reopened ...` 与 `turn.*`）、产物引用格式、`ContentStore` / `DirectoryProvider` 签名。
  当时尚无正式数据，不做迁移；本地开发数据需要删除 `.super-loop-dev/` 后重新生成。
- Kernel API 新增 `/tasks/:id/{messages,assign,unassign,retry,close,reopen,turns}`、`PATCH /tasks/:id`、`POST /files`；`/tasks/:id/cancel` 保留为 close 的别名。
