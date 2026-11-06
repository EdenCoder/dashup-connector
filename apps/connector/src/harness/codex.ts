import WebSocket from 'ws';
import { homedir } from 'node:os';
import { connect } from 'node:net';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { join, isAbsolute } from 'node:path';
import { statSync, readFileSync } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';

import type { Message, Approval, AgentOption, ThreadSummary } from '@dashup/protocol';
import { contextUsage, type ContextUsage } from '@dashup/protocol/context';

import { version as DASHUP_VERSION } from '../../package.json';
import { nativeProcesses } from './processes';
import { EARLIER, NO_PREVIEW, MAX_PREVIEW, INPUT_IMAGE_TYPES, type Settings, type InputFile, type LiveSession } from './session';

// =============================================================================
// Existing Codex control sockets
// =============================================================================

const REQUEST_MS    = 4_000;
const MAX_BYTES     = 8 * 1024 * 1024;
const MAX_SESSIONS  = 100;
const MAX_TURNS     = 20;
const MAX_SOCKETS   = 32;
const SOCKET_PARTS  = ['app-server-control', 'app-server-control.sock'];
const DECISIONS     = [
  { id: 'accept', label: 'Allow once' },
  { id: 'decline', label: 'Reject' },
];

type Data    = Record<string, any>;
const input = (text: string, files: InputFile[] = []) => [
  { type: 'text', text, text_elements: [] },
  ...files
    .filter((file) => INPUT_IMAGE_TYPES.has(file.mime))
    .map((file) => ({ type: 'localImage', path: file.path })),
];
type Waiting = {
  resolve(value: Data): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
type NativeApproval = { requestId: string | number; threadId: string; approval: Approval };

function approval(id: string, method: string, params: Data): Approval {
  const command = method === 'item/commandExecution/requestApproval';
  let detail = [
    command && typeof params.command === 'string' ? params.command : '',
    typeof params.cwd === 'string' ? `Working directory: ${params.cwd}` : '',
    typeof params.grantRoot === 'string' ? `Write access root: ${params.grantRoot}` : '',
    typeof params.reason === 'string' ? params.reason : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const oversized = Buffer.byteLength(detail) > MAX_PREVIEW;
  // Native file-change and stdin approval requests do not include the diff or input.
  const unavailable =
    !command ||
    (params.kind !== undefined && params.kind !== 'command') ||
    typeof params.command !== 'string' ||
    !params.command.trim() ||
    oversized;
  if (oversized) detail = Buffer.from(detail).subarray(0, MAX_PREVIEW).toString('utf8');
  if (unavailable) detail = [detail, NO_PREVIEW].filter(Boolean).join('\n\n');
  return {
    id,
    title: command ? 'Allow command?' : 'Allow file changes?',
    detail,
    choices: DECISIONS.filter((choice) => !unavailable || choice.id === 'decline').map((
      choice,
    ) => ({ ...choice })),
  };
}

const codexHome = () =>
  process.env.DASHUP_CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');

// =============================================================================
// Models and switches
// =============================================================================

// A model as Codex keeps it in its own cache of the account's catalog. The `priority` service
// tier is Codex's fast mode.
type Model = {
  slug                        : string;
  visibility?                 : string;
  display_name?               : string;
  service_tiers?              : { id: string; name?: string }[];
  default_reasoning_level?    : string;
  supported_reasoning_levels? : { effort: string }[];
};

let catalog: { path: string; mtimeMs: number; models: Model[] } | undefined;

function models(): Model[] {
  const path = join(codexHome(), 'models_cache.json');
  try {
    const { mtimeMs } = statSync(path);
    if (catalog?.path !== path || catalog.mtimeMs !== mtimeMs) {
      const listed = JSON.parse(readFileSync(path, 'utf8'))?.models;
      catalog = {
        path,
        mtimeMs,
        models : (Array.isArray(listed) ? listed : []).filter(
          (model): model is Model => typeof model?.slug === 'string',
        ),
      };
    }
    return catalog.models;
  } catch {
    return [];
  }
}

// The model and reasoning effort a thread last ran with, among those Codex lists, and its fast
// mode where that model has the priority tier.
export function codexModels(): NonNullable<AgentOption['choices']> {
  return models()
    .filter((model) => model.visibility !== 'hide')
    .map((model) => ({ value: model.slug, name: model.display_name ?? model.slug }));
}

export function codexOptions(recorded: Settings): AgentOption[] {
  const listed  = models();
  const ran     = typeof recorded.model === 'string' ? recorded.model : '';
  const current = listed.find((model) => model.slug === ran);
  const choices = codexModels();
  const auto: AgentOption[] =
    typeof recorded.auto === 'boolean'
      ? [{ id: 'auto', name: 'Auto mode', value: recorded.auto }]
      : [];
  if (!ran) return auto;
  if (!choices.some((choice) => choice.value === ran))
    choices.push({ value: ran, name: current?.display_name ?? ran });
  const effort  =
    typeof recorded.effort === 'string' ? recorded.effort : current?.default_reasoning_level;
  const efforts = [...(current?.supported_reasoning_levels ?? []).map((level) => level.effort)];
  if (effort && !efforts.includes(effort)) efforts.push(effort);
  const fast    = current?.service_tiers?.find((tier) => tier.id === 'priority');
  return [
    { id: 'model', name: 'Model', value: ran, choices },
    ...(effort
      ? [
          {
            id      : 'effort',
            name    : 'Effort',
            value   : effort,
            choices : efforts.map((value) => ({ value, name: `${value} effort` })),
          },
        ]
      : []),
    ...(fast ? [{ id: 'fast', name: fast.name ?? 'Fast', value: recorded.fast === true }] : []),
    ...auto,
  ];
}

async function sockets(): Promise<string[]> {
  const explicit = process.env.DASHUP_CODEX_SOCKET;
  if (explicit !== undefined) return explicit && isAbsolute(explicit) ? [explicit] : [];
  if (process.env.DASHUP_LIVE_DISCOVERY === '0') return [];
  const homes = new Set([codexHome()]);
  if (process.platform === 'linux') {
    for (const pid of nativeProcesses('codex')) {
      if (homes.size >= MAX_SOCKETS) break;
      try {
        const directory = `/proc/${pid}`;
        const owner = await stat(directory);
        if (process.getuid && owner.uid !== process.getuid()) continue;
        const command = (await readFile(join(directory, 'cmdline'), 'utf8')).slice(0, 4096);
        if (!/(?:^|[\/\0 ])codex(?:[\0 .]|$)/.test(command)) continue;
        const environment = await readFile(join(directory, 'environ'), 'utf8');
        const home = environment
          .split('\0')
          .find((value) => value.startsWith('CODEX_HOME='))
          ?.slice('CODEX_HOME='.length);
        if (home && isAbsolute(home)) homes.add(home);
      } catch {
        // A process may exit during discovery.
      }
    }
  }
  return [...homes].map((home) => join(home, ...SOCKET_PARTS));
}

function messages(thread: Data): Message[] {
  if (!Array.isArray(thread.turns)) return [];
  return thread.turns.flatMap((turn: Data) =>
    Array.isArray(turn?.items)
      ? turn.items.flatMap((item: Data): Message[] => {
          if (typeof item?.id !== 'string') return [];
          if (item.type === 'userMessage' && Array.isArray(item.content)) {
            const text = item.content
              .filter((part: Data) => part?.type === 'text' && typeof part.text === 'string')
              .map((part: Data) => part.text)
              .join('\n');
            return text ? [{ id: item.id, role: 'user', text }] : [];
          }
          if (item.type === 'agentMessage' && typeof item.text === 'string')
            return [{ id: item.id, role: 'assistant', text: item.text }];
          if (item.type === 'commandExecution' && typeof item.command === 'string')
            return [
              {
                id: item.id,
                role: 'tool',
                text: [item.command, item.aggregatedOutput]
                  .filter((value) => typeof value === 'string')
                  .join('\n\n'),
              },
            ];
          return [];
        })
      : []);
}

function status(thread: Data): ThreadSummary['status'] {
  if (thread.status?.type === 'idle') return 'idle';
  if (thread.status?.type === 'active') {
    return thread.status.activeFlags?.some(
      (flag: unknown) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput',
    )
      ? 'attention'
      : 'working';
  }
  return 'unknown';
}

// =============================================================================
// A connection observes loaded threads; it never resumes or loads a thread
// =============================================================================

class Client {
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private stopped = false;
  private sequence = 0;
  private controls = false;
  private activeInput = false;
  private notify?: ReturnType<typeof setTimeout>;
  private readonly pending = new Map<number, Waiting>();
  private readonly approvals = new Map<string, NativeApproval>();
  private readonly requests = new Map<string, Promise<void>>();
  // The reply each thread is writing, as far as it has streamed, and the item it belongs to.
  private readonly typing = new Map<string, { item: unknown; text: string }>();
  // What the person chose for each thread, which its next turn takes and keeps.
  private readonly chosen = new Map<string, Settings>();
  private readonly contexts = new Map<string, ContextUsage | null>();

  constructor(
    readonly path: string,
    private readonly changed: () => void,
  ) {}

  private async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const file = await stat(this.path);
      if (!file.isSocket() || (process.getuid && file.uid !== process.getuid()))
        throw new Error('Codex control socket is not owned by this user');
      const socket = (this.socket = new WebSocket('ws://localhost/rpc', {
        createConnection: () => connect(this.path),
        maxPayload: MAX_BYTES,
        handshakeTimeout: REQUEST_MS,
      }));
      socket.on('error', () => {});
      socket.on('message', (bytes) => {
        let message: Data;
        try {
          message = JSON.parse(bytes.toString());
        } catch {
          return;
        }
        if (typeof message.id === 'number' && !message.method) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error)
            pending.reject(
              new Error(`Codex native request failed (${String(message.error.code ?? 'unknown')})`),
            );
          else pending.resolve(message.result ?? {});
          return;
        }
        if (typeof message.method !== 'string') return;
        const params = message.params;
        if (typeof params?.threadId === 'string') {
          if (message.method === 'thread/tokenUsage/updated') {
            const usage = contextUsage(
              params.tokenUsage?.last?.totalTokens,
              params.tokenUsage?.modelContextWindow,
            );
            this.contexts.delete(params.threadId);
            this.contexts.set(params.threadId, usage ?? null);
          } else if (
            message.method === 'thread/compacted' ||
            (message.method === 'item/started' && params.item?.type === 'contextCompaction')
          ) {
            this.contexts.delete(params.threadId);
            this.contexts.set(params.threadId, null);
          } else if (message.method === 'thread/closed') this.contexts.delete(params.threadId);
          if (this.contexts.size > MAX_SESSIONS)
            this.contexts.delete(this.contexts.keys().next().value!);
        }
        if (
          message.method === 'item/agentMessage/delta' &&
          typeof params?.threadId === 'string' &&
          typeof params.delta === 'string'
        ) {
          const known = this.typing.get(params.threadId);
          this.typing.set(params.threadId, {
            item : params.itemId,
            text : (known && known.item === params.itemId ? known.text : '') + params.delta,
          });
        }
        if (
          typeof params?.threadId === 'string' &&
          (message.method === 'turn/started' ||
            message.method === 'turn/completed' ||
            message.method === 'thread/closed' ||
            (message.method === 'thread/status/changed' && params.status?.type !== 'active') ||
            (message.method === 'item/completed' &&
              this.typing.get(params.threadId)?.item === params.item?.id))
        )
          this.typing.delete(params.threadId);
        if (message.method === 'serverRequest/resolved')
          for (const [id, pending] of this.approvals)
            if (pending.requestId === message.params?.requestId) this.approvals.delete(id);
        if (
          (message.method === 'item/commandExecution/requestApproval' ||
            message.method === 'item/fileChange/requestApproval') &&
          (typeof message.id === 'string' || typeof message.id === 'number') &&
          typeof message.params?.threadId === 'string'
        ) {
          // Request ids restart with the app server, so each ask gets its own approval id.
          const id = randomUUID();
          this.approvals.set(id, {
            requestId: message.id,
            threadId: params.threadId,
            approval: approval(id, message.method, params),
          });
        }
        if (/^(thread|turn|item|serverRequest)\//.test(message.method) && !this.notify) {
          this.notify = setTimeout(() => {
            this.notify = undefined;
            this.changed();
          }, 100);
          this.notify.unref();
        }
      });
      socket.on('close', () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.controls = false;
        this.activeInput = false;
        this.typing.clear();
        this.contexts.clear();
        this.approvals.clear();
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(new Error('Codex control socket disconnected'));
        }
        this.pending.clear();
        if (!this.stopped) this.changed();
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
        socket.once('close', () =>
          reject(new Error('Codex control socket closed before initialization')));
      });
      const initialized = await this.call('initialize', {
        clientInfo: { name: 'dashup', title: 'Dashup', version: DASHUP_VERSION },
        capabilities: { experimentalApi: false, requestAttestation: false },
      });
      socket.send(JSON.stringify({ method: 'initialized', params: {} }));
      // Turn start and interrupt are stable on installed servers; unknown runtimes stay observable.
      const version =
        typeof initialized.userAgent === 'string'
          ? /\b0\.(\d+)\.\d+\b/.exec(initialized.userAgent)
          : null;
      this.controls = !!version && Number(version[1]) >= 140;
      // Codex 0.165 accepts turn/start input while a turn is already running.
      this.activeInput = !!version && Number(version[1]) >= 165;
    })();
    try {
      await this.connecting;
    } catch (error) {
      this.socket?.terminate();
      throw error;
    } finally {
      this.connecting = undefined;
    }
  }

  private call(method: string, params: Data): Promise<Data> {
    const socket = this.socket;
    if (this.stopped || socket?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error('Codex control socket is disconnected'));
    if (this.pending.size >= 32) return Promise.reject(new Error('Codex request limit reached'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Codex native request timed out'));
      }, REQUEST_MS);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error('Codex native request could not be sent'));
        }
      });
    });
  }

  private once(id: string, action: () => Promise<void>): Promise<void> {
    const known = this.requests.get(id);
    if (known) return known;
    if (this.requests.size >= 1000)
      throw new Error('Codex command history is full; reconnect before sending');
    const result = action();
    this.requests.set(id, result);
    return result;
  }

  // Starts a thread in `cwd` with Codex's own settings, or loads a saved one, then a turn.
  async start(
    cwd: string,
    text: string,
    saved?: string,
    files?: InputFile[],
    model?: string,
  ): Promise<string> {
    await this.connect();
    if (!this.controls) throw new Error('Update Codex to start threads from Dashup');
    const id = saved
      ? (await this.call('thread/resume', { threadId: saved, excludeTurns: true })).thread?.id
      : (await this.call('thread/start', { cwd, ...(model ? { model } : {}) })).thread?.id;
    if (typeof id !== 'string') throw new Error('Codex did not open the thread');
    await this.call('turn/start', {
      threadId: id,
      input: input(text, files),
      ...(model ? { model } : {}),
    });
    this.changed();
    return id;
  }

  private acceptsInput(thread: Data): boolean {
    return (
      this.controls &&
      thread.canAcceptDirectInput !== false &&
      (thread.status?.type === 'idle' || (this.activeInput && thread.status?.type === 'active'))
    );
  }

  private async history(
    thread: Data,
    limit = MAX_TURNS,
    itemsView = 'full',
  ): Promise<{ turns: Data[]; earlier: boolean }> {
    if (thread.historyMode === 'paginated') {
      const page = await this.call('thread/turns/list', {
        threadId: thread.id,
        limit,
        itemsView,
        sortDirection: 'desc',
      });
      return {
        turns: Array.isArray(page.data) ? page.data.slice(0, limit).reverse() : [],
        earlier: typeof page.nextCursor === 'string',
      };
    }
    const read = await this.call('thread/read', { threadId: thread.id, includeTurns: true });
    return { turns: Array.isArray(read.thread?.turns) ? read.thread.turns : [], earlier: false };
  }

  async read(): Promise<LiveSession[]> {
    await this.connect();
    const loaded = await this.call('thread/loaded/list', { limit: MAX_SESSIONS });
    if (!Array.isArray(loaded.data)) return [];
    const sessions: LiveSession[] = [];
    for (const id of this.typing.keys()) if (!loaded.data.includes(id)) this.typing.delete(id);
    for (const id of this.contexts.keys()) if (!loaded.data.includes(id)) this.contexts.delete(id);
    for (const id of loaded.data.slice(0, MAX_SESSIONS)) {
      if (typeof id !== 'string') continue;
      try {
        const read = await this.call('thread/read', { threadId: id, includeTurns: false });
        const thread = read.thread;
        if (thread?.id !== id || typeof thread.cwd !== 'string' || !thread.cwd) continue;
        if (thread.status?.type !== 'active') this.typing.delete(id);
        // History hydration must not hide a loaded thread's status or controls.
        const history = await this.history(thread).catch(() => ({ turns: [], earlier: false }));
        const approvals = [...this.approvals.values()]
          .filter((value) => value.threadId === id)
          .map((value) => value.approval);
        sessions.push({
          id,
          harness: 'codex',
          cwd: thread.cwd,
          title:
            typeof thread.name === 'string' && thread.name
              ? thread.name
              : typeof thread.preview === 'string' && thread.preview
                ? thread.preview
                : 'Codex thread',
          updatedAt: new Date(Number(thread.updatedAt ?? 0) * 1000).toISOString(),
          status: approvals.length ? 'attention' : status(thread),
          messages: [...(history.earlier ? [EARLIER] : []), ...messages(history)],
          typing: this.typing.get(id)?.text,
          context: this.contexts.get(id),
          approvals,
          // An interrupt for a finished turn is never answered, so the active turn is read first.
          stop: this.controls
            ? (requestId) =>
                this.once(requestId, async () => {
                  const native = (
                    await this.call('thread/read', { threadId: id, includeTurns: false })
                  ).thread;
                  const turn =
                    native?.status?.type === 'active'
                      ? (await this.history(native, 1, 'notLoaded')).turns.at(-1)
                      : undefined;
                  if (turn?.status !== 'inProgress' || typeof turn.id !== 'string')
                    throw new Error('Nothing is running in this Codex thread');
                  await this.call('turn/interrupt', { threadId: id, turnId: turn.id });
                  this.changed();
                })
            : undefined,
          send: this.acceptsInput(thread)
            ? (requestId, text, _now, files) =>
                this.once(requestId, async () => {
                  if (!text.trim() || Buffer.byteLength(text) > MAX_BYTES / 2)
                    throw new Error('Message is empty or too large');
                  const current = await this.call('thread/loaded/list', { limit: MAX_SESSIONS });
                  if (!Array.isArray(current.data) || !current.data.includes(id))
                    throw new Error('Codex thread is no longer loaded');
                  const native = (
                    await this.call('thread/read', { threadId: id, includeTurns: false })
                  ).thread;
                  if (native?.id !== id || !this.acceptsInput(native))
                    throw new Error('Codex thread is busy or unavailable');
                  const chosen = this.chosen.get(id) ?? {};
                  await this.call('turn/start', {
                    threadId: id,
                    clientUserMessageId: requestId,
                    input: input(text, files),
                    ...('model' in chosen ? { model: chosen.model } : {}),
                    ...('effort' in chosen ? { effort: chosen.effort } : {}),
                    ...('fast' in chosen ? { serviceTier: chosen.fast ? 'priority' : null } : {}),
                    ...('auto' in chosen
                      ? {
                          approvalPolicy: 'on-request',
                          approvalsReviewer: chosen.auto ? 'auto_review' : 'user',
                        }
                      : {}),
                  });
                  this.changed();
                })
            : undefined,
          options: (recorded) => codexOptions({ ...recorded(), ...this.chosen.get(id) }),
          configure: this.controls
            ? (requestId, option, value) =>
                this.once(requestId, async () => {
                  this.chosen.set(id, { ...this.chosen.get(id), [option]: value });
                  this.changed();
                })
            : undefined,
          approve: approvals.length
            ? (requestId, approvalId, reply) =>
                this.once(requestId, async () => {
                  const approval = this.approvals.get(approvalId);
                  const choice = 'choice' in reply ? reply.choice : undefined;
                  const socket = this.socket;
                  if (
                    !approval ||
                    approval.threadId !== id ||
                    !approval.approval.choices.some((value) => value.id === choice) ||
                    socket?.readyState !== WebSocket.OPEN
                  )
                    throw new Error('Codex approval is no longer pending');
                  await new Promise<void>((resolve, reject) =>
                    socket.send(
                      JSON.stringify({ id: approval.requestId, result: { decision: choice } }),
                      (error) =>
                        error ? reject(new Error('Codex approval could not be sent')) : resolve(),
                    ));
                  this.approvals.delete(approvalId);
                  this.changed();
                })
            : undefined,
        });
      } catch {
        // One unavailable thread must not hide other loaded native sessions.
      }
    }
    return sessions;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.notify);
    this.socket?.terminate();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex observation stopped'));
    }
    this.pending.clear();
    this.typing.clear();
    this.approvals.clear();
  }
}

export class Codex {
  private readonly clients = new Map<string, Client>();
  // Control sockets of daemons this connector started, which discovery may not look for.
  private readonly started = new Set<string>();
  constructor(private readonly changed: () => void) {}

  // Codex's own daemon runs the threads Dashup starts or resumes, so they outlive this connector.
  async start(
    cwd: string,
    text: string,
    saved?: string,
    files?: InputFile[],
    model?: string,
  ): Promise<string> {
    const path = process.env.DASHUP_CODEX_SOCKET || join(codexHome(), ...SOCKET_PARTS);
    await promisify(execFile)('codex', ['app-server', 'daemon', 'start'], {
      timeout: 60_000,
      shell: process.platform === 'win32',
    });
    this.started.add(path);
    let client = this.clients.get(path);
    if (!client) {
      client = new Client(path, this.changed);
      this.clients.set(path, client);
    }
    return client.start(cwd, text, saved, files, model);
  }

  async resume(id: string, cwd: string, text: string, files?: InputFile[]): Promise<void> {
    await this.start(cwd, text, id, files);
  }

  async refresh(): Promise<LiveSession[]> {
    const paths = new Set([...(await sockets()), ...this.started]);
    for (const [path, client] of this.clients)
      if (!paths.has(path)) {
        client.stop();
        this.clients.delete(path);
      }
    const results = await Promise.allSettled(
      [...paths].map(async (path) => {
        let client = this.clients.get(path);
        if (!client) {
          client = new Client(path, this.changed);
          this.clients.set(path, client);
        }
        return client.read();
      }),
    );
    return results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  }

  stop(): void {
    for (const client of this.clients.values()) client.stop();
    this.clients.clear();
  }
}
