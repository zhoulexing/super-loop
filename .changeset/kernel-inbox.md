---

"@super-loop/kernel": minor

---

统一消息输入侧名称为 Inbox，与 Outbox 配对。`Kernel.ingest()` 更名为 `Kernel.inbox()`，`IngestOrigin` 更名为 `InboxOrigin`；直接调用旧内核方法或导入旧类型的代码需要迁移。当前包为私有、未发布的 0.0.0 版本，不保留旧名别名。

Source `ctx.emit()`、`submit()` 和 Agent `ctx.spawn()` 的接口不变；HTTP API、存储结构与 Journal 事件保持兼容。补充 Inbox / Outbox 的记录语义与拒收边界。
