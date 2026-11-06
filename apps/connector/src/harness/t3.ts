import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { open, lstat, stat } from 'node:fs/promises';

import WebSocket from 'ws';
import type { Message, Approval, ApprovalReply } from '@dashup/protocol';

import { privateRecord } from './local-file';
import { toolInput, MAX_PREVIEW, NO_PREVIEW, type LiveSession } from './session';

// =============================================================================
// Existing T3 Code environments (published v0.1.5 HTTP / Effect RPC protocol 2)
// =============================================================================

const PROTOCOL      = '2';
const REQUEST_MS    = 4_000;
const AUTH_MS       = 10_000;
const SELECTED_MS   = 350;
const MAX_RECORD    = 64 * 1024;
const MAX_BYTES     = 2 * 1024 * 1024;
const MAX_SESSIONS  = 100;
const MAX_ITEMS     = 600;
const PAGE_ITEMS    = 30;
const MAX_OPERATIONS = 1_000;
const AUTH_TTL      = '10m';

type Data = Record<string, any>;
type Owner = { base: string; origin: string; pid: number; startedAt: string };
type Credential = { token: string; expiresAt: number };
type Page = { messages: Message[]; more: boolean };

export function t3Origin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('T3 Code discovery requires an uncredentialed loopback HTTP origin');
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.origin;
}

async function owner(): Promise<Owner | undefined> {
  const explicit = process.env.DASHUP_T3_BASE_DIR?.trim();
  if (process.env.DASHUP_LIVE_DISCOVERY === '0' && !explicit) return;
  const base = explicit || process.env.T3CODE_HOME?.trim() || join(homedir(), '.t3');
  if (!isAbsolute(base)) return;
  const path = join(base, 'userdata', 'server-runtime.json');
  const info = await lstat(path).catch(() => undefined);
  // Native runtime metadata contains no credential and may be readable by other local users.
  if (
    !info?.isFile() ||
    info.isSymbolicLink() ||
    info.size > MAX_RECORD ||
    (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o022) !== 0))
  )
    return;
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const checked = await file.stat();
    if (
      !checked.isFile() ||
      checked.size > MAX_RECORD ||
      (process.getuid && (checked.uid !== process.getuid() || (checked.mode & 0o022) !== 0))
    )
      return;
    const value = JSON.parse(await file.readFile('utf8'));
    if (
      value?.version !== 1 ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.origin !== 'string' ||
      typeof value.startedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.startedAt))
    )
      return;
    const origin = t3Origin(value.origin);
    if (Number(new URL(origin).port || 80) !== value.port) return;
    process.kill(value.pid, 0);
    if (
      process.platform === 'linux' &&
      process.getuid &&
      (await stat(`/proc/${value.pid}`)).uid !== process.getuid()
    )
      return;
    return { base, origin, pid: value.pid, startedAt: value.startedAt };
  } finally {
    await file.close();
  }
}

function credential(value: Data): Credential {
  if (
    typeof value?.token !== 'string' ||
    !value.token ||
    value.token.length > MAX_RECORD ||
    typeof value.expiresAt !== 'string' ||
    Date.parse(value.expiresAt) <= Date.now() + 10_000
  )
    throw new Error('T3 Code did not issue a usable scoped credential');
  return { token: value.token, expiresAt: Date.parse(value.expiresAt) };
}

async function authorize(native: Owner, signal: AbortSignal): Promise<Credential> {
  const path = process.env.DASHUP_T3_AUTH_FILE?.trim();
  if (path) {
    if (!(await privateRecord(path, MAX_RECORD)))
      throw new Error('T3 Code credential file must be private to this user');
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.size > MAX_RECORD ||
        (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))
      )
        throw new Error('T3 Code credential file changed');
      const value = JSON.parse(await file.readFile('utf8'));
      if (value.origin !== native.origin)
        throw new Error('T3 Code credential belongs to another environment');
      return credential(value);
    } finally {
      await file.close();
    }
  }
  // The official auth subcommand opens the existing local auth store; it never launches a server.
  const { stdout } = await promisify(execFile)(
    process.env.DASHUP_T3_CLI?.trim() || 't3',
    [
      'auth',
      'session',
      'issue',
      '--base-dir',
      native.base,
      '--scope',
      'orchestration:read',
      '--scope',
      'orchestration:operate',
      '--ttl',
      AUTH_TTL,
      '--label',
      'Dashup local connector',
      '--json',
    ],
    { timeout: AUTH_MS, maxBuffer: MAX_RECORD, windowsHide: true, signal },
  );
  return credential(JSON.parse(stdout));
}

async function read(native: Owner, auth: Credential, path: string): Promise<Data> {
  const response = await fetch(`${native.origin}${path}`, {
    redirect: 'error',
    headers: { authorization: `Bearer ${auth.token}`, 'x-t3-orchestration-protocol': PROTOCOL },
    signal: AbortSignal.timeout(REQUEST_MS),
  });
  if (!response.ok || !response.body) throw new Error('T3 Code refused the request');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_BYTES) throw new Error('T3 Code response exceeds the page limit');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function dispatch(native: Owner, auth: Credential, command: Data): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = new URL('/ws', native.origin);
    url.protocol = 'ws:';
    url.searchParams.set('orchestrationProtocol', PROTOCOL);
    const socket = new WebSocket(url, {
      headers: { authorization: `Bearer ${auth.token}` },
      maxPayload: MAX_BYTES,
      handshakeTimeout: REQUEST_MS,
    });
    const id = randomUUID();
    let done = false;
    const finish = (error?: Error): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.terminate();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error('T3 Code did not confirm the action')),
      REQUEST_MS,
    );
    timer.unref();
    socket.once('error', () => finish(new Error('T3 Code is not reachable')));
    socket.once('close', () => finish(new Error('T3 Code closed before confirming the action')));
    socket.on('message', (raw) => {
      try {
        const value = JSON.parse(raw.toString());
        for (const frame of Array.isArray(value) ? value : [value]) {
          if (frame?._tag === 'Ping') {
            socket.send(JSON.stringify({ _tag: 'Pong' }));
            continue;
          }
          if (frame?.requestId !== id || frame?._tag !== 'Exit') continue;
          return finish(
            frame.exit?._tag === 'Success'
              ? undefined
              : new Error('T3 Code refused this action; check the session on your computer'),
          );
        }
      } catch {
        finish(new Error('T3 Code returned an invalid response'));
      }
    });
    socket.once('open', () =>
      socket.send(
        JSON.stringify({
          _tag: 'Request',
          id,
          tag: 'orchestration.dispatchCommand',
          payload: command,
          headers: [],
        }),
      ));
  });
}

// =============================================================================
// Bounded native conversation pages and human commands
// =============================================================================

function nativeMessages(rows: Data[]): Message[] {
  if (rows.length > MAX_ITEMS) throw new Error('T3 Code returned an invalid bounded page');
  const result: Message[] = [];
  for (const row of rows) {
    const item = row?.item;
    if (typeof row?.sourceItemId !== 'string' || typeof row.sourceThreadId !== 'string' || !item)
      continue;
    const id = JSON.stringify([row.sourceThreadId, row.sourceItemId]);
    if (['user_message', 'assistant_message', 'reasoning', 'proposed_plan'].includes(item.type))
      result.push({
        id,
        role: item.type === 'user_message' ? 'user' : 'assistant',
        text: String(item.text ?? item.markdown ?? ''),
      });
    else if (item.type === 'command_execution' || item.type === 'file_change')
      result.push({
        id,
        role: 'tool',
        text: String(item.output ?? item.diffStr ?? ''),
        tool: {
          name: item.type === 'file_change' ? 'File change' : 'Command',
          input: toolInput(id, item.input),
          summary: String(item.input ?? item.fileName ?? ''),
          ...(item.status === 'running'
            ? {}
            : {
                status:
                  item.outputIndicatesFailure || item.status === 'failed'
                    ? ('error' as const)
                    : ('ok' as const),
              }),
          ...(item.type === 'file_change' ? { diff: true } : {}),
        },
      });
  }
  return result;
}

function nativeApprovals(projection: Data): Approval[] {
  const pending = new Set(
    (projection.runtimeRequests ?? [])
      .filter((row: Data) => row.status === 'pending' && row.responseCapability?.type === 'live')
      .map((row: Data) => row.id),
  );
  return (projection.turnItems ?? [])
    .filter((item: Data) => item.type === 'approval_request' && pending.has(item.requestId))
    .slice(0, 32)
    .map((item: Data) => {
      const detail = [item.prompt, item.reason]
        .filter((value) => typeof value === 'string')
        .join('\n');
      const safe = Buffer.byteLength(detail) <= MAX_PREVIEW;
      const choices = Array.isArray(item.options)
        ? item.options
        : [
            { decision: 'accept', label: 'Allow once' },
            { decision: 'decline', label: 'Decline' },
          ];
      return {
        id: item.requestId,
        title: String(item.appName || 'T3 Code approval'),
        detail: safe ? detail : NO_PREVIEW,
        choices: safe
          ? choices
              .slice(0, 32)
              .filter(
                (option: Data) =>
                  typeof option.decision === 'string' && typeof option.label === 'string',
              )
              .map((option: Data) => ({
                id: option.decision,
                label: option.warning ? `${option.label} — ${option.warning}` : option.label,
              }))
          : [],
      };
    });
}

class Conversation {
  readonly live: LiveSession;
  private activeRunId?: string;
  private page: Page = { messages: [], more: false };
  private cursor?: string;
  private readonly historyOrigins = new Map<string, string>();
  private selected?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private readonly operations = new Map<string, { hash: string; promise: Promise<void> }>();
  private disposed = false;

  constructor(
    private readonly native: Owner,
    private readonly auth: () => Promise<Credential>,
    id: string,
    cwd: string,
    private readonly changed: () => void,
  ) {
    this.live = {
      id,
      cwd,
      harness: 't3',
      updatedAt: new Date(0).toISOString(),
      status: 'idle',
      messages: [],
      approvals: [],
      readMessages: (before) => this.read(before),
      releaseMessages: () => this.release(),
      send: (requestId, text, _now, files) => {
        if (files?.length) throw new Error('Add T3 Code attachments on your computer');
        return this.mutate(requestId, {
          type: 'message.dispatch',
          messageId: `dashup-${requestId}`,
          text,
          attachments: [],
          createdBy: 'user',
          creationSource: 'mobile',
          dispatchMode: {
            type: this.activeRunId ? 'queue_after_active' : 'start_immediately',
          },
        });
      },
      stop: (requestId) => {
        const runId = this.activeRunId;
        if (!runId) return Promise.reject(new Error('T3 Code has no active run to stop'));
        return this.mutate(requestId, { type: 'run.interrupt', runId, holdQueue: true });
      },
      approve: (requestId, id, reply) => this.approve(requestId, id, reply),
    };
  }

  update(shell: Data): void {
    this.activeRunId = typeof shell.activeRunId === 'string' ? shell.activeRunId : undefined;
    this.live.title = shell.title;
    this.live.updatedAt =
      typeof shell.updatedAt === 'string' ? shell.updatedAt : new Date(0).toISOString();
    this.live.status = shell.pendingRuntimeRequest
      ? 'attention'
      : ['preparing', 'starting', 'running', 'waiting'].includes(shell.status)
        ? 'working'
        : 'idle';
  }

  private async read(before?: string): Promise<Page> {
    if (this.disposed) throw new Error('T3 Code session is no longer available');
    const generation = this.generation;
    const base = `/api/orchestration/threads/${encodeURIComponent(this.live.id)}`;
    if (before) {
      const index = this.page.messages.findIndex((message) => message.id === before);
      const remembered = index < 0 ? this.historyOrigins.get(before) : undefined;
      if (index < 0 && !remembered)
        throw new Error('T3 Code history changed; reopen this conversation');
      if (index >= 0 && (index > 0 || !this.cursor))
        return {
          messages: this.page.messages.slice(Math.max(0, index + 1 - PAGE_ITEMS), index + 1),
          more: index + 1 > PAGE_ITEMS || this.page.more,
        };
      const anchor = this.page.messages[index];
      const cursor = remembered ?? this.cursor!;
      const older = await read(
        this.native,
        await this.auth(),
        `${base}/history?cursor=${encodeURIComponent(cursor)}`,
      );
      if (this.disposed || generation !== this.generation)
        throw new Error('T3 Code conversation is no longer selected');
      if (!Array.isArray(older.items)) throw new Error('T3 Code returned an invalid history page');
      const rows = nativeMessages(older.items);
      const found = rows.findIndex((message) => message.id === before);
      if (!anchor && found < 0)
        throw new Error('T3 Code history changed; reopen this conversation');
      for (const message of rows) {
        this.historyOrigins.delete(message.id);
        this.historyOrigins.set(message.id, cursor);
      }
      while (this.historyOrigins.size > MAX_ITEMS)
        this.historyOrigins.delete(this.historyOrigins.keys().next().value!);
      this.page = {
        messages: anchor
          ? [...rows.filter((message) => message.id !== anchor.id), anchor]
          : rows.slice(0, found + 1),
        more: older.hasMoreHistory === true,
      };
      this.cursor = typeof older.nextCursor === 'string' ? older.nextCursor : undefined;
    } else {
      const latest = await read(this.native, await this.auth(), `${base}/bounded`);
      if (this.disposed || generation !== this.generation)
        throw new Error('T3 Code conversation is no longer selected');
      const projection = latest.projection;
      if (projection?.thread?.id !== this.live.id || !Array.isArray(projection.visibleTurnItems))
        throw new Error('T3 Code returned an invalid bounded conversation');
      this.page = {
        messages: nativeMessages(projection.visibleTurnItems),
        more: latest.hasMoreHistory === true,
      };
      this.cursor = typeof latest.historyCursor === 'string' ? latest.historyCursor : undefined;
      this.live.approvals = nativeApprovals(projection);
      clearTimeout(this.selected);
      this.selected = setTimeout(() => {
        if (!this.disposed) this.changed();
      }, SELECTED_MS);
      this.selected.unref();
    }
    return {
      messages: this.page.messages.slice(-PAGE_ITEMS),
      more: this.page.messages.length > PAGE_ITEMS || this.page.more,
    };
  }

  private mutate(requestId: string, fields: Data): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('T3 Code session is no longer available'));
    const hash = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
    const prior = this.operations.get(requestId);
    if (prior)
      return prior.hash === hash
        ? prior.promise
        : Promise.reject(new Error('T3 Code request id was already used for another action'));
    if (this.operations.size >= MAX_OPERATIONS)
      return Promise.reject(new Error('Reconnect T3 Code before sending more requests'));
    const promise = (async () => {
      await dispatch(this.native, await this.auth(), {
        ...fields,
        commandId: `dashup-${requestId}`,
        threadId: this.live.id,
      });
      this.changed();
    })();
    this.operations.set(requestId, { hash, promise });
    return promise;
  }

  private approve(requestId: string, id: string, reply: ApprovalReply): Promise<void> {
    const approval = this.live.approvals.find((item) => item.id === id);
    if (
      !approval ||
      !('choice' in reply) ||
      reply.text ||
      !approval.choices.some((choice) => choice.id === reply.choice)
    )
      throw new Error('This T3 Code request must be reviewed on your computer');
    return this.mutate(requestId, {
      type: 'runtime-request.respond',
      requestId: id,
      decision: reply.choice,
    });
  }

  stop(): void {
    this.disposed = true;
    this.historyOrigins.clear();
    this.release();
  }

  private release(): void {
    this.generation++;
    clearTimeout(this.selected);
    this.page = { messages: [], more: false };
    this.cursor = undefined;
    this.live.approvals = [];
  }
}

// =============================================================================
// Metadata-only inventory; no provider is launched or native conversation imported
// =============================================================================

export class T3 {
  private runtime?: Owner;
  private credential?: Credential;
  private authorizing?: Promise<Credential>;
  private authAbort?: AbortController;
  private generation = 0;
  private readonly conversations = new Map<string, Conversation>();
  private stopped = false;
  private refreshing?: Promise<LiveSession[]>;

  constructor(private readonly changed: () => void) {}

  private auth(): Promise<Credential> {
    if (this.stopped || !this.runtime)
      return Promise.reject(new Error('T3 Code environment is no longer available'));
    if (this.credential && this.credential.expiresAt > Date.now() + 30_000)
      return Promise.resolve(this.credential);
    if (this.authorizing) return this.authorizing;
    const generation = this.generation;
    const controller = new AbortController();
    this.authAbort = controller;
    const pending = authorize(this.runtime!, controller.signal)
      .then((value) => {
        if (this.stopped || generation !== this.generation)
          throw new Error('T3 Code environment changed during authentication');
        return (this.credential = value);
      })
      .finally(() => {
        if (this.authorizing === pending) this.authorizing = undefined;
        if (this.authAbort === controller) this.authAbort = undefined;
      });
    this.authorizing = pending;
    return pending;
  }

  refresh(): Promise<LiveSession[]> {
    if (this.stopped) return Promise.resolve([]);
    if (this.refreshing) return this.refreshing;
    const pending = this.discover();
    this.refreshing = pending;
    void pending
      .finally(() => {
        if (this.refreshing === pending) this.refreshing = undefined;
      })
      .catch(() => {});
    return pending;
  }

  private async discover(): Promise<LiveSession[]> {
    if (this.stopped) return [];
    const native = await owner().catch(() => undefined);
    if (this.stopped) return [];
    if (!native) {
      this.clear();
      return [];
    }
    if (
      this.runtime?.origin !== native.origin ||
      this.runtime.pid !== native.pid ||
      this.runtime.startedAt !== native.startedAt
    )
      this.clear();
    this.runtime = native;
    try {
      const inventory = await read(
        native,
        await this.auth(),
        '/api/orchestration/shell?omitIdleSubagents=1&omitOlderSettled=1',
      );
      if (this.stopped) return [];
      if (!Array.isArray(inventory.projects) || !Array.isArray(inventory.threads))
        throw new Error('Invalid T3 Code inventory');
      const projects = new Map<string, string>(
        inventory.projects.slice(0, MAX_SESSIONS).map((row: Data) => [row.id, row.workspaceRoot]),
      );
      const found = new Set<string>();
      for (const row of inventory.threads.slice(0, MAX_SESSIONS)) {
        const cwd = row.worktreePath || projects.get(row.projectId);
        if (typeof row?.id !== 'string' || !row.id || typeof cwd !== 'string' || !isAbsolute(cwd))
          continue;
        found.add(row.id);
        let conversation = this.conversations.get(row.id);
        if (!conversation) {
          conversation = new Conversation(native, () => this.auth(), row.id, cwd, this.changed);
          this.conversations.set(row.id, conversation);
        }
        conversation.update(row);
      }
      for (const [id, conversation] of this.conversations)
        if (!found.has(id)) {
          conversation.stop();
          this.conversations.delete(id);
        }
      return [...this.conversations.values()].map((conversation) => conversation.live);
    } catch {
      this.clear();
      return [];
    }
  }

  private clear(): void {
    this.generation++;
    this.authAbort?.abort();
    this.authAbort = undefined;
    this.authorizing = undefined;
    for (const conversation of this.conversations.values()) conversation.stop();
    this.conversations.clear();
    this.runtime = undefined;
    this.credential = undefined;
  }
  stop(): void {
    this.stopped = true;
    this.clear();
  }
}
