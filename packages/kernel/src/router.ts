import type {
  AgentBinding,
  Envelope,
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
  agent: AgentBinding;
  sinks: SinkBinding[];
  policy: TaskPolicy;
  priority: Priority;
}

export interface RouterDefaults {
  policy: TaskPolicy;
  priority: Priority;
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
 * 3. 否则按 order 匹配启用的 Route，stopOnMatch 为 false 时继续匹配（扇出）。
 * directives.sinks 总是追加到结果上。
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
    for (const agent of route.agents) {
      out.push({
        routeId: route.id,
        agent,
        sinks: [...route.sinks, ...extraSinks],
        policy: route.policy,
        priority,
      });
    }
    if (route.stopOnMatch) break;
  }
  return out;
}

/** 校验 Route 中的正则，返回错误列表（用于加载配置时提前报错）。 */
export function validateRoute(route: Pick<Route, 'name' | 'match'>): string[] {
  const errors: string[] = [];
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
