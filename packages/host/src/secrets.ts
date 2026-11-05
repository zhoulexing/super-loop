import { readFile, stat } from 'node:fs/promises';
import type { SecretResolver } from '@super-loop/protocol';

/** 解析 `KEY=VALUE` 格式（支持 # 注释、`export ` 前缀、单/双引号）。 */
export function parseSecrets(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = (m[2] ?? '').trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1] as string] = value;
  }
  return out;
}

export interface LoadedSecrets {
  values: Record<string, string>;
  warnings: string[];
}

/** 读取 secrets.env；文件不存在返回空。权限比 0600 宽时给出警告。 */
export async function loadSecrets(file: string): Promise<LoadedSecrets> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { values: {}, warnings: [] };
    throw error;
  }
  const warnings: string[] = [];
  const mode = (await stat(file)).mode & 0o777;
  if (mode & 0o077) {
    warnings.push(
      `${file} is accessible by other users (mode ${mode.toString(8)}); run: chmod 600 ${file}`,
    );
  }
  return { values: parseSecrets(text), warnings };
}

/** secrets.env 优先，其次进程环境变量。 */
export function createSecretResolver(
  secrets: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): SecretResolver {
  return { get: async (name) => secrets[name] ?? env[name] };
}
