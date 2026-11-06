import { homedir } from 'node:os';
import { constants } from 'node:fs';
import { createConnection } from 'node:net';
import { join, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { open, lstat, stat } from 'node:fs/promises';

import type { Message, Approval, ApprovalReply } from '@dashup/protocol';

import { privateRecord } from './local-file';
import { MAX_PREVIEW, NO_PREVIEW, type InputFile, type LiveSession } from './session';

// =============================================================================
// Existing Orca runtimes (published local CLI IPC, v1.4.244)
// =============================================================================

const REQUEST_MS   = 4_000;
const SELECTED_MS  = 350;
const MAX_RECORD   = 64 * 1024;
const MAX_BYTES    = 2 * 1024 * 1024;
const MAX_SESSIONS = 100;
const PAGE_ITEMS   = 30;
const MAX_OPERATIONS = 1_000;

type Data = Record<string, any>;
type Owner = { runtimeId: string; pid: number; endpoint: string; authToken: string | null };
type Page = { messages: Message[]; more: boolean };

function dataPath(): string {
  return (
    process.env.ORCA_USER_DATA_PATH?.trim() ||
    (process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'orca')
      : process.platform === 'win32'
        ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'orca')
        : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'orca'))
  );
}

async function owner(): Promise<Owner | undefined> {
  const explicit = process.env.DASHUP_ORCA_DISCOVERY_PATH?.trim();
  if (process.env.DASHUP_LIVE_DISCOVERY === '0' && !explicit) return;
  const path = explicit || join(dataPath(), 'orca-runtime.json');
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
      typeof value?.runtimeId !== 'string' ||
      !value.runtimeId ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      !(
        value.authToken === null ||
        (typeof value.authToken === 'string' && value.authToken.length <= 4096)
      )
    )
      return;
    process.kill(value.pid, 0);
    if (
      process.platform === 'linux' &&
      process.getuid &&
      (await stat(`/proc/${value.pid}`)).uid !== process.getuid()
    )
      return;
    const transports = Array.isArray(value.transports) ? value.transports : [value.transport];
    const transport = transports.find(
      (item: Data) => item?.kind === (process.platform === 'win32' ? 'named-pipe' : 'unix'),
    );
    if (typeof transport?.endpoint !== 'string' || transport.endpoint.length > 4096) return;
    if (process.platform === 'win32') {
      if (!transport.endpoint.startsWith('\\\\.\\pipe\\')) return;
    } else {
      if (!isAbsolute(transport.endpoint)) return;
      const socket = await lstat(transport.endpoint);
      if (
        !socket.isSocket() ||
        socket.isSymbolicLink() ||
        !process.getuid ||
        socket.uid !== process.getuid() ||
        (socket.mode & 0o077) !== 0
      )
        return;
    }
    return {
      runtimeId: value.runtimeId,
      pid: value.pid,
      endpoint: transport.endpoint,
      authToken: value.authToken,
    };
  } finally {
    await file.close();
  }
}

// IPC credentials and content never leave this computer. The runtime id fences every response.
function call(native: Owner, method: string, params: unknown): Promise<Data> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(native.endpoint);
    const id = randomUUID();
    let buffer = '';
    let done = false;
    const finish = (error?: Error, result?: Data): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(
      () => finish(new Error('Orca did not confirm the request')),
      REQUEST_MS,
    );
    timer.unref();
    socket.setNoDelay(true);
    socket.setEncoding('utf8');
    socket.once('error', () => finish(new Error('Orca is not reachable')));
    socket.once('close', () => finish(new Error('Orca closed before confirming the request')));
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_BYTES)
        return finish(new Error('Orca response exceeds the page limit'));
      let newline: number;
      while (!done && (newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try {
          const frame = JSON.parse(line);
          if (frame?._keepalive === true) continue;
          if (frame?.id !== id || frame?._meta?.runtimeId !== native.runtimeId)
            return finish(new Error('Orca runtime identity changed'));
          if (frame.ok !== true)
            return finish(
              new Error('Orca refused the request; check the session on your computer'),
            );
          finish(undefined, frame.result);
        } catch {
          finish(new Error('Orca returned an invalid response'));
        }
      }
    });
    socket.once('connect', () =>
      socket.write(`${JSON.stringify({ id, authToken: native.authToken, method, params })}\n`));
  });
}

// =============================================================================
// Native journal pages and compare-and-set requests
// =============================================================================

function canonical(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`;
}

export function orcaFingerprint(method: string, sessionId: string, fields: Data): string {
  return createHash('sha256').update(canonical({ method, sessionId, fields })).digest('hex');
}

function nativeText(body: Data): string {
  return Array.isArray(body.blocks)
    ? body.blocks
        .filter((block: Data) => typeof block?.text === 'string')
        .map((block: Data) => block.text)
        .join('\n')
    : '';
}

function identity(epoch: string, row: Data): string {
  return JSON.stringify([epoch, row.sequence, row.itemId]);
}

function messages(page: Data): Message[] {
  if (!Array.isArray(page.items) || page.items.length > 200)
    throw new Error('Orca returned an invalid journal page');
  const result: Message[] = [];
  for (const row of page.items) {
    if (typeof row?.itemId !== 'string' || !Number.isSafeInteger(row.sequence)) continue;
    const body = row.body;
    if (body?.kind === 'message' && ['user', 'assistant', 'system'].includes(body.role)) {
      result.push({
        id: identity(page.epoch, row),
        role: body.role,
        text:
          nativeText(body) +
          (row.shortened
            ? '\n[Orca shortened this item; open it on your computer for the full content.]'
            : ''),
      });
    } else if (body?.kind === 'tool-call') {
      result.push({
        id: identity(page.epoch, row),
        role: 'tool',
        text: String(body.output?.head ?? ''),
        tool: {
          name: String(body.name ?? 'Tool'),
          ...(body.state === 'running'
            ? {}
            : { status: body.state === 'failed' ? ('error' as const) : ('ok' as const) }),
        },
      });
    }
  }
  return result;
}

function approvals(page: Data): { values: Approval[]; rows: Map<string, Data> } {
  const rows = new Map<string, Data>();
  const values: Approval[] = [];
  const actionable = Array.isArray(page.actionablePromptIds)
    ? new Set(page.actionablePromptIds)
    : undefined;
  for (const row of page.items ?? []) {
    const body = row?.body;
    if (
      body?.kind !== 'approval' ||
      body.resolution?.state !== 'pending' ||
      (actionable && !actionable.has(row.itemId))
    )
      continue;
    const id = identity(page.epoch, row);
    const detail = typeof body.detail === 'string' ? body.detail : (body.description ?? '');
    const plan =
      body.subject?.kind === 'plan' && typeof body.subject.text === 'string'
        ? body.subject.text
        : undefined;
    const safe =
      !row.shortened &&
      (!body.subject || body.subject.kind === 'plan') &&
      Buffer.byteLength(detail) + Buffer.byteLength(plan ?? '') <= MAX_PREVIEW;
    rows.set(id, row);
    values.push({
      id,
      title: String(body.title || 'Orca approval'),
      detail: safe ? detail : NO_PREVIEW,
      ...(safe && plan ? { plan } : {}),
      choices:
        safe && Array.isArray(body.options)
          ? body.options
              .slice(0, 64)
              .filter(
                (option: Data) => typeof option.id === 'string' && typeof option.label === 'string',
              )
              .map((option: Data) => ({ id: option.id, label: option.label }))
          : [],
    });
  }
  return { values, rows };
}

class Conversation {
  readonly live: LiveSession;
  private fence?: number;
  private pending = new Map<string, Data>();
  private operations = new Map<string, { fingerprint: string; promise: Promise<void> }>();
  private selected?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly native: Owner,
    id: string,
    cwd: string,
    title: string,
    private readonly changed: () => void,
  ) {
    this.live = {
      id,
      cwd,
      title,
      harness: 'orca',
      updatedAt: new Date(0).toISOString(),
      status: 'idle',
      messages: [],
      approvals: [],
      readMessages: (before) => this.read(before),
      releaseMessages: () => this.release(),
      send: (requestId, text, _now, files) => this.send(requestId, text, files),
      stop: (requestId) => this.mutate(requestId, 'agentSession.cancel', {}, {}),
      approve: (requestId, id, reply) => this.approve(requestId, id, reply),
    };
  }

  update(tab: Data): void {
    const status = tab.chatStatus;
    this.live.title = tab.title || this.live.title;
    this.live.updatedAt = new Date(
      Number.isFinite(status?.updatedAt) ? status.updatedAt : 0,
    ).toISOString();
    this.live.status = ['working', 'running'].includes(status?.state)
      ? 'working'
      : ['waiting', 'attention', 'blocked', 'needs-input'].includes(status?.state)
        ? 'attention'
        : 'idle';
  }

  private async pageRead(params: Data): Promise<Data> {
    const result = await call(this.native, 'agentSession.history', {
      sessionId: this.live.id,
      limit: PAGE_ITEMS,
      ...params,
    });
    // An inclusive anchor at the live journal head is one beyond its exclusive cursor.
    // Orca returns its bounded tail with cursor_ahead; the caller still checks the anchor.
    if (
      !(
        result?.ok === true ||
        (params.direction === 'before' && result?.reset === 'cursor_ahead')
      ) ||
      result.page?.sessionId !== this.live.id ||
      typeof result.page.epoch !== 'string'
    )
      throw new Error('Orca history changed; reopen this conversation');
    if (Number.isSafeInteger(result.page.fence) && result.page.fence > 0)
      this.fence = result.page.fence;
    return result.page;
  }

  private async read(before?: string): Promise<Page> {
    if (this.disposed) throw new Error('Orca session is no longer available');
    const generation = this.generation;
    let page: Data;
    if (before) {
      let anchor: any;
      try {
        anchor = JSON.parse(before);
      } catch {
        throw new Error('Orca history cursor is invalid');
      }
      if (
        !Array.isArray(anchor) ||
        typeof anchor[0] !== 'string' ||
        !Number.isSafeInteger(anchor[1]) ||
        typeof anchor[2] !== 'string'
      )
        throw new Error('Orca history cursor is invalid');
      page = await this.pageRead({
        direction: 'before',
        cursor: { epoch: anchor[0], sequence: anchor[1] + 1 },
      });
      if (page.epoch !== anchor[0] || !page.items.some((row: Data) => row.itemId === anchor[2]))
        throw new Error('Orca history changed; reopen this conversation');
    } else {
      page = await this.pageRead({ direction: 'tail' });
      if (this.disposed || generation !== this.generation)
        throw new Error('Orca conversation is no longer selected');
      const requested = approvals(page);
      this.live.approvals = requested.values;
      this.pending = requested.rows;
      // A selected page asks for the next tick. Leaving it stops requests after this one timer.
      clearTimeout(this.selected);
      this.selected = setTimeout(() => {
        if (!this.disposed) this.changed();
      }, SELECTED_MS);
      this.selected.unref();
    }
    if (this.disposed || generation !== this.generation)
      throw new Error('Orca conversation is no longer selected');
    return { messages: messages(page), more: page.hasOlder === true };
  }

  private async mutate(
    requestId: string,
    method: string,
    fields: Data,
    params: Data,
    fingerprintMethod = method,
  ): Promise<void> {
    if (this.disposed) throw new Error('Orca session is no longer available');
    const fingerprint = orcaFingerprint(fingerprintMethod, this.live.id, fields);
    const prior = this.operations.get(requestId);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new Error('Orca request id was already used for another action');
      return prior.promise;
    }
    if (this.operations.size >= MAX_OPERATIONS)
      throw new Error('Reconnect Orca before sending more requests');
    const promise = (async () => {
      if (!this.fence) await this.read();
      if (!this.fence) throw new Error('Orca did not provide a current runtime fence');
      const result = await call(this.native, method, {
        ...params,
        envelope: {
          sessionId: this.live.id,
          clientOperationId: `${Date.now()}-${createHash('sha256').update(requestId).digest('hex').slice(0, 32)}`,
          expectedRuntimeFence: this.fence,
          payloadFingerprint: fingerprint,
        },
      });
      if (result?.ok !== true)
        throw new Error('Orca did not accept this action; check the session on your computer');
      this.changed();
    })();
    this.operations.set(requestId, { fingerprint, promise });
    return promise;
  }

  private send(requestId: string, text: string, files?: InputFile[]): Promise<void> {
    const body = {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text },
        ...(files ?? []).map((file) => ({ type: 'image-ref', path: file.path })),
      ],
    };
    return this.mutate(requestId, 'agentSession.send', { body }, { body });
  }

  private approve(requestId: string, id: string, reply: ApprovalReply): Promise<void> {
    const row = this.pending.get(id);
    const offered = this.live.approvals.find((approval) => approval.id === id);
    if (
      !row ||
      !('choice' in reply) ||
      reply.text ||
      !offered?.choices.some((choice) => choice.id === reply.choice) ||
      !row.body.options.some((option: Data) => option.id === reply.choice)
    )
      throw new Error('This Orca request must be reviewed on your computer');
    const fields = { itemId: row.itemId, expectedRevision: row.revision, optionId: reply.choice };
    return this.mutate(
      requestId,
      'agentSession.respondToApproval',
      fields,
      fields,
      'agentSession.respondTo:approval',
    );
  }

  stop(): void {
    this.disposed = true;
    this.release();
  }

  private release(): void {
    this.generation++;
    clearTimeout(this.selected);
    this.pending.clear();
    this.live.approvals = [];
  }
}

// =============================================================================
// Metadata inventory only; discovery never creates, attaches, or launches a session
// =============================================================================

export class Orca {
  private runtime?: Owner;
  private readonly conversations = new Map<string, Conversation>();
  private stopped = false;
  private refreshing?: Promise<LiveSession[]>;

  constructor(private readonly changed: () => void) {}

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
      this.runtime?.runtimeId !== native.runtimeId ||
      this.runtime.endpoint !== native.endpoint ||
      this.runtime.authToken !== native.authToken
    )
      this.clear();
    this.runtime = native;
    try {
      const [inventory, workspaces] = await Promise.all([
        call(native, 'session.tabs.listAll', null),
        call(native, 'worktree.ps', { limit: MAX_SESSIONS }),
      ]);
      if (this.stopped) return [];
      const paths = new Map<string, string>();
      for (const row of (workspaces?.worktrees ?? []).slice(0, MAX_SESSIONS))
        if (
          typeof row?.worktreeId === 'string' &&
          typeof row.path === 'string' &&
          isAbsolute(row.path) &&
          (!row.hostId || row.hostId === 'local')
        )
          paths.set(row.worktreeId, row.path);
      const found = new Set<string>();
      for (const snapshot of (inventory?.snapshots ?? []).slice(0, MAX_SESSIONS)) {
        const cwd = paths.get(snapshot.worktree);
        if (!cwd) continue;
        for (const tab of (snapshot.tabs ?? []).slice(0, MAX_SESSIONS)) {
          if (found.size >= MAX_SESSIONS) break;
          if (tab?.type !== 'agent-session' || typeof tab.sessionId !== 'string' || !tab.sessionId)
            continue;
          found.add(tab.sessionId);
          let conversation = this.conversations.get(tab.sessionId);
          if (!conversation) {
            conversation = new Conversation(
              native,
              tab.sessionId,
              cwd,
              String(tab.title ?? 'Orca'),
              this.changed,
            );
            this.conversations.set(tab.sessionId, conversation);
          }
          conversation.update(tab);
        }
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
    for (const conversation of this.conversations.values()) conversation.stop();
    this.conversations.clear();
    this.runtime = undefined;
  }
  stop(): void {
    this.stopped = true;
    this.clear();
  }
}
