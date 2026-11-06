import { userInfo } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { closeSync, openSync, renameSync, writeFileSync, readFileSync, readdirSync, mkdirSync, lstatSync, unlinkSync } from 'node:fs';
import type { IPty } from 'node-pty';
import type { Terminal } from '@xterm/headless';
import type { SerializeAddon } from '@xterm/addon-serialize';
import type { SessionContent } from '@dashup/protocol/session';
import { TERMINAL_COLS, TERMINAL_ROWS, TERMINAL_INPUT_CHARS } from '@dashup/protocol/terminal';

import { configPath } from './config';
import type { LiveSession } from './harness/session';

// =============================================================================
// Terminal instances: native shells and private lifecycle metadata
// =============================================================================

const require          = createRequire(import.meta.url);
const OUTPUT_MS        = 16;
const OUTPUT_CHARS     = 8 * 1024;
const MAX_TERMINALS    = 8;
const MAX_HISTORY      = 100;
const MAX_RECORD_BYTES = 512 * 1024;
const SCROLLBACK       = 100;
const OUTPUT_PENDING   = 256 * 1024;
const RECORD_NAME      = /^[a-f0-9-]{36}\.json$/;
// Persisted records never say a shell survived a connector restart.
type Record = {
  id        : string;
  pairing   : string;
  project   : string;
  cwd       : string;
  title     : string;
  updatedAt : string;
  exitCode? : number;
};

type Session = Record & {
  process?   : IPty;
  screen?    : Terminal;
  serialize? : SerializeAddon;
  running    : boolean;
  timer?     : ReturnType<typeof setTimeout>;
  pending    : number;
  output     : string;
};

export class Terminals {
  private readonly records = new Map<string, Session>();
  private readonly follows = new Map<string, { id: string; ready: boolean }>();
  private stopped = false;

  constructor(
    private readonly active: (pairing: string) => boolean,
    private readonly changed: (id?: string) => void,
    private readonly report: (error: unknown) => void,
    private readonly directory = join(dirname(configPath()), 'terminals'),
    private readonly publish?: (pairing: string, project: string, content: SessionContent) => void,
  ) {
    this.load();
  }

  list(): LiveSession[] {
    return [...this.records.keys()].flatMap((id) => this.session(id) ?? []);
  }

  session(id: string): LiveSession | undefined {
    const session = this.records.get(id);
    if (!session) return;
    return {
      id: session.id,
      harness: 'terminal',
      cwd: session.cwd,
      title: session.title,
      updatedAt: session.updatedAt,
      status: session.running ? 'working' : 'idle',
      messages: [],
      approvals: [],
      ...(session.running
        ? {
            send: async (_request: string, text: string) =>
              this.send(session.pairing, session.project, session.id, text),
            stop: async () => this.interrupt(session.pairing, session.project, session.id),
          }
        : {}),
    };
  }

  owns(id: string, pairing: string): boolean {
    return this.records.get(id)?.pairing === pairing;
  }

  async open(
    pairing: string,
    project: string,
    cwd: string,
    cols: number,
    rows: number,
  ): Promise<string> {
    if (this.stopped) throw new Error('The connector has stopped.');
    this.size(cols, rows);
    if (!this.active(pairing)) throw new Error('Pair this phone before starting a terminal.');
    if ([...this.records.values()].filter((item) => item.running).length >= MAX_TERMINALS)
      throw new Error('Close another terminal first.');
    const { spawn } = require('node-pty') as typeof import('node-pty');
    const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless');
    const { SerializeAddon } =
      require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize');
    const shell =
      process.platform === 'win32'
        ? process.env.COMSPEC || 'cmd.exe'
        : userInfo().shell || '/bin/sh';
    const screen = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const serialize = new SerializeAddon();
    // The serializer supports headless xterm; its declaration names the browser's wider API.
    screen.loadAddon(serialize as unknown as Parameters<Terminal['loadAddon']>[0]);
    let processPty: IPty;
    try {
      processPty = spawn(shell, [], { cwd, cols, rows, name: 'xterm-256color', env: process.env });
    } catch (error) {
      screen.dispose();
      throw error;
    }
    const session: Session = {
      id: randomUUID(),
      pairing,
      project,
      cwd,
      process: processPty,
      screen,
      serialize,
      title: 'Terminal',
      updatedAt: new Date().toISOString(),
      running: true,
      pending: 0,
      output: '',
    };
    this.records.set(session.id, session);
    screen.onData((data) => {
      if (session.running && !this.following(pairing, session.id)) processPty.write(data);
    });
    processPty.onData((data) => {
      if (this.stopped || !session.screen) return;
      session.pending += data.length;
      if (session.pending > OUTPUT_PENDING) processPty.pause();
      screen.write(data, () => {
        if (this.stopped || !session.screen) return;
        session.pending -= data.length;
        if (session.running && session.pending < OUTPUT_PENDING / 2) processPty.resume();
      });
      if (this.following(pairing, session.id)) {
        session.output += data;
        if (session.output.length >= OUTPUT_CHARS) this.flushOutput(session);
        else if (!session.timer) {
          session.timer = setTimeout(() => this.flushOutput(session), OUTPUT_MS);
          session.timer.unref();
        }
      }
    });
    processPty.onExit(({ exitCode }) => {
      if (this.stopped || !this.records.has(session.id) || !session.running) return;
      session.exitCode = exitCode;
      this.dispose(session);
    });
    this.save(session);
    this.prune();
    return session.id;
  }

  private size(cols: number, rows: number): void {
    if (
      !Number.isInteger(cols) ||
      !Number.isInteger(rows) ||
      cols < 20 ||
      cols > 160 ||
      rows < 10 ||
      rows > 60
    )
      throw new Error('Choose a terminal size between 20×10 and 160×60.');
  }

  private get(pairing: string, project: string, id: string): Session {
    const session = this.records.get(id);
    if (
      !session ||
      session.pairing !== pairing ||
      session.project !== project ||
      !this.active(pairing)
    )
      throw new Error('This terminal is no longer available. Start a new terminal.');
    return session;
  }

  send(pairing: string, project: string, id: string, text: string): void {
    const session = this.get(pairing, project, id);
    if (!session.running || !session.process)
      throw new Error('This shell has exited. Start a new terminal.');
    if (!text.trim() || text.length > TERMINAL_INPUT_CHARS)
      throw new Error(`Enter a terminal command of at most ${TERMINAL_INPUT_CHARS} characters.`);
    session.process.write(text.replace(/\r\n?/g, '\n').replace(/\n/g, '\r') + '\r');
  }

  input(pairing: string, project: string, id: string, data: string, binary = false): void {
    const session = this.get(pairing, project, id);
    if (!session.running || !session.process)
      throw new Error('This shell has exited. Start a new terminal.');
    if (!data || data.length > TERMINAL_INPUT_CHARS)
      throw new Error('Terminal input is too large.');
    session.process.write(binary ? Buffer.from(data, 'binary') : data);
  }

  interrupt(pairing: string, project: string, id: string): void {
    this.input(pairing, project, id, '\x03');
  }

  resize(pairing: string, project: string, id: string, cols: number, rows: number): void {
    this.size(cols, rows);
    const session = this.get(pairing, project, id);
    if (!session.running || !session.screen || !session.process) return;
    session.screen.resize(cols, rows);
    session.process.resize(cols, rows);
  }

  async follow(pairing: string, project: string, id: string): Promise<void> {
    const session = this.get(pairing, project, id);
    if (this.following(pairing, id)) return;
    const follow = { id, ready: false };
    this.follows.set(pairing, follow);
    if (session.screen) await new Promise<void>((resolve) => session.screen!.write('', resolve));
    if (this.stopped || this.follows.get(pairing) !== follow || !this.active(pairing)) return;
    follow.ready = true;
    session.output = '';
    this.output(session, session.serialize?.serialize({ scrollback: SCROLLBACK }) ?? '', true);
    if (!session.running)
      this.emit(session, { type: 'exit', terminalId: id, exitCode: session.exitCode });
  }

  project(pairing: string, id: string): string | undefined {
    const session = this.records.get(id);
    return session?.pairing === pairing ? session.project : undefined;
  }

  disconnect(pairing?: string): void {
    if (pairing) this.follows.delete(pairing);
    else this.follows.clear();
  }

  unfollow(pairing: string, project: string, id: string): void {
    this.get(pairing, project, id);
    if (this.follows.get(pairing)?.id === id) this.follows.delete(pairing);
  }

  following(pairing: string, id: string): boolean {
    const follow = this.follows.get(pairing);
    return follow?.id === id && follow.ready && this.active(pairing);
  }

  async close(pairing: string, project: string, id: string): Promise<void> {
    this.dispose(this.get(pairing, project, id));
  }

  private emit(session: Session, content: SessionContent): void {
    if (this.stopped || !this.following(session.pairing, session.id)) return;
    try {
      this.publish?.(session.pairing, session.project, content);
    } catch (error) {
      this.follows.delete(session.pairing);
      this.report(error);
    }
  }

  private output(session: Session, data: string, reset = false): void {
    // Each encrypted packet stays under the socket limit, including JSON escapes and UTF-8.
    // Keep a surrogate pair together when a chunk ends in the middle of a Unicode character.
    let first = true;
    do {
      let end = Math.min(data.length, OUTPUT_CHARS);
      if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end--;
      this.emit(session, {
        type: 'output',
        terminalId: session.id,
        data: data.slice(0, end),
        ...(reset && first
          ? {
              reset: true,
              cols: session.screen?.cols ?? TERMINAL_COLS,
              rows: session.screen?.rows ?? TERMINAL_ROWS,
            }
          : {}),
      });
      first = false;
      data = data.slice(end);
    } while (data);
  }

  private flushOutput(session: Session): void {
    clearTimeout(session.timer);
    session.timer = undefined;
    const data = session.output;
    session.output = '';
    if (data) this.output(session, data);
  }

  private save(session: Session): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const directory = lstatSync(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink())
      throw new Error('Terminal instance folder is not a private directory.');
    if (process.platform !== 'win32' && (directory.mode & 0o077) !== 0)
      throw new Error(
        'Terminal instance folder must only be accessible to your operating-system user.',
      );
    const { id, pairing, project, cwd, title, updatedAt, exitCode } = session;
    const data: Record = {
      id,
      pairing,
      project,
      cwd,
      title,
      updatedAt,
      ...(exitCode === undefined ? {} : { exitCode }),
    };
    const temporary = join(this.directory, `${id}.${randomUUID()}.tmp`);
    const file = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(file, JSON.stringify(data));
    } finally {
      closeSync(file);
    }
    renameSync(temporary, join(this.directory, `${id}.json`));
  }

  private load(): void {
    let names: string[];
    try {
      const directory = lstatSync(this.directory);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        (process.platform !== 'win32' && (directory.mode & 0o077) !== 0)
      )
        throw new Error('Terminal instance folder must be a private directory.');
      names = readdirSync(this.directory).filter((name) => RECORD_NAME.test(name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.report(error);
      return;
    }
    const newest = names
      .map((name) => ({ name, stat: lstatSync(join(this.directory, name)) }))
      .filter(
        ({ stat }) => stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_RECORD_BYTES,
      )
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, MAX_HISTORY);
    for (const { name, stat } of newest) {
      try {
        const path = join(this.directory, name);
        if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) continue;
        const item: Record = JSON.parse(readFileSync(path, 'utf8'));
        if (
          `${item.id}.json` !== name ||
          typeof item.pairing !== 'string' ||
          !item.pairing ||
          typeof item.project !== 'string' ||
          !item.project ||
          typeof item.cwd !== 'string' ||
          !item.cwd ||
          typeof item.title !== 'string' ||
          typeof item.updatedAt !== 'string'
        )
          continue;
        const { id, pairing, project, cwd, title, updatedAt, exitCode } = item;
        const session: Session = {
          id,
          pairing,
          project,
          cwd,
          title,
          updatedAt,
          exitCode,
          running: false,
          pending: 0,
          output: '',
        };
        this.records.set(id, session);
        if ('messages' in item) this.save(session);
      } catch (error) {
        this.report(error);
      }
    }
  }

  private dispose(session: Session): void {
    if (!session.running && !session.process && !session.screen) return;
    this.flushOutput(session);
    session.running = false;
    session.updatedAt = new Date().toISOString();
    this.save(session);
    if (!this.stopped) {
      this.changed(session.id);
      this.emit(session, { type: 'exit', terminalId: session.id, exitCode: session.exitCode });
    }
    try {
      session.process?.kill();
    } catch {
      /* Already exited. */
    }
    session.process = undefined;
    session.screen?.dispose();
    session.screen = undefined;
    session.serialize = undefined;
  }

  private prune(): void {
    const closed = [...this.records.values()]
      .filter((item) => !item.running)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const session of closed.slice(MAX_HISTORY)) this.remove(session);
  }

  private remove(session: Session): void {
    this.dispose(session);
    this.records.delete(session.id);
    if (!this.stopped) this.changed();
    try {
      unlinkSync(join(this.directory, `${session.id}.json`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.report(error);
    }
  }

  revoke(pairing: string): void {
    this.follows.delete(pairing);
    for (const session of this.records.values())
      if (session.pairing === pairing) this.remove(session);
  }

  stop(): void {
    this.stopped = true;
    this.follows.clear();
    for (const session of this.records.values()) this.dispose(session);
  }
}
