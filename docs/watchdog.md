# Watchdog 设计

本文为规划设计，独立宿主与自动修复能力尚未实现；阶段见[路线图](roadmap.md)。已定义的协议见 [watchdog.ts](../packages/protocol/src/watchdog.ts)，实施时须遵循 [AGENTS.md](../AGENTS.md) 的审批与隔离边界。

## 部署

`apps/watchdog` 是**独立进程**，只通过 Kernel API 和本机进程信息工作。内核不可达本身就是一个 Incident。推荐用 launchd / systemd / pm2 同时守护 server 与 watchdog。

## 流水线

```
Probe（采集） → Detector（判定） → Incident（去重/聚合） → Playbook（生成 Remediation）
      → Approval（人审） → Execute（执行） → Verify（验证） → Resolve / Rollback
```

内置 Probe：内核存活与 API 延迟、Journal 写入延迟、队列积压与等待时长、卡住的 Run（心跳超时）、各插件 health、错误率/重试率/死信增长、Sink 投递失败率、磁盘与 Blob 目录大小、单 Task 成本超预算。

## 修复动作与风险分级

| 风险       | 示例动作                                            | 审批                                         |
| ---------- | --------------------------------------------------- | -------------------------------------------- |
| `low`      | 采集诊断信息、重新投递失败通知                      | 可配置为自动执行（默认仍需审批）             |
| `medium`   | 取消卡住的 Run 并重试、重启某插件实例、暂停某 Route | 需审批                                       |
| `high`     | 禁用插件、批量重放死信、重启内核                    | 需审批                                       |
| `critical` | 由 Agent 生成代码补丁并提 PR、修改配置文件          | 需审批 + 二次确认；**只提 PR，永不自动合并** |

规则：

1. 每个 Remediation 必须包含：诊断依据、动作列表、预期效果、**回滚步骤**、验证条件。
2. 执行后必须运行 Verify；验证不通过自动执行回滚并重新打开 Incident。
3. 同一 Incident 的自动修复尝试次数有上限（默认 2），超过则只告警。
4. Watchdog 可以把“诊断这个 Incident”作为一个 Envelope 提交给 Loop（例如交给 Claude Code 分析日志），但生成的方案仍走审批。为防自激，Watchdog 发起的任务带 `labels.origin = watchdog`，其失败**不会**再触发 Watchdog 自修复。
5. Playbook 也是插件（`kind: 'playbook'`），声明它能处理的 Incident 类型。
