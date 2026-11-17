---

"@super-loop/dashboard": minor
"@super-loop/server": minor
"@super-loop/protocol": patch
"@super-loop/kernel": patch
---

新增任务看板 `apps/dashboard`（React + Vite + TanStack Query）：七列状态看板、拖拽分配 / 排序 / 追问 / 关闭 / 重新打开、按 Agent 泳道、对话抽屉（对话 / 产物 / 执行记录、排队或打断发送、附件上传）、审批、新建任务、SSE 实时刷新、深浅色。server 在 `/` 托管构建产物（SPA 回落、CSP、防目录穿越）。`/plugins` 返回 Agent 的 capabilities，`/health` 返回并发上限。
