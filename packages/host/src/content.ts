import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type {
  ContentStore,
  DirectoryProvider,
  FileRef,
  FileStore,
  InstanceName,
  RunScope,
} from '@super-loop/protocol';
import {
  artifactPrefix,
  assertFileSize,
  ErrorCode,
  guessMime,
  LoopError,
  newId,
  parseFileRef,
  sanitizeFileName,
  toBytes,
  withSuffix,
} from '@super-loop/shared';
import type { HomeLayout } from './paths.js';

export interface FsContentOptions {
  /** 单个文件大小上限，默认 50MB。 */
  maxFileBytes?: number;
  /** 返回 YYYY-MM-DD，用于附件按日期分目录（测试注入）。 */
  today?: () => string;
}

export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;

const TASK_ID = /^task_[0-9A-HJKMNP-TV-Z]{26}$/;
const RUN_ID = /^run_[0-9A-HJKMNP-TV-Z]{26}$/;

function assertScope(scope: RunScope): void {
  if (!TASK_ID.test(scope.taskId) || !RUN_ID.test(scope.runId)) {
    throw new LoopError(
      ErrorCode.INVALID_INPUT,
      `invalid run scope: ${scope.taskId}/${scope.runId}`,
      { retryable: false },
    );
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 基于主目录的内容存储与目录提供者：
 * - 附件：`attachments/<YYYY-MM-DD>/<ULID>-<文件名>`
 * - 产物：`workspaces/<taskId>/artifacts/<runId>/<路径>`（Agent 可直接写入该目录）
 * - 工作区：`workspaces/<taskId>/work/`，同一任务的多轮对话共用
 * - 共享 / 状态 / 缓存：`shared/`、`state/<plugin>/<instance>/`、`cache/<plugin>/`
 */
export function createFsContent(
  layout: HomeLayout,
  options: FsContentOptions = {},
): ContentStore & DirectoryProvider {
  const maxBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const today = options.today ?? (() => new Date().toISOString().slice(0, 10));
  const taskDir = (taskId: string) => join(layout.workspacesDir, taskId);
  const artifactsDir = (s: RunScope) => join(taskDir(s.taskId), 'artifacts', s.runId);

  /** 引用 → 绝对路径（parseFileRef 已拒绝 .. 与空段）。 */
  const pathOf = (ref: string): string => {
    const p = parseFileRef(ref);
    return p.kind === 'attachment'
      ? join(layout.attachmentsDir, p.date, p.file)
      : join(artifactsDir(p), ...p.path.split('/'));
  };

  /**
   * 解析出真实路径并确认仍在所属根目录内。
   * Agent 可以直接往 artifacts/ 写文件，必须防止它放一个指向目录外的符号链接。
   */
  const safePath = async (ref: string): Promise<string> => {
    const p = parseFileRef(ref);
    const root = p.kind === 'attachment' ? layout.attachmentsDir : artifactsDir(p);
    const [realRoot, real] = await Promise.all([realpath(root), realpath(pathOf(ref))]);
    if (!real.startsWith(realRoot + sep)) {
      throw new LoopError(ErrorCode.PERMISSION_DENIED, `file escapes its directory: ${ref}`, {
        retryable: false,
      });
    }
    return real;
  };

  const read = async (ref: string): Promise<Uint8Array> => {
    try {
      return new Uint8Array(await readFile(await safePath(ref)));
    } catch (error) {
      if (error instanceof LoopError) throw error;
      throw new LoopError(ErrorCode.NOT_FOUND, `file not found: ${ref}`, {
        retryable: false,
        cause: error,
      });
    }
  };

  const write = async (path: string, data: Uint8Array) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, data, { flag: 'wx', mode: 0o600 });
  };

  const attachments: FileStore = {
    async put(data, meta) {
      const bytes = toBytes(data);
      const name = sanitizeFileName(meta.name);
      assertFileSize(bytes.byteLength, maxBytes, name);
      const ref = `attachment:${today()}/${newId('event').slice(4)}-${name}`;
      await write(pathOf(ref), bytes);
      return { ref, name, mime: meta.mime ?? guessMime(name), size: bytes.byteLength };
    },
    get: read,
  };

  return {
    attachments,

    artifacts(scope: RunScope): FileStore {
      assertScope(scope);
      const dir = artifactsDir(scope);
      const prefix = artifactPrefix(scope);
      return {
        async put(data, meta) {
          const bytes = toBytes(data);
          const base = sanitizeFileName(meta.name);
          assertFileSize(bytes.byteLength, maxBytes, base);
          let n = 0;
          while (await exists(join(dir, withSuffix(base, n)))) n++;
          const name = withSuffix(base, n);
          const ref = `${prefix}${name}`;
          await write(pathOf(ref), bytes);
          return { ref, name, mime: meta.mime ?? guessMime(name), size: bytes.byteLength };
        },
        get: read,
      };
    },

    read,

    async stat(ref) {
      parseFileRef(ref);
      try {
        const s = await stat(await safePath(ref));
        if (!s.isFile()) return undefined;
        const name = ref.slice(ref.lastIndexOf('/') + 1);
        return { ref, name, mime: guessMime(name), size: s.size };
      } catch {
        return undefined;
      }
    },

    async listArtifacts(scope) {
      assertScope(scope);
      const dir = artifactsDir(scope);
      const prefix = artifactPrefix(scope);
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { recursive: true, withFileTypes: true, encoding: 'utf8' });
      } catch {
        return [];
      }
      const out: FileRef[] = [];
      for (const e of entries) {
        if (!e.isFile()) continue;
        const rel = relative(dir, join(e.parentPath, e.name)).split(sep).join('/');
        const ref = `${prefix}${rel}`;
        try {
          parseFileRef(ref);
        } catch {
          continue; // 忽略无法表示为合法引用的文件
        }
        const s = await stat(join(e.parentPath, e.name));
        out.push({ ref, name: e.name, mime: guessMime(e.name), size: s.size });
      }
      return out.sort((a, b) => a.ref.localeCompare(b.ref));
    },

    async workspace(scope) {
      assertScope(scope);
      const work = join(taskDir(scope.taskId), 'work');
      const artifacts = artifactsDir(scope);
      await mkdir(work, { recursive: true, mode: 0o700 });
      await mkdir(artifacts, { recursive: true, mode: 0o700 });
      return { work, artifacts };
    },

    async shared() {
      await mkdir(layout.sharedDir, { recursive: true, mode: 0o700 });
      return layout.sharedDir;
    },

    async state(instance: InstanceName) {
      const [plugin, name] = instance.split(':') as [string, string];
      const dir = join(layout.stateDir, sanitizeFileName(plugin), sanitizeFileName(name));
      await mkdir(dir, { recursive: true, mode: 0o700 });
      return dir;
    },

    async cache(plugin: string) {
      const dir = join(layout.cacheDir, sanitizeFileName(plugin));
      await mkdir(dir, { recursive: true, mode: 0o700 });
      return dir;
    },
  };
}
