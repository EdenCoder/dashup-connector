import { randomUUID } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { join, dirname, basename } from 'node:path';
import { statSync, existsSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';

import type { QueueReceipt } from '@dashup/protocol';

import { version as DASHUP_VERSION } from '../../package.json';
import type { HistorySession } from './session';
import { nativeProcesses } from './processes';

// =============================================================================
// A queue writer is not a second conversation owner
// =============================================================================

const QUEUE_VERSIONS = new Set(['0.153.4', '0.160.1', '0.164.0', '0.165.0']);
const REQUEST_MS    = 10_000;
const MAX_BYTES     = 1024 * 1024;
const MAX_FILES     = 4_096;
const THREAD_ID     = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

type FileIdentity = { path: string; device: number; inode: number };
export type CodexOwner = {
  pid        : number;
  start      : string;
  executable : string;
  home       : string;
  cwd        : string;
  thread     : string;
  rollout    : FileIdentity;
};
export type QueueOwner = CodexOwner & { version: string; queue: FileIdentity };
type Owner = { writer: CodexOwner; queue?: QueueOwner };

export type QueueRequest = {
  pairing : string;
  project : string;
  thread  : string;
  owner   : QueueOwner;
  receipt : QueueReceipt;
};

type NativeReceipt = { queueId?: string; turnId?: string; responseId?: string };

function identity(path: string): FileIdentity {
  const canonical = realpathSync.native(path);
  const file = statSync(canonical);
  if (!file.isFile() || (process.getuid && file.uid !== process.getuid()))
    throw new Error('Native queue files are not owned by this user');
  return { path: canonical, device: file.dev, inode: file.ino };
}

function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.path === right.path && left.device === right.device && left.inode === right.inode;
}

const versions = new Map<string, { identity: string; version?: string }>();

// Desktop bundles and npm platform packages have different manifests. The running binary owns
// its version; replacing that binary invalidates the cached answer.
export function codexVersion(executable: string): string | undefined {
  const file = statSync(executable);
  const identity = `${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}`;
  const known = versions.get(executable);
  if (known?.identity === identity) return known.version;
  let version: string | undefined;
  try {
    const output = execFileSync(executable, ['--version'], {
      timeout: 3_000,
      maxBuffer: 4_096,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    version = /^codex-cli (\d+\.\d+\.\d+)\s*$/.exec(output)?.[1];
  } catch {
    // Observation remains available when a runtime cannot report its queue protocol version.
  }
  if (version) versions.set(executable, { identity, version });
  return version;
}

function processOwners(pid: number): Owner[] {
  const root = `/proc/${pid}`;
  if (process.getuid && statSync(root).uid !== process.getuid()) return [];
  const executable = realpathSync.native(join(root, 'exe'));
  if (basename(executable) !== 'codex') return [];
  const status = readFileSync(join(root, 'stat'), 'utf8');
  const start = status.slice(status.lastIndexOf(')') + 2).split(' ')[19];
  if (!start || !/^\d+$/.test(start)) return [];
  const fds = readdirSync(join(root, 'fd')).slice(0, MAX_FILES);
  const files = fds.flatMap((fd) => {
    try {
      return [{ fd, path: readlinkSync(join(root, 'fd', fd)) }];
    } catch {
      return [];
    }
  });
  return files.flatMap(({ fd, path }) => {
    if (basename(dirname(path)) !== 'thread-writer-locks' || !path.endsWith('.lock')) return [];
    const thread = basename(path, '.lock');
    if (!THREAD_ID.test(thread)) return [];
    try {
      const lock = readFileSync(join(root, 'fdinfo', fd), 'utf8');
      if (!/FLOCK\s+ADVISORY\s+WRITE/.test(lock)) return [];
      const home = realpathSync.native(dirname(dirname(path)));
      const directory = statSync(home);
      if (process.getuid && directory.uid !== process.getuid()) return [];
      const rollout = files.find(
        (file) =>
          file.path.startsWith(join(home, 'sessions') + '/') &&
          file.path.endsWith(`-${thread}.jsonl`),
      );
      if (!rollout) return [];
      const writer: CodexOwner = {
        pid,
        start,
        executable,
        home,
        thread,
        cwd     : realpathSync.native(join(root, 'cwd')),
        rollout : identity(rollout.path),
      };
      const owner: Owner = { writer };
      try {
        const version = codexVersion(executable);
        if (!version || !QUEUE_VERSIONS.has(version)) return [owner];
        const queue = identity(join(home, 'queue_1.sqlite'));
        if (
          files.some((file) => {
            try {
              return sameFile(identity(join(root, 'fd', file.fd)), queue);
            } catch {
              return false;
            }
          })
        )
          owner.queue = { ...writer, version, queue };
      } catch {
        // A live writer does not require a supported native queue.
      }
      return [owner];
    } catch {
      return [];
    }
  });
}

function owners(): Owner[] {
  if (process.platform !== 'linux' || process.env.DASHUP_LIVE_DISCOVERY === '0') return [];
  try {
    return nativeProcesses('codex').flatMap((pid) => {
      try {
        return processOwners(pid);
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function sameOwner(left: QueueOwner, right: QueueOwner): boolean {
  return (
    left.pid === right.pid &&
    left.start === right.start &&
    left.home === right.home &&
    left.thread === right.thread &&
    left.executable === right.executable &&
    left.version === right.version &&
    left.cwd === right.cwd &&
    sameFile(left.queue, right.queue) &&
    sameFile(left.rollout, right.rollout)
  );
}

export function writerOwner<T extends CodexOwner>(
  owners: T[],
  history?: HistorySession,
): T | undefined {
  if (history?.harness !== 'codex') return undefined;
  const matches = owners.filter(
    (owner) =>
      owner.thread === history.id &&
      history.files.some((path) => {
        try {
          return sameFile(identity(path), owner.rollout);
        } catch {
          return false;
        }
      }),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export const queueOwner = (
  owners: QueueOwner[],
  history?: HistorySession,
): QueueOwner | undefined => writerOwner(owners, history);

function validateOwner(owner: QueueOwner): void {
  if (
    process.platform !== 'linux' ||
    !processOwners(owner.pid).some((current) => current.queue && sameOwner(owner, current.queue))
  )
    throw new Error('The original native conversation owner is no longer available');
}

function validateEvidence(owner: QueueOwner): void {
  if (
    realpathSync.native(owner.home) !== owner.home ||
    (process.getuid && statSync(owner.home).uid !== process.getuid()) ||
    !sameFile(identity(owner.queue.path), owner.queue) ||
    !sameFile(identity(owner.rollout.path), owner.rollout)
  )
    throw new Error('The original native history storage changed');
  const path = join(owner.home, 'thread_history_1.sqlite');
  if (existsSync(path) && identity(path).path !== path)
    throw new Error('Native history is outside the original home');
}

// =============================================================================
// Native metadata proves identity; queue disappearance and message text do not
// =============================================================================

export function nativeReceipt(owner: QueueOwner, clientId: string): NativeReceipt {
  const queue = new DatabaseSync(owner.queue.path, { readOnly: true });
  let queueId: string | undefined;
  try {
    const rows = queue
      .prepare(
        `SELECT id FROM queued_items WHERE thread_id = ?
      AND json_extract(payload_json, '$.UserInput.client_id') = ? LIMIT 2`,
      )
      .all(owner.thread, clientId);
    if (rows.length > 1) throw new Error('Native input identity is ambiguous');
    if (typeof rows[0]?.id === 'string') queueId = rows[0].id;
  } finally {
    queue.close();
  }
  const path = join(owner.home, 'thread_history_1.sqlite');
  if (!existsSync(path)) return { queueId };
  const history = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = history
      .prepare(
        `SELECT turn_id, rollout_ordinal FROM thread_items
      WHERE thread_id = ? AND item_type = 'userMessage' AND json_extract(item_json, '$.type') = 'userMessage'
      AND json_extract(item_json, '$.clientId') = ? LIMIT 2`,
      )
      .all(owner.thread, clientId);
    if (rows.length > 1) throw new Error('Native input identity is ambiguous');
    const input = rows[0];
    if (!input || typeof input.turn_id !== 'string' || typeof input.rollout_ordinal !== 'number')
      return { queueId };
    const response = history
      .prepare(
        `SELECT item_id FROM thread_items WHERE thread_id = ?
      AND turn_id = ? AND item_type = 'agentMessage' AND json_extract(item_json, '$.type') = 'agentMessage'
      AND rollout_ordinal > ?
      ORDER BY rollout_ordinal ASC LIMIT 1`,
      )
      .get(owner.thread, input.turn_id, input.rollout_ordinal);
    return {
      queueId,
      turnId: input.turn_id,
      ...(typeof response?.item_id === 'string' ? { responseId: response.item_id } : {}),
    };
  } finally {
    history.close();
  }
}

export function reconcileReceipt(current: QueueReceipt, native: NativeReceipt): QueueReceipt {
  const queueId = current.queueId ?? native.queueId;
  if (current.queueId && native.queueId && current.queueId !== native.queueId)
    throw new Error('Native queue identity changed');
  if (current.state === 'responded') return { ...current, queueId };
  if ('turnId' in current && current.turnId && native.turnId && current.turnId !== native.turnId)
    throw new Error('Native turn identity changed');
  const clientUserMessageId = current.clientUserMessageId;
  if (clientUserMessageId && native.turnId)
    return native.responseId
      ? {
          state: 'responded',
          queueId,
          clientUserMessageId,
          turnId: native.turnId,
          responseId: native.responseId,
        }
      : { state: 'delivered', queueId, clientUserMessageId, turnId: native.turnId };
  if (current.state === 'accepted') return current;
  if (current.state === 'delivered') return { ...current, queueId };
  return queueId ? { state: 'accepted', queueId, clientUserMessageId } : current;
}

// =============================================================================
// Each encrypted request may dispatch queue/add once, even if its ACK is lost
// =============================================================================

class Writer {
  private readonly process;
  private closed = false;
  private sequence = 0;
  private bytes = 0;
  private tail = '';
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(owner: QueueOwner) {
    this.process = spawn(owner.executable, ['app-server', '--listen', 'stdio://'], {
      cwd: owner.cwd,
      env: { ...process.env, CODEX_HOME: owner.home },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    this.process.on('error', () => this.close());
    this.process.once('exit', () => this.close());
    this.process.stdin.on('error', () => this.close());
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', (chunk: string) => {
      this.bytes += Buffer.byteLength(chunk);
      if (this.bytes > MAX_BYTES) return this.close();
      this.tail += chunk;
      while (this.tail.includes('\n')) {
        const end = this.tail.indexOf('\n');
        const line = this.tail.slice(0, end);
        this.tail = this.tail.slice(end + 1);
        try {
          const value = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
          if (typeof value.id !== 'number') continue;
          const pending = this.pending.get(value.id);
          if (!pending) continue;
          this.pending.delete(value.id);
          clearTimeout(pending.timer);
          if (value.error) pending.reject(new Error('Native queue request was rejected'));
          else pending.resolve(value.result);
        } catch {
          this.close();
        }
      }
    });
  }

  request(method: 'initialize' | 'thread/queue/add', params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Native queue writer is closed'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Native queue acknowledgement was not received'));
        this.close();
      }, REQUEST_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  initialized(): void {
    if (this.closed) throw new Error('Native queue writer is closed');
    this.process.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Native queue acknowledgement was not received'));
    }
    this.pending.clear();
    this.process.kill();
  }
}

export class NativeQueue {
  writers: CodexOwner[] = [];
  owners: QueueOwner[] = [];
  private stopped = false;
  private readonly helpers = new Set<Writer>();

  constructor(
    readonly requests: Record<string, QueueRequest>,
    private readonly persist: () => void,
    private readonly permitted: (request: QueueRequest) => boolean,
  ) {}

  refresh(): void {
    const found = this.stopped ? [] : owners();
    this.writers = found.map((owner) => owner.writer);
    this.owners = found.flatMap((owner) => (owner.queue ? [owner.queue] : []));
  }

  private recorded(
    requestId: string,
    scope: Omit<QueueRequest, 'receipt'>,
  ): QueueReceipt | undefined {
    const existing = this.requests[requestId];
    if (!existing) return;
    if (
      existing.pairing !== scope.pairing ||
      existing.project !== scope.project ||
      existing.thread !== scope.thread ||
      !sameOwner(existing.owner, scope.owner)
    )
      throw new Error('Native queue request identity changed');
    return this.reconcile(requestId);
  }

  async submit(
    requestId: string,
    scope: Omit<QueueRequest, 'receipt'>,
    text: string,
  ): Promise<QueueReceipt> {
    const existing = this.recorded(requestId, scope);
    if (existing) return existing;
    if (this.stopped) throw new Error('The connector is stopping');
    validateOwner(scope.owner);
    const clientUserMessageId = randomUUID();
    const request: QueueRequest = { ...scope, receipt: { state: 'unknown', clientUserMessageId } };
    let writer: Writer | undefined;
    try {
      writer = new Writer(scope.owner);
      this.helpers.add(writer);
      await writer.request('initialize', {
        clientInfo: { name: 'dashup', version: DASHUP_VERSION },
        capabilities: { experimentalApi: true },
      });
      writer.initialized();
      if (this.stopped || !this.permitted(request)) throw new Error('Pairing is no longer active');
      validateOwner(scope.owner);
      const recorded = this.recorded(requestId, scope);
      if (recorded) return recorded;
      this.requests[requestId] = request;
      try {
        this.persist();
      } catch {
        delete this.requests[requestId];
        throw new Error('Could not durably record this request. No native reply was submitted.');
      }
      try {
        const value = (await writer.request('thread/queue/add', {
          threadId: scope.owner.thread,
          clientUserMessageId,
          input: [{ type: 'text', text, text_elements: [] }],
        })) as { queuedSubmission?: { id?: unknown; clientUserMessageId?: unknown } };
        const queued = value?.queuedSubmission;
        if (
          typeof queued?.id !== 'string' ||
          !queued.id ||
          queued.id.length > 128 ||
          queued.clientUserMessageId !== clientUserMessageId
        )
          throw new Error('Native queue acknowledgement could not be correlated');
        request.receipt = { state: 'accepted', queueId: queued.id, clientUserMessageId };
        this.persist();
      } catch {
        // After durable intent, an interrupted dispatch or ACK cannot safely resubmit.
      }
    } finally {
      if (writer) {
        this.helpers.delete(writer);
        writer.close();
      }
    }
    return this.reconcile(requestId);
  }

  reconcile(requestId: string): QueueReceipt {
    const request = this.requests[requestId];
    if (!request) throw new Error('Native queue request was not recorded');
    if (!request.receipt.clientUserMessageId) return request.receipt;
    try {
      validateEvidence(request.owner);
      const receipt = reconcileReceipt(
        request.receipt,
        nativeReceipt(request.owner, request.receipt.clientUserMessageId),
      );
      if (JSON.stringify(receipt) !== JSON.stringify(request.receipt)) {
        request.receipt = receipt;
        this.persist();
      }
    } catch {
      // Changed storage or delayed native projection never downgrades known evidence.
    }
    return request.receipt;
  }

  stop(): void {
    this.stopped = true;
    this.owners = [];
    this.writers = [];
    for (const writer of this.helpers) writer.close();
    this.helpers.clear();
  }
}
