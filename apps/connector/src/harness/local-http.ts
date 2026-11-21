// =============================================================================
// Agents' own HTTP servers on this computer
// =============================================================================

export const REQUEST_MS = 4_000;
export const MAX_BYTES  = 8 * 1024 * 1024;
const RECONNECT_MS      = 2_000;

type Data = Record<string, any>;

export type Endpoint = { url: string; authorization?: string };

// What tells one kind of server from another: what a refusal calls it and a request to it, and
// the header that names a request's folder.
export type Dialect = { name: string; asked: string; folder: string };

// A URL that reaches only this computer and carries no credential or query; `refusal` says what
// any other is refused as. A numeric address keeps hostname resolution from leaving this computer.
export function loopback(value: string, protocol: string, refusal: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== protocol ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(refusal);
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url;
}

// A loopback HTTP origin, which names no path either.
export function loopbackOrigin(value: string, refusal: string): string {
  const url = loopback(value, 'http:', refusal);
  if (url.pathname !== '/') throw new Error(refusal);
  return url.origin;
}

// A response's bytes as they arrive. Leaving the loop ends the response where it is.
export async function* chunks(body: ReadableStream<Uint8Array> | null): AsyncGenerator<Uint8Array> {
  if (!body) return;
  const reader = body.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// A response's text, read no further than `max` bytes.
export async function text(
  body: ReadableStream<Uint8Array> | null,
  max: number,
  refusal: string,
): Promise<string> {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of chunks(body)) {
    size += chunk.byteLength;
    if (size > max) throw new Error(refusal);
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString('utf8');
}

// One JSON request, a POST when it carries a payload. An empty answer is undefined.
export async function request(
  { url, authorization }: Endpoint,
  { name, asked, folder }: Dialect,
  path: string,
  directory?: string,
  payload?: Data,
  method = payload === undefined ? 'GET' : 'POST',
): Promise<any> {
  const response = await fetch(url + path, {
    method,
    headers  : {
      ...(authorization ? { Authorization: authorization } : {}),
      ...(directory ? { [folder]: directory } : {}),
      ...(payload ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    redirect : 'error',
    signal   : AbortSignal.timeout(REQUEST_MS),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${asked} failed (${response.status})`);
  }
  const answer = await text(
    response.body,
    MAX_BYTES,
    `${name} response exceeds the local content limit`,
  );
  return answer ? JSON.parse(answer) : undefined;
}

// =============================================================================
// Event streams
// =============================================================================

// A server's event stream, once it answers with one.
export async function subscribe(
  { url, authorization }: Endpoint,
  path: string,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array> | null> {
  const response = await fetch(url + path, {
    headers  : authorization ? { Authorization: authorization } : {},
    redirect : 'error',
    signal,
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
    await response.body?.cancel();
    throw new Error('Events are unavailable');
  }
  return response.body;
}

// The data of each event in a stream. One past the content limit ends the stream.
export async function* frames(body: ReadableStream<Uint8Array> | null): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let size = 0;
  for await (const chunk of chunks(body)) {
    buffer += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(buffer) + size > MAX_BYTES)
      throw new Error('Event exceeds the local content limit');
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (line.startsWith('data:')) {
        data.push(line.slice(5).trimStart());
        size += Buffer.byteLength(line);
      } else if (!line && data.length) {
        const event = data.join('\n');
        data = [];
        size = 0;
        yield event;
      }
    }
  }
}

// A server's events for as long as they are wanted: `read` takes one connection's, and the next
// opens two seconds after one ends. `ended` hears each end, and `again` each reopening.
export class EventStream {
  private stream?: AbortController;
  private retry?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(
    private readonly read: (stream: AbortController) => Promise<void>,
    private readonly ended: () => void = () => {},
    private readonly again: () => void = () => {},
  ) {}

  open(): void {
    if (this.stream || this.retry || this.closed) return;
    const stream = (this.stream = new AbortController());
    void this.read(stream)
      .catch(() => {})
      .finally(() => {
        if (this.stream === stream) this.stream = undefined;
        if (this.closed) return;
        this.ended();
        this.retry = setTimeout(() => {
          this.retry = undefined;
          this.again();
          this.open();
        }, RECONNECT_MS);
        this.retry.unref();
      });
  }

  close(): void {
    this.closed = true;
    this.stream?.abort();
    clearTimeout(this.retry);
  }
}
