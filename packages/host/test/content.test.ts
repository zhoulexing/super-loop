import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '@super-loop/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { createFsContent, ensureLayout, resolveLayout } from '../src/index.js';

const root = mkdtempSync(join(tmpdir(), 'super-loop-content-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

async function setup(maxFileBytes?: number) {
  const layout = resolveLayout({ SUPER_LOOP_HOME: join(root, `home-${++n}`) });
  await ensureLayout(layout);
  const content = createFsContent(layout, {
    today: () => '2026-11-05',
    ...(maxFileBytes === undefined ? {} : { maxFileBytes }),
  });
  return { layout, content };
}

describe('createFsContent', () => {
  it('附件按日期存放，文件名清洗，可读回', async () => {
    const { layout, content } = await setup();
    const f = await content.attachments.put('hello', { name: '../../etc/pass wd.txt' });
    // '/' → '_'，'..' 折叠为 '.'，去掉开头的点 → '_._etc_pass wd.txt'
    expect(f.ref).toMatch(/^attachment:2026-11-05\/[0-9A-Z]{26}-_\._etc_pass wd\.txt$/);
    expect(f).toMatchObject({ mime: 'text/plain', size: 5 });
    expect(new TextDecoder().decode(await content.read(f.ref))).toBe('hello');
    expect((await content.stat(f.ref))?.size).toBe(5);
    expect(f.ref).not.toContain('..');
    expect(layout.attachmentsDir).toContain('attachments');
  });

  it('工作区按任务：work/ 共用，artifacts/<runId>/ 每次 Run 一个；直接写入 artifacts/ 的文件会被列出', async () => {
    const { layout, content } = await setup();
    const runId = newId('run');
    const taskId = newId('task');
    const scope = { taskId, runId };
    const ws = await content.workspace(scope);
    expect(ws).toEqual({
      work: join(layout.workspacesDir, taskId, 'work'),
      artifacts: join(layout.workspacesDir, taskId, 'artifacts', runId),
    });
    // Agent 用 ctx.files 写入，同名自动加序号
    const a = await content.artifacts(scope).put('# r', { name: 'report.md' });
    const b = await content.artifacts(scope).put('# r2', { name: 'report.md' });
    expect([a.ref, b.ref]).toEqual([
      `artifact:${taskId}/${runId}/report.md`,
      `artifact:${taskId}/${runId}/report-1.md`,
    ]);
    // Agent（如 CLI）直接往目录里写，含子目录
    await mkdir(join(ws.artifacts, 'screens'), { recursive: true });
    await writeFile(join(ws.artifacts, 'screens', 'home.png'), new Uint8Array([1, 2, 3]));
    // work/ 里的文件不算产物
    await writeFile(join(ws.work, 'tmp.txt'), 'x');

    const list = await content.listArtifacts(scope);
    expect(list.map((f) => [f.ref, f.mime, f.size])).toEqual([
      [`artifact:${taskId}/${runId}/report-1.md`, 'text/markdown', 4],
      [`artifact:${taskId}/${runId}/report.md`, 'text/markdown', 3],
      [`artifact:${taskId}/${runId}/screens/home.png`, 'image/png', 3],
    ]);
    expect(await content.listArtifacts({ taskId, runId: newId('run') })).toEqual([]);
  });

  it('拒绝路径穿越与指向目录外的符号链接', async () => {
    const { layout, content } = await setup();
    const runId = newId('run');
    const taskId = newId('task');
    const scope = { taskId, runId };
    const ws = await content.workspace(scope);
    await expect(
      content.read(`artifact:${taskId}/${runId}/../../config.json`),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(content.read('attachment:2026-11-05/..')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });

    writeFileSync(join(layout.home, 'secret.txt'), 'top secret');
    symlinkSync(join(layout.home, 'secret.txt'), join(ws.artifacts, 'leak.txt'));
    await expect(content.read(`artifact:${taskId}/${runId}/leak.txt`)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(await content.stat(`artifact:${taskId}/${runId}/leak.txt`)).toBeUndefined();
    expect((await content.listArtifacts(scope)).map((f) => f.name)).not.toContain('leak.txt');
  });

  it('单文件大小上限；不存在的文件返回 NOT_FOUND / undefined', async () => {
    const { content } = await setup(4);
    await expect(content.attachments.put('12345', { name: 'big.bin' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    const missing = `artifact:${newId('task')}/${newId('run')}/nope.txt`;
    expect(await content.stat(missing)).toBeUndefined();
    await expect(content.read(missing)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('state / cache / shared 目录', async () => {
    const { layout, content } = await setup();
    expect(await content.state('claude-code:repo-a')).toBe(
      join(layout.stateDir, 'claude-code', 'repo-a'),
    );
    expect(await content.cache('agent-claude-code')).toBe(
      join(layout.cacheDir, 'agent-claude-code'),
    );
    expect(await content.shared()).toBe(layout.sharedDir);
  });
});
