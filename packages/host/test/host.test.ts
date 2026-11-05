// biome-ignore-all lint/suspicious/noTemplateCurlyInString: 测试 ${secret:} / ${env:} 配置插值
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTestAgent } from '@super-loop/testkit';
import { afterAll, describe, expect, it } from 'vitest';
import { acquireLock, loadConfig, parseSecrets, resolveLayout } from '../src/index.js';

const root = mkdtempSync(join(tmpdir(), 'super-loop-host-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const freshHome = () => join(root, `home-${++n}`);

const echo = defineTestAgent(async function* () {
  yield { type: 'result', status: 'succeeded', summary: 'ok' };
});
const importPlugin = async (spec: string) => {
  if (spec === '@test/echo') return { default: echo };
  throw new Error(`unknown plugin ${spec}`);
};
const defaultConfig = { plugins: { 'echo:default': { use: '@test/echo' } }, routes: [] };

describe('resolveLayout', () => {
  it('默认 ~/.super-loop，可用 SUPER_LOOP_HOME / SUPER_LOOP_DATA_DIR 覆盖', () => {
    expect(resolveLayout({ HOME: '/u' }).home).toMatch(/\.super-loop$/);
    expect(resolveLayout({ SUPER_LOOP_HOME: '/srv/sl' })).toMatchObject({
      home: '/srv/sl',
      configFile: '/srv/sl/config.json',
      secretsFile: '/srv/sl/secrets.env',
      dbFile: '/srv/sl/db/loop.db',
      attachmentsDir: '/srv/sl/attachments',
      workspacesDir: '/srv/sl/workspaces',
      sharedDir: '/srv/sl/shared',
      stateDir: '/srv/sl/state',
      cacheDir: '/srv/sl/cache',
      lockFile: '/srv/sl/run/server.lock',
      backupsDir: '/srv/sl/backups/db',
    });
    // 系统状态与内容可以各自搬到不同的磁盘
    expect(
      resolveLayout({
        SUPER_LOOP_HOME: '/srv/sl',
        SUPER_LOOP_DB_DIR: '/ssd/sl-db',
        SUPER_LOOP_ATTACHMENTS_DIR: '/nas/sl/attachments',
        SUPER_LOOP_WORKSPACES_DIR: '/big/sl-ws',
      }),
    ).toMatchObject({
      dbFile: '/ssd/sl-db/loop.db',
      attachmentsDir: '/nas/sl/attachments',
      workspacesDir: '/big/sl-ws',
    });
  });
});

describe('loadConfig', () => {
  it('首次启动创建目录与默认配置（权限 0700 / 0600）', async () => {
    const layout = resolveLayout({ SUPER_LOOP_HOME: freshHome() });
    const loaded = await loadConfig({ layout, env: {}, defaultConfig, importPlugin });
    expect(loaded.created).toBe(true);
    expect(statSync(layout.home).mode & 0o777).toBe(0o700);
    expect(statSync(layout.configFile).mode & 0o777).toBe(0o600);
    for (const d of [
      layout.dbDir,
      layout.attachmentsDir,
      layout.workspacesDir,
      layout.sharedDir,
      layout.stateDir,
      layout.cacheDir,
      layout.pluginsDir,
      layout.logsDir,
      layout.runDir,
      layout.backupsDir,
    ]) {
      expect(statSync(d).isDirectory()).toBe(true);
    }
    expect(loaded.server).toEqual({
      host: '127.0.0.1',
      port: 7300,
      publicUrl: 'http://127.0.0.1:7300',
      token: undefined,
    });
    expect(loaded.kernel.plugins['echo:default']?.use).toBe(echo);
    // 第二次读取已有文件
    expect((await loadConfig({ layout, env: {}, defaultConfig, importPlugin })).created).toBe(
      false,
    );
  });

  it('替换 ${secret:} / ${env:}，环境变量覆盖 server 配置', async () => {
    const layout = resolveLayout({ SUPER_LOOP_HOME: freshHome() });
    await mkdir(layout.home, { recursive: true });
    await writeFile(layout.secretsFile, 'API_TOKEN="s3cret"\n# comment\nexport LARK=abc\n', {
      mode: 0o600,
    });
    await writeFile(
      layout.configFile,
      JSON.stringify({
        server: { token: '${secret:API_TOKEN}', port: 8000 },
        plugins: {
          'echo:x': {
            use: '@test/echo',
            config: { chat: '${secret:LARK}', region: '${env:REGION}' },
          },
        },
      }),
    );
    const loaded = await loadConfig({
      layout,
      env: { REGION: 'cn', SUPER_LOOP_PORT: '9000' },
      defaultConfig,
      importPlugin,
    });
    expect(loaded.server).toMatchObject({
      token: 's3cret',
      port: 9000,
      publicUrl: 'http://127.0.0.1:9000',
    });
    expect(loaded.kernel.plugins['echo:x']?.config).toEqual({ chat: 'abc', region: 'cn' });
    expect(await loaded.secrets.get('LARK')).toBe('abc');
  });

  it('配置错误给出文件路径与字段路径', async () => {
    const layout = resolveLayout({ SUPER_LOOP_HOME: freshHome() });
    await mkdir(layout.home, { recursive: true });
    await writeFile(layout.configFile, JSON.stringify({ server: { prot: 1 } }));
    await expect(loadConfig({ layout, env: {}, defaultConfig, importPlugin })).rejects.toThrow(
      /config\.json:[\s\S]*server/,
    );

    await writeFile(layout.configFile, JSON.stringify({ server: { token: '${secret:MISSING}' } }));
    await expect(loadConfig({ layout, env: {}, defaultConfig, importPlugin })).rejects.toThrow(
      /secret MISSING is not set/,
    );

    await writeFile(layout.configFile, JSON.stringify({ plugins: { 'x:y': { use: '@nope/x' } } }));
    await expect(loadConfig({ layout, env: {}, defaultConfig, importPlugin })).rejects.toThrow(
      /cannot load "@nope\/x"/,
    );
  });

  it('支持 file: 引用主目录下的本地插件', async () => {
    const layout = resolveLayout({ SUPER_LOOP_HOME: freshHome() });
    await mkdir(join(layout.home, 'plugins', 'mine'), { recursive: true });
    await writeFile(
      join(layout.home, 'plugins', 'mine', 'index.mjs'),
      "export default { name: 'agent-mine', version: '0.0.1', kind: 'agent', apiVersion: 1, permissions: [], configSchema: { safeParse: (v) => ({ success: true, data: v }) }, create() { return {}; } };",
    );
    await writeFile(
      layout.configFile,
      JSON.stringify({ plugins: { 'mine:default': { use: 'file:./plugins/mine/index.mjs' } } }),
    );
    const loaded = await loadConfig({ layout, env: {}, defaultConfig, importPlugin });
    expect(loaded.kernel.plugins['mine:default']?.use.name).toBe('agent-mine');
  });

  it('secrets.env 权限过宽时警告', async () => {
    const layout = resolveLayout({ SUPER_LOOP_HOME: freshHome() });
    await mkdir(layout.home, { recursive: true });
    writeFileSync(layout.secretsFile, 'A=1\n', { mode: 0o644 });
    const loaded = await loadConfig({ layout, env: {}, defaultConfig, importPlugin });
    expect(loaded.warnings[0]).toMatch(/chmod 600/);
  });
});

describe('parseSecrets', () => {
  it('解析引号、注释与 export 前缀', () => {
    expect(parseSecrets('A=1\n# x\nexport B=\'two words\'\nC = "3"\nbad line\n')).toEqual({
      A: '1',
      B: 'two words',
      C: '3',
    });
  });
});

describe('acquireLock', () => {
  it('同一主目录只允许一个实例；释放后可再获取；过期锁自动清理', async () => {
    const layout = resolveLayout({ SUPER_LOOP_HOME: freshHome() });
    await mkdir(layout.runDir, { recursive: true });
    const release = await acquireLock(layout.lockFile);
    expect(JSON.parse(await readFile(layout.lockFile, 'utf8')).pid).toBe(process.pid);

    // 模拟另一个存活进程持有锁（用父进程 pid）
    await writeFile(layout.lockFile, JSON.stringify({ pid: process.ppid, startedAt: 'x' }));
    await expect(acquireLock(layout.lockFile)).rejects.toMatchObject({ code: 'CONFLICT' });

    // 过期锁（进程不存在）
    await writeFile(layout.lockFile, JSON.stringify({ pid: 999_999, startedAt: 'x' }));
    const again = await acquireLock(layout.lockFile);
    await again();
    await release(); // 锁已不属于自己，不应误删别人的锁
  });
});
