import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dirname, join, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { watch, readFileSync, type FSWatcher } from 'node:fs';
import { mkdir, readdir, readFile, readlink, rm } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse, type IncomingMessage } from 'node:http';

import type { Approval, AgentOption, ApprovalReply, ThreadSummary } from '@dashup/protocol';

import { configPath } from '../config';
import { claudeHome } from './history';
import { MAX_PREVIEW, questionApproval, type Settings, type LiveSession } from './session';

// =============================================================================
// Models and switches
// =============================================================================

// A model as Claude Code offers it to hosts: `/model` takes its `value`, and its replies record
// its `resolvedModel`.
type Model = {
  value                  : string;
  displayName            : string;
  resolvedModel?         : string;
  supportsFastMode?      : boolean;
  supportedEffortLevels? : string[];
};

const MODELS_MS = 30_000;

// What Claude Code takes to change each option, as the person would type it.
const COMMANDS: Record<string, (value: string | boolean) => string> = {
  model     : (value) => `/model ${value}`,
  fast      : (value) => `/fast ${value ? 'on' : 'off'}`,
  ultracode : (value) => `/effort ultracode ${value ? 'on' : 'off'}`,
};

// Each Claude Code offers the models it knows, so a session's come from the binary that runs it,
// by its path and version. One that has not answered yet offers none.
const offered = new Map<string, Model[]>();
const asking  = new Set<string>();

export const forgetModels = (): void => offered.clear();

export function claudeModels(changed: () => void, command = 'claude', version = ''): Model[] {
  const key = `${command}\0${version}`;
  if (!offered.has(key) && !asking.has(key)) {
    asking.add(key);
    void listModels(command).then((models) => {
      asking.delete(key);
      if (!models.length) return;
      offered.set(key, models);
      changed();
    });
  }
  return offered.get(key) ?? [];
}

// Claude Code's initialize answer lists its models and what each supports, and calls no model.
function listModels(command: string): Promise<Model[]> {
  return new Promise((resolve) => {
    const child = spawn(
      command,
      ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
      { cwd: homedir(), stdio: 'pipe', shell: process.platform === 'win32' },
    );
    const timer = setTimeout(() => child.kill(), MODELS_MS);
    child.stdin.on('error', () => {});
    child.once('error', () => resolve([]));
    child.once('exit', () => {
      clearTimeout(timer);
      resolve([]);
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      try {
        const message = JSON.parse(line);
        if (message?.type !== 'control_response' || message.response?.request_id !== 'models')
          return;
        const models = message.response.response?.models;
        resolve(
          (Array.isArray(models) ? models : []).filter(
            (model): model is Model =>
              typeof model?.value === 'string' && typeof model.displayName === 'string',
          ),
        );
        child.stdin.end();
      } catch {
        // Claude Code writes other lines as it starts.
      }
    });
    child.stdin.write(
      `${JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize' } })}\n`,
    );
  });
}

// The model a session last ran on, among those its Claude Code offers, and the switches that model
// takes. Claude Code allows ultracode on the models that take `xhigh` effort.
export function claudeOptions(models: Model[], recorded: Settings): AgentOption[] {
  const ran     = typeof recorded.model === 'string' ? recorded.model : '';
  const current =
    models.find((model) => model.value !== 'default' && model.resolvedModel === ran) ??
    models.find((model) => model.value === ran);
  const choices = models.map((model) => ({ value: model.value, name: model.displayName }));
  const auto: AgentOption[] =
    typeof recorded.auto === 'boolean'
      ? [{ id: 'auto', name: 'Auto mode', value: recorded.auto }]
      : [];
  if (!ran) return auto;
  if (!current) choices.push({ value: ran, name: ran });
  return [
    { id: 'model', name: 'Model', value: current?.value ?? ran, choices },
    ...auto,
    ...(current?.supportsFastMode
      ? [{ id: 'fast', name: 'Fast', value: recorded.fast === true }]
      : []),
    ...(current?.supportedEffortLevels?.includes('xhigh')
      ? [{ id: 'ultracode', name: 'Ultracode', value: recorded.ultracode === true }]
      : []),
  ];
}

// =============================================================================
// Permission requests
// =============================================================================

// Claude Code asks its host and a plugin alike: a tool, its input and the rules that would stop it
// asking again. A question arrives as AskUserQuestion and a plan as ExitPlanMode. Only the person
// at the computer or the host approves a plan; a plugin can only send it back.
const EDITS = new Set(['Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
const SCOPE = 32;

type Data = Record<string, any>;

export type PermissionRequest = {
  tool         : string;
  input        : Data;
  label?       : string;
  description? : string;
  suggestions? : Data[];
};

export type PermissionDecision =

    | { behavior: 'allow'; updatedInput: Data; updatedPermissions?: Data[] }
    | { behavior: 'deny'; message: string };

// Its first MAX_PREVIEW bytes.
const preview = (text: string): string =>
  Buffer.byteLength(text) > MAX_PREVIEW
    ? Buffer.from(text).subarray(0, MAX_PREVIEW).toString('utf8')
    : text;

// The lines from the first change to the last, with a little context either side; `offset` is
// the line `before` starts on in its file.
function hunk(
  before: string,
  after: string,
  offset = 0,
): { lines: string[]; added: number; deleted: number } {
  const old  = before ? before.replace(/\n$/, '').split('\n') : [];
  const next = after ? after.replace(/\n$/, '').split('\n') : [];
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) start++;
  let end = 0;
  while (
    end < old.length - start &&
    end < next.length - start &&
    old[old.length - 1 - end] === next[next.length - 1 - end]
  )
    end++;
  const removed = old.slice(start, old.length - end);
  const added   = next.slice(start, next.length - end);
  return {
    lines: [
      `@@ -${offset + start + 1},${removed.length} +${offset + start + 1},${added.length} @@`,
      ...old.slice(Math.max(0, start - 3), start).map((line) => ` ${line}`),
      ...removed.map((line) => `-${line}`),
      ...added.map((line) => `+${line}`),
      ...old.slice(old.length - end, old.length - end + 3).map((line) => ` ${line}`),
    ],
    added   : added.length,
    deleted : removed.length,
  };
}

// The file change an edit or write asks for, as the diff the phone reviews.
export function change(tool: string, input: Data): Approval['change'] {
  const path = input.file_path;
  if (typeof path !== 'string') return undefined;
  let current = '';
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    // A new file has no current content.
  }
  const edit = (value: Data) => {
    const before = String(value?.old_string ?? '');
    const at = before ? current.indexOf(before) : -1;
    return hunk(
      before,
      String(value?.new_string ?? ''),
      at < 0 ? 0 : current.slice(0, at).split('\n').length - 1,
    );
  };
  const hunks =
    tool === 'Write' && typeof input.content === 'string'
      ? [hunk(current, input.content)]
      : tool === 'Edit'
        ? [edit(input)]
        : tool === 'MultiEdit' && Array.isArray(input.edits)
          ? input.edits.map(edit)
          : [];
  if (!hunks.length) return undefined;
  const diff = [`--- ${path}`, `+++ ${path}`, ...hunks.flatMap((item) => item.lines)].join('\n');
  if (Buffer.byteLength(diff) > MAX_PREVIEW) return undefined;
  return {
    path,
    diff,
    added   : hunks.reduce((sum, item) => sum + item.added, 0),
    deleted : hunks.reduce((sum, item) => sum + item.deleted, 0),
  };
}

// What Claude Code suggests so it stops asking, named for the phone. A rule or a folder says what
// it covers; a mode covers the whole session, so it is offered only alone.
function remember(suggestions: Data[] = []): { label: string; updates: Data[] } | undefined {
  const updates = suggestions.filter(
    (update) =>
      (update?.type === 'addRules' && update.behavior === 'allow') ||
      update?.type === 'addDirectories',
  );
  const rule   = updates.flatMap((update) => update.rules ?? [])[0];
  const folder = updates.flatMap((update) => update.directories ?? [])[0];
  const scope  = rule
    ? String(rule.ruleContent ?? rule.toolName)
    : folder
      ? `access to ${basename(String(folder))}`
      : '';
  if (scope)
    return {
      label: `Always allow ${scope.length > SCOPE ? `${scope.slice(0, SCOPE - 1)}…` : scope}`,
      updates,
    };
  const edits = suggestions.find(
    (update) => update?.type === 'setMode' && update.mode === 'acceptEdits',
  );
  return edits ? { label: 'Allow all edits', updates: [edits] } : undefined;
}

// The approval the phone shows for a request. As Claude Code's host, the phone can approve a plan.
export function ask(id: string, request: PermissionRequest, host: boolean): Approval {
  const { tool, input } = request;
  if (tool === 'AskUserQuestion' && Array.isArray(input.questions))
    return questionApproval(id, input.questions, (item) => item.multiSelect === true);
  if (tool === 'ExitPlanMode')
    return {
      id,
      title   : 'Approve this plan?',
      detail  : host ? '' : 'Approve it on your computer, or tell Claude what to change.',
      choices : [
        ...(host ? [{ id: 'accept', label: 'Approve' }] : []),
        { id: 'revise', label: 'Keep planning', text: true as const },
      ],
      plan    : preview(String(input.plan ?? '')),
    };
  const diff   = change(tool, input);
  const always = remember(request.suggestions);
  return {
    id,
    title:
      tool === 'Bash'
        ? 'Allow command?'
        : EDITS.has(tool)
          ? 'Allow file changes?'
          : `Allow ${request.label ?? tool}?`,
    detail: preview(
      [
        request.description ?? (typeof input.description === 'string' ? input.description : ''),
        typeof input.command === 'string'
          ? input.command
          : diff
            ? ''
            : JSON.stringify(input, null, 2),
      ]
        .filter(Boolean)
        .join('\n\n'),
    ),
    ...(diff ? { change: diff } : {}),
    choices: [
      { id: 'accept', label: 'Allow once' },
      ...(always ? [{ id: 'always', label: always.label }] : []),
      { id: 'decline', label: 'Reject' },
    ],
  };
}

// What Claude Code takes for the person's reply to the approval `ask` made of the request. A
// multiple choice answer joins its labels.
export function decide(
  request: PermissionRequest,
  approval: Approval,
  reply: ApprovalReply,
): PermissionDecision {
  const input = request.input;
  if ('answers' in reply)
    return {
      behavior     : 'allow',
      updatedInput : {
        ...input,
        answers: Object.fromEntries(
          (approval.questions ?? []).map((item, index) => [
            item.question,
            reply.answers[index]!.join(', '),
          ]),
        ),
      },
    };
  if (reply.choice === 'accept')
    return {
      behavior     : 'allow',
      updatedInput : input,
      ...(approval.plan === undefined
        ? {}
        : { updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }] }),
    };
  if (reply.choice === 'always')
    return {
      behavior           : 'allow',
      updatedInput       : input,
      updatedPermissions : remember(request.suggestions)?.updates ?? [],
    };
  if (reply.choice === 'revise')
    return { behavior: 'deny', message: reply.text?.trim() || 'Keep planning.' };
  return {
    behavior : 'deny',
    message  :
      reply.choice === 'skip'
        ? 'The person skipped these questions.'
        : 'The person rejected this from their phone.',
  };
}

// =============================================================================
// Running Claude Code sessions
// =============================================================================

// Claude Code records each running session in `sessions/<pid>.json`. Its inbox socket frames what
// other processes post as another session's request, never the person's, so Dashup's plugin for
// Claude Code (`claude/` in this package) holds a stream open here for its session, and submits
// each delivery as the person's own. It also holds a request open for each permission request its
// session waits on, which the phone's answer ends. The plugin connects to the default state
// directory's socket.
const MAX_SESSIONS = 100;
const MAX_REQUESTS = 1_000;
const MAX_PROMPT   = 4 * 1024 * 1024;
const SESSION      = /^\/sessions\/([\w-]{1,100})(\/prompts)?$/;

const STATUS: Record<string, ThreadSummary['status']> = {
  busy    : 'working',
  idle    : 'idle',
  shell   : 'idle',
  waiting : 'attention',
};

// `now` first ends the running turn, so a delivery without text only stops it.
type Delivery = { text: string; now?: true } | { now: true };

// A permission request the plugin holds open until the phone answers it, or until it closes the
// request because the person answered at the computer or the session ended.
type Prompt = {
  session  : string;
  request  : PermissionRequest;
  approval : Approval;
  answer   : (decision: PermissionDecision) => void;
};

// `command` is the binary the session runs, where Linux names it.
type Registration = {
  pid        : number;
  cwd        : string;
  status?    : string;
  version?   : string;
  command    : string;
  sessionId  : string;
  updatedAt? : number;
};

async function registrations(): Promise<Registration[]> {
  if (process.env.DASHUP_LIVE_DISCOVERY === '0') return [];
  const directory = join(claudeHome(), 'sessions');
  const names = await readdir(directory).catch(() => []);
  const found = await Promise.all(
    names
      .filter((name) => /^\d+\.json$/.test(name))
      .slice(0, MAX_SESSIONS)
      .map(async (name): Promise<Registration[]> => {
        try {
          const value = JSON.parse(await readFile(join(directory, name), 'utf8')) as Registration;
          if (typeof value.sessionId !== 'string' || typeof value.cwd !== 'string') return [];
          // A crashed process leaves its record behind.
          process.kill(value.pid, 0);
          const binary = await readlink(`/proc/${value.pid}/exe`).catch(() => '');
          return [{ ...value, command: /[\\/]claude(?:\.exe)?$/.test(binary) ? binary : 'claude' }];
        } catch {
          return [];
        }
      }),
  );
  return found.flat();
}

// =============================================================================
// The registry is watched; each session's plugin holds one stream
// =============================================================================

export class Claude {
  private watcher?: FSWatcher;
  private notify?: ReturnType<typeof setTimeout>;
  private server?: Server;
  private readonly streams = new Map<string, ServerResponse>();
  private readonly prompts = new Map<string, Prompt>();
  private readonly requests = new Map<string, Promise<void>>();

  constructor(
    private readonly changed: () => void,
    private readonly socket = join(dirname(configPath()), 'claude.sock'),
  ) {}

  async refresh(): Promise<LiveSession[]> {
    this.watch();
    return (await registrations()).map((session) => {
      const plugin    = this.streams.has(session.sessionId);
      const models    = claudeModels(this.changed, session.command, session.version);
      const approvals = [...this.prompts.values()]
        .filter((prompt) => prompt.session === session.sessionId)
        .map((prompt) => prompt.approval);
      return {
        id        : session.sessionId,
        harness   : 'claude',
        cwd       : session.cwd,
        updatedAt : new Date(session.updatedAt ?? 0).toISOString(),
        status    : approvals.length ? 'attention' : (STATUS[session.status ?? ''] ?? 'unknown'),
        messages  : [],
        approvals,
        approve   : approvals.length
          ? (requestId, approvalId, reply) =>
              this.once(requestId, async () => {
                const prompt = this.prompts.get(approvalId);
                if (prompt?.session !== session.sessionId)
                  throw new Error('Claude Code approval is no longer pending');
                prompt.answer(decide(prompt.request, prompt.approval, reply));
              })
          : undefined,
        send      : plugin
          ? (requestId, text, now) =>
              this.once(requestId, () =>
                this.deliver(session.sessionId, now ? { text, now } : { text }))
          : undefined,
        stop      : plugin
          ? (requestId) =>
              this.once(requestId, () => this.deliver(session.sessionId, { now: true }))
          : undefined,
        now       : plugin,
        options   : (recorded) =>
          claudeOptions(models, recorded()).map((option) =>
            option.id === 'auto' ? { ...option, readOnly: true } : option),
        configure : plugin
          ? (requestId, option, value) =>
              this.once(requestId, () =>
                this.deliver(session.sessionId, { text: COMMANDS[option]!(value) }))
          : undefined,
      };
    });
  }

  // Only the connector serves the plugin; one-off commands such as `dashup doctor` read alone.
  async listen(): Promise<void> {
    if (this.server || process.env.DASHUP_LIVE_DISCOVERY === '0') return;
    const server = (this.server = createServer((request, response) => {
      const [, id, prompt] = SESSION.exec(request.url ?? '') ?? [];
      if (id && prompt && request.method === 'POST') return this.prompt(id, request, response);
      if (!id || prompt || request.method !== 'GET') return void response.writeHead(404).end();
      // A newer stream for the session, as after the plugin reloads, takes over.
      this.streams.get(id)?.end();
      this.streams.set(id, response);
      response.once('close', () => {
        if (this.streams.get(id) === response) this.streams.delete(id);
        this.changed();
      });
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson' }).flushHeaders();
      this.changed();
    }));
    // One connector runs for a state directory, so a socket already here is a stopped one's.
    await mkdir(dirname(this.socket), { recursive: true, mode: 0o700 });
    await rm(this.socket, { force: true });
    if (this.server !== server) return;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socket, resolve);
    });
  }

  // Asks the phone what the session's permission request asks the person.
  private prompt(session: string, request: IncomingMessage, response: ServerResponse): void {
    const chunks: Buffer[] = [];
    let bytes = 0;
    request.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_PROMPT) request.destroy();
      else chunks.push(chunk);
    });
    request.once('end', () => {
      let asked: Data | undefined;
      try {
        asked = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        // Answered below.
      }
      if (typeof asked?.tool !== 'string' || !asked.input || typeof asked.input !== 'object')
        return void response.writeHead(400).end();
      const id = randomUUID();
      const prompted: PermissionRequest = {
        tool  : asked.tool,
        input : asked.input,
        ...(Array.isArray(asked.suggestions) ? { suggestions: asked.suggestions } : {}),
      };
      this.prompts.set(id, {
        session,
        request  : prompted,
        approval : ask(id, prompted, false),
        answer   : (decision) => {
          this.prompts.delete(id);
          response.end(JSON.stringify(decision));
          this.changed();
        },
      });
      response.once('close', () => {
        if (this.prompts.delete(id)) this.changed();
      });
      response.writeHead(200, { 'Content-Type': 'application/json' }).flushHeaders();
      this.changed();
    });
  }

  private deliver(id: string, delivery: Delivery): Promise<void> {
    const stream = this.streams.get(id);
    if (!stream) return Promise.reject(new Error('Claude Code is not taking messages'));
    return new Promise((resolve, reject) =>
      stream.write(`${JSON.stringify(delivery)}\n`, (error) =>
        error ? reject(error) : resolve()));
  }

  // Each request delivers at most once.
  private once(id: string, action: () => Promise<void>): Promise<void> {
    const known = this.requests.get(id);
    if (known) return known;
    if (this.requests.size >= MAX_REQUESTS)
      this.requests.delete(this.requests.keys().next().value!);
    const result = action();
    this.requests.set(id, result);
    return result;
  }

  private watch(): void {
    if (this.watcher || process.env.DASHUP_LIVE_DISCOVERY === '0') return;
    try {
      const watcher = (this.watcher = watch(join(claudeHome(), 'sessions'), () => {
        if (this.notify) return;
        this.notify = setTimeout(() => {
          this.notify = undefined;
          this.changed();
        }, 100);
        this.notify.unref();
      }));
      watcher.on('error', () => {
        watcher.close();
        if (this.watcher === watcher) this.watcher = undefined;
      });
    } catch {
      // Claude Code creates the registry with its first session.
    }
  }

  stop(): void {
    clearTimeout(this.notify);
    this.watcher?.close();
    this.watcher = undefined;
    this.prompts.clear();
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = undefined;
  }
}
