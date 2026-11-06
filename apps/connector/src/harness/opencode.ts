import { join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { stat, readlink, readdir, readFile } from 'node:fs/promises';

import type { Approval, AgentOption } from '@dashup/protocol';

import { nativeProcesses } from './processes';

import { NO_PREVIEW, MAX_PREVIEW, questionApproval, type Settings, type LiveSession } from './session';

// =============================================================================
// Existing local OpenCode servers
// =============================================================================

const run                = promisify(execFile);
const REQUEST_MS         = 4_000;
const MAX_BYTES          = 8 * 1024 * 1024;
const MAX_SESSIONS       = 100;
const MAX_ENDPOINTS      = 32;
const EVENT_DELAY_MS     = 100;
const RECONNECT_MS       = 2_000;
const PERMISSION_CHOICES = [
  { id: 'once', label: 'Allow once' },
  { id: 'always', label: 'Always allow' },
  { id: 'reject', label: 'Reject' },
];

type Data     = Record<string, any>;
type Endpoint = { url: string; authorization?: string };

export function localEndpoint(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('OpenCode endpoint must be an uncredentialed loopback HTTP origin');
  // A numeric loopback address prevents hostname resolution from leaving this computer.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.origin;
}

function authorization(environment: Record<string, string | undefined>): string | undefined {
  const password = environment.OPENCODE_SERVER_PASSWORD;
  return password
    ? `Basic ${Buffer.from(`${environment.OPENCODE_SERVER_USERNAME || 'opencode'}:${password}`).toString('base64')}`
    : undefined;
}

async function linuxEndpoints(): Promise<Endpoint[]> {
  const result: Endpoint[] = [];
  // Packaged OpenCode runs directly; source installs can run through Node or Bun.
  const processes = nativeProcesses('opencode', 'node', 'bun', 'MainThread');
  const listeners = new Map<string, string>();
  for (const name of ['tcp', 'tcp6']) {
    const table = await readFile(`/proc/net/${name}`, 'utf8').catch(() => '');
    for (const line of table.split('\n').slice(1)) {
      const columns = line.trim().split(/\s+/);
      if (columns[3] !== '0A') continue;
      const [address, port] = (columns[1] ?? '').split(':');
      const host =
        address === '0100007F' || address === '00000000'
          ? '127.0.0.1'
          : address === '00000000000000000000000001000000' ||
              address === '00000000000000000000000000000000'
            ? '[::1]'
            : '';
      if (host && port && columns[9])
        listeners.set(columns[9], `http://${host}:${parseInt(port, 16)}`);
    }
  }
  for (const pid of processes) {
    if (result.length >= MAX_ENDPOINTS) break;
    try {
      const directory = `/proc/${pid}`;
      const owner = await stat(directory);
      if (process.getuid && owner.uid !== process.getuid()) continue;
      const command = (await readFile(join(directory, 'cmdline'), 'utf8')).slice(0, 4096);
      if (!/(?:^|[\/\0 ])opencode(?:[\0 .]|$)/.test(command)) continue;
      const environment = Object.fromEntries(
        (await readFile(join(directory, 'environ'), 'utf8')).split('\0').map((entry) => {
          const split = entry.indexOf('=');
          return [entry.slice(0, split), entry.slice(split + 1)];
        }),
      );
      for (const fd of (await readdir(join(directory, 'fd'))).slice(0, 1024)) {
        const target = await readlink(join(directory, 'fd', fd)).catch(() => '');
        const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
        const url = inode ? listeners.get(inode) : undefined;
        if (url) result.push({ url, authorization: authorization(environment) });
      }
    } catch {
      // Processes can exit while their sockets are being inspected.
    }
  }
  return result;
}

async function endpoints(): Promise<Endpoint[]> {
  const configured = process.env.DASHUP_OPENCODE_ENDPOINTS ?? process.env.DASHUP_OPENCODE_ENDPOINT;
  if (configured !== undefined) {
    const values: unknown = configured.startsWith('[')
      ? JSON.parse(configured)
      : configured.split(',').filter(Boolean);
    if (!Array.isArray(values) || values.length > MAX_ENDPOINTS) return [];
    return values
      .filter((value): value is string => typeof value === 'string')
      .flatMap((value) => {
        try {
          return [{ url: localEndpoint(value), authorization: authorization(process.env) }];
        } catch {
          return [];
        }
      });
  }
  if (process.env.DASHUP_LIVE_DISCOVERY === '0') return [];
  if (process.platform === 'linux') return linuxEndpoints();
  if (process.platform === 'darwin') {
    const { stdout } = await run(
      'lsof',
      ['-nP', '-a', '-c', 'opencode', '-iTCP', '-sTCP:LISTEN', '-Fn'],
      { timeout: REQUEST_MS, maxBuffer: MAX_BYTES },
    );
    return stdout
      .split('\n')
      .flatMap((line) => {
        const port = /^n(?:127\.0\.0\.1|\[::1\]|\*):(\d+)$/.exec(line)?.[1];
        return port
          ? [
              {
                url: localEndpoint(`http://127.0.0.1:${port}`),
                authorization: authorization(process.env),
              },
            ]
          : [];
      })
      .slice(0, MAX_ENDPOINTS);
  }
  if (process.platform === 'win32') {
    const script =
      '$ids = @(Get-Process opencode -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id); Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess } | Select-Object -ExpandProperty LocalPort';
    const { stdout } = await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: REQUEST_MS, maxBuffer: MAX_BYTES },
    );
    return stdout
      .split(/\r?\n/)
      .filter((port) => /^\d+$/.test(port))
      .slice(0, MAX_ENDPOINTS)
      .map((port) => ({
        url: localEndpoint(`http://127.0.0.1:${port}`),
        authorization: authorization(process.env),
      }));
  }
  return [];
}

async function body(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const value = await reader.read();
      if (value.done) break;
      size += value.value.byteLength;
      if (size > MAX_BYTES) throw new Error('OpenCode response exceeds the local content limit');
      chunks.push(value.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function permissionApproval(permission: Data, history: unknown, cwd: string): Approval {
  const entry =
    Array.isArray(history) &&
    typeof permission.tool?.messageID === 'string' &&
    typeof permission.tool.callID === 'string'
      ? history.find((item: Data) => item?.info?.id === permission.tool?.messageID)
      : undefined;
  const part = Array.isArray(entry?.parts)
    ? entry.parts.find(
        (item: Data) => item?.type === 'tool' && item.callID === permission.tool?.callID,
      )
    : undefined;
  const input =
    part?.state?.status === 'running' || part?.state?.status === 'pending'
      ? part.state.input
      : undefined;
  const hasInput =
    input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length;
  const metadata = permission.metadata;
  const command = typeof input?.command === 'string' ? input.command : metadata?.command;
  const path = typeof metadata?.filepath === 'string' ? metadata.filepath : input?.filePath;
  const diff = typeof metadata?.diff === 'string' ? metadata.diff : '';
  const change =
    typeof path === 'string' && path.trim() && diff.trim() ? { path, diff } : undefined;
  const patterns = Array.isArray(permission.patterns)
    ? permission.patterns.filter((value: unknown) => typeof value === 'string')
    : [];
  const always = Array.isArray(permission.always)
    ? permission.always.filter((value: unknown) => typeof value === 'string')
    : [];
  let detail = [
    typeof command === 'string' && command.trim() ? `Command:\n${command}` : '',
    hasInput ? `Tool input:\n${JSON.stringify(input, null, 2)}` : '',
    diff && !change ? `Proposed diff:\n${diff}` : '',
    `Working directory: ${cwd}`,
    patterns.length ? `Permission scope:\n${patterns.join('\n')}` : '',
    always.length ? `Always allow scope:\n${always.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const oversized =
    Buffer.byteLength(detail) > MAX_PREVIEW || Buffer.byteLength(diff) > MAX_PREVIEW;
  const unavailable =
    !(hasInput || change || (typeof command === 'string' && command.trim())) || oversized;
  if (oversized) {
    detail = Buffer.from(detail).subarray(0, MAX_PREVIEW).toString('utf8');
    if (change) change.diff = Buffer.from(diff).subarray(0, MAX_PREVIEW).toString('utf8');
  }
  if (unavailable) detail += `\n\n${NO_PREVIEW}`;
  return {
    id: permission.id,
    title: `Allow ${String(permission.permission ?? 'tool')}?`,
    detail,
    choices: PERMISSION_CHOICES.filter((choice) => !unavailable || choice.id === 'reject').map((
      choice,
    ) => ({ ...choice })),
    ...(change ? { change } : {}),
  };
}

// A message goes in the agent and model the session runs with, else in those of its last message.
function promptContext(history: unknown, session?: Data): Data {
  const current = session?.model;
  if (
    typeof session?.agent === 'string' &&
    typeof current?.providerID === 'string' &&
    typeof current.id === 'string'
  )
    return {
      agent : session.agent,
      model : { providerID: current.providerID, modelID: current.id },
      ...(typeof current.variant === 'string' ? { variant: current.variant } : {}),
    };
  if (!Array.isArray(history)) throw new Error('OpenCode session context is unavailable');
  const user = [...history].reverse().find((entry: Data) => entry?.info?.role === 'user')?.info;
  if (!user) return {};
  const model = user.model;
  const variant = user.variant ?? model?.variant;
  if (
    typeof user.agent !== 'string' ||
    !user.agent.trim() ||
    typeof model?.providerID !== 'string' ||
    !model.providerID.trim() ||
    typeof model.modelID !== 'string' ||
    !model.modelID.trim() ||
    (variant !== undefined && typeof variant !== 'string')
  )
    throw new Error('OpenCode current agent or model is unavailable. Use the native interface.');
  return {
    agent: user.agent,
    model: { providerID: model.providerID, modelID: model.modelID },
    ...(variant === undefined ? {} : { variant }),
  };
}

// =============================================================================
// Models and agents
// =============================================================================

// OpenCode's state folder, where its TUI keeps the models a person picks.
export const openCodeState = (): string =>
  join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'opencode');

// The models a person picks from in OpenCode, favourites then recent picks as its TUI keeps them,
// named as OpenCode's catalog names them; with none kept, the catalog.
function picks(models: unknown): { value: string; name: string }[] {
  const names = new Map(
    (Array.isArray(models) ? models : [])
      .filter(
        (model: Data) => typeof model?.providerID === 'string' && typeof model.id === 'string',
      )
      .map((model: Data) => [`${model.providerID}/${model.id}`, String(model.name ?? model.id)]),
  );
  let kept: Data = {};
  try {
    kept = JSON.parse(readFileSync(join(openCodeState(), 'model.json'), 'utf8'));
  } catch {
    // OpenCode writes it once the person picks a model.
  }
  const chosen = [kept.favorite, kept.recent]
    .flatMap((entries) => (Array.isArray(entries) ? entries : []))
    .filter(
      (entry: Data) => typeof entry?.providerID === 'string' && typeof entry.modelID === 'string',
    )
    .map((entry: Data) => `${entry.providerID}/${entry.modelID}`);
  return [...new Set(chosen.length ? chosen : names.keys())].map((value) => ({
    value,
    name : names.get(value) ?? value.slice(value.indexOf('/') + 1),
  }));
}

// The model and agent a session runs with, as OpenCode keeps them on the session, among the models
// a person picks and the primary agents OpenCode lists for the folder. A session that has not run
// yet has neither.
export function sessionOptions(models: unknown, agents: unknown, session?: Data): AgentOption[] {
  const current = session?.model;
  if (typeof current?.providerID !== 'string' || typeof current.id !== 'string') return [];
  const value   = `${current.providerID}/${current.id}`;
  const agent   = typeof session?.agent === 'string' ? session.agent : undefined;
  const listed  = picks(models);
  const primary = (Array.isArray(agents) ? agents : [])
    .filter(
      (item: Data) => typeof item?.id === 'string' && item.mode !== 'subagent' && !item.hidden,
    )
    .map((item: Data) => ({ value: String(item.id), name: String(item.name ?? item.id) }));
  if (!listed.some((choice) => choice.value === value)) listed.push({ value, name: current.id });
  if (agent && !primary.some((choice) => choice.value === agent))
    primary.push({ value: agent, name: agent });
  return [
    { id: 'model', name: 'Model', value, choices: listed },
    ...(agent ? [{ id: 'agent', name: 'Agent', value: agent, choices: primary }] : []),
  ];
}

// What a saved session last ran with: its model as `provider/model`, and its agent.
export function openCodeOptions(recorded: Settings): AgentOption[] {
  const model = typeof recorded.model === 'string' ? recorded.model : '';
  const split = model.indexOf('/');
  if (split < 0) return [];
  return sessionOptions([], [], {
    model : { providerID: model.slice(0, split), id: model.slice(split + 1) },
    agent : recorded.agent,
  });
}

// =============================================================================
// One existing server and its native event stream
// =============================================================================

class Server {
  private stream?: AbortController;
  private retry?: ReturnType<typeof setTimeout>;
  private notify?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly requests = new Map<string, Promise<void>>();
  // The models and agents OpenCode lists for each folder, asked once while it answers.
  private readonly catalogs = new Map<string, Promise<[unknown, unknown]>>();

  constructor(
    readonly endpoint: Endpoint,
    private readonly changed: () => void,
  ) {}

  private headers(directory?: string): Record<string, string> {
    return {
      ...(this.endpoint.authorization ? { Authorization: this.endpoint.authorization } : {}),
      ...(directory ? { 'x-opencode-directory': directory } : {}),
    };
  }

  private async request(path: string, directory?: string, payload?: Data): Promise<any> {
    const signal = AbortSignal.timeout(REQUEST_MS);
    const response = await fetch(this.endpoint.url + path, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: {
        ...this.headers(directory),
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`OpenCode native request failed (${response.status})`);
    }
    const text = await body(response);
    return text ? JSON.parse(text) : undefined;
  }

  private once(id: string, action: () => Promise<void>): Promise<void> {
    const known = this.requests.get(id);
    if (known) return known;
    if (this.requests.size >= 1000)
      throw new Error('OpenCode command history is full; reconnect before sending');
    const pending = action();
    this.requests.set(id, pending);
    return pending;
  }

  private catalog(cwd: string): Promise<[unknown, unknown]> {
    let known = this.catalogs.get(cwd);
    if (!known) {
      known = Promise.all([
        this.request('/api/model', cwd).then((listed) => listed?.data),
        this.request('/api/agent', cwd).then((listed) => listed?.data),
      ]).catch(() => {
        this.catalogs.delete(cwd);
        return [[], []] as [unknown, unknown];
      });
      this.catalogs.set(cwd, known);
    }
    return known;
  }

  // A message to one of this folder's sessions, in the agent and model it runs with; a new
  // session takes OpenCode's defaults.
  async prompt(id: string, cwd: string, text: string): Promise<void> {
    const [existing, session] = await Promise.all([
      this.request(`/session/${encodeURIComponent(id)}/message?limit=200`, cwd),
      this.request(`/api/session/${encodeURIComponent(id)}`, cwd).catch(() => undefined),
    ]);
    await this.request(`/session/${encodeURIComponent(id)}/prompt_async`, cwd, {
      ...promptContext(existing, session?.data),
      parts: [{ type: 'text', text }],
    });
    this.changed();
  }

  async start(cwd: string, text: string): Promise<string> {
    const id = (await this.request('/session', cwd, {}))?.id;
    if (typeof id !== 'string') throw new Error('OpenCode did not start a session');
    await this.prompt(id, cwd, text);
    return id;
  }

  async read(): Promise<LiveSession[]> {
    const health = await this.request('/global/health');
    if (health?.healthy !== true || typeof health.version !== 'string') return [];
    this.listen();
    const sessions = await this.request(`/session?limit=${MAX_SESSIONS}`);
    if (!Array.isArray(sessions)) return [];
    const result: LiveSession[] = [];
    const states = new Map<string, Promise<[Data, Data[], Data[], Data[], [unknown, unknown]]>>();
    for (const session of sessions.slice(0, MAX_SESSIONS) as Data[]) {
      if (
        typeof session?.id !== 'string' ||
        typeof session.directory !== 'string' ||
        !session.directory
      )
        continue;
      try {
        const id = session.id;
        const cwd = session.directory;
        let state = states.get(cwd);
        if (!state) {
          state = Promise.all([
            this.request('/session/status', cwd),
            this.request('/permission', cwd).catch(() => []),
            this.request('/question', cwd).catch(() => []),
            this.request(`/api/session?limit=${MAX_SESSIONS}`, cwd).then(
              (listed) => (Array.isArray(listed?.data) ? listed.data : []),
              () => [],
            ),
            this.catalog(cwd),
          ]);
          states.set(cwd, state);
        }
        const [status, permissions, questions, settings, [models, agents]] = await state;
        const pending = Array.isArray(permissions)
          ? (permissions.filter(
              (permission: Data) =>
                permission?.sessionID === id && typeof permission.id === 'string',
            ) as Data[])
          : [];
        const asks = Array.isArray(questions)
          ? (questions.filter(
              (question: Data) => question?.sessionID === id && typeof question.id === 'string',
            ) as Data[])
          : [];
        const current = settings.find((item: Data) => item?.id === id);
        // OpenCode's storage owns the conversation, read when the phone opens it; a session's
        // messages are fetched only to describe a permission it waits on.
        const history = pending.length
          ? await this.request(`/session/${encodeURIComponent(id)}/message?limit=200`, cwd)
          : [];
        const approvals = pending.map((permission) => permissionApproval(permission, history, cwd));
        for (const question of asks)
          approvals.push(
            questionApproval(
              `question:${question.id}`,
              Array.isArray(question.questions) ? question.questions : [],
              (item) => item.multiple === true,
            ),
          );
        result.push({
          id,
          cwd,
          harness: 'opencode',
          title: typeof session.title === 'string' ? session.title : 'OpenCode thread',
          updatedAt: new Date(Number(session.time?.updated ?? Date.now())).toISOString(),
          status: approvals.length
            ? 'attention'
            : status?.[id]?.type === 'busy' || status?.[id]?.type === 'retry'
              ? 'working'
              : status &&
                  typeof status === 'object' &&
                  !Array.isArray(status) &&
                  (!status[id] || status[id].type === 'idle')
                ? 'idle'
                : 'unknown',
          messages: [],
          approvals,
          stop: (requestId) =>
            this.once(requestId, async () => {
              if (this.stopped) throw new Error('OpenCode is disconnected');
              // Abort answers true even for an idle session, so the native status decides.
              const current = await this.request('/session/status', cwd);
              if (!['busy', 'retry'].includes(current?.[id]?.type))
                throw new Error('Nothing is running in this OpenCode session');
              await this.request(`/session/${encodeURIComponent(id)}/abort`, cwd, {});
              this.changed();
            }),
          send: (requestId, text) =>
            this.once(requestId, async () => {
              if (this.stopped) throw new Error('OpenCode is disconnected');
              if (!text.trim() || Buffer.byteLength(text) > MAX_BYTES / 2)
                throw new Error('Message is empty or too large');
              const messageID = `msg_${createHash('sha256').update(requestId).digest('hex').slice(0, 32)}`;
              const existing = await this.request(
                `/session/${encodeURIComponent(id)}/message?limit=200`,
                cwd,
              );
              if (
                Array.isArray(existing) &&
                existing.some((entry: Data) => entry?.info?.id === messageID)
              )
                return;
              await this.request(`/session/${encodeURIComponent(id)}/prompt_async`, cwd, {
                ...promptContext(existing, current),
                messageID,
                parts: [{ type: 'text', text }],
              });
              this.changed();
            }),
          options: () => sessionOptions(models, agents, current),
          // OpenCode keeps the model, as `provider/model`, and the agent on the session.
          configure: (requestId, option, value) =>
            this.once(requestId, async () => {
              if (this.stopped) throw new Error('OpenCode is disconnected');
              const chosen = String(value);
              const split  = chosen.indexOf('/');
              await this.request(
                `/api/session/${encodeURIComponent(id)}/${option}`,
                cwd,
                option === 'model'
                  ? { model: { providerID: chosen.slice(0, split), id: chosen.slice(split + 1) } }
                  : { agent: chosen },
              );
              this.changed();
            }),
          approve: approvals.some((approval) => approval.choices.length)
            ? (requestId, approvalId, reply) =>
                this.once(requestId, async () => {
                  if (this.stopped) throw new Error('OpenCode is disconnected');
                  const choice = 'choice' in reply ? reply.choice : undefined;
                  if (approvalId.startsWith('question:')) {
                    const requestID = approvalId.slice('question:'.length);
                    const current = await this.request('/question', cwd);
                    if (
                      !Array.isArray(current) ||
                      !current.some(
                        (value: Data) => value?.id === requestID && value.sessionID === id,
                      )
                    )
                      throw new Error('Question is no longer pending');
                    await this.request(
                      `/question/${encodeURIComponent(requestID)}/${'answers' in reply ? 'reply' : 'reject'}`,
                      cwd,
                      'answers' in reply ? { answers: reply.answers } : {},
                    );
                  } else {
                    const current = await this.request('/permission', cwd);
                    const permission = Array.isArray(current)
                      ? current.find(
                          (value: Data) => value?.id === approvalId && value.sessionID === id,
                        )
                      : undefined;
                    if (!PERMISSION_CHOICES.some((value) => value.id === choice) || !permission)
                      throw new Error('Permission is no longer pending or choice is unavailable');
                    if (choice !== 'reject') {
                      const history = await this.request(
                        `/session/${encodeURIComponent(id)}/message?limit=200`,
                        cwd,
                      );
                      if (
                        !permissionApproval(permission, history, cwd).choices.some(
                          (value) => value.id === choice,
                        )
                      )
                        throw new Error(NO_PREVIEW);
                    }
                    await this.request(`/permission/${encodeURIComponent(approvalId)}/reply`, cwd, {
                      reply: choice,
                    });
                  }
                  this.changed();
                })
            : undefined,
        });
      } catch {
        // A removed session must not hide other live sessions.
      }
    }
    return result;
  }

  private listen(): void {
    if (this.stream || this.retry || this.stopped) return;
    const controller = (this.stream = new AbortController());
    const connectTimer = setTimeout(() => controller.abort(), REQUEST_MS);
    connectTimer.unref();
    void (async () => {
      const response = await fetch(this.endpoint.url + '/global/event', {
        headers: this.headers(),
        redirect: 'error',
        signal: controller.signal,
      });
      clearTimeout(connectTimer);
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream'))
        throw new Error('OpenCode events unavailable');
      const reader = response.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      let pending = '';
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          pending += decoder.decode(next.value, { stream: true });
          if (Buffer.byteLength(pending) > MAX_BYTES)
            throw new Error('OpenCode event exceeds the local content limit');
          let boundary: number;
          while ((boundary = pending.search(/\r?\n\r?\n/)) >= 0) {
            const frame = pending.slice(0, boundary);
            pending = pending.slice(boundary).replace(/^\r?\n\r?\n/, '');
            const data = frame
              .split(/\r?\n/)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            if (!data) continue;
            let event: Data;
            try {
              event = JSON.parse(data);
            } catch {
              continue;
            }
            const type = event.payload?.type ?? event.type;
            if (typeof type !== 'string' || !/^(session|message|permission|question)\./.test(type))
              continue;
            if (!this.notify)
              this.notify = setTimeout(() => {
                this.notify = undefined;
                this.changed();
              }, EVENT_DELAY_MS);
          }
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    })()
      .catch(() => {})
      .finally(() => {
        clearTimeout(connectTimer);
        if (this.stream === controller) this.stream = undefined;
        if (!this.stopped) {
          this.changed();
          this.retry = setTimeout(() => {
            this.retry = undefined;
            this.listen();
          }, RECONNECT_MS);
          this.retry.unref();
        }
      });
  }

  stop(): void {
    this.stopped = true;
    this.stream?.abort();
    clearTimeout(this.retry);
    clearTimeout(this.notify);
  }
}

// Serves one folder until this connector stops; resolves once it listens.
function serve(cwd: string): { process: ChildProcess; endpoint: Promise<Endpoint> } {
  const child = spawn('opencode', ['serve', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd,
    stdio: ['ignore', 'pipe', 'ignore'],
    shell: process.platform === 'win32',
  });
  const endpoint = new Promise<Endpoint>((resolve, reject) => {
    let output = '';
    child.stdout!.on('data', (chunk) => {
      output = (output + String(chunk)).slice(-4_096);
      const port = /https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)/.exec(output)?.[1];
      if (port)
        resolve({
          url: localEndpoint(`http://127.0.0.1:${port}`),
          authorization: authorization(process.env),
        });
    });
    child.once('error', () => reject(new Error('OpenCode is not installed on this computer')));
    child.once('exit', () => reject(new Error('OpenCode stopped before it started serving')));
  });
  return { process: child, endpoint };
}

export class OpenCode {
  private readonly servers = new Map<string, Server>();
  // Servers this connector started, by folder.
  private readonly started = new Map<string, ReturnType<typeof serve>>();
  constructor(private readonly changed: () => void) {}

  // The server this connector runs for a folder, started when first needed.
  private async served(cwd: string): Promise<Server> {
    let served = this.started.get(cwd);
    if (!served) this.started.set(cwd, (served = serve(cwd)));
    const endpoint = await served.endpoint.catch((error: unknown) => {
      this.started.delete(cwd);
      throw error;
    });
    let server = this.servers.get(endpoint.url);
    if (!server) {
      server = new Server(endpoint, this.changed);
      this.servers.set(endpoint.url, server);
    }
    return server;
  }

  async start(cwd: string, text: string): Promise<string> {
    return (await this.served(cwd)).start(cwd, text);
  }

  async resume(id: string, cwd: string, text: string): Promise<void> {
    await (await this.served(cwd)).prompt(id, cwd, text);
  }

  async refresh(): Promise<LiveSession[]> {
    const discovered = await endpoints().catch(() => []);
    const current = new Map(discovered.map((endpoint) => [endpoint.url, endpoint]));
    for (const served of this.started.values()) {
      const endpoint = await served.endpoint.catch(() => undefined);
      if (endpoint) current.set(endpoint.url, endpoint);
    }
    for (const [url, server] of this.servers)
      if (!current.has(url)) {
        server.stop();
        this.servers.delete(url);
      }
    const results = await Promise.allSettled(
      [...current.values()].map(async (endpoint) => {
        let server = this.servers.get(endpoint.url);
        if (!server) {
          server = new Server(endpoint, this.changed);
          this.servers.set(endpoint.url, server);
        }
        return server.read();
      }),
    );
    return results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  }

  stop(): void {
    for (const server of this.servers.values()) server.stop();
    this.servers.clear();
    for (const served of this.started.values()) served.process.kill();
    this.started.clear();
  }
}
