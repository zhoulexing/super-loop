# 文档导航

[AGENTS.md](../AGENTS.md) 维护全局工程原则。按修改范围阅读对应文档；字段与校验以所属源码为准，ADR 保留决策背景。

| 主题                                  | 维护内容                                            | 实现入口                                                                                   |
| ------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| [消息流与内核机制](architecture.md)   | Inbox / Outbox、消息记录、状态机、存储与审批        | [kernel](../packages/kernel/src/kernel.ts)、[protocol](../packages/protocol/src/index.ts)  |
| [插件开发](plugins/README.md)         | 创建与验证插件，Source / Agent / Sink / Router 契约 | [插件协议](../packages/protocol/src/plugin.ts)、[SDK](../packages/plugin-sdk/src/index.ts) |
| [运行目录与配置](runtime.md)          | 主目录、文件权限、配置、环境变量与密钥              | [host](../packages/host/src/index.ts)、[内核配置](../packages/kernel/src/config.ts)        |
| [看板与 Kernel API](dashboard-api.md) | 看板交互、HTTP / SSE 与客户端协议                   | [API Schema](../packages/protocol/src/api.ts)、[server](../apps/server/src/app.ts)         |
| [开发与验证](development.md)          | 技术栈、构建、编码、测试、版本与开发命令            | [根脚本](../package.json)、[依赖检查](../scripts/check-deps.ts)                            |
| [Watchdog 设计](watchdog.md)          | 规划中的监测、修复与独立宿主                        | [Watchdog 协议](../packages/protocol/src/watchdog.ts)                                      |
| [实施路线](roadmap.md)                | 已实现范围、阶段与规划能力                          | 以当前代码和验证记录核实进展                                                               |

## 架构决策

- [0001：Monorepo 与插件化架构](adr/0001-monorepo-and-plugin-architecture.md)
- [0002：Task 会话模型](adr/0002-task-as-conversation.md)
- [0003：Router 插件](adr/0003-router-plugin.md)
- [0004：Inbox / Outbox 术语](adr/0004-inbox-outbox.md)
