import { join } from 'node:path';
import { createHash, randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Socket, type Server } from 'node:net';
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';

import { PI_HOST, PI_VERSION, PI_MAX_TEXT, PI_MAX_FRAME, PI_REQUEST_MS, PI_MAX_ENTRIES, PI_MAX_HISTORY, PI_MAX_CLIENTS, PI_MAX_COMMAND, PI_MAX_REQUESTS, piFrame, piPrivate, piDirectory, type PiEntry, type PiCommand, type PiSnapshot } from './bridge';

// =============================================================================
// Pi's supported extension surface (host-provided, no runtime dependencies)
// =============================================================================

type Data = Record<string, any>;
type Context = {
  mode           : string;
  cwd            : string;
  sessionManager : {
    getSessionId(): string;
    getSessionName(): string | undefined;
    getBranch(): Data[];
    buildSessionProjection?(): { entries: { sourceEntry: Data; messages: Data[] }[] };
  };
  isIdle(): boolean;
  abort(): void;
};
type PiAPI = {
  on(event: string, handler: (event: Data, ctx: Context) => void | Promise<void>): unknown;
  sendUserMessage(text: string, options?: { deliverAs?: 'steer' | 'followUp' }): void;
};

function clipped(value: unknown, limit = PI_MAX_TEXT): string {
  if (typeof value !== 'string') return '';
  return value.length > limit
    ? value.slice(0, limit) + '\n[Continues in Pi on your computer.]'
    : value;
}

function message(value: Data): Data | undefined {
  if (!value || !['user', 'assistant', 'toolResult', 'bashExecution'].includes(value.role)) return;
  const content =
    typeof value.content === 'string'
      ? clipped(value.content)
      : Array.isArray(value.content)
        ? value.content.slice(0, 64).flatMap((part: Data): Data[] => {
            if (part?.type === 'text') return [{ type: 'text', text: clipped(part.text) }];
            if (part?.type === 'toolCall')
              return [
                {
                  type: 'toolCall',
                  id: clipped(part.id, 256),
                  name: clipped(part.name, 256),
                  arguments: clipped(JSON.stringify(part.arguments ?? {}), 2_000),
                },
              ];
            // Images, thinking, credentials and extension details are not bridge metadata.
            return [];
          })
        : [];
  return {
    role: value.role,
    content,
    ...(typeof value.toolCallId === 'string' ? { toolCallId: clipped(value.toolCallId, 256) } : {}),
    ...(typeof value.toolName === 'string' ? { toolName: clipped(value.toolName, 256) } : {}),
    ...(typeof value.isError === 'boolean' ? { isError: value.isError } : {}),
    ...(value.role === 'bashExecution'
      ? {
          command: clipped(value.command, 2_000),
          output: clipped(value.output),
          exitCode: value.exitCode,
        }
      : {}),
  };
}

function history(ctx: Context): { entries: PiEntry[]; earlier: boolean } {
  const projection = ctx.sessionManager.buildSessionProjection?.();
  const branch: Data[] = projection
    ? projection.entries.flatMap(({ sourceEntry, messages }) =>
        messages.map((value, index) => ({
          ...sourceEntry,
          id: `${sourceEntry.id}:${index}`,
          message: value,
        })))
    : ctx.sessionManager.getBranch().filter((entry) => entry.type === 'message');
  const entries: PiEntry[] = [];
  let bytes = 0;
  for (let index = branch.length - 1; index >= 0 && entries.length < PI_MAX_ENTRIES; index--) {
    const entry = branch[index]!;
    const value = message(entry.message);
    if (!value || typeof entry.id !== 'string') continue;
    const item = {
      id: clipped(entry.id, 256),
      timestamp: clipped(entry.timestamp, 64),
      message: value,
    };
    bytes += Buffer.byteLength(JSON.stringify(item));
    if (bytes > PI_MAX_HISTORY) break;
    entries.unshift(item);
  }
  return { entries, earlier: entries.length < branch.length };
}

// =============================================================================
// One bridge belongs to the existing interactive session
// =============================================================================

export default function dashup(pi: PiAPI): void {
  let server: Server | undefined;
  let context: Context | undefined;
  let metadata: string | undefined;
  let instance = '';
  let token = '';
  let generation = 0;
  let working = false;
  let prompt: string | undefined;
  let typing: string | undefined;
  let updatedAt = new Date().toISOString();
  let notify: ReturnType<typeof setTimeout> | undefined;
  const clients = new Set<Socket>();
  const authenticated = new Set<Socket>();
  const requests = new Map<string, { fingerprint: string; response: Data }>();

  function snapshot(): PiSnapshot {
    if (!context) throw new Error('Pi session is unavailable');
    return {
      type: 'snapshot',
      version: PI_VERSION,
      instance,
      pid: process.pid,
      session: context.sessionManager.getSessionId(),
      cwd: context.cwd,
      title: clipped(context.sessionManager.getSessionName(), 256) || undefined,
      updatedAt,
      working,
      prompt,
      typing,
      ...history(context),
    };
  }

  function write(socket: Socket, value: unknown): void {
    if (socket.destroyed) return;
    if (socket.writableLength > PI_MAX_FRAME) {
      socket.destroy();
      return;
    }
    socket.write(piFrame(value));
  }

  function changed(ctx: Context): void {
    context = ctx;
    updatedAt = new Date().toISOString();
    if (!notify)
      notify = setTimeout(() => {
        notify = undefined;
        if (!context) return;
        try {
          const value = snapshot();
          for (const client of authenticated) write(client, value);
        } catch {
          for (const client of clients) client.destroy();
        }
      }, 50);
    notify.unref();
  }

  async function close(): Promise<void> {
    generation++;
    clearTimeout(notify);
    notify = undefined;
    context = undefined;
    requests.clear();
    for (const client of clients) client.destroy();
    clients.clear();
    authenticated.clear();
    const current = server;
    const file = metadata;
    server = undefined;
    metadata = undefined;
    if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
    if (file) await unlink(file).catch(() => {});
  }

  function command(socket: Socket, request: PiCommand): void {
    if (
      !context ||
      !request ||
      request.type !== 'command' ||
      typeof request.id !== 'string' ||
      !request.id ||
      request.id.length > 256
    ) {
      socket.destroy();
      return;
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    const prior = requests.get(request.id);
    if (prior) {
      write(
        socket,
        prior.fingerprint === fingerprint
          ? prior.response
          : { type: 'result', id: request.id, error: 'Pi request id was already used' },
      );
      return;
    }
    let error: string | undefined;
    try {
      if (requests.size >= PI_MAX_REQUESTS)
        throw new Error('Pi command limit reached; reload the extension');
      if (request.session !== context.sessionManager.getSessionId())
        throw new Error('Pi session changed');
      if (request.method === 'send') {
        if (prompt) throw new Error('Answer the extension question in Pi on your computer');
        if (
          typeof request.text !== 'string' ||
          !request.text.trim() ||
          Buffer.byteLength(request.text) > PI_MAX_COMMAND
        )
          throw new Error('Pi reply is empty or too large');
        // Pi receives a real user message. Steering is cooperative at its next safe boundary;
        // followUp is its native queue. Neither creates a replacement agent or answers a dialog.
        pi.sendUserMessage(request.text, { deliverAs: request.now ? 'steer' : 'followUp' });
      } else if (request.method === 'abort') {
        if (context.isIdle() && !working) throw new Error('Nothing is running in Pi');
        context.abort();
      } else throw new Error('Unsupported Pi command');
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Pi rejected the command';
    }
    const response = { type: 'result', id: request.id, ...(error ? { error } : {}) };
    if (requests.size < PI_MAX_REQUESTS) requests.set(request.id, { fingerprint, response });
    write(socket, response);
    changed(context);
  }

  pi.on('session_start', async (_event, ctx) => {
    await close();
    if (ctx.mode !== 'tui') return;
    const current = generation;
    const directory = piDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await piPrivate(directory, true))) return;
    context = ctx;
    instance = randomUUID();
    token = randomBytes(32).toString('hex');
    working = !ctx.isIdle();
    prompt = undefined;
    typing = undefined;
    const listener = createServer((socket) => {
      if (socket.remoteAddress !== PI_HOST || clients.size >= PI_MAX_CLIENTS) {
        socket.destroy();
        return;
      }
      clients.add(socket);
      let buffer = Buffer.alloc(0);
      const timer = setTimeout(() => socket.destroy(), PI_REQUEST_MS);
      timer.unref();
      socket.on('error', () => {});
      socket.on('close', () => {
        clearTimeout(timer);
        clients.delete(socket);
        authenticated.delete(socket);
      });
      socket.on('data', (bytes) => {
        buffer = Buffer.concat([buffer, typeof bytes === 'string' ? Buffer.from(bytes) : bytes]);
        if (buffer.length > PI_MAX_FRAME) {
          socket.destroy();
          return;
        }
        let newline: number;
        while ((newline = buffer.indexOf(10)) >= 0) {
          const line = buffer.subarray(0, newline);
          buffer = buffer.subarray(newline + 1);
          try {
            const request = JSON.parse(line.toString('utf8'));
            if (!authenticated.has(socket)) {
              const supplied = Buffer.from(typeof request?.token === 'string' ? request.token : '');
              const secret = Buffer.from(token);
              if (
                request?.type !== 'hello' ||
                request.version !== PI_VERSION ||
                supplied.length !== secret.length ||
                !timingSafeEqual(supplied, secret)
              ) {
                socket.destroy();
                return;
              }
              authenticated.add(socket);
              clearTimeout(timer);
              write(socket, snapshot());
            } else command(socket, request);
          } catch {
            socket.destroy();
            return;
          }
        }
      });
    });
    server = listener;
    listener.on('error', () => {
      for (const client of clients) client.destroy();
    });
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, PI_HOST, () => {
        listener.removeListener('error', reject);
        resolve();
      });
    });
    if (current !== generation) {
      listener.close();
      return;
    }
    listener.unref();
    const address = listener.address();
    if (!address || typeof address === 'string') return;
    const file = join(directory, `${process.pid}-${instance}.json`);
    const temporary = file + '.tmp';
    await writeFile(
      temporary,
      JSON.stringify({
        version: PI_VERSION,
        instance,
        pid: process.pid,
        port: address.port,
        token,
      }),
      { mode: 0o600, flag: 'wx' },
    );
    await rename(temporary, file);
    if (current !== generation) {
      await unlink(file).catch(() => {});
      return;
    }
    metadata = file;
    if (!(await piPrivate(file))) await close();
  });
  pi.on('session_shutdown', close);
  pi.on('agent_start', (_event, ctx) => {
    working = true;
    changed(ctx);
  });
  pi.on('agent_settled', (_event, ctx) => {
    working = false;
    typing = undefined;
    changed(ctx);
  });
  pi.on('message_update', (event, ctx) => {
    const content = message(event.message)?.content;
    typing = Array.isArray(content)
      ? content
          .filter((part) => part.type === 'text')
          .map((part) => part.text)
          .join('\n')
      : undefined;
    changed(ctx);
  });
  pi.on('message_end', (_event, ctx) => {
    typing = undefined;
    changed(ctx);
  });
  for (const event of [
    'message_start',
    'session_info_changed',
    'session_tree',
    'session_compact',
    'tool_execution_start',
    'tool_execution_end',
  ])
    pi.on(event, (_event, ctx) => changed(ctx));
  // Newer Pi versions report blocking extension UI. Observe it without monkeypatching UI
  // methods or inventing answers; older versions simply do not emit these events.
  pi.on('ui_prompt_start', (event, ctx) => {
    prompt = clipped(event.title, 256) || 'Extension question';
    changed(ctx);
  });
  pi.on('ui_prompt_end', (_event, ctx) => {
    prompt = undefined;
    changed(ctx);
  });
}
