import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type { Approval, Message, ThreadSummary } from '@dashup/protocol';

import { attached, INPUT_IMAGE_TYPES, type Settings, type InputFile, type LiveSession } from './session';
import { ask, decide, claudeModels, claudeOptions, type PermissionRequest } from './claude';

// =============================================================================
// Claude Code sessions Dashup starts
// =============================================================================

// Each turn runs Claude Code's headless JSON mode in the project, and the phone answers its
// permission requests as its host. Nothing runs between turns: the next message resumes the
// session.
const MAX_REQUESTS = 1_000;
const NOTIFY_MS    = 100;
// The Claude Code setting each switch is.
const SWITCHES: Record<string, string> = { fast: 'fastMode', ultracode: 'ultracode' };

type Data    = Record<string, any>;
type Pending = { control: string; request: PermissionRequest; approval: Approval };

class Session {
  readonly messages: Message[] = [];
  status: ThreadSummary['status'] = 'idle';
  updatedAt = new Date().toISOString();
  private turn?: ChildProcessWithoutNullStreams;
  // Messages written to this turn's process that Claude Code has not finished answering.
  private open = 0;
  // The text Claude Code is writing, as far as it has streamed.
  private typing = '';
  private readonly approvals = new Map<string, Pending>();
  private readonly requests = new Map<string, Promise<void>>();
  // What the person chose for this session, applied to each turn as it starts.
  private readonly chosen: Settings = {};
  private mode?: string;
  private readonly controls = new Map<string, { resolve(): void; reject(error: Error): void }>();

  // A resumed session is `saved` and keeps the title its history gives.
  constructor(
    readonly id: string,
    readonly cwd: string,
    readonly title: string | undefined,
    private readonly changed: () => void,
    private saved = false,
    model?: string,
  ) {
    if (model) this.chosen.model = model;
  }

  private write(value: Data): void {
    this.turn?.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private interrupt(): void {
    this.write({
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype: 'interrupt' },
    });
  }

  private apply(option: string, value: string | boolean): void {
    this.write({
      type: 'control_request',
      request_id: randomUUID(),
      request:
        option === 'model'
          ? { subtype: 'set_model', model: value }
          : option === 'auto'
            ? { subtype: 'set_permission_mode', mode: value ? 'auto' : 'default' }
            : { subtype: 'apply_flag_settings', settings: { [SWITCHES[option]!]: value } },
    });
  }

  private once(id: string, action: () => Promise<void>): Promise<void> {
    const known = this.requests.get(id);
    if (known) return known;
    if (this.requests.size >= MAX_REQUESTS)
      throw new Error('Claude Code command history is full; restart Dashup before sending');
    const result = action();
    this.requests.set(id, result);
    return result;
  }

  // Resolves once Claude Code takes the message, or says why it could not start. `now` stops the
  // turn under way, so Claude Code takes the message at once.
  async say(text: string, now = false, files: InputFile[] = []): Promise<void> {
    const imageFiles = files.filter((file) => INPUT_IMAGE_TYPES.has(file.mime));
    const images = await Promise.all(
      imageFiles.map(async (file) => ({
        type: 'image',
        source: {
          type: 'base64',
          media_type: file.mime,
          data: (await readFile(file.path)).toString('base64'),
        },
      })),
    );
    const id = randomUUID();
    this.messages.push({
      id,
      role: 'user',
      text,
      ...(images.length
        ? {
            attachments: images.map((image, index) =>
              attached(
                `${id}:image:${index}`,
                image.source.media_type,
                image.source.data,
                basename(imageFiles[index]!.path),
              )),
          }
        : {}),
    });
    this.typing = '';
    this.status = 'working';
    this.updatedAt = new Date().toISOString();
    const message = {
      type: 'user',
      message: {
        role: 'user',
        content: images.length ? [{ type: 'text', text }, ...images] : text,
      },
    };
    if (this.turn) {
      if (now) this.interrupt();
      this.open++;
      this.write(message);
      this.changed();
      return Promise.resolve();
    }
    const turn = (this.turn = spawn(
      'claude',
      [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--include-partial-messages',
        '--permission-prompt-tool',
        'stdio',
        ...(this.saved ? ['--resume', this.id] : ['--session-id', this.id]),
        ...(typeof this.chosen.model === 'string' ? ['--model', this.chosen.model] : []),
        ...(typeof this.chosen.auto === 'boolean'
          ? ['--permission-mode', this.chosen.auto ? 'auto' : 'default']
          : []),
      ],
      { cwd: this.cwd, stdio: 'pipe', shell: process.platform === 'win32' },
    ));
    this.open = 1;
    let errors = '';
    turn.stdin.on('error', () => {});
    turn.stderr.on('data', (chunk) => {
      errors = (errors + String(chunk)).slice(-2_000);
    });
    const started = new Promise<void>((resolve, reject) => {
      createInterface({ input: turn.stdout }).on('line', (line) => {
        if (this.receive(line)) resolve();
      });
      const end = (reason: string) => {
        reject(new Error(reason));
        if (this.turn !== turn) return;
        this.turn = undefined;
        this.open = 0;
        this.typing = '';
        this.approvals.clear();
        for (const pending of this.controls.values()) pending.reject(new Error(reason));
        this.controls.clear();
        this.status = 'idle';
        this.changed();
      };
      turn.once('error', () => end('Claude Code is not installed on this computer'));
      turn.once('exit', () => end(errors.trim() || 'Claude Code stopped before starting'));
    });
    for (const [option, value] of Object.entries(this.chosen))
      if (option !== 'auto' && option !== 'model') this.apply(option, value);
    this.write(message);
    this.changed();
    return started;
  }

  // Handles one line of Claude Code's output, and says whether it started the session.
  private receive(line: string): boolean {
    let message: Data;
    try {
      message = JSON.parse(line);
    } catch {
      return false;
    }
    const init = message.type === 'system' && message.subtype === 'init';
    if (init) {
      this.saved = true;
      if (typeof message.permissionMode === 'string') {
        this.mode = message.permissionMode;
        delete this.chosen.auto;
      }
    } else if (message.type === 'control_response') {
      const response = message.response;
      const pending = this.controls.get(response?.request_id);
      if (!pending) return false;
      this.controls.delete(response.request_id);
      if (response.subtype === 'error')
        pending.reject(new Error(response.error || 'Claude rejected the mode change'));
      else pending.resolve();
      return false;
    } else if (message.type === 'assistant' && !message.parent_tool_use_id) {
      this.typing = '';
      const text = (Array.isArray(message.message?.content) ? message.message.content : [])
        .filter((part: Data) => part?.type === 'text' && typeof part.text === 'string')
        .map((part: Data) => part.text)
        .join('\n\n');
      if (!text) return false;
      // Claude Code sends each part of a reply on its own, under the reply's ID and the part's UUID.
      this.messages.push({ id: String(message.uuid ?? randomUUID()), role: 'assistant', text });
    } else if (message.type === 'control_request' && message.request?.subtype === 'can_use_tool') {
      const id      = randomUUID();
      const asked   = message.request;
      const request = {
        tool        : String(asked.tool_name),
        input       : asked.input ?? {},
        label       : typeof asked.display_name === 'string' ? asked.display_name : undefined,
        description : typeof asked.description === 'string' ? asked.description : undefined,
        suggestions : Array.isArray(asked.permission_suggestions)
          ? asked.permission_suggestions
          : undefined,
      };
      this.approvals.set(id, {
        control  : String(message.request_id),
        request,
        approval : ask(id, request, true),
      });
      this.status = 'attention';
    } else if (message.type === 'control_cancel_request') {
      // Another answer came first, such as a hook's.
      for (const [id, pending] of this.approvals)
        if (pending.control === message.request_id) this.approvals.delete(id);
      if (this.status === 'attention' && !this.approvals.size) this.status = 'working';
    } else if (message.type === 'result') {
      this.typing = '';
      // The process exits once it has answered every message written to it.
      if (--this.open <= 0) this.turn?.stdin.end();
    } else if (message.type === 'stream_event' && !message.parent_tool_use_id) {
      // Each block of a reply streams in pieces; a subagent's stay with it.
      const event = message.event;
      if (event?.type === 'content_block_start') this.typing = '';
      else if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta')
        this.typing += String(event.delta.text ?? '');
      else return false;
      this.changed();
      return false;
    } else return false;
    this.updatedAt = new Date().toISOString();
    this.changed();
    return init;
  }

  live(models: ReturnType<typeof claudeModels>): LiveSession {
    return {
      id: this.id,
      cwd: this.cwd,
      title: this.title,
      harness: 'claude',
      updatedAt: this.updatedAt,
      status: this.status,
      messages: [...this.messages],
      typing: this.typing,
      approvals: [...this.approvals.values()].map((pending) => pending.approval),
      send: (requestId, text, now, files) => this.once(requestId, () => this.say(text, now, files)),
      now: true,
      options: (recorded) =>
        claudeOptions(models, {
          ...recorded(),
          ...(this.mode ? { auto: this.mode === 'auto' } : {}),
          ...this.chosen,
        }),
      configure: (requestId, option, value) =>
        this.once(requestId, async () => {
          if (option === 'auto' && this.turn) {
            await new Promise<void>((resolve, reject) => {
              const id = randomUUID();
              const timer = setTimeout(() => {
                this.controls.delete(id);
                reject(new Error('Claude mode change timed out'));
              }, 10_000);
              this.controls.set(id, {
                resolve: () => {
                  clearTimeout(timer);
                  resolve();
                },
                reject: (error) => {
                  clearTimeout(timer);
                  reject(error);
                },
              });
              this.write({
                type: 'control_request',
                request_id: id,
                request: { subtype: 'set_permission_mode', mode: value ? 'auto' : 'default' },
              });
            });
          } else this.apply(option, value);
          this.chosen[option] = value;
          this.changed();
        }),
      stop: this.turn
        ? (requestId) =>
            this.once(requestId, async () => {
              if (!this.turn) throw new Error('Nothing is running in this Claude Code session');
              this.interrupt();
            })
        : undefined,
      approve: this.approvals.size
        ? (requestId, approvalId, reply) =>
            this.once(requestId, async () => {
              const pending = this.approvals.get(approvalId);
              if (!pending || !this.turn)
                throw new Error('Claude Code approval is no longer pending');
              this.write({
                type: 'control_response',
                response: {
                  subtype: 'success',
                  request_id: pending.control,
                  response: decide(pending.request, pending.approval, reply),
                },
              });
              this.approvals.delete(approvalId);
              if (!this.approvals.size) this.status = 'working';
              this.changed();
            })
        : undefined,
    };
  }

  end(): void {
    this.turn?.kill();
  }
}

export class Headless {
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
  async start(cwd: string, text: string, files?: InputFile[], model?: string): Promise<string> {
    const title = text.trim().split('\n')[0]!.slice(0, 80);
    const session = new Session(randomUUID(), cwd, title, this.soon, false, model);
    this.sessions.set(session.id, session);
    try {
      await session.say(text, false, files);
    } catch (error) {
      this.sessions.delete(session.id);
      throw error;
    }
    return session.id;
  }

  // Continues a saved session with a message; Claude Code resumes it from its own transcript.
  async resume(id: string, cwd: string, text: string, files?: InputFile[]): Promise<void> {
    const known = this.sessions.get(id);
    const session = known ?? new Session(id, cwd, undefined, this.soon, true);
    this.sessions.set(id, session);
    try {
      await session.say(text, false, files);
    } catch (error) {
      if (!known) this.sessions.delete(id);
      throw error;
    }
  }

  async refresh(): Promise<LiveSession[]> {
    const models = claudeModels(this.changed);
    return [...this.sessions.values()].map((session) => session.live(models));
  }

  stop(): void {
    clearTimeout(this.notify);
    for (const session of this.sessions.values()) session.end();
  }
}
