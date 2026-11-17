export interface SseMessage {
  id?: string;
  event: string;
  data: string;
}

/**
 * 增量解析 text/event-stream。按 SSE 规范处理 `id:` / `event:` / `data:`（多行拼接）、
 * 注释行（以 `:` 开头）与 CRLF；空行触发一条消息。
 */
export class SseParser {
  #buffer = '';
  #id: string | undefined;
  #event = '';
  #data: string[] = [];

  push(chunk: string): SseMessage[] {
    this.#buffer += chunk;
    const out: SseMessage[] = [];
    for (;;) {
      const nl = this.#buffer.search(/\r\n|\r|\n/);
      if (nl < 0) break;
      const line = this.#buffer.slice(0, nl);
      const sep = this.#buffer.startsWith('\r\n', nl) ? 2 : 1;
      this.#buffer = this.#buffer.slice(nl + sep);
      const msg = this.#line(line);
      if (msg) out.push(msg);
    }
    return out;
  }

  #line(line: string): SseMessage | undefined {
    if (line === '') {
      if (this.#data.length === 0) {
        this.#event = '';
        return undefined;
      }
      const msg: SseMessage = {
        event: this.#event || 'message',
        data: this.#data.join('\n'),
        ...(this.#id === undefined ? {} : { id: this.#id }),
      };
      this.#event = '';
      this.#data = [];
      return msg;
    }
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.#data.push(value);
    else if (field === 'event') this.#event = value;
    else if (field === 'id' && !value.includes('\0')) this.#id = value;
    return undefined;
  }
}
