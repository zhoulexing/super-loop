# 开发与验证

工程原则见 [AGENTS.md](../AGENTS.md)，命令以 [package.json](../package.json) 为准；验证时使用隔离运行目录。

## 技术栈

- 语言：TypeScript 5.x，`strict: true`，ESM only
- 运行时：Node.js ≥ 22.18.0（以根 `package.json` 为准）；本地使用 `.nvmrc` 指定的版本
- 包管理：pnpm workspaces；任务编排：Turborepo
- Schema / 运行时校验：zod（所有跨边界数据必须有 zod schema）
- 测试：vitest；格式化与 lint：Biome
- 存储：默认 SQLite（Node 内置 `node:sqlite`，零原生依赖），通过 `Store` 接口可替换为 Postgres
- HTTP：Hono；实时推送：SSE
- 看板：React + Vite + TanStack Query
- 版本管理：changesets
- 包作用域：`@super-loop/*`

## 包的构建约定

- 每个包的 `exports` 带自定义条件 `"@super-loop/source": "./src/index.ts"`：typecheck 与 vitest 通过该条件直接读源码，**开发与测试无需先 build**。
- `tsconfig.build.json` 关闭该条件，按 `types → dist` 解析，由 turbo 按拓扑顺序 build。
- 第三方依赖版本统一在 `pnpm-workspace.yaml` 的 `catalog` 中维护，包内写 `"catalog:"`。
- 新增包时同时补 `scripts/check-deps.ts` 中的规则，否则检查直接失败。

## 编码与验证约定

### TypeScript

- `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 开启。
- 禁止 `any`；确需时用 `unknown` + zod 解析。禁止 `// @ts-ignore`，必要时用 `// @ts-expect-error <原因>`。
- 跨包只通过包的 `exports` 入口导入，禁止深路径 `@super-loop/kernel/src/...`。
- 公共 API 使用具名导出；插件入口唯一默认导出 `definePlugin(...)`。
- 错误使用 `@super-loop/shared` 的 `LoopError(code, message, { cause, retryable })`，禁止抛字符串。
- 所有异步操作接受 `AbortSignal`；禁止无超时的 `await` 外部调用。
- 时间统一通过 `ctx.clock` 获取，禁止在内核/插件中直接 `Date.now()`（便于测试与回放）。
- 日志用结构化 logger（pino），必须带 `traceId` / `runId` 等上下文；禁止 `console.log`（CLI 输出除外）。

### 命名

- 包名：`@super-loop/<kind>-<name>`（插件），如 `@super-loop/agent-codex`。
- 文件：kebab-case；类型/类：PascalCase；函数/变量：camelCase；常量：SCREAMING_SNAKE_CASE。
- 事件类型：`<subject>.<past_tense_verb>`，如 `run.started`。

### 测试

- 测试文件放在各包 `test/` 下，命名 `*.test.ts`，由根目录 `vitest.config.ts` 统一运行。
- `kernel` 行覆盖率 ≥ 90%，必须包含：崩溃恢复、租约过期、重复投递、并发上限、重试与死信的测试。
- 每个插件必须通过 `@super-loop/testkit` 提供的**契约测试套件**（`runAgentContractTests` / `runSourceContractTests` / `runSinkContractTests`），参考 `plugins/agent-echo/test`。
- 需要时间的逻辑使用 `testkit` 的 `FakeClock`，需要存储的使用 `MemoryStore`，不要在测试里 mock 内部模块。
- 调用真实外部服务的测试放在 `*.e2e.test.ts`，默认不在 CI 跑，需 `E2E=1`。
- 子进程类 Agent 用录制的输出夹具（fixtures）做单测。

### 提交与 PR

- Conventional Commits：`feat(kernel): ...`、`fix(agent-codex): ...`，scope 为包名去前缀。
- 改动 `protocol` 或 `kernel` 的 PR 必须：附 changeset、说明兼容性影响；架构级改动需新增 ADR（`docs/adr/`）。
- PR 合并前必须通过 `pnpm check`（= `pnpm lint && pnpm typecheck && pnpm test && pnpm check:deps`）。

### 版本与兼容

- `protocol` 与插件 `apiVersion`：新增可选字段 → minor；删除/改语义 → major，并在内核中保留旧版本适配至少一个 major 周期。
- Journal 事件结构一旦发布不可修改，只能新增事件类型或可选字段；需要演进时用 `upcaster` 在读取时升级旧事件。

## 常用命令

```bash
pnpm install
pnpm dev                 # 同时启动 server（tsx watch，:7300）与看板开发服务器（Vite，:5173，/api 代理到 server）
pnpm --filter @super-loop/dashboard build   # 构建看板；之后 server 直接在 http://127.0.0.1:7300/ 托管
pnpm --filter @super-loop/server start   # 构建后以 dist 运行
pnpm build               # turbo 按拓扑顺序构建到 dist/
pnpm test                # 单测 + 契约测试（E2E=1 时包含 *.e2e.test.ts）
pnpm lint                # biome check；pnpm format 自动修复
pnpm typecheck
pnpm check:deps          # 校验AGENTS.md 中的依赖方向
pnpm check               # 以上全部，合并前必跑
pnpm changeset

# pnpm dev 使用仓库内的 .super-loop-dev/ 作为主目录，不会碰 ~/.super-loop；环境变量见 docs/runtime.md
curl -XPOST localhost:7300/api/v1/envelopes -H 'content-type: application/json' -d '{"subject":"hello"}'

# 以下为规划中的 CLI（当前尚未实现）
sloop submit "修复 issue #12" --agent claude-code:default --sink lark:ops
sloop runs ls --status running
sloop approvals ls
sloop replay --from-seq 1000   # 用 Journal 重建 Projection
```
