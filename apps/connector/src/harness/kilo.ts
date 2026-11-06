import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import type { Message, Approval } from '@dashup/protocol';

import { localEndpoint } from './opencode';
import { privateRecord } from './local-file';
import { EARLIER, toolInput, MAX_PREVIEW, NO_PREVIEW, questionApproval, type LiveSession } from './session';

// =============================================================================
// Kilo's existing local daemon
// =============================================================================

const REQUEST_MS     = 4_000;
const RECONNECT_MS   = 2_000;
const EVENT_DELAY_MS = 100;
const MAX_RECORD     = 64 * 1024;
const MAX_BYTES      = 8 * 1024 * 1024;
const MAX_SESSIONS   = 100;
const MAX_MESSAGES   = 200;
const MAX_REQUESTS   = 1_000;
const DECISIONS      = [
  { id: 'once', label: 'Allow once' },
  { id: 'always', label: 'Always allow' },
  { id: 'reject', label: 'Reject' },
];

type Data     = Record<string, any>;
type Endpoint = { url: string; authorization: string; identity: string };

async function owner(path: string): Promise<Endpoint | undefined> {
  try {
    if (!(await privateRecord(path, MAX_RECORD))) return;
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let value: Data;
    try {
      const info = await file.stat();
      if (
        !info.isFile() ||
        info.size > MAX_RECORD ||
        (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))
      )
        return;
      value = JSON.parse(await file.readFile('utf8'));
    } finally {
      await file.close();
    }
    if (
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.url !== 'string' ||
      typeof value.username !== 'string' ||
      typeof value.password !== 'string' ||
      !value.password ||
      /[:\r\n]/.test(value.username) ||
      /[\r\n]/.test(value.password)
    )
      return;
    process.kill(value.pid, 0);
    if (
      process.platform === 'linux' &&
      process.getuid &&
      (await stat(`/proc/${value.pid}`)).uid !== process.getuid()
    )
      return;
    return {
      url           : localEndpoint(value.url),
      authorization : `Basic ${Buffer.from(`${value.username}:${value.password}`).toString('base64')}`,
      identity      : `${value.pid}:${value.startedAt ?? ''}`,
    };
  } catch {
    return;
  }
}

async function endpoint(): Promise<Endpoint | undefined> {
  if (process.env.DASHUP_KILO_DAEMON) return owner(process.env.DASHUP_KILO_DAEMON);
  if (process.env.DASHUP_LIVE_DISCOVERY === '0') return;
  // Kilo keeps an existing data/state fallback after a migration; an explicit XDG state wins.
  const paths = process.env.XDG_STATE_HOME
    ? [join(process.env.XDG_STATE_HOME, 'kilo/daemon.json')]
    : [
        join(
          process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'),
          'kilo/state/daemon.json',
        ),
        join(homedir(), '.local/state/kilo/daemon.json'),
      ];
  for (const path of paths) {
    const found = await owner(path);
    if (found) return found;
  }
  return;
}

const clipped = (text: unknown, max = MAX_PREVIEW): string =>
  typeof text === 'string' ? Buffer.from(text).subarray(0, max).toString('utf8') : '';
const timestamp = (value: unknown): string =>
  new Date(typeof value === 'number' && Number.isFinite(value) ? value : 0).toISOString();

async function* bytes(body: ReadableStream<Uint8Array> | null): AsyncGenerator<Uint8Array> {
  if (!body) return;
  const reader = body.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function messages(listed: Data): Message[] {
  const result: Message[] = listed.cursor?.next ? [EARLIER] : [];
  // The native API pages newest first; a phone conversation reads oldest first.
  for (const item of (Array.isArray(listed.data) ? listed.data : [])
    .slice(0, MAX_MESSAGES)
    .reverse()) {
    if (typeof item.id !== 'string') continue;
    const at = timestamp(item.time?.created);
    if (item.type === 'user' || item.type === 'system')
      result.push({ id: item.id, role: item.type, text: clipped(item.text) });
    else if (item.type === 'shell')
      result.push({
        id: item.id,
        role: 'tool',
        text: clipped(item.output),
        tool: {
          name: 'shell',
          input: toolInput(item.id, item.command),
          summary: clipped(item.command, 500),
          at,
          ...(item.time?.completed ? { status: 'ok' as const } : {}),
        },
      });
    else if (item.type === 'assistant') {
      for (const [index, part] of (Array.isArray(item.content) ? item.content : []).entries()) {
        const id = `${item.id}:${part.id ?? index}`;
        if (part.type === 'text') result.push({ id, role: 'assistant', text: clipped(part.text) });
        else if (part.type === 'tool')
          result.push({
            id,
            role : 'tool',
            text : clipped(
              (Array.isArray(part.state?.content) ? part.state.content : [])
                .filter((entry: Data) => entry.type === 'text')
                .map((entry: Data) => entry.text)
                .join('\n') || part.state?.error?.message,
            ),
            tool : {
              name    : clipped(part.name, 256),
              input   : toolInput(id, part.state?.input),
              summary : clipped(JSON.stringify(part.state?.input ?? {}), 500),
              at,
              ...(part.state?.status === 'completed'
                ? { status: 'ok' as const }
                : part.state?.status === 'error'
                  ? { status: 'error' as const }
                  : {}),
            },
          });
      }
      if (item.error?.message)
        result.push({ id: `${item.id}:error`, role: 'system', text: clipped(item.error.message) });
    }
  }
  return result;
}

function permission(request: Data): Approval {
  const scope = Array.isArray(request.save) ? request.save : [];
  const detail = [
    Array.isArray(request.resources) ? request.resources.join('\n') : '',
    typeof request.metadata?.diff === 'string' ? request.metadata.diff : '',
    Array.isArray(scope) && scope.length
      ? `Always allow saves this ${request.action} rule:\n${scope.join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const preview =
    Array.isArray(request.resources) &&
    request.resources.length > 0 &&
    (request.action !== 'edit' ||
      (typeof request.metadata?.diff === 'string' && !!request.metadata.diff.trim())) &&
    Buffer.byteLength(detail) <= MAX_PREVIEW;
  return {
    id      : request.id,
    title   : `Allow ${clipped(request.action, 256) || 'this'}?`,
    detail  : preview ? detail : NO_PREVIEW,
    choices : DECISIONS.filter((choice) =>
      preview ? choice.id !== 'always' || scope.length > 0 : choice.id === 'reject').map((
      choice,
    ) => ({ ...choice })),
    ...(preview &&
    typeof request.metadata?.filepath === 'string' &&
    typeof request.metadata?.diff === 'string'
      ? { change: { path: request.metadata.filepath, diff: request.metadata.diff } }
      : {}),
  };
}

export class Kilo {
  private endpoint?: Endpoint;
  private stream?: AbortController;
  private retry?: ReturnType<typeof setTimeout>;
  private notify?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly requests = new Map<string, Promise<void>>();
  private readonly typing = new Map<string, { id: string; text: string }>();

  constructor(private readonly changed: () => void) {}

  private async connect(): Promise<Endpoint | undefined> {
    if (this.stopped) return;
    const found = await endpoint();
    if (JSON.stringify(found) !== JSON.stringify(this.endpoint)) {
      this.close();
      this.endpoint = found;
    }
    return this.endpoint;
  }

  // Discovery only observes the native daemon. Starting it remains an explicit Kilo action.
  async available(): Promise<boolean> {
    const host = await this.connect();
    if (!host) return false;
    try {
      const health = await this.request(host, '/global/health');
      return health.healthy === true && typeof health.version === 'string';
    } catch {
      return false;
    }
  }

  private async request(host: Endpoint, path: string, cwd?: string, payload?: Data): Promise<Data> {
    if (this.stopped || this.endpoint !== host)
      throw new Error('Kilo connection changed; refresh the thread');
    const response = await fetch(host.url + path, {
      method   : payload ? 'POST' : 'GET',
      headers  : {
        Authorization : host.authorization,
        ...(cwd ? { 'x-kilo-directory': cwd } : {}),
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      redirect : 'error',
      signal   : AbortSignal.timeout(REQUEST_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Kilo request failed (${response.status})`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of bytes(response.body)) {
      size += chunk.length;
      if (size > MAX_BYTES) throw new Error('Kilo response exceeds the local content limit');
      chunks.push(chunk);
    }
    return size ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  }

  private once(host: Endpoint, id: string, action: () => Promise<void>): Promise<void> {
    const key = `${host.identity}\0${id}`;
    const known = this.requests.get(key);
    if (known) return known;
    if (this.requests.size >= MAX_REQUESTS)
      throw new Error('Kilo command history is full; restart Dashup before sending');
    const pending = action();
    this.requests.set(key, pending);
    return pending;
  }

  async start(cwd: string, text: string): Promise<string> {
    const host = await this.connect();
    if (!host) throw new Error('Start the local Kilo daemon with kilo daemon start first');
    const created = await this.request(host, '/api/session', cwd, { location: { directory: cwd } });
    const id = created.data?.id;
    if (typeof id !== 'string') throw new Error('Kilo did not return its new session');
    await this.resume(id, cwd, text);
    return id;
  }

  async resume(id: string, cwd: string, text: string): Promise<void> {
    const host = await this.connect();
    if (!host) throw new Error('The local Kilo daemon is not running');
    await this.request(host, `/api/session/${encodeURIComponent(id)}/prompt`, cwd, {
      prompt: { text },
    });
    this.changed();
  }

  async refresh(): Promise<LiveSession[]> {
    const host = await this.connect();
    if (!host) return [];
    const health = await this.request(host, '/global/health');
    if (health.healthy !== true || typeof health.version !== 'string') return [];
    const [listed, active] = await Promise.all([
      this.request(host, `/api/session?limit=${MAX_SESSIONS}`),
      this.request(host, '/api/session/active'),
    ]);
    this.listen(host);
    const sessions: Data[] = (Array.isArray(listed.data) ? listed.data : []).slice(0, MAX_SESSIONS);
    const current = new Set(sessions.map((session) => session.id));
    for (const id of this.typing.keys()) if (!current.has(id)) this.typing.delete(id);
    const result = await Promise.allSettled(
      sessions.map(async (session): Promise<LiveSession | undefined> => {
        const id = session.id;
        const cwd = session.location?.directory;
        if (typeof id !== 'string' || typeof cwd !== 'string' || !isAbsolute(cwd)) return;
        const path = `/api/session/${encodeURIComponent(id)}`;
        const [history, pending, questions] = await Promise.all([
          this.request(host, `${path}/message?limit=${MAX_MESSAGES}&order=desc`, cwd),
          this.request(host, `${path}/permission`, cwd),
          this.request(host, `${path}/question`, cwd),
        ]);
        const asked: Data[] = (Array.isArray(questions.data) ? questions.data : []).filter(
          (item: Data) => item.sessionID === id && typeof item.id === 'string',
        );
        const approvals: Approval[] = (Array.isArray(pending.data) ? pending.data : [])
          .filter((item: Data) => item.sessionID === id && typeof item.id === 'string')
          .map(permission);
        for (const item of asked)
          if (Buffer.byteLength(JSON.stringify(item)) <= MAX_PREVIEW)
            approvals.push(
              questionApproval(
                `question:${item.id}`,
                item.questions ?? [],
                (question) => question.multiple === true,
              ),
            );
        const running = !!active.data?.[id];
        if (!running) this.typing.delete(id);
        const conversation = messages(history);
        const draft = this.typing.get(id);
        if (draft && conversation.some((item) => item.id === draft.id && item.text === draft.text))
          this.typing.delete(id);
        return {
          id,
          cwd,
          harness   : 'kilo',
          title     : clipped(session.title, 1000) || 'Kilo Code thread',
          updatedAt : timestamp(session.time?.updated),
          status    : approvals.length || asked.length ? 'attention' : running ? 'working' : 'idle',
          messages  : conversation,
          ...(running && this.typing.get(id)?.text ? { typing: this.typing.get(id)!.text } : {}),
          approvals,
          stop      : running
            ? (requestId) =>
                this.once(host, requestId, async () => {
                  await this.request(host, `${path}/interrupt`, cwd, {});
                  this.changed();
                })
            : undefined,
          send      : (requestId, text, now) =>
            this.once(host, requestId, async () => {
              await this.request(host, `${path}/prompt`, cwd, {
                id     : `msg_${createHash('sha256').update(requestId).digest('hex').slice(0, 32)}`,
                prompt : { text },
                ...(running ? { delivery: now ? 'steer' : 'queue' } : {}),
              });
              this.changed();
            }),
          now       : true,
          approve   : approvals.length
            ? (requestId, approvalId, reply) =>
                this.once(host, requestId, async () => {
                  const approval = approvals.find((item) => item.id === approvalId);
                  if (!approval) throw new Error('Kilo is no longer asking');
                  if (approvalId.startsWith('question:')) {
                    const question = asked.find((item) => `question:${item.id}` === approvalId)!;
                    if ('answers' in reply) {
                      if (
                        reply.answers.length !== question.questions.length ||
                        question.questions.some(
                          (item: Data, index: number) =>
                            (!item.multiple && reply.answers[index]!.length > 1) ||
                            (item.custom === false &&
                              reply.answers[index]!.some(
                                (answer) =>
                                  !item.options.some((option: Data) => option.label === answer),
                              )),
                        )
                      )
                        throw new Error('Answer Kilo with the offered choices');
                      await this.request(
                        host,
                        `${path}/question/${encodeURIComponent(question.id)}/reply`,
                        cwd,
                        { answers: reply.answers },
                      );
                    } else if (reply.choice === 'skip')
                      await this.request(
                        host,
                        `${path}/question/${encodeURIComponent(question.id)}/reject`,
                        cwd,
                        {},
                      );
                    else throw new Error('Kilo did not offer that answer');
                  } else {
                    if (
                      !('choice' in reply) ||
                      !approval.choices.some((choice) => choice.id === reply.choice)
                    )
                      throw new Error('Kilo did not offer that permission choice');
                    await this.request(
                      host,
                      `${path}/permission/${encodeURIComponent(approvalId)}/reply`,
                      cwd,
                      { reply: reply.choice },
                    );
                  }
                  this.changed();
                })
            : undefined,
        };
      }),
    );
    return result.flatMap((item) =>
      item.status === 'fulfilled' && item.value ? [item.value] : []);
  }

  // The native event stream invalidates snapshots; reconnecting re-reads the native state.
  private listen(host: Endpoint): void {
    if (this.stream || this.retry || this.stopped) return;
    const controller = (this.stream = new AbortController());
    void (async () => {
      const response = await fetch(host.url + '/api/event', {
        headers: { Authorization: host.authorization },
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream')) {
        await response.body?.cancel();
        throw new Error('Kilo events unavailable');
      }
      const decoder = new TextDecoder();
      let buffer = '';
      let data: string[] = [];
      let size = 0;
      for await (const chunk of bytes(response.body)) {
        buffer += decoder.decode(chunk, { stream: true });
        if (Buffer.byteLength(buffer) + size > MAX_BYTES)
          throw new Error('Kilo event exceeds the local content limit');
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          if (line.startsWith('data:')) {
            data.push(line.slice(5).trimStart());
            size += Buffer.byteLength(line);
          } else if (!line && data.length) {
            const event = JSON.parse(data.join('\n'));
            data = [];
            size = 0;
            const item = event.data;
            if (
              event.type?.startsWith('session.next.text.') &&
              typeof item?.sessionID === 'string' &&
              typeof item.assistantMessageID === 'string' &&
              typeof item.textID === 'string'
            ) {
              const id = `${item.assistantMessageID}:${item.textID}`;
              const known = this.typing.get(item.sessionID);
              if (this.typing.size < MAX_SESSIONS || known)
                this.typing.set(item.sessionID, {
                  id,
                  text: clipped(
                    event.type === 'session.next.text.ended'
                      ? item.text
                      : (known?.id === id ? known.text : '') + clipped(item.delta),
                  ),
                });
            }
            if (!this.notify)
              this.notify = setTimeout(() => {
                this.notify = undefined;
                this.changed();
              }, EVENT_DELAY_MS);
          }
        }
      }
    })()
      .catch(() => {})
      .finally(() => {
        if (this.stream === controller) {
          this.stream = undefined;
          this.typing.clear();
        }
        if (this.stopped || this.endpoint !== host) return;
        this.retry = setTimeout(() => {
          this.retry = undefined;
          this.changed();
          this.listen(host);
        }, RECONNECT_MS);
        this.retry.unref();
      });
  }

  private close(): void {
    this.stream?.abort();
    this.stream = undefined;
    clearTimeout(this.retry);
    clearTimeout(this.notify);
    this.retry = this.notify = undefined;
    this.typing.clear();
  }

  stop(): void {
    this.stopped = true;
    this.close();
    this.endpoint = undefined;
  }
}
