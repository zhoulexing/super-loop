/**
 * 最小的 MCP 服务端（Streamable HTTP，只用 JSON 响应，不开 SSE 流）。
 * 只实现 Router 需要的部分：initialize / ping / tools/list / tools/call。
 * 只监听 127.0.0.1，并要求随机 Bearer token，供本插件启动的 dsh 子进程调用。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';

/** 按新到旧排列；客户端请求的版本在列表里就原样回应，否则回应第一个。 */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY_BYTES = 1024 * 1024;

export interface McpToolResult {
  text: string;
  isError?: boolean;
}

export interface McpTool<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  input: S;
  call(args: z.output<S>, signal: AbortSignal): Promise<McpToolResult>;
}

/** 让 `tools` 数组里每个工具保留自己的参数类型。 */
export const defineMcpTool = <S extends z.ZodType>(tool: McpTool<S>): McpTool => tool as McpTool;

export interface McpServerOptions {
  name: string;
  version: string;
  instructions?: string;
  tools: readonly McpTool[];
  /** 单次工具调用的上限。 */
  callTimeoutMs?: number;
}

export interface RunningMcpServer {
  readonly url: string;
  readonly token: string;
  close(): Promise<void>;
}

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new RpcError(-32600, 'request too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sameToken(header: string | undefined, token: string): boolean {
  const got = Buffer.from(header ?? '');
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export async function startMcpServer(options: McpServerOptions): Promise<RunningMcpServer> {
  const token = randomBytes(24).toString('base64url');
  const tools = new Map(options.tools.map((t) => [t.name, t]));
  const listed = options.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.input, { io: 'input' }),
  }));
  const controller = new AbortController();

  async function handle(msg: RpcRequest): Promise<unknown> {
    switch (msg.method) {
      case 'initialize': {
        const requested = (msg.params as { protocolVersion?: unknown } | undefined)
          ?.protocolVersion;
        const protocolVersion =
          typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : PROTOCOL_VERSIONS[0];
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: options.name, version: options.version },
          ...(options.instructions ? { instructions: options.instructions } : {}),
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: listed };
      case 'tools/call': {
        const p = (msg.params ?? {}) as { name?: unknown; arguments?: unknown };
        const tool = typeof p.name === 'string' ? tools.get(p.name) : undefined;
        if (!tool) throw new RpcError(-32602, `unknown tool: ${String(p.name)}`);
        const parsed = tool.input.safeParse(p.arguments ?? {});
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map((i) => `${i.path.join('.') || '$'}: ${i.message}`)
            .join('; ');
          return { content: [{ type: 'text', text: `参数无效：${issues}` }], isError: true };
        }
        const signal = AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(options.callTimeoutMs ?? 30_000),
        ]);
        try {
          const r = await tool.call(parsed.data, signal);
          return {
            content: [{ type: 'text', text: r.text }],
            ...(r.isError ? { isError: true } : {}),
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { content: [{ type: 'text', text: `工具执行失败：${message}` }], isError: true };
        }
      }
      default:
        throw new RpcError(-32601, `method not found: ${msg.method}`);
    }
  }

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!sameToken(req.headers.authorization, token)) {
      res.writeHead(401).end();
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(200).end();
      return;
    }
    if (req.method !== 'POST') {
      // 不提供服务端主动推送的 SSE 流
      res.writeHead(405, { allow: 'POST, DELETE' }).end();
      return;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await readBody(req));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'parse error' },
        }),
      );
      return;
    }
    const batch = Array.isArray(payload) ? payload : [payload];
    const replies: unknown[] = [];
    for (const raw of batch as RpcRequest[]) {
      if (raw?.id === undefined || raw.id === null) continue; // 通知：不回复
      try {
        replies.push({ jsonrpc: '2.0', id: raw.id, result: await handle(raw) });
      } catch (err) {
        const code = err instanceof RpcError ? err.code : -32603;
        const message = err instanceof Error ? err.message : String(err);
        replies.push({ jsonrpc: '2.0', id: raw.id, error: { code, message } });
      }
    }
    if (replies.length === 0) {
      res.writeHead(202).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(payload) ? replies : replies[0]));
  }

  const server: Server = createServer((req, res) => {
    onRequest(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    async close() {
      controller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
