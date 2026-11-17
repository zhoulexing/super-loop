import type { InstanceName, RiskLevel, Usage } from '@super-loop/protocol';

const toMs = (t: string | number) => (typeof t === 'number' ? t : Date.parse(t));

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前。 */
export function ago(t: string | number, now = Date.now()): string {
  const s = Math.max(0, (now - toMs(t)) / 1000);
  if (s < 45) return '刚刚';
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

/** 剩余时间：N 分钟后 / N 小时后。 */
export function until(t: string | number, now = Date.now()): string {
  const s = Math.max(0, (toMs(t) - now) / 1000);
  if (s < 60) return `${Math.ceil(s)}s 后`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟后`;
  return `${Math.round(s / 3600)} 小时后`;
}

export function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

export const ktok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export const tokens = (u: Usage | undefined) => (u ? u.inputTokens + u.outputTokens : 0);

export const bytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${(n / 1024).toFixed(1)} KB`
      : `${(n / 1024 ** 2).toFixed(1)} MB`;

export const RISK_LABEL: Record<RiskLevel, string> = {
  low: '低',
  medium: '中',
  high: '高',
  critical: '极高',
};

/** 来源实例名的展示文案。 */
export function sourceLabel(instance: InstanceName): string {
  if (instance === 'manual:api') return '手动提交';
  const [kind, name] = instance.split(':') as [string, string];
  if (kind === 'spawn') return `派生 · ${name}`;
  const KIND: Record<string, string> = { cron: '定时', webhook: 'Webhook', lark: '飞书' };
  return KIND[kind] ? `${KIND[kind]} · ${name}` : instance;
}

/** Agent 实例名的短名：`claude-code:default` → `claude-code`，非 default 实例保留全名。 */
export function agentName(instance: string): string {
  const [plugin, name] = instance.split(':');
  return name === 'default' ? (plugin ?? instance) : instance;
}
