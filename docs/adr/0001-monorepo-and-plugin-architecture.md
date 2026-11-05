# ADR 0001：Monorepo 与插件化架构

- 状态：已采纳
- 日期：2026-11-04

## 背景

Super Loop 需要接入多种消息来源、多种 Agent（Claude Code、Codex、Claude Agent SDK、DeepSeek 等）和多种通知通道，同时要求内核长期稳定运行。

## 决策

1. **只有 Loop 内核不是插件**，Source / Agent / Sink / Probe / Playbook 全部插件化，插件通过 `@super-loop/protocol` 定义的接口与内核交互。
2. **Journal（追加写事件日志）是唯一事实来源**，查询视图由事件推导；`Store` 接口放在 `protocol`，内核不依赖具体存储。
3. **pnpm workspaces + Turborepo**，分 `packages/`（基础库）、`plugins/`（插件）、`apps/`（可运行程序）三层，依赖方向由 `scripts/check-deps.ts` 在 CI 中强制。
4. 包 `exports` 使用自定义条件 `@super-loop/source` 指向 `src`，typecheck 与测试不需要先构建；发布构建走 `dist`。
5. 审批只有一个入口：Agent 调用 `ctx.awaitApproval()`；不在事件流中再提供 `approval_request` 事件，避免两套语义。
6. Watchdog 是独立进程，只通过 Kernel API 交互，不依赖 kernel 包。

## 影响

- 新增插件只需依赖 `plugin-sdk`，并通过 `testkit` 契约测试即可接入。
- 跨包修改协议需要谨慎，`protocol` 的破坏性变更需升 major 并保留适配。
- 插件之间不能共享代码，公共逻辑需要下沉到 `shared` 或 `plugin-sdk`。
