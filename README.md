# super-loop

An event-driven agent runtime for messages, events, and scheduled tasks, with pluggable harnesses and models, human review, notifications, and watchdog supervision.

- 架构与开发规范：[AGENTS.md](./AGENTS.md)（`CLAUDE.md` 为其软链接）
- 插件开发：[docs/plugins](./docs/plugins/README.md)
- 架构决策：[docs/adr](./docs/adr)

## 快速开始

```bash
nvm use            # Node 24
pnpm install
pnpm check         # lint + typecheck + test + 依赖方向检查
pnpm build
```
