import type {
  AgentBinding,
  Envelope,
  InstanceName,
  JsonPathCondition,
  Priority,
  Route,
  RouteId,
  RouteMatch,
  SinkBinding,
  TaskPolicy,
} from '@super-loop/protocol';
import { getPath } from '@super-loop/shared';

export interface ResolvedBinding {
  routeId?: RouteId;
  /** 为空表示手动分配（Task 进入 unassigned）。 */
  agent?: AgentBinding;
  /** 手动分配（或交给 Router）时的候选 Agent。 */
  candidates?: AgentBinding[];
  /** 交给哪个 Router 插件实例判断（此时 agent 为空）。 */
  router?: InstanceName;
  sinks: SinkBinding[];
  policy: TaskPolicy;
  priority: Priority;
  closeOnComplete?: boolean;
}

export interface RouterDefaults {
  policy: TaskPolicy;
  priority: Priority;
  /** defaults.router：Route 的 assign 为 router 但没指定实例时使用。 */
  router?: InstanceName | undefined;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function safeRegExp(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

function matchCondition(envelope: Envelope, c: JsonPathCondition): boolean {
  const actual = getPath(envelope, c.path);
  switch (c.op) {
    case 'exists':
      return actual !== undefined;
    case 'eq':
      return jsonEqual(actual, c.value);
    case 'in':
      return Array.isArray(c.value) && c.value.some((v) => jsonEqual(actual, v));
    case 'regex': {
      const re = typeof c.value === 'string' ? safeRegExp(c.value) : undefined;
      return typeof actual === 'string' && re !== undefined && re.test(actual);
    }
  }
}

/** 所有给出的条件都满足才命中（AND）。空条件匹配一切。 */
export function matchRoute(match: RouteMatch, envelope: Envelope): boolean {
  if (match.kind && !match.kind.includes(envelope.kind)) return false;
  if (match.source && !match.source.some((g) => globToRegExp(g).test(envelope.source.instance))) {
    return false;
  }
  if (match.labels) {
    for (const [k, v] of Object.entries(match.labels)) {
      if (envelope.labels?.[k] !== v) return false;
    }
  }
  if (match.subjectRegex !== undefined) {
    const re = safeRegExp(match.subjectRegex);
    if (!re?.test(envelope.subject)) return false;
  }
  return (match.jsonPath ?? []).every((c) => matchCondition(envelope, c));
}

/**
 * 决定一个 Envelope 生成哪些 Task：
 * 1. directives.agents 存在 → 只用 directives（显式指定优先于 Route）；
 * 2. directives.skipRoutes → 不匹配 Route；
 * 3. 否则按 order 匹配启用的 Route，stopOnMatch 为 false 时继续匹配（扇出）；
 *    assign 为 manual 的 Route 生成一个不带 Agent 的绑定，agents 作为候选；
 *    assign 为 router 的 Route 同样不带 Agent，并标记交给哪个 Router。
 * directives.sinks 总是追加到结果上。返回空数组表示未路由（由内核按 defaults.unrouted 处理）。
 */
export function resolveBindings(
  envelope: Envelope,
  routes: readonly Route[],
  defaults: RouterDefaults,
): ResolvedBinding[] {
  const d = envelope.directives;
  const extraSinks = d?.sinks ?? [];
  const priority = d?.priority ?? defaults.priority;

  if (d?.agents?.length) {
    return d.agents.map((agent) => ({
      agent,
      sinks: extraSinks,
      policy: defaults.policy,
      priority,
    }));
  }
  if (d?.skipRoutes) return [];

  const out: ResolvedBinding[] = [];
  const ordered = routes
    .filter((r) => r.enabled)
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  for (const route of ordered) {
    if (!matchRoute(route.match, envelope)) continue;
    const common = {
      routeId: route.id,
      sinks: [...route.sinks, ...extraSinks],
      policy: route.policy,
      priority,
      ...(route.closeOnComplete === undefined ? {} : { closeOnComplete: route.closeOnComplete }),
    };
    if (route.assign === 'router') {
      const router = route.router ?? defaults.router;
      out.push({
        ...common,
        ...(route.agents.length ? { candidates: route.agents } : {}),
        ...(router ? { router } : {}),
      });
    } else if (route.assign === 'manual' || route.agents.length === 0) {
      out.push({ ...common, ...(route.agents.length ? { candidates: route.agents } : {}) });
    } else {
      for (const agent of route.agents) out.push({ ...common, agent });
    }
    if (route.stopOnMatch) break;
  }
  return out;
}

/** 校验 Route 中的正则，返回错误列表（用于加载配置时提前报错）。 */
export function validateRoute(
  route: Pick<Route, 'name' | 'match' | 'assign' | 'agents'>,
): string[] {
  const errors: string[] = [];
  if (route.assign === 'auto' && route.agents.length === 0) {
    errors.push(`route "${route.name}": assign "auto" requires at least one agent`);
  }
  if (route.match.subjectRegex !== undefined && !safeRegExp(route.match.subjectRegex)) {
    errors.push(`route "${route.name}": invalid subjectRegex`);
  }
  for (const c of route.match.jsonPath ?? []) {
    if (c.op === 'regex' && (typeof c.value !== 'string' || !safeRegExp(c.value))) {
      errors.push(`route "${route.name}": invalid regex for ${c.path}`);
    }
  }
  return errors;
}
