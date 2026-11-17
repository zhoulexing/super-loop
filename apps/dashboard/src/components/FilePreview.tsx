import type { FileRef } from '@super-loop/protocol';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import { loop } from '../lib/api.js';
import { bytes } from '../lib/format.js';
import { useUi } from './ui.js';

const TEXT_LIMIT = 256 * 1024;

const isText = (mime: string) =>
  mime.startsWith('text/') || /json|yaml|xml|x-diff|ndjson|javascript|typescript|csv/.test(mime);

/** 通过 client 下载（带鉴权头），再以 Blob URL 触发保存。 */
export async function downloadFile(f: FileRef): Promise<void> {
  const blob = await loop.files.download(f.ref);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = f.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * 产物预览。HTML 只显示源码，不渲染：Agent 产出的内容视为不可信（AGENTS.md「安全与权限」）。
 */
export function FilePreview({ file }: { file: FileRef }) {
  const ui = useUi();
  const q = useQuery({
    queryKey: ['file', file.ref],
    queryFn: () => loop.files.download(file.ref),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const image = file.mime.startsWith('image/') && file.mime !== 'image/svg+xml';
  const url = useMemo(
    () => (q.data && image ? URL.createObjectURL(q.data) : undefined),
    [q.data, image],
  );
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url]);
  const text = useQuery({
    queryKey: ['file-text', file.ref],
    queryFn: async () => {
      const blob = q.data as Blob;
      const head = blob.size > TEXT_LIMIT ? blob.slice(0, TEXT_LIMIT) : blob;
      return { text: await head.text(), truncated: blob.size > TEXT_LIMIT };
    },
    enabled: !!q.data && isText(file.mime),
    staleTime: Number.POSITIVE_INFINITY,
  });

  let body: React.ReactNode;
  if (q.isPending) body = <p className="note">加载中…</p>;
  else if (q.isError) body = <p className="err-text">加载失败：{String(q.error)}</p>;
  else if (url) body = <img className="preview-img" src={url} alt={file.name} />;
  else if (isText(file.mime))
    body = (
      <>
        <pre>{text.data?.text ?? ''}</pre>
        {text.data?.truncated && <p className="note">只显示前 256 KB。</p>}
        {file.mime === 'text/html' && <p className="note">HTML 只显示源码，不在看板中渲染。</p>}
      </>
    );
  else body = <p className="note">这种类型（{file.mime}）不能预览，可以下载后查看。</p>;

  return (
    <>
      <h3>{file.name}</h3>
      <p className="note" style={{ margin: 0 }}>
        <span className="mono">{file.mime}</span> · {bytes(file.size)} ·{' '}
        <span className="mono">{file.ref}</span>
      </p>
      {body}
      <div className="row">
        <button type="button" className="btn" onClick={() => void downloadFile(file)}>
          下载
        </button>
        <button type="button" className="btn primary" onClick={ui.closeModal}>
          关闭
        </button>
      </div>
    </>
  );
}
