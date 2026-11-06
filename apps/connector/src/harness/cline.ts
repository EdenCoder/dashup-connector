import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { open, stat, readdir } from 'node:fs/promises';

import WebSocket from 'ws';
import type { Message, Approval, ApprovalReply } from '@dashup/protocol';

import { privateRecord } from './local-file';
import { EARLIER, toolInput, NO_PREVIEW, MAX_PREVIEW, type LiveSession } from './session';

// =============================================================================
// Existing local Cline hubs
// =============================================================================

const VERSION       = 'v1';
const REQUEST_MS    = 4_000;
const MAX_HUBS      = 32;
const MAX_SESSIONS  = 100;
const MAX_MESSAGES  = 1_000;
const MAX_REQUESTS  = 1_000;
const MAX_RECORD    = 64 * 1024;
const MAX_BYTES     = 8 * 1024 * 1024;
const APPROVALS     = [
  { id: 'once', label: 'Allow once' },
  { id: 'reject', label: 'Reject' },
];

type Data = Record<string, any>;
type Owner = { hubId: string; url: string; authToken: string; startedAt: string };
type Pending = {
  resolve : (value: Data) => void;
  reject  : (error: Error) => void;
  timer   : NodeJS.Timeout;
  accept? : string;
};

// The auth token comes only from a same-user native discovery file, never a remote URL.
export function clineEndpoint(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'ws:' ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Cline endpoint must be an uncredentialed loopback WebSocket origin');
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.toString();
}

async function owner(path: string): Promise<Owner | undefined> {
  if (!(await privateRecord(path, MAX_RECORD))) return;
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.size > MAX_RECORD ||
      (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))
    )
      return;
    const value = JSON.parse(await file.readFile('utf8'));
    if (
      !value ||
      typeof value.hubId !== 'string' ||
      !value.hubId ||
      value.protocolVersion !== VERSION ||
      (value.minClientProtocolVersion && value.minClientProtocolVersion !== VERSION) ||
      (value.maxClientProtocolVersion && value.maxClientProtocolVersion !== VERSION) ||
      typeof value.authToken !== 'string' ||
      !/^[A-Za-z0-9._~-]{1,512}$/.test(value.authToken) ||
      typeof value.startedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.startedAt)) ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.url !== 'string'
    )
      return;
    const url = clineEndpoint(value.url);
    if (Number(new URL(url).port || 80) !== value.port) return;
    process.kill(value.pid, 0);
    if (
      process.platform === 'linux' &&
      process.getuid &&
      (await stat(`/proc/${value.pid}`)).uid !== process.getuid()
    )
      return;
    return { hubId: value.hubId, url, authToken: value.authToken, startedAt: value.startedAt };
  } finally {
    await file.close();
  }
}

async function owners(): Promise<Owner[]> {
  const explicit = process.env.CLINE_HUB_DISCOVERY_PATH?.trim();
  if (process.env.DASHUP_LIVE_DISCOVERY === '0' && !explicit) return [];
  const data =
    process.env.CLINE_DATA_DIR?.trim() ||
    join(process.env.CLINE_DIR?.trim() || join(homedir(), '.cline'), 'data');
  const directory = join(data, 'locks', 'hub', 'owners');
  const paths = explicit
    ? [explicit]
    : (await readdir(directory).catch(() => []))
        .filter((name) => name.endsWith('.json'))
        .slice(0, MAX_HUBS)
        .map((name) => join(directory, name));
  return (await Promise.all(paths.map((path) => owner(path).catch(() => undefined)))).filter(
    (value): value is Owner => !!value,
  );
}

// =============================================================================
// Native messages and tool approvals
// =============================================================================

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return JSON.stringify(value) ?? '';
}

function messages(value: unknown): Message[] {
  if (!Array.isArray(value)) return [];
  const entries = value.slice(-MAX_MESSAGES);
  const result: Message[] = value.length > entries.length ? [EARLIER] : [];
  for (const [index, entry] of entries.entries()) {
    if (!entry || !['user', 'assistant'].includes(entry.role)) continue;
    const content =
      typeof entry.content === 'string' ? [{ type: 'text', text: entry.content }] : entry.content;
    if (!Array.isArray(content)) continue;
    const prose = content
      .filter((part: Data) => part?.type === 'text' && typeof part.text === 'string')
      .map((part: Data) => part.text)
      .join('\n');
    if (prose)
      result.push({
        id:
          typeof entry.id === 'string'
            ? entry.id
            : `cline:message:${value.length - entries.length + index}`,
        role: entry.role,
        text: prose,
      });
    for (const part of content) {
      if (part?.type !== 'tool_use' && part?.type !== 'tool_result') continue;
      const callId = part.type === 'tool_use' ? part.id : part.tool_use_id;
      if (typeof callId !== 'string' || typeof part.name !== 'string') continue;
      const id = `cline:tool:${callId}`;
      const previous = result.findIndex((message) => message.id === id);
      const input = part.type === 'tool_use' ? text(part.input) : undefined;
      const output = Array.isArray(part.content)
        ? part.content
            .filter((block: Data) => block?.type === 'text' && typeof block.text === 'string')
            .map((block: Data) => block.text)
            .join('\n')
        : text(part.content);
      const message: Message = {
        id,
        role : 'tool',
        text : part.type === 'tool_result' ? output : '',
        tool : {
          ...(previous >= 0 ? result[previous]!.tool : {}),
          name: part.name,
          ...(part.type === 'tool_use' ? { input: toolInput(id, part.input) } : {}),
          ...(input ? { summary: input.slice(0, MAX_PREVIEW) } : {}),
          ...(part.type === 'tool_result'
            ? { status: part.is_error ? ('error' as const) : ('ok' as const) }
            : {}),
        },
      };
      if (previous >= 0) result[previous] = message;
      else result.push(message);
    }
  }
  return result;
}

function approval(value: Data): Approval | undefined {
  if (
    typeof value.approvalId !== 'string' ||
    typeof value.toolName !== 'string' ||
    typeof value.inputJson !== 'string'
  )
    return;
  const visible = Buffer.byteLength(value.inputJson) <= MAX_PREVIEW;
  return {
    id      : value.approvalId,
    title   : value.toolName,
    detail  : visible ? value.inputJson : NO_PREVIEW,
    choices : visible ? APPROVALS : [],
  };
}

// =============================================================================
// Authenticated native v1 transport
// =============================================================================

class Hub {
  constructor(
    readonly owner: Owner,
    private readonly changed: () => void,
  ) {}

  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private readonly clientId = `dashup-${randomUUID()}`;
  private readonly pending = new Map<string, Pending>();
  private readonly approvals = new Map<string, { sessionId: string; value: Approval }>();
  private readonly tools = new Map<string, { sessionId: string; message: Message }>();
  private readonly typing = new Map<string, string>();
  private sequence?: number;
  private connected = false;
  private stopped = false;

  private disconnect(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.connected = false;
    this.socket = undefined;
    this.approvals.clear();
    this.tools.clear();
    this.typing.clear();
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('Cline hub disconnected; the action was not retried'));
    }
    this.pending.clear();
    this.changed();
  }

  private receive(raw: WebSocket.RawData): void {
    let frame: Data;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const event = frame?.envelope;
    if (!event || event.version !== VERSION) return;
    if (frame.kind === 'reply') {
      const item = this.pending.get(event.requestId);
      if (!item) return;
      this.pending.delete(event.requestId);
      clearTimeout(item.timer);
      if (event.ok === true) item.resolve(event.payload ?? {});
      else item.reject(new Error('Cline rejected the native request'));
      return;
    }
    if (frame.kind !== 'event') return;
    // Pending approval replay intentionally has no durable sequence; its native id owns it.
    if (typeof event.sequence === 'number' && Number.isSafeInteger(event.sequence)) {
      if (this.sequence !== undefined && event.sequence <= this.sequence) return;
      this.sequence = event.sequence;
    }
    const payload = event.payload ?? {};
    const sessionId = event.sessionId;
    if (event.event === 'run.started' && typeof payload.requestId === 'string') {
      const item = this.pending.get(payload.requestId);
      if (item && item.accept === sessionId) {
        this.pending.delete(payload.requestId);
        clearTimeout(item.timer);
        item.resolve({});
      }
    }
    if (typeof sessionId === 'string') {
      if (event.event === 'approval.requested') {
        const value = approval(payload);
        if (value) this.approvals.set(value.id, { sessionId, value });
      } else if (event.event === 'approval.resolved') {
        this.approvals.delete(payload.approvalId);
      } else if (event.event === 'assistant.delta' && typeof payload.text === 'string') {
        this.typing.set(
          sessionId,
          ((this.typing.get(sessionId) ?? '') + payload.text).slice(-MAX_BYTES),
        );
      } else if (event.event === 'assistant.finished' && typeof payload.text === 'string') {
        this.typing.set(sessionId, payload.text.slice(-MAX_BYTES));
      } else if (
        ['tool.started', 'tool.updated', 'tool.finished'].includes(event.event) &&
        typeof payload.toolCallId === 'string' &&
        typeof payload.toolName === 'string'
      ) {
        const key = `${sessionId}\0${payload.toolCallId}`;
        const previous = this.tools.get(key)?.message;
        const summary =
          payload.input === undefined ? undefined : text(payload.input).slice(0, MAX_PREVIEW);
        const message: Message = {
          id: `cline:tool:${payload.toolCallId}`,
          role: 'tool',
          text:
            event.event === 'tool.finished'
              ? text(payload.output ?? payload.error)
              : event.event === 'tool.updated'
                ? text(payload.update)
                : '',
          tool: {
            name: payload.toolName,
            ...previous?.tool,
            ...(payload.input !== undefined
              ? { input: toolInput(`cline:tool:${payload.toolCallId}`, payload.input) }
              : {}),
            ...(summary ? { summary } : {}),
            ...(event.event === 'tool.finished'
              ? { status: payload.error ? ('error' as const) : ('ok' as const) }
              : {}),
          },
        };
        if (!this.tools.has(key) && this.tools.size >= MAX_MESSAGES)
          this.tools.delete(this.tools.keys().next().value!);
        this.tools.set(key, { sessionId, message });
      } else if (['run.completed', 'run.aborted', 'run.failed'].includes(event.event)) {
        this.typing.delete(sessionId);
        for (const [id, item] of this.approvals)
          if (item.sessionId === sessionId) this.approvals.delete(id);
      }
    }
    this.changed();
  }

  private async connect(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    if (this.stopped) throw new Error('Cline observer is closed');
    const task = (async () => {
      const socket = new WebSocket(this.owner.url, [`cline-hub-auth.${this.owner.authToken}`], {
        maxPayload: MAX_BYTES,
        followRedirects: false,
        handshakeTimeout: REQUEST_MS,
      });
      this.socket = socket;
      socket.on('message', (raw) => this.receive(raw));
      socket.on('close', () => this.disconnect(socket));
      socket.on('error', () => this.disconnect(socket));
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', () => reject(new Error('Could not connect to the local Cline hub')));
        socket.once('close', () => reject(new Error('Local Cline hub closed during connection')));
      });
      await this.command('client.register', {
        clientId: this.clientId,
        clientType: 'dashup',
        displayName: 'Dashup',
        actorKind: 'client',
        transport: 'native',
        protocolVersion: VERSION,
        capabilities: [{ name: 'approval.respond' }],
        metadata: { pid: process.pid },
      });
      if (this.stopped || this.socket !== socket) throw new Error('Cline observer disconnected');
      this.connected = true;
      socket.send(
        JSON.stringify({
          kind: 'stream.subscribe',
          clientId: this.clientId,
          ...(this.sequence === undefined ? {} : { sinceSequence: this.sequence }),
        }),
      );
    })();
    this.connecting = task;
    try {
      await task;
    } catch (error) {
      const socket = this.socket;
      if (socket) {
        this.disconnect(socket);
        socket.terminate();
      }
      throw error;
    } finally {
      this.connecting = undefined;
    }
  }

  private command(
    command: string,
    payload: Data,
    sessionId?: string,
    accept = false,
  ): Promise<Data> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('Cline hub is disconnected'));
    const requestId = randomUUID();
    return new Promise<Data>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('Cline did not acknowledge the action; it was not retried'));
      }, REQUEST_MS);
      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
        ...(accept ? { accept: sessionId } : {}),
      });
      socket.send(
        JSON.stringify({
          kind: 'command',
          envelope: {
            version: VERSION,
            command,
            requestId,
            clientId: this.clientId,
            payload,
            ...(sessionId ? { sessionId } : {}),
            ...(accept ? { timeoutMs: null } : {}),
          },
        }),
        (error) => {
          if (!error) return;
          const item = this.pending.get(requestId);
          if (item) {
            this.pending.delete(requestId);
            clearTimeout(timer);
            reject(new Error('Cline action could not be delivered'));
          }
        },
      );
    });
  }

  async refresh(
    once: (id: string, action: () => Promise<void>) => Promise<void>,
  ): Promise<LiveSession[]> {
    await this.connect();
    const listed = await this.command('session.list', { limit: MAX_SESSIONS });
    if (!Array.isArray(listed.sessions)) return [];
    const sessions: LiveSession[] = [];
    // Bound concurrent message reads; discovery never creates, resumes or starts a session.
    for (let index = 0; index < Math.min(listed.sessions.length, MAX_SESSIONS); index += 8) {
      const batch = await Promise.allSettled(
        listed.sessions.slice(index, index + 8).map(async (record: Data) => {
          if (
            typeof record?.sessionId !== 'string' ||
            !record.sessionId ||
            typeof (record.cwd ?? record.workspaceRoot) !== 'string' ||
            !isAbsolute(record.cwd ?? record.workspaceRoot)
          )
            return;
          const id = record.sessionId;
          const read = await this.command('session.messages', { sessionId: id }, id);
          const history = messages(read.messages);
          for (const [key, item] of this.tools) {
            if (item.sessionId !== id) continue;
            const saved = history.findIndex((message) => message.id === item.message.id);
            if (saved >= 0 && history[saved]!.tool?.status) this.tools.delete(key);
            else if (saved >= 0) history[saved] = item.message;
            else history.push(item.message);
          }
          const typing = this.typing.get(id);
          if (
            typing &&
            history.some((message) => message.role === 'assistant' && message.text.endsWith(typing))
          )
            this.typing.delete(id);
          const approvals = [...this.approvals.values()]
            .filter((item) => item.sessionId === id)
            .map((item) => item.value);
          const current = (): void => {
            if (!this.connected || this.stopped)
              throw new Error('Cline hub is disconnected; reconnect before sending');
          };
          const updated =
            typeof record.updatedAt === 'number' ? record.updatedAt : Date.parse(record.updatedAt);
          const title = record.metadata?.title ?? record.metadata?.prompt;
          const session: LiveSession = {
            id,
            cwd: record.cwd ?? record.workspaceRoot,
            harness: 'cline',
            ...(typeof title === 'string' && title.trim()
              ? { title: title.trim().slice(0, 200) }
              : {}),
            updatedAt: new Date(Number.isFinite(updated) ? updated : 0).toISOString(),
            status: approvals.length
              ? 'attention'
              : ['running', 'pending'].includes(record.status)
                ? 'working'
                : 'idle',
            messages: history,
            approvals,
            ...(this.typing.has(id) ? { typing: this.typing.get(id) } : {}),
            now: true,
            send: (requestId, prompt, now) =>
              once(requestId, async () => {
                current();
                if (!prompt.trim()) throw new Error('Write a message for Cline first');
                await this.command(
                  'session.send_input',
                  { prompt, delivery: now ? 'steer' : 'queue' },
                  id,
                  true,
                );
              }),
            stop: (requestId) =>
              once(requestId, async () => {
                current();
                await this.command('run.abort', { sessionId: id }, id);
              }),
            ...(approvals.length
              ? {
                  approve: (requestId: string, approvalId: string, reply: ApprovalReply) =>
                    once(requestId, async () => {
                      current();
                      const item = this.approvals.get(approvalId);
                      if (!item || item.sessionId !== id)
                        throw new Error('Cline approval is no longer pending');
                      if (
                        !('choice' in reply) ||
                        !item.value.choices.some((choice) => choice.id === reply.choice)
                      )
                        throw new Error('This Cline request must be reviewed on your computer');
                      // Consume before dispatch: an uncertain delivery must never trigger a second answer.
                      this.approvals.delete(approvalId);
                      await this.command(
                        'approval.respond',
                        { approvalId, approved: reply.choice === 'once' },
                        id,
                      );
                      this.changed();
                    }),
                }
              : {}),
          };
          return session;
        }),
      );
      for (const result of batch)
        if (result.status === 'fulfilled' && result.value) sessions.push(result.value);
    }
    return this.connected ? sessions : [];
  }

  stop(): void {
    this.stopped = true;
    const socket = this.socket;
    if (socket) {
      this.disconnect(socket);
      socket.terminate();
    }
  }
}

// =============================================================================
// Cline observer lifecycle
// =============================================================================

export class Cline {
  constructor(private readonly changed: () => void) {}

  private readonly hubs = new Map<string, Hub>();
  private readonly requests = new Map<string, Promise<void>>();
  private refreshing?: Promise<LiveSession[]>;
  private stopped = false;

  private once = (id: string, action: () => Promise<void>): Promise<void> => {
    const known = this.requests.get(id);
    if (known) return known;
    if (this.requests.size >= MAX_REQUESTS)
      throw new Error('Cline command history is full; restart the connector before sending');
    const pending = Promise.resolve().then(action);
    this.requests.set(id, pending);
    return pending;
  };

  refresh(): Promise<LiveSession[]> {
    if (this.stopped) return Promise.resolve([]);
    if (this.refreshing) return this.refreshing;
    const task = (async () => {
      const discovered = await owners();
      if (this.stopped) return [];
      const keys = new Set<string>();
      for (const record of discovered) {
        const key = `${record.hubId}\0${record.url}\0${record.startedAt}\0${record.authToken}`;
        keys.add(key);
        if (!this.hubs.has(key)) this.hubs.set(key, new Hub(record, this.changed));
      }
      for (const [key, hub] of this.hubs)
        if (!keys.has(key)) {
          hub.stop();
          this.hubs.delete(key);
        }
      const results = await Promise.allSettled(
        [...this.hubs.values()].map((hub) => hub.refresh(this.once)),
      );
      const sessions = new Map<string, LiveSession>();
      for (const result of results)
        if (result.status === 'fulfilled')
          for (const session of result.value)
            if (!sessions.has(session.id)) sessions.set(session.id, session);
      return this.stopped ? [] : [...sessions.values()];
    })();
    this.refreshing = task;
    void task.finally(() => {
      if (this.refreshing === task) this.refreshing = undefined;
    });
    return task;
  }

  stop(): void {
    this.stopped = true;
    for (const hub of this.hubs.values()) hub.stop();
    this.hubs.clear();
  }
}
