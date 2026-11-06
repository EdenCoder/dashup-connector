import { join } from 'node:path';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { Approval, Message, AgentOption, ThreadSummary } from '@dashup/protocol';

import { zedData } from '../discovery';
import { kimiHome } from './history';
import { version as DASHUP_VERSION } from '../../package.json';
import { MAX_PREVIEW, questionApproval, type Settings, type LiveSession } from './session';

// =============================================================================
// The Kimi command, its models and its switches
// =============================================================================

const run          = promisify(execFile);
const MAX_REQUESTS = 1_000;
const NOTIFY_MS    = 100;
const CHOICES      = [
  { id: 'approve', label: 'Allow once' },
  { id: 'approve_for_session', label: 'Allow for this session' },
  { id: 'reject', label: 'Reject', text: true as const },
];

type Data    = Record<string, any>;
type Model   = { value: string; name: string; thinking: boolean };
type Pending = { rpc: unknown; request: unknown; approval: Approval; questions?: Data[] };

// `kimi` where it is installed, else the newest copy Zed's agent registry keeps.
export async function kimiCommand(): Promise<string | undefined> {
  const shell = process.platform === 'win32';
  if (
    await run('kimi', ['--version'], { timeout: 10_000, shell }).then(
      () => true,
      () => false,
    )
  )
    return 'kimi';
  const registry = join(zedData(), 'external_agents/registry/kimi');
  return (existsSync(registry) ? readdirSync(registry) : [])
    .map((version) => join(registry, version, shell ? 'kimi.exe' : 'kimi'))
    .filter((path) => existsSync(path))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
}

// The models Kimi's config names, with whether each thinks, and the defaults a session starts
// with. Kimi writes the file itself: quoted model sections, then `key = value` lines.
function config(): { model?: string; thinking?: boolean; models: Model[] } {
  let text = '';
  try {
    text = readFileSync(join(kimiHome(), 'config.toml'), 'utf8');
  } catch {
    // Kimi writes its config when it first runs.
  }
  const found: ReturnType<typeof config> = { models: [] };
  let section = '';
  let model: Model | undefined;
  for (const line of text.split('\n')) {
    const header = /^\s*\[(.+)\]\s*$/.exec(line)?.[1];
    if (header !== undefined) {
      section = header;
      const named = /^models\."(.+)"$/.exec(header)?.[1];
      model = named ? { value: named, name: named, thinking: false } : undefined;
      if (model) found.models.push(model);
      continue;
    }
    const [, key, value = ''] = /^\s*(\w+)\s*=\s*(.+?)\s*$/.exec(line) ?? [];
    if (model && key === 'display_name') model.name = JSON.parse(value);
    else if (model && key === 'capabilities') model.thinking = value.includes('"thinking"');
    else if (!section && key === 'default_model') found.model = JSON.parse(value);
    else if (!section && key === 'default_thinking') found.thinking = value === 'true';
  }
  return found;
}

// What a Kimi session runs with: the model and thinking it starts with, among the models Kimi's
// config names, and its plan mode. A saved session records only its plan mode.
export function kimiOptions(recorded: Settings): AgentOption[] {
  const { models } = config();
  const model   = typeof recorded.model === 'string' ? recorded.model : undefined;
  const current = models.find((item) => item.value === model);
  const choices = models.map(({ value, name }) => ({ value, name }));
  if (model && !current) choices.push({ value: model, name: model });
  return [
    ...(model ? [{ id: 'model', name: 'Model', value: model, choices }] : []),
    ...(model && current?.thinking !== false && typeof recorded.thinking === 'boolean'
      ? [{ id: 'thinking', name: 'Thinking', value: recorded.thinking }]
      : []),
    ...(typeof recorded.plan === 'boolean'
      ? [{ id: 'plan', name: 'Plan', value: recorded.plan }]
      : []),
  ];
}

// =============================================================================
// Kimi sessions Dashup starts
// =============================================================================

// Each turn runs Kimi's wire mode in the project under a session id Dashup chooses, and the phone
// answers its approvals and questions. Nothing runs between turns: the next message resumes the
// session, with the model and thinking the person chose, which Kimi takes only as it starts.
class Session {
  readonly messages: Message[] = [];
  status: ThreadSummary['status'] = 'idle';
  updatedAt = new Date().toISOString();
  private turn?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  // The reply Kimi is writing, as far as it has streamed.
  private typing = '';
  private begun?: { resolve(): void; reject(error: Error): void };
  private readonly calls = new Map<
    string,
    { resolve(value: Data): void; reject(error: Error): void }
  >();
  private readonly approvals = new Map<string, Pending>();
  private readonly requests = new Map<string, Promise<void>>();
  private readonly chosen: Settings = {};

  constructor(
    readonly id: string,
    readonly cwd: string,
    readonly title: string | undefined,
    private readonly changed: () => void,
  ) {}

  private write(value: Data): void {
    this.turn?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
  }

  private call(method: string, params?: Data): Promise<Data> {
    const id = `dashup-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.write({ id, method, ...(params ? { params } : {}) });
    });
  }

  private once(id: string, action: () => Promise<void>): Promise<void> {
    const known = this.requests.get(id);
    if (known) return known;
    if (this.requests.size >= MAX_REQUESTS)
      throw new Error('Kimi command history is full; restart Dashup before sending');
    const result = action();
    this.requests.set(id, result);
    return result;
  }

  // What the session starts with: the person's choice, else Kimi's defaults.
  private launch(): Settings {
    const defaults = config();
    const model    = this.chosen.model ?? defaults.model;
    const thinking = this.chosen.thinking ?? defaults.thinking;
    return {
      ...(model === undefined ? {} : { model }),
      ...(thinking === undefined ? {} : { thinking }),
    };
  }

  // Resolves once Kimi begins the turn, or says why it could not. A message while a turn runs is
  // steered into it.
  async say(text: string): Promise<void> {
    // TurnEnd precedes the prompt acknowledgement and process exit. Its stdin is closing.
    if (this.turn && this.status === 'idle') await once(this.turn, 'exit');
    this.messages.push({ id: randomUUID(), role: 'user', text });
    this.typing = '';
    this.status = 'working';
    this.updatedAt = new Date().toISOString();
    if (this.turn) {
      await this.call('steer', { user_input: text });
      this.changed();
      return;
    }
    const command = await kimiCommand();
    if (!command) throw new Error('Kimi is not installed on this computer');
    const { model, thinking } = this.launch();
    const turn = (this.turn = spawn(
      command,
      [
        '--wire',
        '--work-dir',
        this.cwd,
        '--session',
        this.id,
        ...(typeof model === 'string' ? ['--model', model] : []),
        ...(typeof thinking === 'boolean' ? [thinking ? '--thinking' : '--no-thinking'] : []),
      ],
      { cwd: this.cwd, stdio: 'pipe', shell: process.platform === 'win32' },
    ));
    let errors = '';
    turn.stdin.on('error', () => {});
    turn.stderr.on('data', (chunk) => {
      errors = (errors + String(chunk)).slice(-2_000);
    });
    createInterface({ input: turn.stdout }).on('line', (line) => this.receive(line));
    const begun = new Promise<void>((resolve, reject) => {
      this.begun = { resolve, reject };
      const end = (reason: string) => {
        reject(new Error(reason));
        if (this.turn !== turn) return;
        this.turn = undefined;
        for (const pending of this.calls.values()) pending.reject(new Error(reason));
        this.calls.clear();
        this.approvals.clear();
        this.status = 'idle';
        this.changed();
      };
      turn.once('error', () => end('Kimi is not installed on this computer'));
      turn.once('exit', () => end(errors.trim() || 'Kimi stopped before starting'));
    });
    await this.call('initialize', {
      protocol_version : '1.10',
      client           : { name: 'dashup', version: DASHUP_VERSION },
      capabilities     : { supports_question: true, supports_plan_mode: true },
    });
    if (typeof this.chosen.plan === 'boolean')
      await this.call('set_plan_mode', { enabled: this.chosen.plan });
    // The prompt answers when the turn ends; the process then has nothing left to do. A refusal
    // before the turn begins is why it could not start, and after it, how the turn ended.
    void this.call('prompt', { user_input: text })
      .catch((error: Error) => {
        this.begun?.reject(error);
        this.messages.push({ id: randomUUID(), role: 'system', text: error.message });
      })
      .finally(() => turn.stdin.end());
    this.changed();
    return begun;
  }

  // Handles one line of Kimi's output: the answer to a call, an event, or a request to answer.
  private receive(line: string): void {
    let message: Data;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.calls.get(String(message.id));
      this.calls.delete(String(message.id));
      if (message.error) pending?.reject(new Error(String(message.error.message ?? 'Kimi failed')));
      else pending?.resolve(message.result ?? {});
      return;
    }
    const type    = message.params?.type;
    const payload = message.params?.payload ?? {};
    if (message.method === 'event') {
      if (type === 'TurnBegin') this.begun?.resolve();
      else if (type === 'ContentPart' && payload.type === 'text') {
        this.typing += String(payload.text ?? '');
      } else if (type === 'TurnEnd') {
        if (this.typing)
          this.messages.push({ id: randomUUID(), role: 'assistant', text: this.typing });
        this.typing = '';
        this.status = this.approvals.size ? 'attention' : 'idle';
      } else return;
    } else if (message.method === 'request' && type === 'ApprovalRequest') {
      const id     = randomUUID();
      let detail = [payload.description, payload.sender].filter(Boolean).join('\n\n');
      if (Buffer.byteLength(detail) > MAX_PREVIEW)
        detail = Buffer.from(detail).subarray(0, MAX_PREVIEW).toString('utf8');
      this.approvals.set(id, {
        rpc      : message.id,
        request  : payload.id,
        approval : {
          id,
          title   : `Allow ${String(payload.action ?? 'this')}?`,
          detail,
          choices : CHOICES.map((choice) => ({ ...choice })),
        },
      });
      this.status = 'attention';
    } else if (message.method === 'request' && type === 'QuestionRequest') {
      const id        = randomUUID();
      const questions = Array.isArray(payload.questions) ? payload.questions : [];
      this.approvals.set(id, {
        rpc      : message.id,
        request  : payload.id,
        questions,
        approval : questionApproval(id, questions, (item) => item.multi_select === true),
      });
      this.status = 'attention';
    } else return;
    this.updatedAt = new Date().toISOString();
    this.changed();
  }

  live(): LiveSession {
    return {
      id        : this.id,
      cwd       : this.cwd,
      title     : this.title,
      harness   : 'kimi',
      updatedAt : this.updatedAt,
      status    : this.status,
      messages  : [...this.messages],
      typing    : this.typing,
      approvals : [...this.approvals.values()].map((pending) => pending.approval),
      send      : (requestId, text) => this.once(requestId, () => this.say(text)),
      now       : true,
      stop      : this.turn
        ? (requestId) =>
            this.once(requestId, async () => {
              await this.call('cancel');
            })
        : undefined,
      approve   : this.approvals.size
        ? (requestId, approvalId, reply) =>
            this.once(requestId, async () => {
              const pending = this.approvals.get(approvalId);
              const choice  = 'choice' in reply ? reply.choice : undefined;
              if (!pending || !this.turn) throw new Error('Kimi is no longer asking');
              // Questions name each answer by its question; skipping answers none.
              if (pending.questions)
                this.write({
                  id     : pending.rpc,
                  result : {
                    request_id : pending.request,
                    answers    : Object.fromEntries(
                      'answers' in reply
                        ? pending.questions.map((item, index) => [
                            item.question,
                            (reply.answers[index] ?? []).join(', '),
                          ])
                        : [],
                    ),
                  },
                });
              else if (CHOICES.some((value) => value.id === choice))
                this.write({
                  id     : pending.rpc,
                  result : {
                    request_id : pending.request,
                    response   : choice,
                    ...('text' in reply && reply.text ? { feedback: reply.text } : {}),
                  },
                });
              else throw new Error('Kimi is no longer asking');
              this.approvals.delete(approvalId);
              if (!this.approvals.size) this.status = 'working';
              this.changed();
            })
        : undefined,
      options   : (recorded) => kimiOptions({ ...recorded(), ...this.launch() }),
      // Plan mode applies to the turn under way; the model and thinking apply as the next starts.
      configure : (requestId, option, value) =>
        this.once(requestId, async () => {
          this.chosen[option] = value;
          if (option === 'plan' && this.turn && this.status !== 'idle')
            await this.call('set_plan_mode', { enabled: value });
          this.changed();
        }),
    };
  }

  end(): void {
    this.turn?.kill();
  }
}

export class Kimi {
  private readonly sessions = new Map<string, Session>();
  private notify?: ReturnType<typeof setTimeout>;

  constructor(private readonly changed: () => void) {}

  private readonly soon = (): void => {
    if (this.notify) return;
    this.notify = setTimeout(() => {
      this.notify = undefined;
      this.changed();
    }, NOTIFY_MS);
    this.notify.unref();
  };

  // Starts a session in `cwd` with its first message, and resolves with the session's id.
  async start(cwd: string, text: string): Promise<string> {
    const title = text.trim().split('\n')[0]!.slice(0, 80);
    const session = new Session(randomUUID(), cwd, title, this.soon);
    this.sessions.set(session.id, session);
    try {
      await session.say(text);
    } catch (error) {
      this.sessions.delete(session.id);
      throw error;
    }
    return session.id;
  }

  // Continues a saved session with a message; Kimi resumes it from its own session folder.
  async resume(id: string, cwd: string, text: string): Promise<void> {
    const known = this.sessions.get(id);
    const session = known ?? new Session(id, cwd, undefined, this.soon);
    this.sessions.set(id, session);
    try {
      await session.say(text);
    } catch (error) {
      if (!known) this.sessions.delete(id);
      throw error;
    }
  }

  async refresh(): Promise<LiveSession[]> {
    return [...this.sessions.values()].map((session) => session.live());
  }

  stop(): void {
    clearTimeout(this.notify);
    for (const session of this.sessions.values()) session.end();
  }
}
