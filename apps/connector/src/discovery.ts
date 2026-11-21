import { homedir } from 'node:os';
import { createHmac } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { zstdDecompressSync } from 'node:zlib';
import { watch, existsSync, readdirSync, readFileSync, type FSWatcher } from 'node:fs';

import type { Harness, Message, Remote, ProjectSummary, ThreadSummary, Capabilities } from '@dashup/protocol';

import type { AcpSession } from './acp';
import { scanHistories } from './harness/history';
import { agentHarness, type Page, type LiveSession, type HistorySession } from './harness/session';

interface Location {
  editor   : 'zed' | 'vscode' | 'cli' | 'acp';
  path     : string;
  session? : string;
  history? : HistorySession;
  live?    : LiveSession;
  acp?     : AcpSession;
}

// What a thread's own records cannot say, asked of whoever knows: whether a native queue owner
// takes the saved session's queued replies, whether a native process writes it, and whether its
// agent starts here.
export type Owners = {
  queue(history: HistorySession)  : boolean;
  writer(history: HistorySession) : boolean;
  starts(harness: Harness)        : boolean;
};

const UNOWNED: Owners = { queue: () => false, writer: () => false, starts: () => false };

// boundary: editor-owned persisted JSON changes independently of Dashup.
type NativeRecord = Record<string, any>;

const READ_ONLY: Capabilities = {
  read    : true,
  send    : false,
  queue   : false,
  stop    : false,
  approve : false,
};

// A scan names thousands of threads and projects, and each keeps its ID.
const opaqueIds = new Map<string, string>();
const opaqueId = (value: string, secret: string): string => {
  const key = `${secret}\0${value}`;
  const known = opaqueIds.get(key);
  if (known) return known;
  const id = createHmac('sha256', secret).update(value).digest('hex').slice(0, 32);
  opaqueIds.set(key, id);
  return id;
};

// A native agent session has one thread id, whichever store names it.
const agentThread = (harness: Harness, session: string, secret: string): string =>
  opaqueId(`agent\0${harness}\0${session}`, secret);

// Zed writes an SSH host as a string or a tagged variant such as `{ "IpAddr": "10.0.0.7" }`.
const zedHost = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : value && typeof value === 'object'
      ? String(Object.values(value)[0] ?? '')
      : '';

// Remote-SSH names a host directly, or as hex-encoded JSON settings carrying `hostName`.
function vscodeHost(authority: string): string {
  const host = decodeURIComponent(authority).replace(/^ssh-remote\+/, '');
  if (!/^(?:[0-9a-f]{2})+$/i.test(host)) return host;
  try {
    const settings = JSON.parse(Buffer.from(host, 'hex').toString('utf8')) as NativeRecord;
    return typeof settings.hostName === 'string' ? settings.hostName : host;
  } catch {
    return host;
  }
}

// Zed's data folder, where its agent registry installs agents too.
export const zedData = (): string => process.env.DASHUP_ZED_DATA ?? dataPaths().zed;

function dataPaths(): { zed: string; code: string } {
  const home = homedir();
  if (process.platform === 'darwin')
    return {
      zed: join(home, 'Library/Application Support/Zed'),
      code: join(home, 'Library/Application Support/Code/User'),
    };
  if (process.platform === 'win32')
    return {
      zed: join(process.env.LOCALAPPDATA ?? join(home, 'AppData/Local'), 'Zed'),
      code: join(process.env.APPDATA ?? join(home, 'AppData/Roaming'), 'Code/User'),
    };
  return {
    zed: join(process.env.XDG_DATA_HOME ?? join(home, '.local/share'), 'zed'),
    code: join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Code/User'),
  };
}

function sqlite(path: string, sql: string): NativeRecord[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
}

export function replaySession(value: string): NativeRecord {
  let state: NativeRecord = {};
  const lines = value.split('\n');
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let entry: NativeRecord;
    try {
      entry = JSON.parse(line) as NativeRecord;
    } catch (error) {
      if (index === lines.length - 1 && !value.endsWith('\n')) break;
      throw error;
    }
    if (entry.kind === 0) {
      state = entry.v;
      continue;
    }
    let target = state;
    const keys = entry.k as (string | number)[];
    for (const key of keys.slice(0, -1)) {
      if (['__proto__', 'constructor', 'prototype'].includes(String(key)))
        throw new Error('Invalid editor session path');
      target = target[key];
    }
    const key = keys.at(-1)!;
    if (['__proto__', 'constructor', 'prototype'].includes(String(key)))
      throw new Error('Invalid editor session path');
    if (entry.kind === 1) target[key] = entry.v;
    else if (entry.kind === 3) delete target[key];
    else if (entry.kind === 2) {
      const array = target[key] as unknown[];
      if (entry.i !== undefined) array.length = entry.i;
      array.push(...(entry.v ?? []));
    }
  }
  return state;
}

// VS Code saves a chat session as JSON, or as a `.jsonl` journal of edits to replay.
function chatSession(path: string): NativeRecord {
  const text = readFileSync(path, 'utf8');
  return path.endsWith('.jsonl') ? replaySession(text) : (JSON.parse(text) as NativeRecord);
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(contentText).filter(Boolean).join('\n');
  if (!content || typeof content !== 'object') return '';
  const part = content as NativeRecord;
  return typeof part.text === 'string'
    ? part.text
    : typeof part.Text === 'string'
      ? part.Text
      : typeof part.value === 'string'
        ? part.value
        : contentText(part.content);
}

export class Discovery {
  readonly projects = new Map<string, ProjectSummary>();
  readonly locations = new Map<string, Location>();
  // Each native agent session's thread, so finding it costs the same however many sessions a scan
  // sees. The first project to list a thread keeps it.
  private readonly agents = new Map<string, { project: ProjectSummary; thread: ThreadSummary }>();
  readonly paths = new Set<string>();
  readonly warnings: string[] = [];

  constructor(
    readonly deviceId: string,
    readonly secret: string,
    private readonly owners = UNOWNED,
  ) {}

  scan(): ProjectSummary[] {
    this.projects.clear();
    this.locations.clear();
    this.agents.clear();
    this.paths.clear();
    this.warnings.length = 0;
    const defaults = dataPaths();
    this.zed(zedData());
    this.vscode(process.env.DASHUP_VSCODE_DATA ?? defaults.code);
    const history = scanHistories();
    for (const path of history.paths) this.paths.add(path);
    this.warnings.push(...history.warnings);
    for (const session of history.sessions) this.history(session);
    // An editor workspace without a conversation has nothing to show on the phone.
    for (const [id, project] of this.projects)
      if (!project.threads.length) this.projects.delete(id);
    return [...this.projects.values()];
  }

  private native(session: Pick<LiveSession, 'id' | 'harness' | 'cwd' | 'title' | 'updatedAt'>): {
    project: ProjectSummary;
    thread: ThreadSummary;
  } {
    const known = this.agents.get(`${session.harness}\0${session.id}`);
    if (known) return known;
    const project = this.project(session.cwd);
    const thread: ThreadSummary = {
      id: agentThread(session.harness, session.id, this.secret),
      title: session.title ?? '',
      editor: 'cli',
      status: 'unknown',
      updatedAt: session.updatedAt,
      capabilities: { ...READ_ONLY },
      agent: { harness: session.harness, sessionId: session.id },
    };
    project.threads.push(thread);
    this.locations.set(thread.id, { editor: 'cli', path: '' });
    this.agents.set(`${session.harness}\0${session.id}`, { project, thread });
    return { project, thread };
  }

  // The native history owns the conversation's last message time, whichever editor lists it.
  private history(session: HistorySession): void {
    const { thread } = this.native(session);
    this.locations.get(thread.id)!.history = session;
    thread.updatedAt = session.updatedAt;
    if (session.parent) thread.parent = agentThread(session.harness, session.parent, this.secret);
  }

  // Where new projects go: the folders holding this computer's projects, most used first.
  folders(): string[] {
    const counts = new Map<string, number>();
    for (const project of this.projects.values())
      if (!project.remote) {
        const parent = dirname(project.path);
        counts.set(parent, (counts.get(parent) ?? 0) + 1);
      }
    const folders = [...counts]
      .sort((a, b) => b[1] - a[1])
      .map(([folder]) => folder)
      .filter((folder) => existsSync(folder))
      .slice(0, 3);
    return folders.length ? folders : [homedir()];
  }

  observe(session: LiveSession): { project: ProjectSummary; thread: ThreadSummary } {
    const found = this.native(session);
    const location = this.locations.get(found.thread.id)!;
    location.live = session;
    Object.assign(found.thread, {
      editor: session.editor ?? found.thread.editor,
      title: session.title ?? found.thread.title,
      updatedAt: location.history?.updatedAt ?? session.updatedAt,
    });
    this.summarize(found.project, found.thread);
    return found;
  }

  // Live sessions no integration lists any more, of one harness or of all, let go of what they hold.
  retire(sessions: LiveSession[], harness?: Harness): void {
    const current = new Set(sessions.map((session) => `${session.harness}:${session.id}`));
    for (const [id, location] of this.locations) {
      const live = location.live;
      if (
        !live ||
        (harness && live.harness !== harness) ||
        current.has(`${live.harness}:${live.id}`)
      )
        continue;
      location.live = undefined;
      live.releaseMessages?.();
      for (const project of this.projects.values())
        for (const thread of project.threads) if (thread.id === id) this.summarize(project, thread);
    }
  }

  // An ACP session holds the editor thread it continues, or a thread of its own, until it closes.
  adopt(agent: AcpSession, open = true): { project: ProjectSummary; thread: ThreadSummary } {
    const found = this.acpThread(agent.id, agent.cwd);
    this.locations.get(found.thread.id)!.acp = open ? agent : undefined;
    found.thread.updatedAt = agent.updatedAt;
    this.summarize(found.project, found.thread);
    return found;
  }

  // Each thread no session holds shows what its saved records say, once they or their owners change.
  refresh(): void {
    for (const project of this.projects.values())
      for (const thread of project.threads) {
        const location = this.locations.get(thread.id);
        if (location && !location.live && !location.acp) this.summarize(project, thread);
      }
  }

  // A thread shows what holds it: an ACP or live session offers what either can do. Saved history
  // alone reads, takes queued replies while a native queue has an owner, and continues headless when
  // its agent starts here and no native process writes it; its lifecycle marker says what runs only
  // while one does. Only a working thread carries its step: a project's snapshot holds every thread.
  private summarize(project: ProjectSummary, thread: ThreadSummary): void {
    const { editor, history, live, acp } = this.locations.get(thread.id)!;
    const harness = thread.agent?.harness;
    const queue   = !!history && this.owners.queue(history);
    const writer  = !!history && this.owners.writer(history);
    let saved: ThreadSummary['status'] | undefined;
    if (history && writer && !live && !acp)
      try {
        saved = history.status?.();
      } catch {
        // A rollout can disappear between discovery and reading its lifecycle marker.
      }
    const resumes =
      !!history &&
      history.resumable !== false &&
      !live &&
      !project.remote &&
      !queue &&
      !writer &&
      !!harness &&
      this.owners.starts(harness);
    thread.status = acp?.status ?? live?.status ?? saved ?? 'unknown';
    thread.step = thread.status === 'working' ? history?.step : undefined;
    thread.options = acp?.options ?? live?.options?.(() => history?.settings?.() ?? {});
    thread.capabilities = {
      read    : editor !== 'cli' || !!history || !!live,
      send    : !!live?.send || !!acp || resumes,
      queue,
      stop    : !!live?.stop || !!acp,
      approve : !!live?.approve || !!acp,
      ...(live ? { now: !!live.now } : {}),
      ...(live || acp ? { configure: !!live?.configure || !!acp?.options.length } : {}),
    };
  }

  private acpThread(
    session: string,
    cwd: string,
  ): { project: ProjectSummary; thread: ThreadSummary } {
    for (const project of this.projects.values()) {
      const thread = project.threads.find(
        (item) => this.locations.get(item.id)?.session === session,
      );
      if (thread) return { project, thread };
    }
    const project =
      [...this.projects.values()].find((item) => !item.remote && item.path === cwd) ??
      this.project(cwd);
    const id = opaqueId(`acp\0${session}`, this.secret);
    const thread: ThreadSummary = {
      id,
      title: 'ACP conversation',
      editor: 'acp',
      status: 'idle',
      updatedAt: new Date().toISOString(),
      capabilities: READ_ONLY,
    };
    project.threads.push(thread);
    this.locations.set(id, { editor: 'acp', path: '', session });
    return { project, thread };
  }

  private project(path: string, remote?: Remote): ProjectSummary {
    const id = opaqueId(
      `${remote?.host ?? ''}\0${remote?.user ?? ''}\0${remote?.port ?? ''}\0${path}`,
      this.secret,
    );
    let project = this.projects.get(id);
    if (!project) {
      project = {
        id,
        name: basename(path.replace(/\\/g, '/')) || path,
        path,
        deviceId: this.deviceId,
        threads: [],
        ...(remote ? { remote } : {}),
      };
      this.projects.set(id, project);
    }
    return project;
  }

  private zed(root: string): void {
    const database = join(root, 'db');
    const store    = join(root, 'threads/threads.db');
    if (!existsSync(database)) return;
    this.paths.add(database);
    for (const entry of readdirSync(database)) {
      const path = join(database, entry, 'db.sqlite');
      if (!existsSync(path)) continue;
      this.paths.add(join(database, entry));
      try {
        if (
          !sqlite(
            path,
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sidebar_threads'",
          ).length
        )
          continue;
        // Zed restamps `updated_at` on many rows at once. `interacted_at` is the person's last
        // message, and Zed's own agent stamps each thread's content in its store.
        const stamps = new Map(
          existsSync(store)
            ? sqlite(store, 'SELECT id, updated_at FROM threads').map((row) => [
                row.id,
                row.updated_at,
              ])
            : [],
        );
        for (const row of sqlite(
          path,
          'SELECT * FROM sidebar_threads WHERE archived = 0 ORDER BY thread_id',
        )) {
          const connection = row.remote_connection
            ? (JSON.parse(row.remote_connection) as NativeRecord)
            : null;
          const ssh        = connection?.Ssh;
          const host       = zedHost(ssh?.host);
          const session    = String(row.session_id ?? Buffer.from(row.thread_id).toString('hex'));
          const harness    = agentHarness(String(row.agent_id ?? ''));
          // An agent in an SSH project runs and keeps its conversation there, where Dashup lists it.
          if (host && harness) continue;
          const updatedAt  = new Date(
            stamps.get(session) ?? row.interacted_at ?? row.updated_at,
          ).toISOString();
          const id         = harness
            ? agentThread(harness, session, this.secret)
            : opaqueId(`zed\0${session}`, this.secret);
          for (const folder of String(row.folder_paths ?? '')
            .split('\n')
            .filter(Boolean)) {
            const remote = host
              ? {
                  host,
                  path: folder,
                  ...(ssh.username ? { user: String(ssh.username) } : {}),
                  ...(ssh.port ? { port: Number(ssh.port) } : {}),
                }
              : undefined;
            const project = this.project(folder, remote);
            if (!project.threads.some((thread) => thread.id === id)) {
              const thread: ThreadSummary = {
                id,
                title: row.title_override || row.title,
                editor: 'zed',
                status: 'unknown',
                updatedAt,
                capabilities: READ_ONLY,
                ...(harness ? { agent: { harness, sessionId: session } } : {}),
              };
              project.threads.push(thread);
              if (harness && !this.agents.has(`${harness}\0${session}`))
                this.agents.set(`${harness}\0${session}`, { project, thread });
            }
            this.locations.set(id, { editor: 'zed', path: store, session });
          }
        }
      } catch (error) {
        this.warnings.push(`Zed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const threads = join(root, 'threads');
    if (existsSync(threads)) this.paths.add(threads);
  }

  private vscode(root: string): void {
    const workspaces = join(root, 'workspaceStorage');
    if (!existsSync(workspaces)) return;
    this.paths.add(workspaces);
    for (const entry of readdirSync(workspaces)) {
      const directory = join(workspaces, entry);
      const workspace = join(directory, 'workspace.json');
      const sessions  = join(directory, 'chatSessions');
      if (!existsSync(workspace)) continue;
      this.paths.add(directory);
      try {
        const data = JSON.parse(readFileSync(workspace, 'utf8')) as { folder?: string };
        if (!data.folder) continue;
        const uri     = new URL(data.folder);
        const path    = decodeURIComponent(uri.pathname).replace(/^\/([A-Za-z]:\/)/, '$1');
        const host    = uri.protocol === 'vscode-remote:' ? vscodeHost(uri.host) : '';
        const project = this.project(path, host ? { host, path } : undefined);
        if (!existsSync(sessions)) continue;
        this.paths.add(sessions);
        for (const filename of readdirSync(sessions).filter((name) => /\.jsonl?$/.test(name))) {
          const file  = join(sessions, filename);
          const state = chatSession(file);
          const id    = opaqueId(`vscode\0${entry}\0${state.sessionId ?? filename}`, this.secret);
          project.threads.push({
            id,
            title:
              state.customTitle || contentText(state.requests?.[0]?.message) || 'VS Code thread',
            editor: 'vscode',
            status: 'unknown',
            updatedAt: new Date(state.lastMessageDate ?? state.creationDate ?? 0).toISOString(),
            capabilities: READ_ONLY,
          });
          this.locations.set(id, { editor: 'vscode', path: file });
        }
      } catch (error) {
        this.warnings.push(`VS Code: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // A conversation's newest page, or its page up to `before`, from whichever store holds it.
  async read(thread: ThreadSummary, before?: string): Promise<Page> {
    const location = this.locations.get(thread.id);
    if (!location) throw new Error('Thread is no longer available');
    if (location.history) return { messages: location.history.read(before), more: false };
    if (location.live) return location.live.readMessages?.(before) ?? { messages: [], more: false };
    return { messages: location.acp?.messages ?? this.saved(location), more: false };
  }

  // A conversation only its editor's own files hold.
  private saved(location: Location): Message[] {
    if (location.editor === 'vscode') {
      const state = chatSession(location.path);
      return (state.requests ?? [])
        .flatMap((request: NativeRecord, index: number) => [
          { id: `${index}:user`, role: 'user' as const, text: contentText(request.message) },
          {
            id: `${index}:assistant`,
            role: 'assistant' as const,
            text: contentText(request.response),
          },
        ])
        .filter((message: Message) => message.text);
    }
    if (!existsSync(location.path))
      throw new Error(
        'This external agent keeps its conversation in its own storage. View the open thread on your computer.',
      );
    const db = new DatabaseSync(location.path, { readOnly: true });
    try {
      const row = db
        .prepare('SELECT data_type, data FROM threads WHERE id = ?')
        .get(location.session!) as { data_type: string; data: Uint8Array } | undefined;
      if (!row)
        throw new Error(
          'This agent history is not available on this computer. View the existing session in Zed.',
        );
      const data = row.data_type === 'zstd' ? zstdDecompressSync(row.data) : row.data;
      const state = JSON.parse(Buffer.from(data).toString('utf8')) as NativeRecord;
      return (state.messages ?? [])
        .map((message: NativeRecord, index: number) => {
          const user = message.User ?? message.user;
          const agent = message.Agent ?? message.agent;
          return {
            id: String(index),
            role: user ? 'user' : 'assistant',
            text: contentText((user ?? agent ?? message).content ?? message.segments),
          } as Message;
        })
        .filter((message: Message) => message.text);
    } finally {
      db.close();
    }
  }

  watch(onChange: () => void): () => void {
    const watchers: FSWatcher[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    for (const path of this.paths) {
      try {
        watchers.push(
          watch(path, () => {
            clearTimeout(timer);
            timer = setTimeout(onChange, 150);
          }),
        );
      } catch {
        // Native stores may rotate or disappear between discovery and watching.
      }
    }
    return () => {
      clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    };
  }
}
