import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import type { Approval } from '@dashup/protocol';

import { MAX_PREVIEW, questionApproval, type LiveSession } from './session';
import { localEndpoint, openCodeState, sessionOptions } from './opencode';

// =============================================================================
// OpenCode 2's background service
// =============================================================================

// OpenCode 2 runs one background service per person, holding every session, and records where it
// listens and the password each request takes in its state folder. Its API is all under `/api`;
// the conversations themselves are read from OpenCode's database.
const REQUEST_MS     = 4_000;
const MAX_BYTES      = 8 * 1024 * 1024;
const MAX_SESSIONS   = 100;
const MAX_REQUESTS   = 1_000;
const EVENT_DELAY_MS = 100;
const RECONNECT_MS   = 2_000;
const DECISIONS      = [
  { id: 'once', label: 'Allow once' },
  { id: 'always', label: 'Always allow' },
  { id: 'reject', label: 'Reject' },
];

type Data     = Record<string, any>;
type Endpoint = { url: string; authorization: string };
// A form the phone answers: each question's field, and how its labels map to values.
type Form     = { session: string; id: string; fields: Data[] };

function endpoint(): Endpoint | undefined {
  const path =
    process.env.DASHUP_OPENCODE_SERVICE ??
    (process.env.DASHUP_LIVE_DISCOVERY === '0' ? undefined : join(openCodeState(), 'service.json'));
  if (!path) return undefined;
  try {
    const service = JSON.parse(readFileSync(path, 'utf8'));
    // A stopped service leaves its record behind.
    if (typeof service.pid === 'number') process.kill(service.pid, 0);
    return {
      url           : localEndpoint(String(service.url)),
      authorization : `Basic ${Buffer.from(`opencode:${service.password}`).toString('base64')}`,
    };
  } catch {
    return undefined;
  }
}

function permissionApproval(request: Data): Approval {
  const resources = Array.isArray(request.resources) ? request.resources.map(String) : [];
  let detail = [resources.join('\n'), typeof request.message === 'string' ? request.message : '']
    .filter(Boolean)
    .join('\n\n');
  if (Buffer.byteLength(detail) > MAX_PREVIEW)
    detail = Buffer.from(detail).subarray(0, MAX_PREVIEW).toString('utf8');
  const path = request.metadata?.filepath;
  const diff = request.metadata?.diff;
  return {
    id      : String(request.id),
    title   : `Allow ${String(request.action ?? 'this')}?`,
    detail,
    choices : DECISIONS.map((choice) => ({ ...choice })),
    ...(typeof path === 'string' &&
    typeof diff === 'string' &&
    Buffer.byteLength(diff) <= MAX_PREVIEW
      ? { change: { path, diff } }
      : {}),
  };
}

// A form's fields as questions: a choice from its options, yes or no, or the person's own words.
// A field the phone cannot fill leaves the form to the computer.
function formQuestions(form: Data): Data[] | undefined {
  const fields = (Array.isArray(form.fields) ? form.fields : []).filter(
    (field: Data) => !field.hidden,
  );
  if (fields.some((field: Data) => field.type === 'external')) return undefined;
  return fields.map((field: Data) => ({
    question : fields.length === 1 ? String(form.title ?? field.key) : String(field.key),
    options  :
      field.type === 'boolean'
        ? [{ label: 'Yes' }, { label: 'No' }]
        : (Array.isArray(field.options) ? field.options : []).map((option: Data) => ({
            label : String(option.label ?? option.value),
          })),
    multiple : field.type === 'multiselect',
  }));
}

// The person's answers, as the values each field takes.
function formAnswer(fields: Data[], answers: string[][]): Data {
  return Object.fromEntries(
    fields.map((field, index) => {
      const given  = answers[index] ?? [];
      const values = given.map(
        (label) =>
          (Array.isArray(field.options) ? field.options : []).find(
            (option: Data) => option.label === label,
          )?.value ?? label,
      );
      return [
        field.key,
        field.type === 'multiselect'
          ? values
          : field.type === 'boolean'
            ? given[0] === 'Yes'
            : field.type === 'number' || field.type === 'integer'
              ? Number(values[0])
              : (values[0] ?? ''),
      ];
    }),
  );
}

export class OpenCodeService {
  private endpoint?: Endpoint;
  private stream?: AbortController;
  private retry?: ReturnType<typeof setTimeout>;
  private notify?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly requests = new Map<string, Promise<void>>();
  private readonly forms = new Map<string, Form>();
  // The models and agents OpenCode lists for each folder, asked once while the service answers.
  private readonly catalogs = new Map<string, Promise<[unknown, unknown]>>();

  constructor(private readonly changed: () => void) {}

  private async request(path: string, directory?: string, payload?: Data, method?: string) {
    const signal = AbortSignal.timeout(REQUEST_MS);
    const response = await fetch(this.endpoint!.url + path, {
      method   : method ?? (payload === undefined ? 'GET' : 'POST'),
      headers  : {
        Authorization : this.endpoint!.authorization,
        ...(directory ? { 'x-opencode-directory': directory } : {}),
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      redirect : 'error',
      signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`OpenCode request failed (${response.status})`);
    if (text.length > MAX_BYTES)
      throw new Error('OpenCode response exceeds the local content limit');
    return text ? JSON.parse(text) : undefined;
  }

  private once(id: string, action: () => Promise<void>): Promise<void> {
    const known = this.requests.get(id);
    if (known) return known;
    if (this.requests.size >= MAX_REQUESTS)
      throw new Error('OpenCode command history is full; restart Dashup before sending');
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

  // The service as its record names it now; a changed record starts over.
  private connect(): Endpoint | undefined {
    const found = endpoint();
    if (
      found?.url !== this.endpoint?.url ||
      found?.authorization !== this.endpoint?.authorization
    ) {
      this.close();
      this.endpoint = found;
    }
    return this.endpoint;
  }

  // Whether OpenCode 2's service runs here, so that it starts and resumes OpenCode's sessions.
  available(): boolean {
    return !!this.connect();
  }

  async start(cwd: string, text: string): Promise<string> {
    if (!this.connect()) throw new Error('OpenCode is not running on this computer');
    const created = await this.request('/api/session', cwd, { location: { directory: cwd } });
    const id      = created?.data?.id;
    if (typeof id !== 'string') throw new Error('OpenCode did not start a session');
    await this.resume(id, cwd, text);
    return id;
  }

  async resume(id: string, cwd: string, text: string): Promise<void> {
    if (!this.connect()) throw new Error('OpenCode is not running on this computer');
    await this.request(`/api/session/${encodeURIComponent(id)}/prompt`, cwd, { text });
    this.changed();
  }

  async refresh(): Promise<LiveSession[]> {
    if (!this.connect()) return [];
    const info = await this.request('/api/info');
    if (typeof info?.version !== 'string') return [];
    this.listen();
    const [listed, active] = await Promise.all([
      this.request(`/api/session?limit=${MAX_SESSIONS}`),
      this.request('/api/session/active'),
    ]);
    const recent = Array.isArray(listed?.data) ? listed.data.slice(0, MAX_SESSIONS) : [];
    // A long-running session can fall outside the newest page while newer sessions are created.
    const older = await Promise.all(
      Object.keys(active?.data ?? {})
        .filter((id) => !recent.some((session: Data) => session?.id === id))
        .slice(0, MAX_SESSIONS)
        .map((id) =>
          this.request(`/api/session/${encodeURIComponent(id)}`).then(
            (found) => (found?.data?.id === id ? found.data : undefined),
            () => undefined,
          )),
    );
    const sessions = [...recent, ...older].filter(
      (session: Data) =>
        typeof session?.id === 'string' && typeof session.location?.directory === 'string',
    ) as Data[];
    // Permissions are listed per folder.
    const permissions = new Map<string, Promise<Data[]>>();
    const result: LiveSession[] = [];
    for (const session of sessions) {
      const id      = String(session.id);
      const cwd     = String(session.location.directory);
      const running = !!active?.data?.[id];
      if (!permissions.has(cwd))
        permissions.set(
          cwd,
          this.request('/api/permission/request', cwd).then(
            (pending) => (Array.isArray(pending?.data) ? pending.data : []),
            () => [],
          ),
        );
      const [pending, forms, [models, agents]] = await Promise.all([
        permissions.get(cwd)!,
        running
          ? this.request(`/api/session/${encodeURIComponent(id)}/form`, cwd).then(
              (listed) => (Array.isArray(listed?.data) ? listed.data : []),
              () => [],
            )
          : [],
        this.catalog(cwd),
      ]);
      const approvals: Approval[] = pending
        .filter((request: Data) => request?.sessionID === id && typeof request.id === 'string')
        .map(permissionApproval);
      for (const form of forms as Data[]) {
        const questions = formQuestions(form);
        if (!questions || typeof form.id !== 'string') continue;
        const approvalId = `form:${form.id}`;
        this.forms.set(approvalId, { session: id, id: form.id, fields: form.fields ?? [] });
        approvals.push(
          questionApproval(approvalId, questions, (question) => question.multiple === true),
        );
      }
      const path = `/api/session/${encodeURIComponent(id)}`;
      result.push({
        id,
        cwd,
        harness   : 'opencode',
        title     : typeof session.title === 'string' ? session.title : 'OpenCode thread',
        updatedAt : new Date(Number(session.time?.updated ?? Date.now())).toISOString(),
        status    : approvals.length ? 'attention' : running ? 'working' : 'idle',
        // OpenCode's database holds the conversation, which its saved history reads.
        messages  : [],
        approvals,
        stop      : running
          ? (requestId) =>
              this.once(requestId, async () => {
                await this.request(`${path}/interrupt`, cwd, {});
                this.changed();
              })
          : undefined,
        // While the session works, a message waits for its turn to end, or steers it at once.
        send      : (requestId, text, now) =>
          this.once(requestId, async () => {
            await this.request(`${path}/prompt`, cwd, {
              id   : `msg_${createHash('sha256').update(requestId).digest('hex').slice(0, 32)}`,
              text,
              ...(running ? { delivery: now ? 'steer' : 'queue' } : {}),
            });
            this.changed();
          }),
        now       : true,
        approve   : approvals.length
          ? (requestId, approvalId, reply) =>
              this.once(requestId, async () => {
                const form = this.forms.get(approvalId);
                if (form?.session === id) {
                  // Skipping a form cancels it.
                  if ('answers' in reply)
                    await this.request(`${path}/form/${encodeURIComponent(form.id)}/reply`, cwd, {
                      answer : formAnswer(
                        form.fields.filter((field) => !field.hidden),
                        reply.answers,
                      ),
                    });
                  else
                    await this.request(
                      `${path}/form/${encodeURIComponent(form.id)}`,
                      cwd,
                      undefined,
                      'DELETE',
                    );
                } else {
                  const choice = 'choice' in reply ? reply.choice : undefined;
                  if (
                    !DECISIONS.some((value) => value.id === choice) ||
                    !approvals.some((item) => item.id === approvalId)
                  )
                    throw new Error('OpenCode is no longer asking');
                  await this.request(
                    `${path}/permission/${encodeURIComponent(approvalId)}/reply`,
                    cwd,
                    { decision: choice },
                  );
                }
                this.changed();
              })
          : undefined,
        options   : () => sessionOptions(models, agents, session),
        // OpenCode keeps the model, as `provider/model`, and the agent on the session.
        configure : (requestId, option, value) =>
          this.once(requestId, async () => {
            const chosen = String(value);
            const split  = chosen.indexOf('/');
            await this.request(
              `${path}/${option}`,
              cwd,
              option === 'model'
                ? { model: { providerID: chosen.slice(0, split), id: chosen.slice(split + 1) } }
                : { agent: chosen },
            );
            this.changed();
          }),
      });
    }
    return result;
  }

  // Any event may change what a session shows; a burst of them is one change.
  private listen(): void {
    if (this.stream || this.retry || this.stopped || !this.endpoint) return;
    const controller = (this.stream = new AbortController());
    const { url, authorization } = this.endpoint;
    void (async () => {
      const response = await fetch(`${url}/api/event`, {
        headers  : { Authorization: authorization },
        redirect : 'error',
        signal   : controller.signal,
      });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/event-stream'))
        throw new Error('OpenCode events unavailable');
      const reader = response.body?.getReader();
      if (!reader) return;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          if (this.notify) continue;
          this.notify = setTimeout(() => {
            this.notify = undefined;
            this.changed();
          }, EVENT_DELAY_MS);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    })()
      .catch(() => {})
      .finally(() => {
        if (this.stream === controller) this.stream = undefined;
        if (this.stopped || this.endpoint?.url !== url) return;
        this.retry = setTimeout(() => {
          this.retry = undefined;
          this.listen();
        }, RECONNECT_MS);
        this.retry.unref();
      });
  }

  private close(): void {
    this.stream?.abort();
    this.stream = undefined;
    clearTimeout(this.retry);
    this.retry = undefined;
    this.catalogs.clear();
    this.forms.clear();
  }

  stop(): void {
    this.stopped = true;
    this.close();
    clearTimeout(this.notify);
  }
}
