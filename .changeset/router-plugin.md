---

"@super-loop/protocol": minor
"@super-loop/kernel": minor
"@super-loop/plugin-sdk": minor
"@super-loop/testkit": minor
"@super-loop/host": patch
"@super-loop/server": minor
"@super-loop/dashboard": patch
"@super-loop/router-dsh": minor
---

新增 Router 插件类型：Route `assign: router` 或 `defaults.unrouted: router` 的消息先生成未分配的 Task，由内核分批交给 Router 插件判断派给哪个 Agent（`Task.routing`、`routing.*` 事件、重试 / 兜底 / 崩溃恢复，人可随时接管）。插件配置支持 `description`。新增内置插件 `@super-loop/router-dsh`：基于 `@deepseek-ai/dsh-sdk-client` 驱动一个长驻、可恢复的路由会话，工具通过本地 MCP 提供。testkit 新增 `defineTestRouter`、`runRouterContractTests`；看板显示路由状态与理由。
