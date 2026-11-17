# 看板与 Kernel API

接口 Schema 与返回类型以 [protocol/api.ts](../packages/protocol/src/api.ts) 为准，HTTP 实现见 [server/app.ts](../apps/server/src/app.ts)，客户端见 [client](../packages/client/src/index.ts)。

只通过 `@super-loop/client` 调用 Kernel API，不直连数据库。

**M2 已实现：任务看板**（设计以已确认的原型为准，改视觉先改原型）：

- 七列按状态：未分配 / 排队中 / 执行中 / 待审批（`pending_approval` + `waiting_approval`）/ 等待追问 / 失败 / 已关闭（默认折叠）；执行中、待审批由系统推进，不能拖入。
- 拖拽只表达人的决定（规则在 `apps/dashboard/src/lib/board.ts`，有单测）：未分配 → 排队 = 分配；排队内上下拖 = 调整顺序（同步优先级）；等待追问 / 失败 → 排队 = 追问 / 重试 / 换 Agent；任意 → 已关闭；已关闭 → 等待追问 = 重新打开；按 Agent 分泳道时跨泳道 = 改派。
- 点卡片打开右侧抽屉（地址 `/tasks/<id>`，通知里的链接直接定位）：对话 / 产物 / 执行记录；执行中发消息默认排队，可"打断并发送"；可上传附件。
- 实时：SSE 事件触发对应查询刷新（合并 150ms），断线自动重连并全量刷新。
- 安全：产物预览只显示文本源码或图片，不渲染 HTML；看板页面带 CSP（只允许同源脚本与接口）。
- 配置了 token 时，看板首次打开会要求输入（存在浏览器 localStorage，也可用 `/?token=` 一次性带入）。

完整版还需要提供的视图：

1. **总览**：吞吐、成功率、队列深度、运行中 Run、成本、各插件健康。
2. **消息流（Inbox）**：所有 Envelope 时间线，可按来源/标签/状态筛选；点开看完整生命周期（Envelope → Task → Runs → Deliveries）。
3. **Run 详情**：实时事件流（SSE）、工具调用、产物、用量、重试历史；支持取消、重试、续跑。
4. **路由**：Route 列表、可视化编辑、匹配测试（贴一个 Envelope 看会命中哪些规则）。
5. **定时任务**：cron 列表、下次触发时间、手动触发、暂停。
6. **插件**：实例列表、配置（敏感字段脱敏）、健康、启停。
7. **审批**：待审批列表，批准/拒绝/评论。
8. **Watchdog**：Incident、Remediation、执行与回滚记录。
9. **审计**：原始 Journal 浏览器（按 seq / traceId 查）。
10. **手动提交**：表单提交 Envelope，选择 Agent 与 Sink。

## Kernel API 约定

- 前缀 `/api/v1`，JSON，字段 camelCase，时间 ISO8601 UTC。已发布 API 只增不改，破坏性变更走 `/api/v2`。
- 请求体 schema 与响应类型定义在 `protocol/src/api.ts`，server 用它校验、`@super-loop/client` 用它的类型；新增接口时两边一起改，并在 `apps/server/test/client.test.ts` 补用例。
- 列表接口统一游标分页：`?cursor=&limit=`，返回 `{ items, nextCursor }`。
- 错误统一：`{ error: { code, message, details? } }`，`code` 为 `SCREAMING_SNAKE_CASE`。
- 实时：`GET /api/v1/stream?fromSeq=` 以 SSE 推送 Journal 事件，断线可续。
- 鉴权：配置了 `server.token`（或 `SUPER_LOOP_API_TOKEN`）后需要 `Authorization: Bearer <token>`（`/health` 除外）；操作人取自 `x-loop-user` 头，记为 `user:<name>`，所有写操作记录 `actor`。
- 错误码 → HTTP：`INVALID_INPUT` 400、`PERMISSION_DENIED` 403、`NOT_FOUND` 404、`CONFLICT` 409、`SPAWN_DEPTH_EXCEEDED` 422、`UNAVAILABLE` 503、其它 500。

已实现的接口（`apps/server/src/app.ts`）：

| 方法  | 路径                                                         | 说明                                                                                             |
| ----- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| GET   | `/health`                                                    | 内核状态、运行中 Run 数、最新 seq、插件状态                                                      |
| GET   | `/plugins` · `/routes`                                       | 插件实例（含健康检查）、生效的路由                                                               |
| POST  | `/envelopes`                                                 | 提交消息；`kind` 默认 `task`，`idempotencyKey` 可省略。新建 201，重复 200 + `duplicated: true`   |
| GET   | `/envelopes` · `/envelopes/:id`                              | 消息列表 / 详情（含派生的 Task）                                                                 |
| GET   | `/tasks?status=a,b` · `/tasks/:id`                           | 任务列表（状态可逗号分隔多个）/ 详情（含 Envelope、所有 Turn 与 Run）                            |
| GET   | `/tasks/:id/turns`                                           | 会话轮次                                                                                         |
| POST  | `/tasks/:id/messages`                                        | 追问 `{ content, mode?: 'queue' \| 'interrupt', attachments? }`，已关闭的任务会自动重新打开，201 |
| POST  | `/tasks/:id/assign` · `/tasks/:id/unassign`                  | 分配 / 改派 Agent `{ agent, prompt?, options? }`；排队中退回未分配                               |
| POST  | `/tasks/:id/retry`                                           | 重试失败的任务 `{ agent? }`（可同时换 Agent）                                                    |
| POST  | `/tasks/:id/close` · `/tasks/:id/reopen`                     | 关闭（执行中会中止当前 Run）`{ reason? }` / 重新打开；`/cancel` 为 close 的别名                  |
| PATCH | `/tasks/:id`                                                 | 调整 `{ priority?, rank? }`（看板拖拽排序）                                                      |
| GET   | `/runs/:id`                                                  | Run 详情与它的事件流                                                                             |
| GET   | `/approvals?status=` · POST `/approvals/:id/decision`        | 审批列表 / 决策 `{ decision: 'grant' \| 'reject', comment? }`                                    |
| GET   | `/deliveries?status=` · `/notifications?sink=`               | 投递记录 / 看板收件箱（默认 `dashboard:default`，新的在前）                                      |
| GET   | `/files?ref=&download=1`                                     | 下载附件 / 产物（不存在 404，非法引用 400）                                                      |
| POST  | `/files?name=`                                               | 上传附件（请求体为原始字节，content-type 为 MIME），返回 FileRef，201                            |
| GET   | `/journal?fromSeq=&traceId=&subjectId=` · `/stream?fromSeq=` | 事件日志查询 / SSE（支持 `Last-Event-ID` 续传，15s 心跳）                                        |
