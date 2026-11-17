# 实施路线

以下阶段从原根规范迁入，描述实现范围与后续计划，不是部署或外部平台验收记录。新增能力时同时更新本页和所属文档。

| 阶段  | 内容                                                                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M0 ✅ | 仓库骨架、`protocol`、`shared`、`plugin-sdk`、`testkit`、`agent-echo`、依赖校验                                                                                                |
| M1 ✅ | `kernel` 最小闭环：inbox → journal → route → dispatch → run → outbox，含重试/超时/租约/取消/审批/崩溃恢复；`store-sqlite`；`sink-dashboard`；`apps/server`（Kernel API + SSE） |
| M2    | 会话模型 ✅、`@super-loop/client` ✅、任务看板 ✅、Router 插件（`router-dsh`）✅；`agent-claude-code`、看板其它视图（总览/路由/插件/审计）、CLI                                |
| M3    | `source-cron`、`source-webhook`、`sink-lark`、`agent-codex`、`agent-claude-agent-sdk`、`agent-http`、Agent 进程级隔离                                                          |
| M4    | Watchdog：Probe/Detector/Incident/Playbook + 审批执行与回滚                                                                                                                    |
| M5    | `agent-deepseek`、`agent-codex-sdk`、Postgres Store、成本预算与配额                                                                                                            |

## 规划中的接入与宿主

当前插件为 `agent-echo`、`sink-dashboard` 和 `router-dsh`；宿主为 `server` 和 `dashboard`。其余接入通过插件扩展，具体目录随实现建立：

- Source：Webhook、Cron、飞书事件，以及后续 GitHub 等来源。
- Agent：Claude Code、Claude Agent SDK、Codex CLI / SDK、DeepSeek、通用 HTTP Agent。接入方式见[插件指南](plugins/README.md#agent-插件)。
- Sink：飞书、Webhook、邮件。
- Watchdog：独立宿主与核心探针 / Playbook，见 [Watchdog 设计](watchdog.md)。
- CLI：提交、查询、审批、重放入口，预期命令见[开发指南](development.md#常用命令)。
