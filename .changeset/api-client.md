---

"@super-loop/client": minor
"@super-loop/protocol": minor
"@super-loop/kernel": patch
"@super-loop/server": patch
---

新增 `@super-loop/client`：Kernel API 的类型安全客户端（tasks / envelopes / approvals / files / journal 等分组方法、统一的 `LoopApiError`、`paginate`），以及基于 fetch 的 SSE 订阅（可带鉴权头，断线按退避重连并用 Last-Event-ID 续传）。API 请求体 schema 与响应类型移到 `protocol/src/api.ts`，由 server 与 client 共用。
