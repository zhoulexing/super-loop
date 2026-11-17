# super-loop

An event-driven agent runtime for messages, events, and scheduled tasks, with pluggable harnesses and models, human review, notifications, and watchdog supervision.

消息流统一使用 **Inbox → 处理与调度 → Outbox**：Inbox 接收并记录输入，Outbox 保存并投递输出通知。二者不是后进先出的栈；消息记录与失败边界见 [消息契约](./docs/architecture.md#inbox--outbox-与消息记录)。

- 工程原则：[AGENTS.md](./AGENTS.md)（`CLAUDE.md` 为其软链接）
- 专项文档：[文档导航](./docs/README.md)
- 插件开发：[docs/plugins](./docs/plugins/README.md)
- 架构决策：[docs/adr](./docs/adr)

## 快速开始

```bash
nvm use            # Node 24
pnpm install
pnpm check         # lint + typecheck + test + 依赖方向检查
pnpm build
```
