import { DEFAULT_TASK_POLICY, type Route } from '@super-loop/protocol';
import { newId } from '@super-loop/shared';
import { makeEnvelope } from '@super-loop/testkit';
import { describe, expect, it } from 'vitest';
import { matchRoute, resolveBindings, validateRoute } from '../src/index.js';

const defaults = { policy: DEFAULT_TASK_POLICY, priority: 2 as const };

function route(name: string, patch: Partial<Route> = {}): Route {
  return {
    id: newId('route'),
    name,
    enabled: true,
    order: 0,
    match: {},
    agents: [{ agent: `echo:${name}` }],
    sinks: [],
    policy: DEFAULT_TASK_POLICY,
    stopOnMatch: true,
    ...patch,
  };
}

describe('matchRoute', () => {
  const env = makeEnvelope({
    kind: 'event',
    source: { plugin: 'source-webhook', instance: 'webhook:github' },
    subject: 'PR #12 opened',
    labels: { repo: 'super-loop' },
    payload: { action: 'opened', pr: { number: 12 } },
  });

  it('空条件匹配一切', () => expect(matchRoute({}, env)).toBe(true));

  it('kind / source glob / labels / subjectRegex', () => {
    expect(matchRoute({ kind: ['event'] }, env)).toBe(true);
    expect(matchRoute({ kind: ['task'] }, env)).toBe(false);
    expect(matchRoute({ source: ['webhook:*'] }, env)).toBe(true);
    expect(matchRoute({ source: ['cron:*'] }, env)).toBe(false);
    expect(matchRoute({ labels: { repo: 'super-loop' } }, env)).toBe(true);
    expect(matchRoute({ labels: { repo: 'other' } }, env)).toBe(false);
    expect(matchRoute({ subjectRegex: '^PR #\\d+' }, env)).toBe(true);
  });

  it('jsonPath 条件', () => {
    expect(
      matchRoute({ jsonPath: [{ path: 'payload.action', op: 'eq', value: 'opened' }] }, env),
    ).toBe(true);
    expect(
      matchRoute({ jsonPath: [{ path: 'payload.action', op: 'in', value: ['closed'] }] }, env),
    ).toBe(false);
    expect(matchRoute({ jsonPath: [{ path: 'payload.pr.number', op: 'exists' }] }, env)).toBe(true);
    expect(
      matchRoute({ jsonPath: [{ path: 'payload.action', op: 'regex', value: '^op' }] }, env),
    ).toBe(true);
  });

  it('非法正则不匹配，并能被 validateRoute 发现', () => {
    expect(matchRoute({ subjectRegex: '(' }, env)).toBe(false);
    expect(validateRoute({ name: 'bad', match: { subjectRegex: '(' } })).toHaveLength(1);
  });
});

describe('resolveBindings', () => {
  const a = route('a', { order: 1 });
  const b = route('b', { order: 2, stopOnMatch: false });
  const c = route('c', { order: 3 });

  it('按 order 匹配，stopOnMatch 停止', () => {
    expect(resolveBindings(makeEnvelope(), [c, b, a], defaults).map((x) => x.agent.agent)).toEqual([
      'echo:a',
    ]);
  });

  it('stopOnMatch=false 时扇出', () => {
    const r = resolveBindings(makeEnvelope(), [c, b], defaults);
    expect(r.map((x) => x.agent.agent)).toEqual(['echo:b', 'echo:c']);
  });

  it('禁用的 Route 跳过', () => {
    expect(resolveBindings(makeEnvelope(), [{ ...a, enabled: false }], defaults)).toEqual([]);
  });

  it('directives.agents 优先于 Route，directives.sinks 追加', () => {
    const env = makeEnvelope({
      directives: {
        agents: [{ agent: 'codex:default' }],
        sinks: [{ sink: 'lark:ops', on: ['failed'] }],
        priority: 0,
      },
    });
    const r = resolveBindings(env, [a], defaults);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ agent: { agent: 'codex:default' }, priority: 0 });
    expect(r[0]?.routeId).toBeUndefined();
    expect(r[0]?.sinks).toEqual([{ sink: 'lark:ops', on: ['failed'] }]);

    const viaRoute = resolveBindings(
      makeEnvelope({ directives: { sinks: [{ sink: 'lark:ops', on: ['failed'] }] } }),
      [{ ...a, sinks: [{ sink: 'dashboard:default', on: ['succeeded'] }] }],
      defaults,
    );
    expect(viaRoute[0]?.sinks.map((s) => s.sink)).toEqual(['dashboard:default', 'lark:ops']);
  });

  it('skipRoutes 且没有 agents → 不路由', () => {
    expect(
      resolveBindings(makeEnvelope({ directives: { skipRoutes: true } }), [a], defaults),
    ).toEqual([]);
  });
});
