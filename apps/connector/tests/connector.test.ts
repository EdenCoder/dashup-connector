import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { Duplex, PassThrough } from 'node:stream';
import { zstdCompressSync } from 'node:zlib';
import { rmSync, statSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';

import { open, seal, newSecret } from '@dashup/protocol/crypto';
import type { ThreadSummary, PairingRecord } from '@dashup/protocol';

import type { SessionContent as Content } from '@dashup/protocol/session';

import { Connector } from '../src/connector';
import { Discovery, replaySession } from '../src/discovery';
import { saveConfig, type ConnectorConfig } from '../src/config';
import { bridgeAcp, commandAcp, type AcpSession } from '../src/acp';
import type { LiveSession } from '../src/harness/session';
import type { CodexOwner, NativeQueue } from '../src/harness/queue';

test('saved native threads retain their SSH owner and actual persisted conversation without granting live control, and SSH agent threads stay with their host', () => {
  const root = mkdtempSync(join(tmpdir(), 'dashup-editors-'));
  const zed = join(root, 'zed');
  const code = join(root, 'code');
  const oldZed = process.env.DASHUP_ZED_DATA;
  const oldCode = process.env.DASHUP_VSCODE_DATA;
  const nativeHomes = [
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'DASHUP_KIMI_HOME',
    'XDG_DATA_HOME',
  ] as const;
  const previousHomes = nativeHomes.map((name) => process.env[name]);
  try {
    process.env.DASHUP_ZED_DATA = zed;
    process.env.DASHUP_VSCODE_DATA = code;
    for (const name of nativeHomes) process.env[name] = join(root, name);
    mkdirSync(join(zed, 'db/0-stable'), { recursive: true });
    mkdirSync(join(zed, 'threads'), { recursive: true });
    const db = new DatabaseSync(join(zed, 'db/0-stable/db.sqlite'));
    db.exec(
      'CREATE TABLE remote_connections (id INTEGER, host TEXT, user TEXT, port INTEGER); CREATE TABLE workspaces (paths TEXT, remote_connection_id INTEGER); CREATE TABLE sidebar_threads (thread_id BLOB, session_id TEXT, agent_id TEXT, title TEXT, title_override TEXT, updated_at TEXT, folder_paths TEXT, remote_connection TEXT, archived INTEGER);',
    );
    db.prepare('INSERT INTO remote_connections VALUES (1, ?, ?, 2222)').run('dev-box', 'coder');
    db.prepare('INSERT INTO workspaces VALUES (?, 1)').run('/work/payments');
    db.prepare('INSERT INTO sidebar_threads VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0)').run(
      Buffer.alloc(16),
      'native-session',
      'zed',
      'Fix retries',
      '2026-10-17T01:00:00Z',
      '/work/payments',
      JSON.stringify({ Ssh: { host: 'dev-box', username: 'coder', port: 2222 } }),
    );
    // Claude runs on the SSH host and keeps its conversation there.
    db.prepare('INSERT INTO sidebar_threads VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0)').run(
      Buffer.alloc(16, 1),
      'remote-claude-session',
      'claude-acp',
      'Remote agent work',
      '2026-10-17T02:00:00Z',
      '/work/payments',
      JSON.stringify({ Ssh: { host: 'dev-box', username: 'coder', port: 2222 } }),
    );
    db.close();
    const history = new DatabaseSync(join(zed, 'threads/threads.db'));
    history.exec('CREATE TABLE threads (id TEXT, updated_at TEXT, data_type TEXT, data BLOB)');
    history.prepare('INSERT INTO threads VALUES (?, ?, ?, ?)').run(
      'native-session',
      '2026-10-16T22:15:00.5+00:00',
      'zstd',
      zstdCompressSync(
        Buffer.from(
          JSON.stringify({
            messages: [
              { User: { content: [{ Text: 'Fix retries' }] } },
              { Agent: { content: [{ Text: 'The retry key changes.' }] } },
            ],
          }),
        ),
      ),
    );
    history.close();
    const workspace = join(code, 'workspaceStorage/project');
    mkdirSync(join(workspace, 'chatSessions'), { recursive: true });
    writeFileSync(
      join(workspace, 'workspace.json'),
      JSON.stringify({ folder: 'file:///work/frontend' }),
    );
    const lines =
      [
        {
          kind: 0,
          v: {
            sessionId: 'code-session',
            customTitle: 'Fix UI',
            creationDate: Date.now(),
            requests: [{ message: { text: 'Fix the UI' }, response: [] }],
          },
        },
        {
          kind: 2,
          k: ['requests', 0, 'response'],
          v: [{ kind: 'markdownContent', content: { value: 'Updated the form.' } }],
        },
      ]
        .map((value) => JSON.stringify(value))
        .join('\n') + '\n';
    writeFileSync(join(workspace, 'chatSessions/session.jsonl'), lines);
    // Remote-SSH can name its host as hex-encoded JSON settings.
    const settings = Buffer.from(JSON.stringify({ hostName: 'dev-box' })).toString('hex');
    mkdirSync(join(code, 'workspaceStorage/remote/chatSessions'), { recursive: true });
    writeFileSync(
      join(code, 'workspaceStorage/remote/workspace.json'),
      JSON.stringify({ folder: `vscode-remote://ssh-remote%2B${settings}/work/api` }),
    );
    writeFileSync(
      join(code, 'workspaceStorage/remote/chatSessions/remote.json'),
      JSON.stringify({ sessionId: 'remote-session', creationDate: Date.now(), requests: [] }),
    );
    // A workspace without a conversation is not a project on the phone.
    mkdirSync(join(code, 'workspaceStorage/empty'), { recursive: true });
    writeFileSync(
      join(code, 'workspaceStorage/empty/workspace.json'),
      JSON.stringify({ folder: 'file:///work/empty' }),
    );
    const discovery = new Discovery('computer', 'private-local-secret');
    const projects = discovery.scan();
    assert.deepEqual(discovery.warnings, []);
    assert.deepEqual(projects.map((project) => project.path).sort(), [
      '/work/api',
      '/work/frontend',
      '/work/payments',
    ]);
    assert.deepEqual(projects.find((project) => project.path === '/work/api')!.remote, {
      host: 'dev-box',
      path: '/work/api',
    });
    const remote = projects.find((project) => project.path === '/work/payments')!;
    assert.deepEqual(remote.remote, {
      host: 'dev-box',
      path: '/work/payments',
      user: 'coder',
      port: 2222,
    });
    assert.deepEqual(
      remote.threads.map((thread) => thread.title),
      ['Fix retries'],
    );
    assert.equal(remote.threads[0]!.status, 'unknown');
    assert.equal(remote.threads[0]!.capabilities.approve, false);
    // Zed's own agent stamps the thread content; the sidebar's `updated_at` is bookkeeping.
    assert.equal(remote.threads[0]!.updatedAt, '2026-10-16T22:15:00.500Z');
    assert.deepEqual(
      discovery.read(remote.threads[0]!).map((message) => message.text),
      ['Fix retries', 'The retry key changes.'],
    );
    const local = projects.find((project) => !project.remote)!;
    assert.deepEqual(
      discovery.read(local.threads[0]!).map((message) => message.text),
      ['Fix the UI', 'Updated the form.'],
    );
    assert.equal(replaySession(lines + '{"kind":').requests[0].message.text, 'Fix the UI');
    assert.throws(() =>
      replaySession('{"kind":0,"v":{}}\n{"kind":1,"k":["__proto__","polluted"],"v":true}\n'));
  } finally {
    if (oldZed === undefined) delete process.env.DASHUP_ZED_DATA;
    else process.env.DASHUP_ZED_DATA = oldZed;
    if (oldCode === undefined) delete process.env.DASHUP_VSCODE_DATA;
    else process.env.DASHUP_VSCODE_DATA = oldCode;
    nativeHomes.forEach((name, index) => {
      if (previousHomes[index] === undefined) delete process.env[name];
      else process.env[name] = previousHomes[index];
    });
    rmSync(root, { recursive: true, force: true });
  }
});

test('a native history resume opt-out stays read-only despite an installed agent and stale send capability', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashup-native-owner-'));
  const previous = process.env.DASHUP_CONFIG;
  process.env.DASHUP_CONFIG = join(root, 'connector.json');
  const connector = new Connector({
    api         : 'http://127.0.0.1:1',
    secret      : 'fixture',
    localSecret : 'fixture-secret',
    device      : {
      id: 'computer',
      user: 'owner',
      name: 'Computer',
      kind: 'desktop',
      platform: 'linux',
    },
    pairs       : {},
  });
  try {
    const internal = connector as unknown as {
      startable: ['junie'];
      refreshResumes(): void;
      command(
        pair: PairingRecord,
        command: Extract<Content, { type: 'command' }>,
      ): Promise<unknown>;
    };
    internal.startable = ['junie'];
    const thread: ThreadSummary = {
      id: 'native-thread',
      title: 'Native Junie work',
      editor: 'cli',
      status: 'unknown',
      updatedAt: '2026-10-29T00:00:00.000Z',
      capabilities: { read: true, send: false, approve: false },
      agent: { harness: 'junie', sessionId: 'native-session' },
    };
    connector.discovery.projects.set('project', {
      id: 'project',
      name: 'Native project',
      path: '/work/project',
      deviceId: 'computer',
      threads: [thread],
    });
    connector.discovery.locations.set(thread.id, {
      editor: 'cli',
      path: '/work/project',
      history: {
        id: 'native-session',
        cwd: '/work/project',
        title: thread.title,
        harness: 'junie',
        updatedAt: thread.updatedAt,
        files: [],
        resumable: false,
        read: () => [],
      },
    });
    let resumes = 0;
    connector.harnesses.resume = async () => {
      resumes++;
    };
    internal.refreshResumes();
    assert.equal(thread.capabilities.send, false);
    // A stale advertised capability cannot override the current native ownership record.
    thread.capabilities.send = true;
    await assert.rejects(
      internal.command(
        {
          id: 'pair',
          device: 'computer',
          mobile: 'phone',
          code: '',
          revokedAt: null,
        },
        {
          type: 'command',
          requestId: 'stale-send',
          projectId: 'project',
          threadId: thread.id,
          action: { kind: 'thread.send', text: 'Continue the original thread' },
        },
      ),
      /no verified reply owner/,
    );
    assert.equal(resumes, 0);
  } finally {
    connector.stop();
    if (previous === undefined) delete process.env.DASHUP_CONFIG;
    else process.env.DASHUP_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a saved Claude thread takes replies from the moment its agent is found, through every catalogue and after its session ends', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashup-resume-'));
  const homes = [
    'DASHUP_CONFIG',
    'DASHUP_ZED_DATA',
    'DASHUP_VSCODE_DATA',
    'DASHUP_JUNIE_HOME',
    'DASHUP_KIMI_HOME',
    'CLAUDE_CONFIG_DIR',
    'XDG_DATA_HOME',
    'OPENCODE_DB',
    'CODEX_HOME',
  ] as const;
  const previous = homes.map((name) => process.env[name]);
  const discovery = process.env.DASHUP_LIVE_DISCOVERY;
  for (const name of homes) process.env[name] = join(root, name);
  process.env.DASHUP_LIVE_DISCOVERY = '0';
  const session = 'claude-session';
  const transcript = join(root, 'CLAUDE_CONFIG_DIR/projects/project', `${session}.jsonl`);
  mkdirSync(join(transcript, '..'), { recursive: true });
  writeFileSync(
    transcript,
    `${JSON.stringify({
      sessionId  : session,
      cwd        : root,
      type       : 'user',
      uuid       : 'u1',
      parentUuid : null,
      timestamp  : '2026-11-03T00:00:00.000Z',
      message    : { role: 'user', content: 'Ship it' },
    })}\n`,
  );
  const connector = new Connector({
    api         : 'http://127.0.0.1:1',
    secret      : 'fixture',
    localSecret : 'fixture-secret',
    device      : {
      id: 'computer',
      user: 'owner',
      name: 'Computer',
      kind: 'desktop',
      platform: 'linux',
    },
    pairs       : {},
  });
  const internal = connector as unknown as {
    changed(): Promise<void>;
    findAgents(): Promise<void>;
    refreshNative(harness: 'claude'): Promise<void>;
  };
  const thread = () =>
    [...connector.discovery.projects.values()]
      .flatMap((project) => project.threads)
      .find((item) => item.agent?.sessionId === session)!;
  try {
    connector.harnesses.agents = async () => ['claude'];
    connector.harnesses.refresh = async () => [];
    await internal.changed();
    assert.equal(thread().capabilities.send, false);
    await internal.findAgents();
    assert.equal(thread().capabilities.send, true);

    let release!: (sessions: LiveSession[]) => void;
    connector.harnesses.refresh = () => new Promise((resolve) => (release = resolve));
    const cataloguing = internal.changed();
    assert.equal(thread().capabilities.send, true);
    release([
      {
        id        : session,
        cwd       : root,
        harness   : 'claude',
        updatedAt : '2026-11-03T00:00:00.000Z',
        status    : 'idle',
        messages  : [],
        approvals : [],
        send      : async () => {},
      },
    ]);
    await cataloguing;
    assert.ok(connector.discovery.locations.get(thread().id)!.live);
    assert.equal(thread().capabilities.send, true);

    connector.harnesses.sessionsFor = async () => [];
    await internal.refreshNative('claude');
    assert.equal(connector.discovery.locations.get(thread().id)!.live, undefined);
    assert.equal(thread().capabilities.send, true);
  } finally {
    connector.stop();
    homes.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
    if (discovery === undefined) delete process.env.DASHUP_LIVE_DISCOVERY;
    else process.env.DASHUP_LIVE_DISCOVERY = discovery;
    rmSync(root, { recursive: true, force: true });
  }
});

test('Codex lifecycle status requires its writer, preserves live observations, and never resumes an owned thread', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashup-codex-owner-'));
  const previous = process.env.DASHUP_CONFIG;
  process.env.DASHUP_CONFIG = join(root, 'connector.json');
  const connector = new Connector({
    api         : 'http://127.0.0.1:1',
    secret      : 'fixture',
    localSecret : 'fixture-secret',
    device      : {
      id: 'computer',
      user: 'owner',
      name: 'Computer',
      kind: 'desktop',
      platform: 'linux',
    },
    pairs       : {},
  });
  try {
    const internal = connector as unknown as {
      startable: ['codex'];
      nativeQueue: NativeQueue;
      refreshQueues(): void;
      refreshResumes(): void;
      command(
        pair: PairingRecord,
        command: Extract<Content, { type: 'command' }>,
      ): Promise<unknown>;
    };
    internal.startable = ['codex'];
    internal.nativeQueue.refresh = () => {};
    const path = join(root, 'rollout.jsonl');
    writeFileSync(path, '');
    const file = statSync(path);
    const owner: CodexOwner = {
      pid: process.pid,
      start: 'fixture',
      executable: '/codex',
      home: root,
      cwd: root,
      thread: 'native-session',
      rollout: { path, device: file.dev, inode: file.ino },
    };
    const thread: ThreadSummary = {
      id: 'native-thread',
      title: 'Native Codex work',
      editor: 'cli',
      status: 'unknown',
      updatedAt: '2026-10-29T00:00:00.000Z',
      capabilities: { read: true, send: false, approve: false },
      agent: { harness: 'codex', sessionId: owner.thread },
    };
    connector.discovery.projects.set('project', {
      id: 'project',
      name: 'Native project',
      path: root,
      deviceId: 'computer',
      threads: [thread],
    });
    let status: 'working' | 'idle' = 'working';
    let reads = 0;
    const step = { name: 'exec_command', summary: 'npm test' };
    connector.discovery.locations.set(thread.id, {
      editor: 'cli',
      path: root,
      history: {
        id: owner.thread,
        cwd: root,
        title: thread.title,
        harness: 'codex',
        updatedAt: thread.updatedAt,
        files: [path],
        step,
        read: () => [],
        status: () => {
          reads++;
          return status;
        },
      },
    });
    internal.refreshQueues();
    assert.equal(thread.status, 'unknown');
    assert.equal(reads, 0);
    internal.nativeQueue.writers = [owner];
    internal.refreshQueues();
    internal.refreshResumes();
    assert.equal(thread.status, 'working');
    assert.deepEqual(thread.step, step);
    assert.equal(thread.capabilities.queue, false);
    assert.equal(thread.capabilities.send, false);
    status = 'idle';
    internal.refreshQueues();
    assert.equal(thread.status, 'idle');
    assert.equal(thread.step, undefined);
    const location = connector.discovery.locations.get(thread.id)!;
    location.live = {
      id: owner.thread,
      cwd: root,
      harness: 'codex',
      status: 'attention',
      updatedAt: thread.updatedAt,
      messages: [],
      approvals: [],
    };
    thread.status = 'attention';
    internal.refreshQueues();
    assert.equal(thread.status, 'attention');
    assert.equal(reads, 2);
    location.live = undefined;
    status = 'working';
    internal.refreshQueues();
    internal.nativeQueue.writers = [];
    internal.refreshQueues();
    assert.equal(thread.status, 'unknown');
    assert.equal(thread.step, undefined);
    internal.nativeQueue.writers = [owner];
    let resumes = 0;
    connector.harnesses.resume = async () => {
      resumes++;
    };
    thread.capabilities.send = true;
    await assert.rejects(
      internal.command(
        { id: 'pair', device: 'computer', mobile: 'phone', code: '', revokedAt: null },
        {
          type: 'command',
          requestId: 'stale-send',
          projectId: 'project',
          threadId: thread.id,
          action: { kind: 'thread.send', text: 'Continue the original thread' },
        },
      ),
      /session is open on your computer/,
    );
    assert.equal(resumes, 0);
    location.history!.status = () => {
      throw new Error('Rollout disappeared');
    };
    internal.refreshQueues();
    assert.equal(thread.status, 'unknown');
    assert.equal(thread.step, undefined);
  } finally {
    connector.stop();
    if (previous === undefined) delete process.env.DASHUP_CONFIG;
    else process.env.DASHUP_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('an approval stays the ask Home shows until it is answered, however the transcript moves on', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashup-attention-'));
  const previous = process.env.DASHUP_CONFIG;
  process.env.DASHUP_CONFIG = join(root, 'connector.json');
  const connector = new Connector({
    api         : 'http://127.0.0.1:1',
    secret      : 'fixture',
    localSecret : 'fixture-secret',
    device      : {
      id: 'computer',
      user: 'owner',
      name: 'Computer',
      kind: 'desktop',
      platform: 'linux',
    },
    pairs       : {},
  });
  try {
    const internal = connector as unknown as { attentionFor(thread: ThreadSummary): unknown };
    const thread: ThreadSummary = {
      id: 'claude-thread',
      title: 'Round invoice totals per line',
      editor: 'cli',
      status: 'attention',
      updatedAt: '2026-11-05T00:00:00.000Z',
      capabilities: { read: true, send: true, approve: true },
      agent: { harness: 'claude', sessionId: 'native' },
    };
    connector.discovery.projects.set('project', {
      id: 'project',
      name: 'billing-web',
      path: root,
      deviceId: 'computer',
      threads: [thread],
    });
    const approval = { id: 'edit', title: 'Allow file changes?', detail: '', choices: [] };
    const live: LiveSession = {
      id: 'native',
      cwd: root,
      harness: 'claude',
      status: 'attention',
      updatedAt: thread.updatedAt,
      messages: [],
      approvals: [approval],
    };
    connector.discovery.locations.set(thread.id, { editor: 'cli', path: root, live });
    await connector.attention('project', thread.id, approval.title, '', 'approval', approval.id);
    thread.updatedAt = '2026-11-05T00:00:05.000Z';
    assert.deepEqual(internal.attentionFor(thread), {
      reason: 'approval',
      title: 'Allow file changes?',
      body: '',
    });
    live.approvals = [];
    assert.equal(internal.attentionFor(thread), undefined);
    await connector.attention('project', thread.id, 'Claude needs your input', '', 'input');
    assert.ok(internal.attentionFor(thread));
    thread.updatedAt = '2026-11-05T00:00:10.000Z';
    assert.equal(internal.attentionFor(thread), undefined);
  } finally {
    connector.stop();
    if (previous === undefined) delete process.env.DASHUP_CONFIG;
    else process.env.DASHUP_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('the opt-in ACP bridge keeps native request choices and resolves the original request once', async () => {
  const output = new PassThrough();
  output.on('error', () => {});
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      output.write(chunk);
      callback();
    },
  });
  let current: AcpSession | undefined;
  const sessions = bridgeAcp(socket, (session) => {
    current = session;
  });
  const event = (direction: 'editor' | 'agent', message: object) =>
    socket.push(JSON.stringify({ direction, message }) + '\n');
  event('editor', {
    id: 1,
    method: 'session/load',
    params: { sessionId: 'existing', cwd: '/work/project' },
  });
  event('agent', {
    method: 'session/update',
    params: {
      sessionId: 'existing',
      update: {
        sessionUpdate: 'user_message_chunk',
        messageId: 'native-user-message',
        content: { type: 'text', text: 'Existing native request' },
      },
    },
  });
  event('agent', {
    method: 'session/update',
    params: {
      sessionId: 'existing',
      update: {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'native-agent-message',
        content: { type: 'text', text: 'Existing native response' },
      },
    },
  });
  event('agent', { id: 1, result: {} });
  event('agent', {
    id: 91,
    method: 'session/request_permission',
    params: {
      sessionId: 'existing',
      toolCall: {
        title: 'Edit handler.ts',
        content: [
          { type: 'diff', path: '/work/project/handler.ts', oldText: 'old', newText: 'new' },
        ],
      },
      options: [{ optionId: 'native-once', name: 'Allow once', kind: 'allow_once' }],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sessions.size, 1);
  assert.deepEqual(
    current!.messages.map((message) => message.text),
    ['Existing native request', 'Existing native response'],
  );
  assert.deepEqual(current!.approvals.get('91')!.choices, [
    { id: 'native-once', label: 'Allow once', intent: 'approve' },
  ]);
  assert.equal(current!.approvals.get('91')!.change!.path, '/work/project/handler.ts');
  assert.equal(current!.status, 'attention');
  const asked = current!.approvals.get('91')!.id;
  const response = commandAcp(current!, 'phone-request', {
    kind: 'approval',
    id: '91',
    choice: 'native-once',
  });
  const wire = await new Promise<string>((resolve) =>
    output.once('data', (chunk) => resolve(String(chunk))));
  assert.equal(JSON.parse(wire).id, '91');
  event('agent', {
    method: 'dashup/command_result',
    params: { requestId: 'phone-request', session: 'existing', ok: true },
  });
  event('editor', {
    id: 91,
    result: { outcome: { outcome: 'selected', optionId: 'native-once' } },
  });
  await response;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(current!.approvals.size, 0);
  // A restarted agent numbers its requests again; the phone must not take this for the answered ask.
  event('agent', {
    id: 91,
    method: 'session/request_permission',
    params: {
      sessionId: 'existing',
      toolCall: { title: 'Edit handler.ts' },
      options: [{ optionId: 'native-once', name: 'Allow once', kind: 'allow_once' }],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(current!.approvals.get('91')!.id, asked);
  assert.equal(current!.context, undefined);
  for (const [used, size, expected] of [
    [50_000, 200_000, { used: 50_000, size: 200_000 }],
    [0, 200_000, { used: 0, size: 200_000 }],
    [20_000, 0, null],
    [-1, 200_000, null],
    ['50000', 200_000, null],
  ] as const) {
    event('agent', {
      method: 'session/update',
      params: {
        sessionId: 'existing',
        update: {
          sessionUpdate: 'usage_update',
          used,
          size,
          cost: { amount: 42, currency: 'USD' },
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(current!.context, expected);
    assert.equal(current!.messages.length, 2);
  }
  socket.destroy();
});

test('ACP settings track native changes and configuration results without adding messages', async () => {
  const socket = new Duplex({
    read() {},
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const sessions = bridgeAcp(socket, () => {});
  const event = (direction: string, message: object) =>
    socket.push(JSON.stringify({ direction, message }) + '\n');
  const option = (value: string) => ({
    id: 'permission',
    category: 'mode',
    name: 'Permissions',
    type: 'select',
    currentValue: value,
    options: [
      {
        group: 'modes',
        name: 'Modes',
        options: [
          { value: 'default', name: 'Manual' },
          { value: 'auto', name: 'Auto' },
        ],
      },
    ],
  });
  event('editor', { id: 1, method: 'session/new', params: { cwd: '/project' } });
  event('agent', { id: 1, result: { sessionId: 'native', configOptions: [option('default')] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sessions.get('native')!.options[0]!.value, 'default');
  assert.deepEqual(sessions.get('native')!.options[0]!.choices, [
    { value: 'default', name: 'Manual' },
    { value: 'auto', name: 'Auto' },
  ]);
  event('editor', {
    id: 2,
    method: 'session/set_config_option',
    params: { sessionId: 'native', configId: 'permission', value: 'auto' },
  });
  event('agent', { id: 2, error: { message: 'Denied' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sessions.get('native')!.options[0]!.value, 'default');
  event('editor', {
    id: 3,
    method: 'session/set_config_option',
    params: { sessionId: 'native', configId: 'permission', value: 'auto' },
  });
  event('agent', { id: 3, result: { configOptions: [option('auto')] } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sessions.get('native')!.options[0]!.value, 'auto');
  event('agent', {
    method: 'session/update',
    params: {
      sessionId: 'native',
      update: { sessionUpdate: 'config_option_update', configOptions: [option('default')] },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sessions.get('native')!.options[0]!.value, 'default');
  assert.deepEqual(sessions.get('native')!.messages, []);
  socket.destroy();
});
