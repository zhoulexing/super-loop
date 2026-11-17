# ADR 0004：统一 Inbox / Outbox 术语

- 状态：已采纳
- 日期：2026-11-15

## 背景与决策

消息入口原名为 `ingest`，输出侧已使用 Outbox。统一输入侧为 Inbox，与 Outbox 分别表达收件箱、发件箱，便于讨论完整消息流。正式定义与记录边界维护在 [消息契约](../architecture.md#inbox--outbox-与消息记录)。

## 实现与兼容性

- 内核方法 `Kernel.ingest()` 改为 `Kernel.inbox()`，导出类型 `IngestOrigin` 改为 `InboxOrigin`。当前 kernel 为私有、未发布的 `0.0.0` 包，仓库调用方同步迁移，不保留旧名别名；仓库外直接引用旧方法或类型的调用方需要改名。
- Source 的 `ctx.emit()`、手动入口 `submit()`、Agent 的 `ctx.spawn()` 汇入新名称。会话追问继续使用 `sendMessage()`。
- HTTP 路径、插件协议、返回结构、存储表及 Journal 事件名保持兼容，无需数据库迁移。
- 本次调整统一命名和记录契约，不引入栈语义，也不拆分接收与路由事务。
