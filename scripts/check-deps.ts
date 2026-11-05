/**
 * 校验 AGENTS.md 第 4.3 节的依赖方向。
 * 1. package.json 中声明的 @super-loop/* 依赖必须在白名单内；
 * 2. 源码中 import 的 @super-loop/* 必须已声明且允许，禁止深路径导入；
 * 3. 插件之间禁止互相依赖；apps/watchdog 禁止依赖 kernel。
 * 运行：node scripts/check-deps.ts
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SCOPE = '@super-loop/';

interface Pkg {
  dir: string;
  name: string;
  group: 'packages' | 'plugins' | 'apps';
  deps: string[];
  devDeps: string[];
}

/** 运行时依赖白名单（devDependencies 额外允许 testkit）。'*' 表示任意。 */
const RULES: Record<string, string[] | '*'> = {
  protocol: [],
  shared: ['protocol'],
  'plugin-sdk': ['protocol', 'shared'],
  testkit: ['protocol', 'shared', 'plugin-sdk'],
  kernel: ['protocol', 'shared'],
  host: ['protocol', 'shared'],
  'store-*': ['protocol', 'shared'],
  'plugins/*': ['protocol', 'shared', 'plugin-sdk'],
  'apps/watchdog': ['protocol', 'shared', 'plugin-sdk'],
  'apps/*': '*',
};

function allowedFor(pkg: Pkg): string[] | '*' {
  const short = pkg.name.slice(SCOPE.length);
  if (pkg.group === 'plugins') return RULES['plugins/*'] as string[];
  if (pkg.group === 'apps') return RULES[`apps/${short}`] ?? RULES['apps/*'] ?? '*';
  if (short.startsWith('store-')) return RULES['store-*'] as string[];
  const rule = RULES[short];
  if (!rule)
    throw new Error(`no dependency rule for ${pkg.name}; add one to scripts/check-deps.ts`);
  return rule;
}

function loadPackages(): Pkg[] {
  const out: Pkg[] = [];
  for (const group of ['packages', 'plugins', 'apps'] as const) {
    const base = join(ROOT, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const file = join(base, entry, 'package.json');
      if (!existsSync(file)) continue;
      const json = JSON.parse(readFileSync(file, 'utf8'));
      const scoped = (o: Record<string, string> = {}) =>
        Object.keys(o).filter((d) => d.startsWith(SCOPE));
      out.push({
        dir: join(base, entry),
        name: json.name,
        group,
        deps: [...scoped(json.dependencies), ...scoped(json.peerDependencies)],
        devDeps: scoped(json.devDependencies),
      });
    }
  }
  return out;
}

function* walk(dir: string): Generator<string> {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|mts)$/.test(entry)) yield full;
  }
}

const IMPORT_RE =
  /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(?\s*['"]([^'"]+)['"]/g;
/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

const errors: string[] = [];
const packages = loadPackages();
const pluginNames = new Set(packages.filter((p) => p.group === 'plugins').map((p) => p.name));

for (const pkg of packages) {
  const allowed = allowedFor(pkg);
  const isAllowed = (dep: string, dev: boolean) => {
    const short = dep.slice(SCOPE.length);
    if (pluginNames.has(dep) && pkg.group !== 'apps') return false; // 只有 apps 能装配插件
    if (dev && short === 'testkit') return true;
    return allowed === '*' || allowed.includes(short);
  };

  for (const dep of pkg.deps) {
    if (!isAllowed(dep, false)) errors.push(`${pkg.name}: 不允许依赖 ${dep}（package.json）`);
  }
  for (const dep of pkg.devDeps) {
    if (!isAllowed(dep, true)) errors.push(`${pkg.name}: 不允许依赖 ${dep}（devDependencies）`);
  }

  for (const sub of ['src', 'test'] as const) {
    for (const file of walk(join(pkg.dir, sub))) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(IMPORT_RE)) {
        const spec = m[1] ?? m[2];
        if (!spec?.startsWith(SCOPE)) continue;
        const rel = relative(ROOT, file);
        const [, name = '', ...rest] = spec.split('/');
        const dep = `${SCOPE}${name}`;
        if (rest[0] === 'src')
          errors.push(`${rel}: 禁止深路径导入 "${spec}"，请使用包的 exports 入口`);
        if (dep === pkg.name) continue;
        const declared = pkg.deps.includes(dep) || (sub === 'test' && pkg.devDeps.includes(dep));
        if (!declared) errors.push(`${rel}: 导入了未声明的依赖 ${dep}`);
        else if (!isAllowed(dep, sub === 'test')) errors.push(`${rel}: 不允许导入 ${dep}`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error(
    `✗ 依赖方向检查失败（${errors.length}）：\n${errors.map((e) => `  - ${e}`).join('\n')}`,
  );
  process.exit(1);
}
console.log(`✓ 依赖方向检查通过（${packages.length} 个包）`);
