import Socket from 'ws';
import { homedir } from 'node:os';
import { connect } from 'node:net';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { stat, readdir, readFile } from 'node:fs/promises';
import { join, dirname, basename, isAbsolute } from 'node:path';
import { WebSocketTransport } from '@microsoft/agent-host-protocol/ws';
import { AhpClient, type AhpTransport, type SubscriptionEvent } from '@microsoft/agent-host-protocol/client';
import { chatReducer, sessionReducer, SUPPORTED_PROTOCOL_VERSIONS, type Snapshot, type StateAction, type ChatState, type ChatAction, type SessionState, type SessionAction, type ProtocolMessage } from '@microsoft/agent-host-protocol';

import type { Message, Approval } from '@dashup/protocol';

import { NO_PREVIEW, MAX_PREVIEW, agentHarness, type LiveSession } from './session';

// =============================================================================
// Existing VS Code Agent Host endpoint registry
// =============================================================================

const REQUEST_MS   = 4_000;
const MAX_BYTES    = 8 * 1024 * 1024;
const MAX_METADATA = 64 * 1024;
const MAX_HOSTS    = 16;
const MAX_SESSIONS = 100;
const ROOT_CHANNEL = 'ahp-root://';
const run          = promisify(execFile);

type Data = Record<string, any>;
type Entry = { identity: string; path: string; token: string; root: string };
type Resource = { state: Data; sequence: number };
type Receipt = {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
type ConfirmationChoice = { id: string; label: string; kind: string; nativeId?: string };

const CONFIRMATION_CHOICES: ConfirmationChoice[] = [
  { id: 'approve', label: 'Allow once', kind: 'approve' },
  { id: 'deny', label: 'Reject', kind: 'deny' },
];

function roots(): string[] {
  const override = process.env.DASHUP_AHP_DATA ?? process.env.DASHUP_VSCODE_DATA;
  if (override !== undefined)
    return override ? [basename(override) === 'User' ? dirname(override) : override] : [];
  if (process.env.DASHUP_LIVE_DISCOVERY === '0') return [];
  const base =
    process.platform === 'darwin'
      ? join(homedir(), 'Library/Application Support')
      : process.platform === 'win32'
        ? (process.env.APPDATA ?? join(homedir(), 'AppData/Roaming'))
        : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'));
  return ['Code', 'Code - Insiders'].map((name) => join(base, name));
}

async function privateFile(path: string, limit: number): Promise<boolean> {
  const file = await stat(path).catch(() => undefined);
  if (!file || file.size > limit) return false;
  if (process.platform === 'win32') {
    const encodedPath = Buffer.from(path).toString('base64');
    const script = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $a=Get-Acl -LiteralPath $p -ErrorAction Stop; $sid=[Security.Principal.SecurityIdentifier]; $me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $ok=$a.GetOwner($sid).Value -eq $me; foreach($r in $a.Access){if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Translate($sid).Value -notin @($me,'S-1-5-18','S-1-5-32-544')){$ok=$false}}; $ok`;
    try {
      const { stdout } = await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(script, 'utf16le').toString('base64'),
        ],
        { timeout: REQUEST_MS, maxBuffer: MAX_METADATA },
      );
      return stdout.trim().toLowerCase() === 'true';
    } catch {
      return false;
    }
  }
  return !process.getuid || (file.uid === process.getuid() && (file.mode & 0o077) === 0);
}

async function entries(): Promise<Entry[]> {
  const result = new Map<string, Entry>();
  for (const root of roots()) {
    const registry = join(root, 'agent-host/local-endpoint');
    const files = (await readdir(join(registry, 'entries')).catch(() => []))
      .filter((name) => name.endsWith('.json'))
      .slice(0, MAX_HOSTS);
    const sources = [
      ...files.map((name) => join(registry, 'entries', name)),
      join(registry, 'metadata.json'),
    ];
    for (const path of sources) {
      try {
        if (!(await privateFile(path, MAX_METADATA))) continue;
        const parsed = JSON.parse(await readFile(path, 'utf8'));
        const rows =
          basename(path) === 'metadata.json' && Array.isArray(parsed) ? parsed : [parsed];
        for (const row of rows.slice(0, MAX_HOSTS) as Data[]) {
          if (
            row?.schemaVersion !== 2 ||
            !['editor', 'standalone'].includes(row.type) ||
            !Number.isSafeInteger(row.pid) ||
            row.pid <= 0 ||
            typeof row.instanceId !== 'string' ||
            !row.instanceId ||
            typeof row.connectionToken !== 'string' ||
            !row.connectionToken ||
            row.connectionToken.length > 1024 ||
            row.endpoint?.type !== 'socket' ||
            typeof row.endpoint.path !== 'string' ||
            !isAbsolute(row.endpoint.path)
          )
            continue;
          const identity = createHash('sha256')
            .update(`${row.type}\0${row.pid}\0${row.instanceId}`)
            .digest('hex');
          if (basename(path) !== 'metadata.json' && basename(path) !== `${identity}.json`) continue;
          try {
            process.kill(row.pid, 0);
          } catch {
            continue;
          }
          if (process.platform === 'win32') {
            if (!/^\\\\\.\\pipe\\vscode-agent-host-[A-Za-z0-9-]+$/i.test(row.endpoint.path))
              continue;
          } else {
            const socket = await stat(row.endpoint.path).catch(() => undefined);
            if (!socket?.isSocket() || (process.getuid && socket.uid !== process.getuid()))
              continue;
          }
          // Registry tokens remain local; only owner-readable metadata is accepted.
          if (!(await privateFile(dirname(path), MAX_BYTES))) continue;
          const key = `${root}\0${identity}`;
          if (!result.has(key))
            result.set(key, {
              root,
              identity: key,
              path: row.endpoint.path,
              token: row.connectionToken,
            });
        }
      } catch {
        // An unknown entry or an editor exiting does not hide other hosts.
      }
    }
  }
  return [...result.values()].slice(0, MAX_HOSTS);
}

function directory(state: Data): string | undefined {
  const uri = state.workingDirectories?.[0];
  if (typeof uri !== 'string' || !uri.startsWith('file:')) return;
  try {
    return fileURLToPath(uri);
  } catch {
    return;
  }
}

function text(value: unknown): string {
  return typeof value === 'string'
    ? value
    : typeof (value as Data)?.markdown === 'string'
      ? (value as Data).markdown
      : '';
}

function confirmation(toolCall: Data): { detail: string; choices: ConfirmationChoice[] } {
  const sections = [text(toolCall.invocationMessage), text(toolCall.intention)];
  const input = toolCall.toolInput;
  if (typeof input === 'string') sections.push(input);
  const edits = toolCall.edits?.items;
  if (Array.isArray(edits) && edits.length)
    sections.push(
      edits
        .map((edit: Data) => {
          const before = edit?.before?.uri;
          const after = edit?.after?.uri;
          const paths = [before, after].filter((uri): uri is string => typeof uri === 'string');
          const names = [...new Set(paths)].map((uri) => {
            try {
              return fileURLToPath(uri);
            } catch {
              return uri;
            }
          });
          const added = edit?.diff?.added;
          const removed = edit?.diff?.removed;
          const counts = [
            Number.isSafeInteger(added) && added >= 0 ? `+${added}` : '',
            Number.isSafeInteger(removed) && removed >= 0 ? `-${removed}` : '',
          ]
            .filter(Boolean)
            .join(' ');
          return [names.join(' → ') || 'File changes', counts].filter(Boolean).join(' ');
        })
        .join('\n'),
    );
  let detail = [...new Set(sections.filter(Boolean))].join('\n\n');
  const oversized = Buffer.byteLength(detail) > MAX_PREVIEW;
  // Referenced input and file contents stay in the native editor until fully previewed.
  const unavailable =
    (input !== undefined && typeof input !== 'string') ||
    (toolCall.edits !== undefined && (!Array.isArray(edits) || edits.length > 0)) ||
    oversized;
  let choices: ConfirmationChoice[] =
    toolCall.options === undefined
      ? CONFIRMATION_CHOICES
      : Array.isArray(toolCall.options)
        ? toolCall.options
            .filter(
              (option: Data) =>
                typeof option?.id === 'string' &&
                !!option.id &&
                typeof option.label === 'string' &&
                !!option.label &&
                CONFIRMATION_CHOICES.some((choice) => choice.kind === option.kind),
            )
            .map((option: Data) => ({
              id: option.id,
              label: option.label,
              kind: option.kind,
              nativeId: option.id,
            }))
        : [];
  if (unavailable) choices = choices.filter((choice) => choice.kind === 'deny');
  if (oversized) detail = Buffer.from(detail).subarray(0, MAX_PREVIEW).toString('utf8');
  if (unavailable || !choices.length) detail = [detail, NO_PREVIEW].filter(Boolean).join('\n\n');
  return { detail, choices };
}

function messages(chat: Data): Message[] {
  const turns = [
    ...(Array.isArray(chat.turns) ? chat.turns : []),
    ...(chat.activeTurn ? [chat.activeTurn] : []),
  ];
  return turns.flatMap((turn: Data) => {
    if (typeof turn?.id !== 'string') return [];
    const result: Message[] = [];
    if (typeof turn.message?.text === 'string' && turn.message.text)
      result.push({
        id: `${turn.id}:message`,
        role: turn.message.origin?.kind === 'user' ? 'user' : 'system',
        text: turn.message.text,
      });
    for (const [index, part] of (Array.isArray(turn.responseParts)
      ? turn.responseParts
      : []
    ).entries() as IterableIterator<[number, Data]>) {
      if (part?.kind === 'markdown' && typeof part.content === 'string')
        result.push({
          id: `${turn.id}:${part.id ?? index}`,
          role: 'assistant',
          text: part.content,
        });
      if (part?.kind === 'error')
        result.push({
          id: `${turn.id}:error:${index}`,
          role: 'system',
          text: text(part.error?.message) || 'The native agent reported an error.',
        });
    }
    return result;
  });
}

// =============================================================================
// Official AHP client over an already-running local socket
// =============================================================================

class Host {
  private client?: AhpClient;
  private connecting?: Promise<void>;
  private stopped = false;
  private readonly clientId = `dashup-${randomUUID()}`;
  private readonly resources = new Map<string, Resource>();
  private readonly subscriptions = new Set<string>();
  private readonly receipts = new Map<number, Receipt>();
  private readonly requests = new Map<string, Promise<void>>();
  private active = new Set<string>();
  private notify?: ReturnType<typeof setTimeout>;

  constructor(
    readonly entry: Entry,
    private readonly changed: () => void,
  ) {}

  private changedSoon(): void {
    if (!this.notify && !this.stopped)
      this.notify = setTimeout(() => {
        this.notify = undefined;
        this.changed();
      }, 100);
  }

  private snapshot(snapshot: Snapshot): void {
    if (
      !snapshot ||
      typeof snapshot.resource !== 'string' ||
      typeof snapshot.state !== 'object' ||
      !Number.isSafeInteger(snapshot.fromSeq)
    )
      throw new Error('Native AHP snapshot is invalid');
    this.resources.set(snapshot.resource, {
      state: snapshot.state as Data,
      sequence: snapshot.fromSeq,
    });
  }

  private event(uri: string, event: SubscriptionEvent): void {
    if (event.type === 'action') {
      const envelope = event.params;
      const receipt =
        envelope.origin?.clientId === this.clientId
          ? this.receipts.get(envelope.origin.clientSeq)
          : undefined;
      if (receipt) {
        this.receipts.delete(envelope.origin!.clientSeq);
        clearTimeout(receipt.timer);
        if (envelope.rejectionReason)
          receipt.reject(new Error('The native editor rejected this action'));
        else receipt.resolve();
      }
      const current = this.resources.get(uri);
      if (!envelope.rejectionReason && current && envelope.serverSeq > current.sequence) {
        const state = uri.startsWith('ahp-session:')
          ? sessionReducer(
              current.state as SessionState,
              envelope.action as SessionAction,
              () => {},
            )
          : uri.startsWith('ahp-chat:')
            ? chatReducer(current.state as ChatState, envelope.action as ChatAction, () => {})
            : current.state;
        this.resources.set(uri, { state, sequence: envelope.serverSeq });
      }
    }
    this.changedSoon();
  }

  private async connect(): Promise<void> {
    if (this.client?.connectionState.status === 'connected') return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const socket = new Socket(`ws://localhost/?tkn=${encodeURIComponent(this.entry.token)}`, {
        createConnection: () => connect(this.entry.path),
        maxPayload: MAX_BYTES,
        handshakeTimeout: REQUEST_MS,
      });
      socket.on('error', () => {});
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', () => reject(new Error('Native AHP socket unavailable')));
        socket.once('close', () => reject(new Error('Native AHP socket closed')));
      });
      if (this.stopped) {
        socket.terminate();
        throw new Error('AHP observation stopped');
      }
      const wire = WebSocketTransport.fromSocket(socket as unknown as WebSocket);
      // SDK parse diagnostics can include native content; decode without logging that content.
      const transport: AhpTransport = {
        send: (message) =>
          wire.send(typeof message === 'string' ? message : JSON.stringify(message)),
        close: () => wire.close(),
        recv: async () => {
          const frame = await wire.recv();
          if (!frame || frame.kind === 'parsed') return frame;
          try {
            const message = JSON.parse(
              frame.kind === 'text' ? frame.text : new TextDecoder().decode(frame.data),
            );
            if (!message || typeof message !== 'object' || Array.isArray(message))
              throw new Error();
            return { kind: 'parsed', message: message as ProtocolMessage };
          } catch {
            throw new Error('Native AHP frame is invalid');
          }
        },
      };
      const client = (this.client = new AhpClient(transport, {
        requestTimeoutMs: REQUEST_MS,
        subscriptionBuffer: 1024,
      }));
      this.resources.clear();
      this.subscriptions.clear();
      client.connect();
      const root = client.attachSubscription(ROOT_CHANNEL);
      const initialized = await client.initialize({
        clientId: this.clientId,
        protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
        initialSubscriptions: [ROOT_CHANNEL],
      });
      if (!SUPPORTED_PROTOCOL_VERSIONS.includes(initialized.protocolVersion))
        throw new Error('Native AHP version is unsupported');
      for (const snapshot of initialized.snapshots ?? []) this.snapshot(snapshot);
      void (async () => {
        for await (const event of root) this.event(ROOT_CHANNEL, event);
      })().catch(() => {});
      socket.once('close', () => {
        for (const receipt of this.receipts.values()) {
          clearTimeout(receipt.timer);
          receipt.reject(new Error('Native AHP host disconnected'));
        }
        this.receipts.clear();
        this.changedSoon();
      });
    })();
    try {
      await this.connecting;
    } catch (error) {
      await this.client?.shutdown();
      this.client = undefined;
      throw error;
    } finally {
      this.connecting = undefined;
    }
  }

  private async subscribe(uri: string): Promise<Data | undefined> {
    if (!uri.startsWith('ahp-session:') && !uri.startsWith('ahp-chat:')) return;
    if (!this.subscriptions.has(uri)) {
      const { result, subscription } = await this.client!.subscribe(uri, { view: { turns: 100 } });
      if (result.snapshot) this.snapshot(result.snapshot);
      this.subscriptions.add(uri);
      void (async () => {
        for await (const event of subscription) this.event(uri, event);
      })().catch(() => {});
    }
    return this.resources.get(uri)?.state;
  }

  private dispatch(requestId: string, uri: string, action: StateAction): Promise<void> {
    const prior = this.requests.get(requestId);
    if (prior) return prior;
    const client = this.client;
    if (this.stopped || client?.connectionState.status !== 'connected' || !this.active.has(uri))
      return Promise.reject(new Error('Native AHP chat is disconnected'));
    if (this.requests.size >= 1000 || this.receipts.size >= 32)
      return Promise.reject(new Error('Native AHP command limit reached'));
    const pending = new Promise<void>((resolve, reject) => {
      const handle = client.dispatch(uri, action);
      const timer = setTimeout(() => {
        this.receipts.delete(handle.clientSeq);
        reject(new Error('Native AHP action was not acknowledged; delivery is unknown'));
      }, REQUEST_MS);
      this.receipts.set(handle.clientSeq, { resolve, reject, timer });
    });
    this.requests.set(requestId, pending);
    return pending;
  }

  async read(): Promise<LiveSession[]> {
    await this.connect();
    const catalog = await this.client!.request('listSessions', {
      channel: ROOT_CHANNEL,
      limit: MAX_SESSIONS,
    });
    if (!Array.isArray(catalog.items)) return [];
    const result: LiveSession[] = [];
    const active = new Set<string>();
    for (const summary of catalog.items.slice(0, MAX_SESSIONS)) {
      try {
        const session = await this.subscribe(summary.resource);
        if (!session || session.lifecycle !== 'ready' || !Array.isArray(session.chats)) continue;
        for (const item of session.chats.slice(0, 20) as Data[]) {
          if (typeof item.resource !== 'string' || item.interactivity === 'hidden') continue;
          const chat = await this.subscribe(item.resource);
          if (!chat || chat.interactivity === 'hidden') continue;
          const cwd = directory(chat) ?? directory(session);
          if (!cwd) continue;
          active.add(item.resource);
          const approvals: Approval[] = [];
          for (const pending of (Array.isArray(session.inputNeeded)
            ? session.inputNeeded
            : []) as Data[]) {
            if (
              pending.kind !== 'toolConfirmation' ||
              pending.chat !== item.resource ||
              pending.toolCall?.status !== 'pending-confirmation'
            )
              continue;
            const preview = confirmation(pending.toolCall);
            approvals.push({
              id: pending.id,
              title:
                text(pending.toolCall.confirmationTitle) ||
                pending.toolCall.displayName ||
                'Native agent approval',
              detail: preview.detail,
              choices: preview.choices.map(({ id, label, kind }) => ({
                id,
                label,
                intent: kind === 'approve' ? ('approve' as const) : ('reject' as const),
              })),
            });
          }
          const id = `vscode-ahp:${createHash('sha256').update(this.entry.root).digest('hex').slice(0, 16)}:${item.resource}`;
          result.push({
            id,
            cwd,
            harness: agentHarness(String(session.provider)) ?? 'other',
            editor: 'vscode',
            title:
              typeof chat.title === 'string' && chat.title
                ? chat.title
                : String(session.title ?? 'VS Code thread'),
            updatedAt: typeof chat.modifiedAt === 'string' ? chat.modifiedAt : summary.modifiedAt,
            status:
              approvals.length || chat.status & 16
                ? 'attention'
                : chat.status & 8
                  ? 'working'
                  : chat.status & 1
                    ? 'idle'
                    : 'unknown',
            messages: messages(chat),
            approvals,
            // The host aborts the chat for any cancel, so only its current active turn is named.
            stop:
              chat.interactivity !== 'read-only'
                ? (requestId) => {
                    const prior = this.requests.get(requestId);
                    if (prior) return prior;
                    const turn = this.resources.get(item.resource)?.state.activeTurn;
                    if (typeof turn?.id !== 'string')
                      return Promise.reject(new Error('Nothing is running in this VS Code chat'));
                    return this.dispatch(requestId, item.resource, {
                      type: 'chat/turnCancelled',
                      turnId: turn.id,
                      duration: Math.max(0, Date.now() - Date.parse(turn.startedAt)) || 0,
                    } as StateAction);
                  }
                : undefined,
            send:
              chat.interactivity !== 'read-only' && (chat.status & 1) !== 0 && !(chat.status & 8)
                ? (requestId, value) => {
                    const prior = this.requests.get(requestId);
                    if (prior) return prior;
                    const current = this.resources.get(item.resource)?.state;
                    if (
                      !value.trim() ||
                      Buffer.byteLength(value) > MAX_BYTES / 2 ||
                      current?.interactivity === 'read-only' ||
                      !(current?.status & 1) ||
                      current?.status & 8
                    )
                      return Promise.reject(
                        new Error('Native AHP chat is unavailable for a reply'),
                      );
                    return this.dispatch(requestId, item.resource, {
                      type: 'chat/turnStarted',
                      turnId: requestId,
                      startedAt: new Date().toISOString(),
                      message: { text: value, origin: { kind: 'user' } },
                    } as StateAction);
                  }
                : undefined,
            approve: approvals.some((approval) => approval.choices.length)
              ? (requestId, approvalId, reply) => {
                  const choice = 'choice' in reply ? reply.choice : undefined;
                  const prior = this.requests.get(requestId);
                  if (prior) return prior;
                  const current = this.resources.get(summary.resource)?.state;
                  const pending = current?.inputNeeded?.find(
                    (entry: Data) =>
                      entry.id === approvalId &&
                      entry.chat === item.resource &&
                      entry.kind === 'toolConfirmation' &&
                      entry.toolCall?.status === 'pending-confirmation',
                  );
                  const option = pending
                    ? confirmation(pending.toolCall).choices.find((entry) => entry.id === choice)
                    : undefined;
                  if (!pending || !option)
                    return Promise.reject(new Error('Native approval is no longer pending'));
                  return this.dispatch(requestId, item.resource, {
                    type: 'chat/toolCallConfirmed',
                    turnId: pending.turnId,
                    toolCallId: pending.toolCall.toolCallId,
                    ...(option.nativeId ? { selectedOptionId: option.nativeId } : {}),
                    ...(option.kind === 'approve'
                      ? { approved: true, confirmed: 'user-action' }
                      : { approved: false, reason: 'denied' }),
                  } as StateAction);
                }
              : undefined,
          });
        }
      } catch {
        // Unsupported or removed sessions remain available through editor history.
      }
    }
    this.active = active;
    return result;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.notify);
    for (const receipt of this.receipts.values()) {
      clearTimeout(receipt.timer);
      receipt.reject(new Error('AHP observation stopped'));
    }
    this.receipts.clear();
    this.active.clear();
    void this.client?.shutdown();
  }
}

export class VSCode {
  private readonly hosts = new Map<string, Host>();
  constructor(private readonly changed: () => void) {}

  async refresh(): Promise<LiveSession[]> {
    const discovered = await entries();
    const current = new Set(discovered.map((entry) => entry.identity));
    for (const [key, host] of this.hosts)
      if (!current.has(key)) {
        host.stop();
        this.hosts.delete(key);
      }
    const results = await Promise.allSettled(
      discovered.map(async (entry) => {
        let host = this.hosts.get(entry.identity);
        if (!host) {
          host = new Host(entry, this.changed);
          this.hosts.set(entry.identity, host);
        }
        return host.read();
      }),
    );
    return results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  }

  stop(): void {
    for (const host of this.hosts.values()) host.stop();
    this.hosts.clear();
  }
}
