/** 按点路径取值：`getPath({a:{b:1}}, 'a.b') === 1`。 */
export function getPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/**
 * 极简模板：`{{ envelope.subject }}`。
 * 缺失值渲染为空串，对象渲染为 JSON。不支持逻辑，复杂渲染交给 Sink 自己做。
 */
export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER, (_, path: string) => {
    const value = getPath(vars, path);
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  });
}

const REF = /\$\{(env|secret):([A-Za-z_][A-Za-z0-9_]*)\}/g;

export type RefKind = 'env' | 'secret';

/**
 * 递归替换字符串中的 `${env:NAME}` / `${secret:NAME}`。
 * `lookup` 返回 undefined 时抛错，错误信息带 JSON 路径，便于定位配置问题。
 */
export function interpolateRefs(
  value: unknown,
  lookup: (kind: RefKind, name: string) => string | undefined,
  path = '$',
): unknown {
  if (typeof value === 'string') {
    return value.replace(REF, (_, kind: RefKind, name: string) => {
      const v = lookup(kind, name);
      if (v === undefined) throw new Error(`${path}: ${kind} ${name} is not set`);
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v, i) => interpolateRefs(v, lookup, `${path}[${i}]`));
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, interpolateRefs(v, lookup, `${path}.${k}`)]),
    );
  }
  return value;
}
