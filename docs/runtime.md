# 运行目录与配置

适用于宿主、插件文件访问与部署配置。准确配置 Schema 见 [host/config.ts](../packages/host/src/config.ts) 与 [kernel/config.ts](../packages/kernel/src/config.ts)，路径由 [host/paths.ts](../packages/host/src/paths.ts) 解析。

所有运行时文件（配置、密钥、数据库、日志、工作区）都放在**主目录**下，代码仓库里不放任何运行时数据。路径解析统一由 `@super-loop/host` 的 `resolveLayout()` 完成，server / cli / watchdog 必须使用它，**禁止各自拼路径**。

## 目录布局

```
~/.super-loop/                        主目录，SUPER_LOOP_HOME 可覆盖（权限 0700）
├── config.json                       主配置，首次启动自动生成（0600）
├── secrets.env                       密钥 KEY=VALUE（0600，权限过宽会告警）
│
├── db/loop.db (+ -wal, -shm)         系统状态：只有内核读写，禁止手动修改
│
├── attachments/<YYYY-MM-DD>/<ULID>-<文件名>   外部带进来的附件（Source / API）
├── workspaces/<taskId>/              每个任务（会话）一个
│   ├── work/                         Agent 工作目录（cwd），多轮对话共用：git worktree、中间文件，临时
│   └── artifacts/<runId>/            交付结果：Run 结束时自动扫描登记为产物
│
├── shared/                           用户维护的共享资料（规范、知识文档），Agent 只读
├── state/<plugin>/<instance>/        插件实例的持久状态（CLI 会话、登录态），跨 Run 保留
├── cache/<plugin>/                   可随时删除的缓存（git 镜像、依赖缓存）
│
├── plugins/                          本地自定义插件，config 中用 "file:./plugins/xxx/index.js" 引用
├── logs/                             server.log、watchdog.log（同时输出到 stdout）
├── run/server.lock                   单实例锁（pid）
└── backups/db/                       数据库快照
```

**分区原则：系统状态与内容分开放**，各自可以独立搬迁、备份与清理。

| 区域                                      | 谁写                              | 丢失影响                       | 备份 / 清理                              |
| ----------------------------------------- | --------------------------------- | ------------------------------ | ---------------------------------------- |
| `db/`                                     | 只有内核                          | Loop 无法启动                  | `VACUUM INTO` 一致性快照到 `backups/db/` |
| `attachments/`、`workspaces/*/artifacts/` | 插件（Agent 可直接写 artifacts/） | 只影响对应记录（API 返回 404） | 普通文件拷贝 / 同步；按保留期清理        |
| `workspaces/*/work/`                      | Agent                             | 无，重跑可重建                 | 任务关闭 N 天后删除（保留 artifacts/）   |
| `shared/`                                 | 人                                | 用户资料                       | 用户自己管理，Loop 不删除                |
| `state/`                                  | 插件实例                          | 会话、登录态丢失，无法续跑     | 不自动清理                               |
| `cache/`                                  | 内核 / 插件                       | 无，自动重建                   | 随时可删                                 |

- **一个主目录 = 一套独立的 Loop**（独立的库、配置、锁）。需要多套环境时用不同的 `SUPER_LOOP_HOME`。
- 本地开发：`pnpm dev` 使用仓库内的 `.super-loop-dev/`（已 gitignore），不影响 `~/.super-loop`。
- 测试：一律使用临时目录作为主目录，禁止读写真实的 `~/.super-loop`。
- 上次异常退出留下的锁，如果对应进程已不存在，会被自动清理。

## config.json

以下为配置结构示意，包含尚未实现的 Claude Code、飞书等插件；可运行的默认配置以 `apps/server/src/default-config.ts` 为准。

```jsonc
{
  "server": {
    "host": "127.0.0.1", // 默认只监听本机
    "port": 7300,
    "publicUrl": "https://loop.example.com", // 通知里的链接前缀，默认 http://<host>:<port>
    "token": "${secret:API_TOKEN}" // 设置后 API 需要 Bearer Token
  },
  "plugins": {
    // 实例名 "<plugin>:<instance>" → 插件包名（或 file: 本地路径）+ 插件配置
    "claude-code:default": {
      "use": "@super-loop/agent-claude-code",
      "config": { "model": "claude-opus-5-5" },
      "description": "写代码、修 bug、排查线上问题" // Router 据此判断派给谁
    },
    "router-dsh:default": {
      "use": "@super-loop/router-dsh",
      "config": { "provider": "openai", "model": "gpt-5.4-mini", "apiKeySecret": "OPENAI_API_KEY" }
    },
    "lark:ops": {
      "use": "@super-loop/sink-lark",
      "config": { "chatId": "${secret:LARK_OPS_CHAT}" }
    },
    "mine:default": { "use": "file:./plugins/my-agent/index.js", "enabled": false }
  },
  "routes": [
    { "name": "default", "agents": [{ "agent": "claude-code:default" }] },
    // 手动分配：进入看板"未分配"列，agents 作为候选
    { "name": "triage", "assign": "manual", "match": { "source": ["lark-event:*"] }, "agents": [] },
    // 交给 Router 在候选中选择
    { "name": "smart", "assign": "router", "match": { "source": ["webhook:*"] }, "agents": [] }
  ],
  "defaults": {
    "sinks": [{ "sink": "dashboard:default", "on": ["succeeded", "failed", "approval_required"] }],
    "unrouted": "triage", // 未匹配 Route 的消息：triage 进入"未分配"，router 交给 defaults.router，drop 只记录
    "router": "router-dsh:default" // 默认的 Router 实例
  },
  "limits": {
    "globalConcurrency": 4,
    "maxSpawnDepth": 3,
    "idleCloseMs": 604800000,
    "routing": { "batchSize": 10, "timeoutMs": 120000, "maxAttempts": 3 }
  }
}
```

- 顶层只允许 `server`、`plugins`、`routes`、`defaults`、`limits`（拼错字段直接报错）。除 `server` 外的字段结构与 `KernelConfigInput` 一致，由内核做完整校验。
- `plugins.*.use` 的解析：`file:` 开头的路径相对主目录；其余先查宿主应用的**内置插件表**（`apps/server/src/plugins.ts`），再 `import(包名)`。插件包的默认导出必须是插件定义。
- 默认配置在 `apps/server/src/default-config.ts`，只在 `config.json` 不存在时写入一次，之后以用户文件为准。
- 看板中创建的 Route 存在数据库里；同名时 `config.json` 中的定义会在启动时覆盖数据库中的版本。

## 文件与目录访问

**文件引用（`FileRef`）**：数据库里只存逻辑地址，读取时再按当前配置的目录解析，所以目录可以整体搬迁。

| 类型 | 引用格式                                  | 实际位置                                  |
| ---- | ----------------------------------------- | ----------------------------------------- |
| 附件 | `attachment:<YYYY-MM-DD>/<ULID>-<文件名>` | `attachments/<日期>/…`                    |
| 产物 | `artifact:<taskId>/<runId>/<相对路径>`    | `workspaces/<taskId>/artifacts/<runId>/…` |

**插件怎么写文件**：

- `ctx.files.put(data, { name, mime? })` 的写入位置由上下文决定：插件级上下文（Source 等）写**附件**，Agent 的 Run 上下文写**本次 Run 的产物**。`ctx.files.get(ref)` 两类都能读，Agent 可以读消息带来的附件。
- Agent 也可以直接把文件写进 `ctx.paths.artifacts`（CLI 类 Agent 最方便）。Run 结束时内核自动扫描该目录，结果记在 `Run.artifacts`。
- **想让人看到的东西必须放进 artifacts/**。`work/` 里的任何内容都视为随时会被删除。
- 跨任务传递文件用引用（`artifact:<taskId>/<runId>/…`），不要往共享目录里写，保证来源可追溯。

**目录权限**：插件在 `permissions` 中声明后，才能在 `ctx.paths` 里拿到对应目录。

| 权限                   | `ctx.paths`         | 目录                                                                                |
| ---------------------- | ------------------- | ----------------------------------------------------------------------------------- |
| （Run 上下文总是提供） | `work`、`artifacts` | `workspaces/<taskId>/work/`、`…/artifacts/<runId>/`                                 |
| `fs:shared:read`       | `shared`            | `shared/`（只读）                                                                   |
| `fs:state`             | `state`             | `state/<plugin>/<instance>/`；同一实例的多个 Run 可能同时运行，并发写由插件自己加锁 |
| `fs:cache`             | `cache`             | `cache/<plugin>/`，同一插件的所有实例共用                                           |

**安全约束**（`@super-loop/host` 的 `createFsContent` 实现）：

- 文件名清洗：去掉路径分隔符、`..`、控制字符，最长 200 字符；同名产物自动加序号。
- 引用中的 `..`、空段一律拒绝；读取时校验真实路径，**指向目录外的符号链接返回 `PERMISSION_DENIED`**，也不会被登记为产物。
- 单个文件默认上限 50MB。
- `GET /api/v1/files?ref=` 下载时带 `content-security-policy: sandbox` 与 `nosniff`，防止 Agent 产出的 HTML 在 API 源下执行。

## 密钥

- 密钥只能用 `${secret:NAME}`（先查 `secrets.env`，再查环境变量）或 `${env:NAME}` 引用，**禁止明文写入 config.json 或提交到仓库**。
- 引用的变量不存在时拒绝启动，错误信息带 JSON 路径（如 `$.plugins.lark:ops.config.chatId: secret LARK_OPS_CHAT is not set`）。
- 插件运行时通过 `ctx.secrets.get(name)` 读取，来源同上。

## 优先级与环境变量

优先级：**环境变量 > config.json > 内置默认值**。配置在加载时完整校验，校验失败拒绝启动。

| 环境变量                              | 作用                               | 默认                           |
| ------------------------------------- | ---------------------------------- | ------------------------------ |
| `SUPER_LOOP_HOME`                     | 主目录                             | `~/.super-loop`                |
| `SUPER_LOOP_DB_DIR`                   | 数据库目录                         | `$SUPER_LOOP_HOME/db`          |
| `SUPER_LOOP_ATTACHMENTS_DIR`          | 附件目录                           | `$SUPER_LOOP_HOME/attachments` |
| `SUPER_LOOP_WORKSPACES_DIR`           | 工作区目录（含产物）               | `$SUPER_LOOP_HOME/workspaces`  |
| `SUPER_LOOP_HOST` / `SUPER_LOOP_PORT` | 覆盖 `server.host` / `server.port` | `127.0.0.1` / `7300`           |
| `SUPER_LOOP_PUBLIC_URL`               | 覆盖 `server.publicUrl`            | `http://<host>:<port>`         |
| `SUPER_LOOP_API_TOKEN`                | 覆盖 `server.token`                | 无                             |
| `SUPER_LOOP_LOG_LEVEL`                | 日志级别                           | `info`                         |
| `SUPER_LOOP_DASHBOARD_DIR`            | 看板构建产物目录（server 托管）    | `apps/dashboard/dist`          |
| `SUPER_LOOP_API_URL`                  | 看板开发服务器代理 `/api` 的目标   | `http://127.0.0.1:7300`        |

新增环境变量必须使用 `SUPER_LOOP_` 前缀，并登记到本表和 `turbo.json` 的 `globalEnv`。
