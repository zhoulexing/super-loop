import type { ContentStore, FileRef, FileStore, RunId } from '@super-loop/protocol';
import { ErrorCode, LoopError } from './errors.js';
import { newId } from './id.js';

const MAX_NAME = 200;

/** 清洗文件名：去掉路径分隔符、`..`、控制字符与首尾空白/点，最长 200 字符。 */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 有意剔除控制字符
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_')
    .replace(/\.{2,}/g, '.')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!cleaned) return 'file';
  if (cleaned.length <= MAX_NAME) return cleaned;
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, MAX_NAME - ext.length) + ext;
}

/** 同名时追加序号：`report.md` → `report-1.md`。 */
export function withSuffix(name: string, n: number): string {
  if (n === 0) return name;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
}

export type ParsedFileRef =
  | { kind: 'attachment'; date: string; file: string }
  | { kind: 'artifact'; runId: RunId; path: string };

const ATTACHMENT = /^attachment:(\d{4}-\d{2}-\d{2})\/([^/]+)$/;
const ARTIFACT = /^artifact:(run_[0-9A-HJKMNP-TV-Z]{26})\/(.+)$/;

/** 解析文件引用；含 `..`、空段或绝对路径的引用一律视为非法（防路径穿越）。 */
export function parseFileRef(ref: string): ParsedFileRef {
  const a = ATTACHMENT.exec(ref);
  if (a && a[2] !== '.' && a[2] !== '..') {
    return { kind: 'attachment', date: a[1] as string, file: a[2] as string };
  }
  const b = ARTIFACT.exec(ref);
  if (b) {
    const segments = (b[2] as string).split('/');
    if (segments.every((s) => s !== '' && s !== '.' && s !== '..')) {
      return { kind: 'artifact', runId: b[1] as RunId, path: b[2] as string };
    }
  }
  throw new LoopError(ErrorCode.INVALID_INPUT, `invalid file ref: ${ref}`, { retryable: false });
}

const MIME: Record<string, string> = {
  txt: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  json: 'application/json',
  jsonl: 'application/x-ndjson',
  csv: 'text/csv',
  html: 'text/html',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  diff: 'text/x-diff',
  patch: 'text/x-diff',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  zip: 'application/zip',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
};

export function guessMime(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return MIME[ext] ?? 'application/octet-stream';
}

export function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? new TextEncoder().encode(data) : data;
}

export function assertFileSize(size: number, maxBytes: number | undefined, name: string): void {
  if (maxBytes !== undefined && size > maxBytes) {
    throw new LoopError(
      ErrorCode.INVALID_INPUT,
      `file "${name}" is ${size} bytes, exceeds limit ${maxBytes}`,
      { retryable: false },
    );
  }
}

/**
 * 内存版 ContentStore：内核默认值与测试使用，引用格式与文件版一致。
 * 不提供目录（Run 没有工作区）。
 */
export function createMemoryContentStore(
  options: { maxFileBytes?: number; today?: () => string } = {},
): ContentStore {
  const files = new Map<string, FileRef & { data: Uint8Array }>();
  const today = options.today ?? (() => new Date().toISOString().slice(0, 10));

  const read = async (ref: string) => {
    parseFileRef(ref);
    const f = files.get(ref);
    if (!f)
      throw new LoopError(ErrorCode.NOT_FOUND, `file not found: ${ref}`, { retryable: false });
    return f.data;
  };
  const save = (ref: string, name: string, mime: string | undefined, data: Uint8Array): FileRef => {
    assertFileSize(data.byteLength, options.maxFileBytes, name);
    const meta: FileRef = { ref, name, mime: mime ?? guessMime(name), size: data.byteLength };
    files.set(ref, { ...meta, data });
    return meta;
  };

  const attachments: FileStore = {
    async put(data, meta) {
      const name = sanitizeFileName(meta.name);
      return save(
        `attachment:${today()}/${newId('event').slice(4)}-${name}`,
        name,
        meta.mime,
        toBytes(data),
      );
    },
    get: read,
  };

  return {
    attachments,
    artifacts(runId) {
      return {
        async put(data, meta) {
          const base = sanitizeFileName(meta.name);
          let n = 0;
          while (files.has(`artifact:${runId}/${withSuffix(base, n)}`)) n++;
          const name = withSuffix(base, n);
          return save(`artifact:${runId}/${name}`, name, meta.mime, toBytes(data));
        },
        get: read,
      };
    },
    read,
    async stat(ref) {
      parseFileRef(ref);
      const f = files.get(ref);
      if (!f) return undefined;
      const { data: _data, ...meta } = f;
      return meta;
    },
    async listArtifacts(runId) {
      const prefix = `artifact:${runId}/`;
      return [...files.values()]
        .filter((f) => f.ref.startsWith(prefix))
        .map(({ data: _data, ...meta }) => meta)
        .sort((a, b) => a.ref.localeCompare(b.ref));
    },
  };
}
