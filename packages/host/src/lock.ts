import { readFile, rm, writeFile } from 'node:fs/promises';
import { ErrorCode, LoopError } from '@super-loop/shared';

interface LockInfo {
  pid: number;
  startedAt: string;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * 获取单实例锁：同一个主目录（同一个数据库）只允许一个 server 进程。
 * 两个内核写同一个库会重复调度任务，必须避免。上次异常退出留下的锁会被自动清理。
 * 返回释放函数。
 */
export async function acquireLock(file: string): Promise<() => Promise<void>> {
  const info: LockInfo = { pid: process.pid, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(file, JSON.stringify(info), { flag: 'wx', mode: 0o600 });
      return async () => {
        try {
          const current = JSON.parse(await readFile(file, 'utf8')) as LockInfo;
          if (current.pid === process.pid) await rm(file, { force: true });
        } catch {
          // 已被清理
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holder: LockInfo | undefined;
      try {
        holder = JSON.parse(await readFile(file, 'utf8')) as LockInfo;
      } catch {
        holder = undefined; // 锁文件损坏，视为过期
      }
      if (holder && holder.pid !== process.pid && isAlive(holder.pid)) {
        throw new LoopError(
          ErrorCode.CONFLICT,
          `another super-loop server is running (pid ${holder.pid}, since ${holder.startedAt}); lock: ${file}`,
          { retryable: false },
        );
      }
      await rm(file, { force: true }); // 过期锁
    }
  }
  throw new LoopError(ErrorCode.CONFLICT, `failed to acquire lock ${file}`, { retryable: false });
}
