import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { join, delimiter, isAbsolute } from 'node:path';
import { access, stat } from 'node:fs/promises';
import { Readable, Writable } from 'node:stream';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type { ClientConnection, InitializeResponse, SessionNotification, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { Message, Approval, ApprovalReply } from '@dashup/protocol';

import { version as DASHUP_VERSION } from '../../package.json';
import { EARLIER, toolInput, NO_PREVIEW, MAX_PREVIEW, type LiveSession } from './session';
import { junieHome } from './junie-history';

// =============================================================================
// Junie's installed ACP command
// =============================================================================

const REQUEST_MS   = 30_000;
const MAX_BYTES    = 8 * 1024 * 1024;
const MAX_MESSAGES = 1_000;
const MAX_REQUESTS = 1_000;

type Data = Record<string, any>;
type Permission = {
  approval : Approval;
  resolve  : (response: RequestPermissionResponse) => void;
};

// Finding the command does not run it. Existing terminal and IDEA sessions keep their owners.
export async function junieCommand(): Promise<string | undefined> {
  const explicit = process.env.DASHUP_JUNIE_COMMAND?.trim();
  const names = process.platform === 'win32' ? ['junie.exe', 'junie.cmd', 'junie.bat'] : ['junie'];
  const paths = explicit
    ? isAbsolute(explicit)
      ? [explicit]
      : []
    : [...(process.env.PATH ?? '').split(delimiter), join(homedir(), '.local', 'bin')].flatMap((
        directory,
      ) => names.map((name) => join(directory, name)));
  for (const path of paths)
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return path;
    } catch {
      // Missing PATH entries are normal on machines without Junie.
    }
  return undefined;
}

async function within<T>(task: Promise<T>, close: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error('Junie did not acknowledge the native request in time'));
          close();
        }, REQUEST_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value);
}

function toolContent(tool: Data): string {
  return (tool.content ?? [])
    .flatMap((part: Data) =>
      part?.type === 'content' && part.content?.type === 'text' ? [part.content.text] : [])
    .join('\n\n');
}

// Only the native choices are offered. Missing or oversized previews leave allow on the computer.
export function junieApproval(id: string, request: RequestPermissionRequest): Approval {
  const tool = request.toolCall;
  const diffs = (tool.content ?? []).filter((part) => part.type === 'diff');
  const change = diffs[0];
  const input =
    typeof tool.rawInput === 'string'
      ? tool.rawInput.trim()
      : tool.rawInput && typeof tool.rawInput === 'object' && Object.keys(tool.rawInput).length
        ? text(tool.rawInput)
        : '';
  const changes = diffs.map(
    (part) =>
      `--- ${part.path}\n+++ ${part.path}\n${(part.oldText ?? '')
        .split('\n')
        .map((line) => `-${line}`)
        .join('\n')}\n${part.newText
        .split('\n')
        .map((line) => `+${line}`)
        .join('\n')}`,
  );
  const detail = [input, toolContent(tool), ...changes].filter(Boolean).join('\n\n');
  const complete = !!detail.trim() && Buffer.byteLength(detail) <= MAX_PREVIEW;
  return {
    id,
    title   : tool.title || tool.name || 'Junie needs approval',
    detail  : complete ? detail : NO_PREVIEW,
    choices : request.options
      .filter((option) => complete || option.kind.startsWith('reject'))
      .map((option) => ({
        id: option.optionId,
        label: option.name,
        intent: option.kind.startsWith('allow') ? ('approve' as const) : ('reject' as const),
      })),
    ...(complete && change ? { change: { path: change.path, diff: changes[0]! } } : {}),
  };
}

// =============================================================================
// Sessions explicitly started or loaded by the phone
// =============================================================================

class Session {
  id: string;
  title?: string;
  updatedAt = new Date().toISOString();
  private readonly messages: Message[] = [];
  private readonly permissions = new Map<string, Permission>();
  private process?: ChildProcessWithoutNullStreams;
  private connection?: ClientConnection;
  private turn?: Promise<void>;
  private accepted?: { resolve(): void; reject(error: unknown): void };
  private assistant?: Message;
  private capabilities?: InitializeResponse;
  private ended = false;

  constructor(
    readonly cwd: string,
    private readonly changed: () => void,
    id = '',
  ) {
    this.id = id;
  }

  private publish(): void {
    this.updatedAt = new Date().toISOString();
    while (
      this.messages.length > MAX_MESSAGES ||
      (this.messages.length > 1 &&
        this.messages.reduce((size, message) => size + Buffer.byteLength(message.text), 0) >
          MAX_BYTES)
    ) {
      if (this.messages[0]?.id === EARLIER.id) this.messages.splice(1, 1);
      else {
        this.messages.shift();
        this.messages.unshift({ ...EARLIER });
      }
    }
    this.changed();
  }

  private receive(params: SessionNotification): void {
    if (params.sessionId !== this.id) return;
    this.accepted?.resolve();
    const update = params.update;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
      if (!this.assistant || (update.messageId && this.assistant.id !== update.messageId)) {
        this.assistant = { id: update.messageId || randomUUID(), role: 'assistant', text: '' };
        this.messages.push(this.assistant);
      }
      this.assistant.text = (this.assistant.text + update.content.text).slice(-MAX_BYTES);
    } else if (update.sessionUpdate === 'user_message_chunk' && update.content.type === 'text') {
      // Loaded history is replayed by Junie; live user prompts are already recorded by say().
      if (!this.turn) {
        const last = this.messages.at(-1);
        if (last?.role === 'user') last.text += update.content.text;
        else this.messages.push({ id: randomUUID(), role: 'user', text: update.content.text });
      }
      this.assistant = undefined;
    } else if (
      update.sessionUpdate === 'tool_call' ||
      update.sessionUpdate === 'tool_call_update'
    ) {
      this.assistant = undefined;
      const id = `tool:${update.toolCallId}`;
      const known = this.messages.find((message) => message.id === id);
      const message: Message = {
        id,
        role : 'tool',
        text : (toolContent(update) || text(update.rawOutput) || known?.text || '').slice(
          -MAX_BYTES,
        ),
        tool : {
          ...known?.tool,
          name: update.name || update.title || known?.tool?.name || 'Tool',
          ...(update.rawInput !== undefined
            ? {
                summary: text(update.rawInput).slice(0, MAX_PREVIEW),
                input: toolInput(id, update.rawInput),
              }
            : {}),
          ...(update.status === 'completed' ? { status: 'ok' as const } : {}),
          ...(update.status === 'failed' ? { status: 'error' as const } : {}),
        },
      };
      if (known) Object.assign(known, message);
      else this.messages.push(message);
    } else if (update.sessionUpdate === 'session_info_update' && update.title) {
      this.title = update.title;
    }
    this.publish();
  }

  private permission(
    params: RequestPermissionRequest,
    signal: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    if (params.sessionId !== this.id || this.ended || signal.aborted)
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    this.accepted?.resolve();
    const id = randomUUID();
    return new Promise((resolve) => {
      const settle = (response: RequestPermissionResponse) => {
        signal.removeEventListener('abort', cancel);
        this.permissions.delete(id);
        resolve(response);
        this.publish();
      };
      const cancel = () => settle({ outcome: { outcome: 'cancelled' } });
      this.permissions.set(id, { approval: junieApproval(id, params), resolve: settle });
      signal.addEventListener('abort', cancel, { once: true });
      this.publish();
    });
  }

  async open(command: string, saved: boolean): Promise<void> {
    const windows = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
    const encoded = Buffer.from(command, 'utf8').toString('base64');
    const script = `[Console]::InputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding; $p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); & $p --acp true; exit $LASTEXITCODE`;
    const child = (this.process = spawn(
      windows ? 'powershell.exe' : command,
      windows
        ? [
            '-NoProfile',
            '-NonInteractive',
            '-EncodedCommand',
            Buffer.from(script, 'utf16le').toString('base64'),
          ]
        : ['--acp', 'true'],
      {
        cwd         : this.cwd,
        stdio       : 'pipe',
        windowsHide : true,
        env         : {
          ...process.env,
          JUNIE_HOME: junieHome(),
        },
      },
    ));
    child.stdin.on('error', () => {});
    child.stderr.resume();
    child.once('error', () => this.end(new Error('Junie could not start on this computer')));
    child.once('exit', () => this.end(new Error('Junie ACP process exited')));
    this.connection = client({ name: 'dashup' })
      .onNotification(methods.client.session.update, ({ params }) => this.receive(params))
      .onRequest(methods.client.session.requestPermission, ({ params, signal }) =>
        this.permission(params, signal))
      .connect(
        ndJsonStream(
          Writable.toWeb(child.stdin),
          Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
          {
            maxMessageBytes: MAX_BYTES,
          },
        ),
      );
    void this.connection.closed.then(() => this.end(new Error('Junie ACP connection closed')));
    const request = this.connection.agent.request.bind(this.connection.agent);
    this.capabilities = await within(
      request(methods.agent.initialize, {
        protocolVersion    : PROTOCOL_VERSION,
        clientCapabilities : {},
        clientInfo         : { name: 'Dashup', version: DASHUP_VERSION },
      }),
      () => this.end(),
    );
    if (this.capabilities.protocolVersion !== PROTOCOL_VERSION)
      throw new Error('Junie uses an unsupported ACP protocol version');
    if (saved) {
      if (!this.capabilities.agentCapabilities?.loadSession)
        throw new Error('This Junie version cannot load saved sessions through ACP');
      await within(
        request(methods.agent.session.load, {
          sessionId  : this.id,
          cwd        : this.cwd,
          mcpServers : [],
        }),
        () => this.end(),
      );
    } else {
      const session = await within(
        request(methods.agent.session.new, { cwd: this.cwd, mcpServers: [] }),
        () => this.end(),
      );
      this.id = session.sessionId;
    }
  }

  async say(prompt: string, now = false): Promise<void> {
    if (!prompt.trim()) throw new Error('Write a message for Junie first');
    if (now) throw new Error('Junie steering is not available through this connection');
    if (!this.connection || this.ended) throw new Error('Junie ACP connection is closed');
    if (this.turn) throw new Error('Wait for the current Junie turn to finish');
    this.assistant = undefined;
    this.messages.push({ id: randomUUID(), role: 'user', text: prompt });
    const accepted = new Promise<void>((resolve, reject) => {
      this.accepted = { resolve, reject };
    });
    const turn = this.connection.agent
      .request(methods.agent.session.prompt, {
        sessionId : this.id,
        prompt    : [{ type: 'text', text: prompt }],
      })
      .then(
        () => this.accepted?.resolve(),
        (error: unknown) => {
          this.accepted?.reject(error);
          this.messages.push({
            id   : randomUUID(),
            role : 'system',
            text : error instanceof Error ? error.message : 'Junie rejected the native prompt',
          });
        },
      )
      .finally(() => {
        if (this.turn !== turn) return;
        this.turn = undefined;
        this.accepted = undefined;
        for (const permission of this.permissions.values())
          permission.resolve({ outcome: { outcome: 'cancelled' } });
        this.publish();
      });
    this.turn = turn;
    this.publish();
    await within(accepted, () => this.end());
  }

  live(once: (id: string, action: () => Promise<void>) => Promise<void>): LiveSession {
    const connected = !this.ended && !!this.connection;
    return {
      id        : this.id,
      cwd       : this.cwd,
      title     : this.title,
      harness   : 'junie',
      updatedAt : this.updatedAt,
      status    : this.permissions.size ? 'attention' : this.turn ? 'working' : 'idle',
      messages  : this.messages.map((message) => ({ ...message })),
      approvals : [...this.permissions.values()].map((permission) => permission.approval),
      ...(connected
        ? {
            send: (id: string, prompt: string, now?: boolean) =>
              once(id, () => this.say(prompt, now)),
            ...(this.turn
              ? {
                  stop: (id: string) =>
                    once(id, async () => {
                      if (!this.turn || !this.connection || this.ended)
                        throw new Error('Nothing is running in this Junie session');
                      const turn = this.turn;
                      await this.connection.agent.notify(methods.agent.session.cancel, {
                        sessionId: this.id,
                      });
                      for (const permission of this.permissions.values())
                        permission.resolve({ outcome: { outcome: 'cancelled' } });
                      await within(turn, () => this.end());
                    }),
                }
              : {}),
            ...(this.permissions.size
              ? {
                  approve: (id: string, approvalId: string, reply: ApprovalReply) =>
                    once(id, async () => {
                      const permission = this.permissions.get(approvalId);
                      if (!permission || this.ended)
                        throw new Error('Junie approval is no longer pending');
                      if (
                        !('choice' in reply) ||
                        !permission.approval.choices.some((choice) => choice.id === reply.choice)
                      )
                        throw new Error('Choose one of the native Junie permission options');
                      permission.resolve({
                        outcome: { outcome: 'selected', optionId: reply.choice },
                      });
                    }),
                }
              : {}),
          }
        : {}),
    };
  }

  connected(): boolean {
    return !this.ended && !!this.connection;
  }

  end(error?: Error): void {
    if (this.ended) return;
    this.ended = true;
    this.accepted?.reject(error ?? new Error('Junie ACP connection closed'));
    for (const permission of this.permissions.values())
      permission.resolve({ outcome: { outcome: 'cancelled' } });
    this.connection?.close(error);
    this.process?.kill();
    this.publish();
  }
}

// =============================================================================
// Junie lifecycle
// =============================================================================

export class Junie {
  private readonly owned = new Set<Session>();
  private readonly sessions = new Map<string, Session>();
  private readonly requests = new Map<string, Promise<void>>();
  private stopped = false;

  constructor(private readonly changed: () => void) {}

  available(): Promise<boolean> {
    return junieCommand().then(Boolean);
  }

  private readonly once = (id: string, action: () => Promise<void>): Promise<void> => {
    const known = this.requests.get(id);
    if (known) return known;
    if (this.requests.size >= MAX_REQUESTS)
      throw new Error('Junie command history is full; restart Dashup before sending');
    const result = Promise.resolve().then(action);
    this.requests.set(id, result);
    return result;
  };

  async start(cwd: string, prompt: string): Promise<string> {
    if (this.stopped) throw new Error('Dashup has stopped its Junie connections');
    if (!prompt.trim()) throw new Error('Write a message for Junie first');
    const command = await junieCommand();
    if (!command) throw new Error('Junie is not installed on this computer');
    const session = new Session(cwd, this.changed);
    this.owned.add(session);
    try {
      await session.open(command, false);
      if (this.stopped) throw new Error('Dashup has stopped its Junie connections');
      session.title = prompt.trim().split('\n')[0]!.slice(0, 80);
      this.sessions.set(session.id, session);
      await session.say(prompt);
      return session.id;
    } catch (error) {
      this.sessions.delete(session.id);
      this.owned.delete(session);
      session.end();
      throw error;
    }
  }

  async resume(id: string, cwd: string, prompt: string): Promise<void> {
    if (this.stopped) throw new Error('Dashup has stopped its Junie connections');
    const known = this.sessions.get(id);
    if (known?.connected()) return known.say(prompt);
    // Loading restores native state in a new process; product history cannot authorize this
    // without owner evidence, so imported Junie records opt out of automatic resume.
    if (known) {
      this.owned.delete(known);
      this.sessions.delete(id);
    }
    if (!prompt.trim()) throw new Error('Write a message for Junie first');
    const command = await junieCommand();
    if (!command) throw new Error('Junie is not installed on this computer');
    const session = new Session(cwd, this.changed, id);
    this.owned.add(session);
    try {
      await session.open(command, true);
      if (this.stopped) throw new Error('Dashup has stopped its Junie connections');
      this.sessions.set(id, session);
      await session.say(prompt);
    } catch (error) {
      this.sessions.delete(id);
      this.owned.delete(session);
      session.end();
      throw error;
    }
  }

  async refresh(): Promise<LiveSession[]> {
    return this.stopped
      ? []
      : [...this.sessions.values()].map((session) => session.live(this.once));
  }

  stop(): void {
    this.stopped = true;
    for (const session of this.owned) session.end();
    this.owned.clear();
    this.sessions.clear();
  }
}
