import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { newSecret, sealAttachment, openAttachment } from '@dashup/protocol/crypto';
import { openSession, sealSession, SESSION_JOIN, SESSION_READY, SESSION_PACKET, type SessionContent, type SessionPacket, type SessionJoin } from '@dashup/protocol/session';
import { DEFAULT_NOTIFICATION_POLICY } from '@dashup/protocol/attention';
import type { Message, Attachment, PairingRecord } from '@dashup/protocol';
import { opaque } from '../src/attachments';
import { Connector } from '../src/connector';
import type { ConnectorConfig } from '../src/config';

async function fixture(
  run: (f: {
    connector: Connector;
    config: ConnectorConfig;
    pair: PairingRecord;
    project: string;
    thread: string;
    messages: Message[];
    received: SessionContent[];
    send: (content: SessionContent) => Promise<void>;
    path: string;
    stops: () => number;
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'dashup-session-'));
  const previous = process.env.DASHUP_CONFIG;
  const path = join(directory, 'connector.json');
  process.env.DASHUP_CONFIG = path;
  const pair: PairingRecord = {
    id: 'pair',
    device: 'computer',
    mobile: 'phone',
    code: '',
    revokedAt: null,
  };
  const config: ConnectorConfig = {
    api: 'http://127.0.0.1:1',
    secret: 'test-only',
    localSecret: newSecret(randomBytes),
    device: { id: pair.device, user: 'user', kind: 'desktop', name: 'Computer', platform: 'linux' },
    pairs: { [pair.id]: { key: newSecret(randomBytes), sequence: 0 } },
  };
  const connector = new Connector(config);
  const received: SessionContent[] = [];
  connector.activePairs = () => [pair];
  connector['isActive'] = () => true;
  connector['stream'] = '02'.repeat(16);
  connector['ready'].add(pair.id);
  connector.client.send = (name: string, value: unknown) => {
    assert.equal(name, SESSION_PACKET);
    received.push(openSession(config.pairs[pair.id]!.key, value as SessionPacket));
  };
  connector['refreshOverview'] = () => {};
  connector['scheduleSelected'] = () => {};
  const messages: Message[] = Array.from({ length: 50 }, (_, i) => ({
    id: String(i),
    role: 'assistant' as const,
    text: `native ${i}`,
  }));
  let stops = 0;
  const found = connector.discovery.observe({
    id: 'session',
    harness: 'codex',
    cwd: directory,
    title: 'Chat',
    updatedAt: '2026-10-30T00:00:00Z',
    status: 'working',
    messages,
    approvals: [],
    stop: async () => {
      stops++;
    },
  });
  let sequence = 0;
  const send = (content: SessionContent) =>
    connector['receiveSession'](
      sealSession(
        config.pairs[pair.id]!.key,
        {
          pairing: pair.id,
          sender: pair.mobile,
          recipient: pair.device,
          stream: '01'.repeat(16),
          sequence: ++sequence,
        },
        content,
        randomBytes,
      ),
    );
  try {
    await run({
      connector,
      config,
      pair,
      project: found.project.id,
      thread: found.thread.id,
      messages,
      received,
      send,
      path,
      stops: () => stops,
    });
  } finally {
    connector.stop();
    if (previous === undefined) delete process.env.DASHUP_CONFIG;
    else process.env.DASHUP_CONFIG = previous;
    rmSync(directory, { recursive: true, force: true });
  }
}

type Fixture = Parameters<Parameters<typeof fixture>[0]>[0];

async function lifecycle(f: Fixture) {
  const handlers = new Map<string, Set<(...args: any[]) => void>>();
  const wire: Array<{ event: string; value: unknown }> = [];
  let connected = false;
  let refreshes = 0;
  const blocked = new Promise<void>(() => {});
  const on = (event: string, handler: (...args: any[]) => void) => {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event)!.add(handler);
    return () => handlers.get(event)!.delete(handler);
  };
  f.connector.activePairs = Connector.prototype.activePairs.bind(f.connector);
  f.connector['isActive'] = Connector.prototype['isActive'].bind(f.connector);
  f.connector['ready'].clear();
  f.connector['stream'] = '';
  Object.defineProperty(f.connector.client, 'isConnected', { get: () => connected });
  f.connector.client.on = on;
  f.connector.client.subscribe = on;
  f.connector.client.send = (event: string, value: unknown) => {
    wire.push({ event, value });
    if (event === SESSION_PACKET)
      f.received.push(openSession(f.config.pairs[f.pair.id]!.key, value as SessionPacket));
  };
  f.connector.client.reconnect = async () => {};
  f.connector['refreshState'] = async () => {
    if (++refreshes === 1) f.connector['acceptPairings']([f.pair]);
    else await blocked;
  };
  f.connector['changed'] = async () => {};
  f.connector['findAgents'] = async () => {};
  f.connector.harnesses.watch = () => () => {};
  await f.connector.start();
  return {
    wire,
    refreshes: () => refreshes,
    emit: (event: string, value?: unknown) => {
      if (event === 'connected') connected = true;
      if (event === 'disconnected') connected = false;
      for (const handler of handlers.get(event) ?? []) handler(value);
    },
    joins: () =>
      wire.filter((item) => item.event === SESSION_JOIN).map((item) => item.value as SessionJoin),
  };
}

test('a raw socket connection cannot join session pipes before authenticated resync', () =>
  fixture(async (f) => {
    const connection = await lifecycle(f);
    connection.emit('connected');
    f.connector['acceptPairings']([f.pair]);
    assert.equal(connection.joins().length, 0);
    assert.equal(f.connector['joining'].size, 0);
    assert.equal(f.connector['stream'], '');
  }));

test('authenticated resync restores the pipe and first page while the dashboard refresh is blocked', () =>
  fixture(async (f) => {
    const connection = await lifecycle(f);
    connection.emit('connected');
    f.connector.client.session.resolve('user');
    connection.emit('resync-required');
    assert.equal(connection.refreshes(), 2);
    assert.equal(connection.joins().length, 1);
    const first = connection.joins()[0]!;
    assert.match(first.stream, /^[a-f0-9]{32}$/);
    assert.equal(first.device, f.pair.device);
    connection.emit(SESSION_READY, { ...first, ok: true });
    await f.send({ type: 'chat.attach', projectId: f.project, threadId: f.thread });
    assert.equal(f.received[0]?.type, 'chat.page');
    assert.equal(f.received[1]?.type, 'thread-state');
    const packet = connection.wire.find((item) => item.event === SESSION_PACKET)!
      .value as SessionPacket;
    assert.equal(packet.stream, first.stream);
    assert.equal(packet.sequence, 1);

    connection.emit('disconnected');
    assert.equal(f.connector['stream'], '');
    assert.equal(f.connector['ready'].size, 0);
    assert.equal(f.connector['selected'].size, 0);
    connection.emit('connected');
    f.connector['acceptPairings']([f.pair]);
    assert.equal(connection.joins().length, 1);
    connection.emit('resync-required');
    assert.equal(connection.joins().length, 2);
    const next = connection.joins()[1]!;
    assert.notEqual(next.stream, first.stream);
    connection.emit(SESSION_READY, { ...first, ok: true });
    assert.equal(f.connector['ready'].size, 0);
    connection.emit(SESSION_READY, { ...next, ok: true });
    await f.send({
      type: 'chat.history',
      requestId: 'after-reconnect',
      projectId: f.project,
      threadId: f.thread,
    });
    const response = f.received.find(
      (content) => content.type === 'chat.page' && content.requestId === 'after-reconnect',
    );
    assert.ok(response?.type === 'chat.page');
    const resumed = [...connection.wire].reverse().find((item) => item.event === SESSION_PACKET)!
      .value as SessionPacket;
    assert.equal(resumed.stream, next.stream);
    assert.equal(resumed.sequence, 2);
  }));

test('a lost session join goes again on its stream, and a refused one at the next heartbeat', (t) =>
  fixture(async (f) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const connection = await lifecycle(f);
    const reports: string[] = [];
    f.connector['report'] = (error: unknown) => void reports.push((error as Error).message);
    connection.emit('connected');
    connection.emit('resync-required');
    const replaced = connection.joins()[0]!;
    t.mock.timers.tick(2_500);
    connection.emit('disconnected');
    connection.emit('connected');
    connection.emit('resync-required');
    const join = connection.joins()[1]!;
    assert.notEqual(join.stream, replaced.stream);
    t.mock.timers.tick(4_999);
    assert.deepEqual(connection.joins(), [replaced, join]);
    t.mock.timers.tick(1);
    assert.deepEqual(connection.joins(), [replaced, join, join]);
    connection.emit(SESSION_READY, { ...join, ok: false, error: 'The database is unavailable.' });
    assert.deepEqual(reports, ['The database is unavailable.']);
    assert.equal(f.connector['ready'].size, 0);
    t.mock.timers.tick(22_499);
    assert.equal(connection.joins().length, 3);
    t.mock.timers.tick(1);
    assert.deepEqual(connection.joins(), [replaced, join, join, join]);
    connection.emit(SESSION_READY, { ...join, ok: true });
    assert.ok(f.connector['ready'].has(f.pair.id));
    t.mock.timers.tick(60_000);
    assert.equal(connection.joins().length, 4);
  }));

test('opening a chat sends only the latest page before metadata without scanning other sources or writing configuration', () =>
  fixture(async (f) => {
    f.connector.discovery.scan = () => {
      throw new Error('opening a chat scanned sources');
    };
    f.connector.harnesses.refresh = async () => {
      throw new Error('opening a chat refreshed every harness');
    };
    await f.send({ type: 'chat.attach', projectId: f.project, threadId: f.thread });
    assert.equal(f.received[0]?.type, 'chat.page');
    assert.equal(f.received[1]?.type, 'thread-state');
    const first = f.received[0];
    assert.equal(first.type, 'chat.page');
    if (first.type !== 'chat.page') return;
    assert.equal(first.messages.length, 30);
    assert.equal(first.messages.at(-1)?.text, 'native 49');
    assert.ok(first.before);
    f.messages.push({ id: '50', role: 'assistant', text: 'newly arrived' });
    await f.send({
      type: 'chat.history',
      requestId: 'older',
      projectId: f.project,
      threadId: f.thread,
      before: first.before!,
    });
    const page = f.received.find((c) => c.type === 'chat.page' && c.requestId === 'older');
    assert.ok(page?.type === 'chat.page');
    assert.equal(page.messages.at(-1)?.text, 'native 19');
    assert.equal([...f.connector['selected'].values()][0]?.latest, false);
    assert.equal(existsSync(f.path), false);
    assert.deepEqual(f.config.receipts, {});
  }));
test('context is read for the selected thread and sent only in its encrypted live state', () =>
  fixture(async (f) => {
    const location = f.connector.discovery.locations.get(f.thread)!;
    let reads = 0;
    location.history = {
      id: 'session',
      cwd: location.live!.cwd,
      title: 'Chat',
      harness: 'codex',
      updatedAt: '',
      files: [],
      read: () => f.messages,
      context: () => {
        reads++;
        return { used: 40000, size: 200000 };
      },
    };
    const overview = f.connector['overview'](f.pair);
    assert.equal(reads, 0);
    assert.ok(!JSON.stringify(overview).includes('"context"'));
    await f.send({ type: 'chat.attach', projectId: f.project, threadId: f.thread });
    const state = f.received.find((content) => content.type === 'thread-state');
    assert.ok(state?.type === 'thread-state');
    assert.deepEqual(state.context, { used: 40000, size: 200000 });
    assert.equal(reads, 1);
    location.live!.context = { used: 10000, size: 200000 };
    const project = f.connector.discovery.projects.get(f.project)!;
    const updated = f.connector['threadState'](project, project.threads[0]!);
    assert.deepEqual(updated.context, location.live!.context);
    assert.equal(reads, 1);
    location.live!.context = null;
    assert.equal(f.connector['threadState'](project, project.threads[0]!).context, undefined);
    assert.equal(reads, 1);
    location.live!.context = undefined;
    location.history.context = () => {
      throw new Error('History removed');
    };
    assert.equal(f.connector['threadState'](project, project.threads[0]!).context, undefined);
    assert.equal(existsSync(f.path), false);
  }));

test('session listing carries project ownership and performs no durable receipt write', () =>
  fixture(async (f) => {
    await f.send({
      type: 'command',
      requestId: 'list',
      projectId: '',
      action: { kind: 'sessions.list' },
    });
    const result = f.received.at(-1);
    assert.equal(result?.type, 'result');
    if (result?.type !== 'result') return;
    assert.equal(result.sessions?.[0]?.projectId, f.project);
    assert.equal(result.projects?.[0]?.id, f.project);
    assert.equal(existsSync(f.path), false);
    assert.deepEqual(f.config.receipts, {});
  }));
test('native handoff receipt prevents duplicate execution including after reconnect and restart', () =>
  fixture(async (f) => {
    const command: SessionContent = {
      type: 'command',
      requestId: 'stop-once',
      projectId: f.project,
      threadId: f.thread,
      action: { kind: 'thread.stop' },
    };
    await f.send(command);
    await f.send(command);
    assert.equal(f.stops(), 1);
    const saved = JSON.parse(readFileSync(f.path, 'utf8')) as ConnectorConfig;
    assert.equal(saved.receipts?.['pair:stop-once']?.result?.ok, true);
    assert.equal('outbox' in saved, false);
    assert.equal(JSON.stringify(saved).includes('native 49'), false);
    const restored = new Connector(saved);
    restored.activePairs = () => [f.pair];
    const results: SessionContent[] = [];
    restored.send = async (_pair, content) => {
      results.push(content);
    };
    try {
      await restored['execute'](f.pair, command);
      assert.equal(results[0]?.type, 'result');
      assert.equal(f.stops(), 1);
    } finally {
      restored.stop();
    }
  }));
test('an unconfirmed native handoff is never retried and notification policy remains pair scoped', () =>
  fixture(async (f) => {
    f.config.receipts!['pair:unconfirmed'] = {
      pairing: 'pair',
      project: f.project,
      at: Date.now(),
    };
    await f.send({
      type: 'command',
      requestId: 'unconfirmed',
      projectId: f.project,
      threadId: f.thread,
      action: { kind: 'thread.stop' },
    });
    const result = f.received.at(-1);
    assert.ok(result?.type === 'result' && !result.ok);
    assert.match(result.error ?? '', /unconfirmed/);
    assert.equal(f.stops(), 0);
    f.config.pairs.other = { key: newSecret(randomBytes), sequence: 0 };
    const policy = { ...DEFAULT_NOTIFICATION_POLICY, projects: { [f.project]: { muted: true } } };
    await f.send({
      type: 'command',
      requestId: 'policy',
      projectId: '',
      action: { kind: 'notifications.configure', policy },
    });
    assert.deepEqual(f.config.pairs.pair!.attention, policy);
    assert.equal(f.config.pairs.other.attention, undefined);
  }));

test('attention is one current dashboard fact and expires when the native session advances', () =>
  fixture(async (f) => {
    await f.connector.attention(
      f.project,
      f.thread,
      'Needs a reply',
      'A private question',
      'input',
    );
    const dashboard = f.connector['overview'](f.pair);
    assert.deepEqual(dashboard.sessions[0]?.attention, {
      reason: 'input',
      title: 'Needs a reply',
      body: 'A private question',
    });
    const native = f.connector.discovery.locations.get(f.thread)!.live!;
    native.updatedAt = '2026-10-30T00:01:00Z';
    f.connector.discovery.observe(native);
    assert.equal(f.connector['overview'](f.pair).sessions[0]?.attention, undefined);
  }));

test('invalid older cursors leave the selected live window intact and oversized request IDs never reach receipts', () =>
  fixture(async (f) => {
    await f.send({ type: 'chat.attach', projectId: f.project, threadId: f.thread });
    const selected = [...f.connector['selected'].values()][0];
    await f.send({
      type: 'chat.history',
      requestId: 'bad-cursor',
      projectId: f.project,
      threadId: f.thread,
      before: 'invalid',
    });
    assert.equal(f.received.at(-1)?.type, 'error');
    assert.equal([...f.connector['selected'].values()][0], selected);
    assert.equal(selected?.latest, true);
    await assert.rejects(
      f.send({
        type: 'command',
        requestId: 'x'.repeat(129),
        projectId: f.project,
        threadId: f.thread,
        action: { kind: 'thread.stop' },
      }),
    );
    assert.equal(f.stops(), 0);
    assert.deepEqual(f.config.receipts, {});
  }));

test('dashboard size trimming keeps the project card for every retained session', () =>
  fixture(async (f) => {
    const template = f.connector.discovery.projects.get(f.project)!;
    f.connector.discovery.projects.clear();
    for (let index = 0; index < 150; index++) {
      const id = `project-${index}`;
      f.connector.discovery.projects.set(id, {
        ...template,
        id,
        name: `Project ${index}` + 'x'.repeat(500),
        path: '/fixture/' + String(index),
        threads: [
          {
            ...template.threads[0]!,
            id: `thread-${index}`,
            status: index === 149 ? 'attention' : 'idle',
            updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 150 - index)).toISOString(),
          },
        ],
      });
    }
    const dashboard = f.connector['overview'](f.pair);
    assert.ok(dashboard.sessions.some((session) => session.projectId === 'project-149'));
    assert.ok(
      dashboard.sessions.every((session) =>
        dashboard.projects.some((project) => project.id === session.projectId)),
    );
    assert.ok(
      Buffer.byteLength(JSON.stringify({ type: 'dashboard', dashboard })) + 16 <= 64 * 1024,
    );
  }));

test('a phone reconnect receives current queue receipts even when their state has not changed', () =>
  fixture(async (f) => {
    const queueId = 'queued-native';
    f.config.queued![queueId] = {
      pairing: f.pair.id,
      project: f.project,
      thread: f.thread,
      receipt: { state: 'accepted', queueId },
      owner: {
        pid: 1,
        start: 'fixture',
        executable: '/fixture',
        home: '/fixture',
        cwd: '/fixture',
        thread: 'native',
        version: 'fixture',
        rollout: { path: '/fixture/rollout', device: 1, inode: 1 },
        queue: { path: '/fixture/queue', device: 1, inode: 2 },
      },
    };
    f.connector.nativeQueue.reconcile = () => ({ state: 'accepted', queueId });
    await f.connector['publishQueueReceipts']();
    await f.connector['publishQueueReceipts']();
    assert.equal(
      f.received.filter((content) => content.type === 'result' && content.requestId === queueId)
        .length,
      1,
    );
    await f.connector['publishQueueReceipts'](f.pair.id);
    assert.equal(
      f.received.filter((content) => content.type === 'result' && content.requestId === queueId)
        .length,
      2,
    );
  }));

test('a group selects up to four native conversations and detach releases just its bounded native page', () =>
  fixture(async (f) => {
    const first = f.connector.discovery.locations.get(f.thread)!.live!;
    const sessions = [
      first,
      ...Array.from({ length: 4 }, (_, index) => ({ ...first, id: `group-${index}` })),
    ];
    const released = new Set<string>();
    const threads = sessions.map((live) => {
      live.releaseMessages = () => {
        released.add(live.id);
      };
      return f.connector.discovery.observe(live).thread.id;
    });
    for (const threadId of threads.slice(0, 4))
      await f.send({ type: 'chat.attach', projectId: f.project, threadId });
    assert.equal(f.connector['selected'].size, 4);
    await f.send({ type: 'chat.attach', projectId: f.project, threadId: threads[4]! });
    assert.equal(f.connector['selected'].size, 4);
    assert.equal(f.received.at(-1)?.type, 'error');
    await f.send({ type: 'chat.detach', projectId: f.project, threadId: threads[1]! });
    assert.equal(f.connector['selected'].size, 3);
    assert.deepEqual([...released], [sessions[1]!.id]);
    await f.send({ type: 'chat.attach', projectId: f.project, threadId: threads[4]! });
    assert.equal(f.connector['selected'].size, 4);
  }));

test('native async pages retain upstream pagination and discard a response after its chat detaches', () =>
  fixture(async (f) => {
    const live = f.connector.discovery.locations.get(f.thread)!.live!;
    const reads: Array<string | undefined> = [];
    live.readMessages = async (before) => {
      reads.push(before);
      return { messages: [{ id: 'anchor', role: 'assistant', text: 'latest' }], more: true };
    };
    await f.send({ type: 'chat.attach', projectId: f.project, threadId: f.thread });
    const first = f.received.find((content) => content.type === 'chat.page');
    assert.ok(first?.type === 'chat.page' && first.before);
    live.readMessages = async (before) => {
      reads.push(before);
      return {
        messages: [
          { id: 'older', role: 'assistant', text: 'older' },
          { id: 'anchor', role: 'assistant', text: 'latest' },
        ],
        more: false,
      };
    };
    await f.send({
      type: 'chat.history',
      requestId: 'native-older',
      projectId: f.project,
      threadId: f.thread,
      before: first.before,
    });
    const older = f.received.find(
      (content) => content.type === 'chat.page' && content.requestId === 'native-older',
    );
    assert.ok(older?.type === 'chat.page');
    assert.equal(older.messages[0]?.text, 'older');
    assert.equal(older.before, null);
    assert.deepEqual(reads, [undefined, 'anchor']);
    let complete!: (value: { messages: typeof f.messages; more: boolean }) => void;
    live.readMessages = () =>
      new Promise((resolve) => {
        complete = resolve;
      });
    const pending = f.send({ type: 'chat.attach', projectId: f.project, threadId: f.thread });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await f.send({ type: 'chat.detach', projectId: f.project, threadId: f.thread });
    const count = f.received.length;
    complete({ messages: f.messages, more: false });
    await pending;
    assert.equal(f.received.length, count);
  }));

test('usage resets notify at the advertised deadline, carry only pairing routing, and never replay after restart', (t) =>
  fixture(async (f) => {
    let now = Date.parse('2026-10-30T00:00:00Z');
    t.mock.method(Date, 'now', () => now);
    const pushes: unknown[] = [];
    t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(url), f.config.api + '/v1/dashup/attention');
      pushes.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ success: true, result: { sent: true } }));
    });
    const usage = [
      {
        harness: 'codex' as const,
        account: 'private-reset@example.com',
        windows: [
          { minutes: 300, used: 100, resets: new Date(now + 60_000).toISOString() },
          { minutes: 10080, used: 10, resets: new Date(now + 60_000).toISOString() },
        ],
      },
    ];
    f.connector['usage'] = usage;
    f.connector['usageReady'] = true;
    f.connector['armUsageResets']();
    const armed = structuredClone(f.config.attentionPending);
    assert.equal(armed?.length, 1);
    assert.equal(JSON.stringify(f.config).includes(usage[0]!.account), false);
    await f.connector.notifications.flush();
    assert.equal(pushes.length, 0);
    now += 60_000;
    await f.connector.notifications.flush();
    assert.deepEqual(pushes, [{ pairing: f.pair.id }]);
    assert.equal(Object.keys(f.config.usageResetReceipts!).length, 1);
    assert.ok(Object.keys(f.config.usageResetReceipts!).every((key) => /^[a-f0-9]{64}$/.test(key)));
    const restarted = new Connector({ ...f.config, attentionPending: armed });
    restarted.activePairs = () => [f.pair];
    restarted['isActive'] = () => true;
    restarted['refreshOverview'] = () => {};
    restarted['usage'] = usage;
    restarted['usageReady'] = true;
    try {
      restarted.notifications.start();
      await restarted.notifications.flush();
      restarted['armUsageResets']();
      assert.equal(pushes.length, 1);
      assert.equal(restarted.config.attentionPending?.length, 0);
    } finally {
      restarted.stop();
    }
  }));

test('a shared login names its reset with an opaque key, and its account ID stays on the computer', (t) =>
  fixture(async (f) => {
    let now = Date.parse('2026-10-30T00:00:00Z');
    t.mock.method(Date, 'now', () => now);
    const pushes: Array<Record<string, unknown>> = [];
    t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      pushes.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ success: true, result: { sent: true } }));
    });
    f.connector['usage'] = [
      {
        harness  : 'claude',
        account  : 'private-reset@example.com',
        identity : 'private-account-id',
        windows  : [{ minutes: 300, used: 40, resets: new Date(now + 60_000).toISOString() }],
      },
    ];
    f.connector['usageReady'] = true;
    assert.equal(
      JSON.stringify(f.connector['overview'](f.pair)).includes('private-account-id'),
      false,
    );
    f.connector['armUsageResets']();
    now += 60_000;
    await f.connector.notifications.flush();
    assert.deepEqual(Object.keys(pushes[0] ?? {}), ['pairing', 'reset']);
    assert.equal(pushes[0]!.pairing, f.pair.id);
    assert.match(String(pushes[0]!.reset), /^[\w-]{43}$/);
    assert.equal(/private/.test(JSON.stringify(pushes)), false);
  }));

test('reset opt-outs cancel armed windows immediately and re-enabling arms only future usage', () =>
  fixture(async (f) => {
    f.connector['usage'] = [
      {
        harness: 'claude',
        account: 'private@example.com',
        windows: [{ minutes: 300, used: 25, resets: new Date(Date.now() + 60_000).toISOString() }],
      },
    ];
    f.connector['usageReady'] = true;
    f.connector['armUsageResets']();
    assert.equal(f.config.attentionPending?.length, 1);
    f.config.pairs[f.pair.id]!.attention = { ...DEFAULT_NOTIFICATION_POLICY, usageResets: false };
    f.connector['armUsageResets']();
    assert.equal(f.config.attentionPending?.length, 0);
    f.config.pairs[f.pair.id]!.attention = { ...DEFAULT_NOTIFICATION_POLICY, usageResets: true };
    f.connector['armUsageResets']();
    assert.equal(f.config.attentionPending?.length, 1);
    f.connector['usage'] = [
      { ...f.connector['usage'][0]!, account: 'new-account@example.com', windows: [] },
    ];
    f.connector['armUsageResets']();
    assert.equal(f.config.attentionPending?.length, 0);
  }));

function writable(
  f: Fixture,
  send: NonNullable<
    NonNullable<ReturnType<Connector['discovery']['locations']['get']>>['live']
  >['send'],
) {
  const native = f.connector.discovery.locations.get(f.thread)!.live!;
  native.send = send;
  f.connector.discovery.observe(native);
  return native;
}
const prompt = (f: Fixture, requestId: string, text: string, attachments?: Attachment[]) =>
  f.send({
    type: 'command',
    requestId,
    projectId: f.project,
    threadId: f.thread,
    action: { kind: 'thread.send', text, ...(attachments ? { attachments } : {}) },
  });
async function pageAfter(f: Fixture, requestId = 'correlated-page') {
  await f.send({ type: 'chat.history', requestId, projectId: f.project, threadId: f.thread });
  const page = [...f.received]
    .reverse()
    .find((item) => item.type === 'chat.page' && item.requestId === requestId);
  assert.ok(page?.type === 'chat.page');
  return page;
}

test('acknowledged prompts stamp one canonical native user message and persist only its proof across restart', () =>
  fixture(async (f) => {
    const words = 'private phone prompt with a distinctive secret';
    f.messages.push({ id: 'old-identical', role: 'user', text: words });
    writable(f, async (_request, text) => {
      f.messages.push({ id: 'native-new', role: 'user', text });
    });
    await prompt(f, 'phone-one', words);
    const page = await pageAfter(f);
    assert.deepEqual(
      page.messages.filter((item) => item.requestId).map((item) => [item.requestId, item.text]),
      [['phone-one', words]],
    );
    assert.equal(
      page.messages.find((item) => item.text === words && !item.requestId)?.role,
      'user',
    );
    const saved = JSON.parse(readFileSync(f.path, 'utf8')) as ConnectorConfig;
    assert.deepEqual(saved.receipts?.['pair:phone-one']?.message, {
      thread: f.thread,
      before: 'old-identical',
      hash: opaque(f.config.localSecret, ['sent-message', words]),
      originalLength: words.length,
      id: 'native-new',
    });
    assert.equal(JSON.stringify(saved).includes(words), false);
    const restored = new Connector(saved);
    try {
      const mapping = restored['sentMessages'](f.pair, f.project, f.thread, f.messages);
      assert.deepEqual([...mapping], [['native-new', 'phone-one']]);
      assert.equal(restored['sentMessages'](f.pair, 'other-project', f.thread, f.messages).size, 0);
      assert.equal(restored['sentMessages'](f.pair, f.project, 'other-thread', f.messages).size, 0);
      assert.equal(
        restored['sentMessages']({ ...f.pair, id: 'other-phone' }, f.project, f.thread, f.messages)
          .size,
        0,
      );
    } finally {
      restored.stop();
    }
  }));

test('attachments correlate native prompts while phone bubbles and full readers keep only the original words', (t) =>
  fixture(async (f) => {
    const bytes = Buffer.from('private attachment body');
    const attachment: Attachment = {
      id: 'ab'.repeat(32),
      mime: 'text/plain',
      name: 'private-upload.txt',
      bytes: bytes.length,
    };
    const encrypted = sealAttachment(
      f.config.pairs[f.pair.id]!.key,
      f.pair.id,
      attachment.id,
      bytes,
      randomBytes,
    );
    const fetched = new Map<string, Uint8Array>();
    t.mock.method(globalThis, 'fetch', async (
      url: Parameters<typeof fetch>[0],
      options?: RequestInit,
    ) => {
      if (options?.method === 'POST') {
        fetched.set(String(url).split('/').at(-1)!, options.body as Uint8Array);
        return Response.json({ success: true, result: null });
      }
      return new Response(new Uint8Array(encrypted));
    });
    let nativeText = '';
    writable(f, async (_request, text, _now, files) => {
      nativeText = text;
      assert.equal(files?.length, 1);
      f.messages.push({ id: 'with-upload', role: 'user', text });
    });
    const words = 'Read this attachment.\n' + 'Original details 😀 '.repeat(300);
    await prompt(f, 'uploaded-message', words, [attachment]);
    assert.match(nativeText, /Files attached from my phone/);
    assert.match(nativeText, /private-upload\.txt/);
    f.messages.push({ id: 'manual-instructions', role: 'user', text: nativeText });
    const page = await pageAfter(f);
    const visible = page.messages.filter((item) => item.requestId === 'uploaded-message');
    assert.equal(visible.length, 1);
    assert.ok(words.startsWith(visible[0]!.text));
    assert.equal(visible[0]!.text.includes('Files attached'), false);
    const manual = page.messages.find((item) => item.role === 'user' && !item.requestId)!;
    assert.ok(nativeText.startsWith(manual.text));
    assert.equal(manual.full?.bytes, Buffer.byteLength(nativeText));
    const full = visible[0]!.full!;
    assert.equal(full.bytes, Buffer.byteLength(words));
    await f.send({
      type: 'command',
      requestId: 'read-uploaded-message',
      projectId: f.project,
      threadId: f.thread,
      action: { kind: 'attachment.read', id: full.id },
    });
    assert.equal(
      Buffer.from(
        openAttachment(f.config.pairs[f.pair.id]!.key, f.pair.id, full.id, fetched.get(full.id)!),
      ).toString(),
      words,
    );
    assert.equal(f.messages.find((item) => item.id === 'with-upload')!.text, nativeText);
    const saved = readFileSync(f.path, 'utf8');
    assert.equal(saved.includes('Read this attachment'), false);
    assert.equal(saved.includes('private-upload.txt'), false);
    assert.equal(saved.includes('private attachment body'), false);
    assert.equal(
      f.config.receipts!['pair:uploaded-message']!.message!.originalLength,
      words.length,
    );
    assert.equal(
      f.config.receipts!['pair:uploaded-message']!.message!.hash,
      opaque(f.config.localSecret, ['sent-message', nativeText.trim()]),
    );
    const edited = f.messages.map((message) =>
      message.id === 'with-upload'
        ? { ...message, text: nativeText + '\nLater desktop edit' }
        : message);
    assert.equal(
      f.connector['phoneMessages'](f.pair, f.project, f.thread, edited).messages.find(
        (message) => message.id === 'with-upload',
      )!.text,
      nativeText + '\nLater desktop edit',
    );
    const restored = new Connector(JSON.parse(saved));
    try {
      assert.equal(
        restored['phoneMessages'](f.pair, f.project, f.thread, f.messages).messages.find(
          (message) => message.id === 'with-upload',
        )!.text,
        words,
      );
    } finally {
      restored.stop();
    }
  }));

test('identical queued acknowledgements correlate in handoff order once each across paired phones', () =>
  fixture(async (f) => {
    const second = { ...f.pair, id: 'pair-two', mobile: 'phone-two' };
    const scope = {
      project: f.project,
      result: { ok: true },
      message: {
        thread: f.thread,
        before: '49',
        hash: opaque(f.config.localSecret, ['sent-message', 'same words']),
      },
    };
    // Persistence order is not handoff order.
    f.config.receipts!['pair-two:second'] = {
      ...structuredClone(scope),
      pairing: second.id,
      at: 20,
    };
    f.config.receipts!['pair:first'] = { ...structuredClone(scope), pairing: f.pair.id, at: 10 };
    f.messages.push(
      { id: 'first-native', role: 'user', text: 'same words' },
      { id: 'assistant-between', role: 'assistant', text: 'same words' },
      { id: 'second-native', role: 'user', text: 'same words' },
    );
    assert.deepEqual(
      [...f.connector['sentMessages'](second, f.project, f.thread, f.messages)],
      [['second-native', 'second']],
    );
    assert.deepEqual(
      [...f.connector['sentMessages'](f.pair, f.project, f.thread, f.messages)],
      [['first-native', 'first']],
    );
    assert.deepEqual(
      [...f.connector['sentMessages'](second, f.project, f.thread, f.messages)],
      [['second-native', 'second']],
    );
  }));

test('unconfirmed, rejected and missing-anchor sends never claim a later message with the same words', () =>
  fixture(async (f) => {
    const base = {
      pairing: f.pair.id,
      project: f.project,
      at: 1,
      message: {
        thread: f.thread,
        before: '49',
        hash: opaque(f.config.localSecret, ['sent-message', 'same words']),
      },
    };
    f.config.receipts!['pair:crashed'] = structuredClone(base);
    f.config.receipts!['pair:rejected'] = {
      ...structuredClone(base),
      result: { ok: false, error: 'Not accepted' },
    };
    f.config.receipts!['pair:queue-unknown'] = {
      ...structuredClone(base),
      result: { ok: false, queue: { state: 'unknown', clientUserMessageId: 'unseen-native-id' } },
    };
    f.config.receipts!['pair:missing-anchor'] = {
      ...structuredClone(base),
      message: { ...base.message, before: 'no-longer-visible' },
      result: { ok: true },
    };
    f.messages.push({ id: 'manual-desktop-message', role: 'user', text: 'same words' });
    assert.equal(f.connector['sentMessages'](f.pair, f.project, f.thread, f.messages).size, 0);
    assert.ok(Object.values(f.config.receipts!).every((receipt) => !receipt.message?.id));
    f.messages.push({ id: 'unseen-native-id', role: 'user', text: 'same words' });
    assert.deepEqual(
      [...f.connector['sentMessages'](f.pair, f.project, f.thread, f.messages)],
      [['unseen-native-id', 'queue-unknown']],
    );
  }));

test('native pages arriving before an acknowledgement get an identity only after the handoff is confirmed', () =>
  fixture(async (f) => {
    let accept!: () => void;
    writable(f, async (_request, text) => {
      f.messages.push({ id: 'native-before-ack', role: 'user', text });
      await new Promise<void>((resolve) => {
        accept = resolve;
      });
    });
    const sending = prompt(f, 'waiting-for-ack', 'still pending');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.connector['sentMessages'](f.pair, f.project, f.thread, f.messages).size, 0);
    accept();
    await sending;
    assert.deepEqual(
      [...f.connector['sentMessages'](f.pair, f.project, f.thread, f.messages)],
      [['native-before-ack', 'waiting-for-ack']],
    );
  }));

test('async native stores establish the actual pre-send boundary and never normalize unrelated prompt text', () =>
  fixture(async (f) => {
    const nativeMessages: Message[] = [{ id: 'native-old', role: 'user', text: 'same words' }];
    const native = writable(f, async (_request, text) => {
      nativeMessages.push({ id: 'native-new', role: 'user', text: `Injected context\n${text}` });
    });
    native.messages = [];
    let reads = 0;
    native.readMessages = async () => {
      reads++;
      return { messages: nativeMessages.slice(), more: false };
    };
    await prompt(f, 'async-owner', 'same words');
    assert.equal(reads, 1);
    assert.equal(f.config.receipts!['pair:async-owner']?.message?.before, 'native-old');
    assert.equal(f.connector['sentMessages'](f.pair, f.project, f.thread, nativeMessages).size, 0);
    nativeMessages[1]!.text = 'same words';
    assert.deepEqual(
      [...f.connector['sentMessages'](f.pair, f.project, f.thread, nativeMessages)],
      [['native-new', 'async-owner']],
    );
  }));

test('older native attachments resolve by their sent-page origin after latest resumes and reject other scopes', (t) =>
  fixture(async (f) => {
    const older: Message = {
      id: 'older-native',
      role: 'assistant',
      text: 'Private older response\n'.repeat(400),
    };
    const newest: Message = { id: 'newest-native', role: 'assistant', text: 'Newest response' };
    const native = f.connector.discovery.locations.get(f.thread)!.live!;
    const anchors: Array<string | undefined> = [];
    let old = true;
    native.messages = [];
    native.readMessages = async (before) => {
      anchors.push(before);
      return { messages: before === older.id || old ? [older] : [newest], more: false };
    };
    const previous = await pageAfter(f, 'older-view');
    const file = previous.messages[0]!.full!;
    old = false;
    await pageAfter(f, 'latest-view');
    let sealed: Uint8Array | undefined;
    t.mock.method(globalThis, 'fetch', async (
      _url: Parameters<typeof fetch>[0],
      options?: RequestInit,
    ) => {
      sealed = options!.body as Uint8Array;
      return Response.json({ success: true, result: null });
    });
    await f.send({
      type: 'command',
      requestId: 'read-older-file',
      projectId: f.project,
      threadId: f.thread,
      action: { kind: 'attachment.read', id: file.id },
    });
    assert.equal(anchors.at(-1), older.id);
    assert.equal(
      Buffer.from(
        openAttachment(f.config.pairs[f.pair.id]!.key, f.pair.id, file.id, sealed!),
      ).toString(),
      older.text,
    );
    const seen = anchors.length;
    const command = {
      type: 'command' as const,
      requestId: 'other-scope',
      projectId: f.project,
      threadId: f.thread,
      action: { kind: 'attachment.read' as const, id: file.id },
    };
    await assert.rejects(
      f.connector['command']({ ...f.pair, id: 'another-phone' }, command),
      /another conversation/,
    );
    const other = f.connector.discovery.observe({
      ...native,
      id: 'other-session',
      cwd: `${f.path}.other`,
    });
    await assert.rejects(
      f.connector['command'](f.pair, {
        ...command,
        projectId: other.project.id,
        threadId: other.thread.id,
      }),
      /another conversation/,
    );
    assert.equal(anchors.length, seen);
    assert.equal(JSON.stringify([...f.connector['attachmentOrigins']]).includes(older.text), false);
    f.connector.activePairs = () => [];
    f.connector['acceptPairings']([]);
    assert.equal(f.connector['attachmentOrigins'].size, 0);
  }));

test('attachment origins retain only bounded routing metadata from pages sent to the phone', () =>
  fixture(async (f) => {
    for (let batch = 0; batch < 18; batch++) {
      f.messages.splice(
        0,
        f.messages.length,
        ...Array.from({ length: 30 }, (_, index): Message => ({
          id: `${batch}-${index}`,
          role: 'assistant',
          text: '',
          attachments: Array.from({ length: 4 }, (_, file) => ({
            id: `${batch}-${index}-${file}`,
            mime: 'text/plain',
            bytes: 1,
          })),
        })),
      );
      await pageAfter(f, `origin-batch-${batch}`);
    }
    assert.equal(f.connector['attachmentOrigins'].size, 2_048);
    assert.ok(
      [...f.connector['attachmentOrigins'].values()].every(
        (origin) => Object.keys(origin).sort().join() === 'message,pairing,project,thread',
      ),
    );
    assert.equal(JSON.stringify(f.config).includes('attachmentOrigins'), false);
  }));

test('an unreadable baseline preserves sending without recording a misleading empty-history proof', () =>
  fixture(async (f) => {
    let sends = 0;
    const native = writable(f, async () => {
      sends++;
    });
    native.readMessages = async () => {
      throw new Error('Native history temporarily unavailable');
    };
    await prompt(f, 'no-baseline', 'same words');
    assert.equal(sends, 1);
    assert.equal(f.config.receipts!['pair:no-baseline']?.message, undefined);
    assert.equal(f.config.receipts!['pair:no-baseline']?.result?.ok, true);
  }));
