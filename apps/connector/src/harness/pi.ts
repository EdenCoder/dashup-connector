import { basename, join, isAbsolute } from 'node:path';
import { connect, type Socket } from 'node:net';
import { readdir, readFile } from 'node:fs/promises';

import type { Message } from '@dashup/protocol';

import { EARLIER, toolInput, type LiveSession } from './session';
import { PI_HOST, PI_VERSION, PI_MAX_TEXT, PI_MAX_FRAME, PI_REQUEST_MS, PI_MAX_HOSTS, PI_MAX_ENTRIES, PI_MAX_COMMAND, PI_MAX_REQUESTS, piFrame, piPrivate, piDirectory, type PiCommand, type PiSnapshot, type PiRegistry } from '../../pi/bridge';

// =============================================================================
// Existing Pi extension endpoints
// =============================================================================

type Entry = PiRegistry & { path: string };
type Pending = {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};

async function entries(): Promise<Entry[]> {
  if (process.env.DASHUP_LIVE_DISCOVERY === '0' && process.env.DASHUP_PI_DIRECTORY === undefined)
    return [];
  const directory = piDirectory();
  if (!(await piPrivate(directory, true))) return [];
  const files = (await readdir(directory).catch(() => []))
    .filter((name) => name.endsWith('.json'))
    .slice(0, PI_MAX_HOSTS);
  const result: Entry[] = [];
  for (const file of files) {
    const path = join(directory, file);
    try {
      if (!(await piPrivate(path))) continue;
      const value: PiRegistry = JSON.parse(await readFile(path, 'utf8'));
      if (
        value?.version !== PI_VERSION ||
        !Number.isSafeInteger(value.pid) ||
        value.pid <= 0 ||
        !Number.isSafeInteger(value.port) ||
        value.port < 1 ||
        value.port > 65535 ||
        typeof value.instance !== 'string' ||
        !/^[a-f0-9-]{36}$/.test(value.instance) ||
        typeof value.token !== 'string' ||
        !/^[a-f0-9]{64}$/.test(value.token) ||
        basename(path) !== `${value.pid}-${value.instance}.json`
      )
        continue;
      process.kill(value.pid, 0);
      result.push({ ...value, path });
    } catch {
      // An exiting Pi or a registry entry we do not own never becomes a controllable thread.
    }
  }
  return result;
}

function content(value: unknown): string {
  return typeof value === 'string'
    ? value.slice(0, PI_MAX_TEXT)
    : Array.isArray(value)
      ? value
          .filter((part) => part?.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text)
          .join('\n')
          .slice(0, PI_MAX_TEXT)
      : '';
}

export function piMessages(snapshot: Pick<PiSnapshot, 'entries' | 'earlier'>): Message[] {
  const result: Message[] = snapshot.earlier ? [EARLIER] : [];
  for (const entry of snapshot.entries.slice(-PI_MAX_ENTRIES)) {
    const value = entry.message;
    if (!value || typeof entry.id !== 'string') continue;
    const text = content(value.content);
    if (value.role === 'user' || value.role === 'assistant') {
      if (text) result.push({ id: entry.id, role: value.role, text });
      if (value.role === 'assistant' && Array.isArray(value.content)) {
        for (const [index, part] of value.content.entries())
          if (part?.type === 'toolCall' && typeof part.name === 'string')
            result.push({
              id: `${entry.id}:tool:${part.id ?? index}`,
              role: 'tool',
              text: '',
              tool: {
                name: part.name.slice(0, 256),
                input: toolInput(`${entry.id}:tool:${part.id ?? index}`, part.arguments),
                summary: typeof part.arguments === 'string' ? part.arguments.slice(0, 500) : '',
                at: entry.timestamp,
              },
            });
      }
    } else if (value.role === 'toolResult')
      result.push({
        id: entry.id,
        role: 'tool',
        text,
        tool: {
          name: typeof value.toolName === 'string' ? value.toolName.slice(0, 256) : 'tool',
          status: value.isError ? 'error' : 'ok',
          at: entry.timestamp,
        },
      });
    else if (value.role === 'bashExecution')
      result.push({
        id: entry.id,
        role: 'tool',
        text: content(value.output),
        tool: {
          name: 'bash',
          input: toolInput(entry.id, value.command),
          summary: typeof value.command === 'string' ? value.command.slice(0, 500) : '',
          status: value.exitCode === 0 ? 'ok' : 'error',
          at: entry.timestamp,
        },
      });
  }
  return result;
}

// =============================================================================
// Persistent, authenticated observation of the same Pi process
// =============================================================================

class Host {
  private socket?: Socket;
  private snapshot?: PiSnapshot;
  private connecting?: Promise<void>;
  private stopped = false;
  private readonly pending = new Map<string, Pending>();
  private readonly requests = new Map<string, Promise<void>>();

  constructor(
    readonly entry: Entry,
    private readonly changed: () => void,
  ) {}

  private disconnected(socket: Socket): void {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.snapshot = undefined;
    for (const receipt of this.pending.values()) {
      clearTimeout(receipt.timer);
      receipt.reject(new Error('Pi disconnected; command delivery is unknown'));
    }
    this.pending.clear();
    if (!this.stopped) this.changed();
  }

  private connect(): Promise<void> {
    if (this.snapshot && this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    const promise = new Promise<void>((resolve, reject) => {
      if (this.stopped) {
        reject(new Error('Pi observation stopped'));
        return;
      }
      const socket = (this.socket = connect({ host: PI_HOST, port: this.entry.port }));
      let buffer = Buffer.alloc(0);
      let ready = false;
      const timer = setTimeout(() => {
        reject(new Error('Pi bridge unavailable'));
        socket.destroy();
      }, PI_REQUEST_MS);
      socket.on('error', () => {
        reject(new Error('Pi bridge unavailable'));
      });
      socket.on('close', () => {
        clearTimeout(timer);
        if (!ready) reject(new Error('Pi bridge closed before authentication'));
        this.disconnected(socket);
      });
      socket.on('connect', () =>
        socket.write(piFrame({ type: 'hello', version: PI_VERSION, token: this.entry.token })));
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
            const value = JSON.parse(line.toString('utf8'));
            if (value?.type === 'snapshot') {
              if (
                value.version !== PI_VERSION ||
                value.instance !== this.entry.instance ||
                value.pid !== this.entry.pid ||
                typeof value.session !== 'string' ||
                !value.session ||
                value.session.length > 256 ||
                typeof value.cwd !== 'string' ||
                !isAbsolute(value.cwd) ||
                value.cwd.length > 16_384 ||
                typeof value.updatedAt !== 'string' ||
                !Number.isFinite(Date.parse(value.updatedAt)) ||
                typeof value.working !== 'boolean' ||
                !Array.isArray(value.entries) ||
                value.entries.length > PI_MAX_ENTRIES ||
                typeof value.earlier !== 'boolean'
              )
                throw new Error('Pi bridge identity is invalid');
              this.snapshot = value;
              clearTimeout(timer);
              if (!ready) {
                ready = true;
                resolve();
              }
              this.changed();
            } else if (ready && value?.type === 'result' && typeof value.id === 'string') {
              const receipt = this.pending.get(value.id);
              if (!receipt) continue;
              this.pending.delete(value.id);
              clearTimeout(receipt.timer);
              if (typeof value.error === 'string')
                receipt.reject(new Error(value.error.slice(0, 500)));
              else receipt.resolve();
            } else throw new Error('Pi bridge frame is invalid');
          } catch {
            socket.destroy();
            return;
          }
        }
      });
    });
    this.connecting = promise;
    void promise
      .finally(() => {
        if (this.connecting === promise) this.connecting = undefined;
      })
      .catch(() => {});
    return promise;
  }

  private command(
    id: string,
    session: string,
    method: PiCommand['method'],
    text?: string,
    now?: boolean,
  ): Promise<void> {
    const previous = this.requests.get(id);
    if (previous) return previous;
    const socket = this.socket;
    if (
      this.stopped ||
      !socket ||
      socket.destroyed ||
      !this.snapshot ||
      this.snapshot.session !== session
    )
      return Promise.reject(new Error('Pi session is disconnected or changed'));
    if (!id || id.length > 256 || this.requests.size >= PI_MAX_REQUESTS || this.pending.size >= 32)
      return Promise.reject(new Error('Pi command limit reached'));
    if (
      method === 'send' &&
      (this.snapshot.prompt ||
        typeof text !== 'string' ||
        !text.trim() ||
        Buffer.byteLength(text) > PI_MAX_COMMAND)
    )
      return Promise.reject(new Error('Pi reply is unavailable; check Pi on your computer'));
    const pending = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Pi did not acknowledge the command; delivery is unknown'));
      }, PI_REQUEST_MS);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(
        piFrame({
          type: 'command',
          id,
          session,
          method,
          ...(text === undefined ? {} : { text }),
          ...(now === undefined ? {} : { now }),
        }),
      );
    });
    this.requests.set(id, pending);
    return pending;
  }

  async read(): Promise<LiveSession[]> {
    await this.connect();
    const value = this.snapshot;
    if (!value) return [];
    const session = value.session;
    const messages = piMessages(value);
    if (value.prompt)
      messages.push({
        id: `${session}:local-question`,
        role: 'system',
        text: `${String(value.prompt).slice(0, 256)}\nAnswer this extension question in Pi on your computer.`,
      });
    return [
      {
        id: session,
        cwd: value.cwd,
        harness: 'pi',
        ...(value.title ? { title: String(value.title).slice(0, 256) } : {}),
        updatedAt: value.updatedAt,
        status: value.prompt ? 'attention' : value.working ? 'working' : 'idle',
        messages,
        approvals: [],
        ...(typeof value.typing === 'string' && value.typing
          ? { typing: value.typing.slice(0, PI_MAX_TEXT) }
          : {}),
        ...(!value.prompt
          ? {
              send: (id: string, text: string, now?: boolean) =>
                this.command(id, session, 'send', text, now),
              now: true,
            }
          : {}),
        ...(value.working ? { stop: (id: string) => this.command(id, session, 'abort') } : {}),
      },
    ];
  }

  stop(): void {
    this.stopped = true;
    this.snapshot = undefined;
    this.socket?.destroy();
    for (const receipt of this.pending.values()) {
      clearTimeout(receipt.timer);
      receipt.reject(new Error('Pi observation stopped'));
    }
    this.pending.clear();
  }
}

export class Pi {
  private stopped = false;
  private readonly hosts = new Map<string, Host>();
  constructor(private readonly changed: () => void) {}

  async refresh(): Promise<LiveSession[]> {
    if (this.stopped) return [];
    const discovered = await entries();
    if (this.stopped) return [];
    const current = new Set(discovered.map((entry) => JSON.stringify(entry)));
    for (const [key, host] of this.hosts)
      if (!current.has(key)) {
        host.stop();
        this.hosts.delete(key);
      }
    const results = await Promise.allSettled(
      discovered.map(async (entry) => {
        const key = JSON.stringify(entry);
        let host = this.hosts.get(key);
        if (!host) {
          host = new Host(entry, this.changed);
          this.hosts.set(key, host);
        }
        return host.read();
      }),
    );
    return this.stopped
      ? []
      : results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  }

  stop(): void {
    this.stopped = true;
    for (const host of this.hosts.values()) host.stop();
    this.hosts.clear();
  }
}
