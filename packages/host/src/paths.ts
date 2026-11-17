import { chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** 默认主目录名：`~/.super-loop`。 */
export const HOME_DIRNAME = '.super-loop';

/**
 * Super Loop 主目录布局（docs/runtime.md）。所有运行时文件都在这里，代码仓库里不放任何运行时数据。
 * 系统状态（db/）与内容（attachments/、workspaces/）分开存放，可以各自搬迁、备份与清理。
 *
 * ```
 * ~/.super-loop/                  SUPER_LOOP_HOME
 * ├── config.json                 主配置（首次启动自动生成）
 * ├── secrets.env                 密钥 KEY=VALUE（0600），配置中用 ${secret:NAME} 引用
 * ├── db/loop.db                  系统状态，只有内核读写（SUPER_LOOP_DB_DIR）
 * ├── attachments/<日期>/<ULID>-<文件名>   外部带进来的附件（SUPER_LOOP_ATTACHMENTS_DIR）
 * ├── workspaces/<taskId>/        每个任务（会话）一个（SUPER_LOOP_WORKSPACES_DIR）
 * │   ├── work/                   Agent 工作目录（cwd），多轮对话共用，临时
 * │   └── artifacts/<runId>/      交付结果，Run 结束时自动登记
 * ├── shared/                     用户维护的共享资料，Agent 只读
 * ├── state/<plugin>/<instance>/  插件实例的持久状态（会话、登录态）
 * ├── cache/<plugin>/             可随时删除的缓存（git 镜像等）
 * ├── plugins/                    本地自定义插件
 * ├── logs/                       server.log / watchdog.log
 * ├── run/server.lock             单实例锁
 * └── backups/db/                 数据库快照
 * ```
 */
export interface HomeLayout {
  home: string;
  configFile: string;
  secretsFile: string;
  dbDir: string;
  dbFile: string;
  attachmentsDir: string;
  workspacesDir: string;
  sharedDir: string;
  stateDir: string;
  cacheDir: string;
  pluginsDir: string;
  logsDir: string;
  runDir: string;
  lockFile: string;
  backupsDir: string;
}

/** 展开 `~` 并转为绝对路径。 */
export function expandPath(path: string, base = process.cwd()): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return resolve(base, path);
}

export function resolveLayout(env: NodeJS.ProcessEnv = process.env): HomeLayout {
  const home = expandPath(env.SUPER_LOOP_HOME ?? join(homedir(), HOME_DIRNAME));
  const dir = (override: string | undefined, name: string) =>
    override ? expandPath(override) : join(home, name);
  const dbDir = dir(env.SUPER_LOOP_DB_DIR, 'db');
  const runDir = join(home, 'run');
  return {
    home,
    configFile: join(home, 'config.json'),
    secretsFile: join(home, 'secrets.env'),
    dbDir,
    dbFile: join(dbDir, 'loop.db'),
    attachmentsDir: dir(env.SUPER_LOOP_ATTACHMENTS_DIR, 'attachments'),
    workspacesDir: dir(env.SUPER_LOOP_WORKSPACES_DIR, 'workspaces'),
    sharedDir: join(home, 'shared'),
    stateDir: join(home, 'state'),
    cacheDir: join(home, 'cache'),
    pluginsDir: join(home, 'plugins'),
    logsDir: join(home, 'logs'),
    runDir,
    lockFile: join(runDir, 'server.lock'),
    backupsDir: join(home, 'backups', 'db'),
  };
}

/** 创建所有目录。主目录及其子目录权限 0700（只有当前用户可访问）。 */
export async function ensureLayout(layout: HomeLayout): Promise<void> {
  await mkdir(layout.home, { recursive: true, mode: 0o700 });
  await chmod(layout.home, 0o700);
  for (const dir of [
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
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
}
