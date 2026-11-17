---

"@super-loop/protocol": minor
"@super-loop/kernel": minor
"@super-loop/shared": minor
"@super-loop/host": minor
"@super-loop/testkit": minor
"@super-loop/store-sqlite": minor
"@super-loop/server": minor
---

Task 改为会话模型（ADR 0002）：新增 Turn、追问 / 打断、手动分配（`assign: manual`、`defaults.unrouted: triage`）、关闭 / 重新打开、空闲自动关闭、按 rank 排序；工作区改为按任务分配，产物引用改为 `artifact:<taskId>/<runId>/<path>`。
