import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer as httpServer } from 'node:http';
import { createServer as ipcServer } from 'node:net';
import { mkdir, mkdtemp, rm, chmod, symlink, readFile, writeFile } from 'node:fs/promises';

import { WebSocketServer } from 'ws';
import { HISTORY_TEXT_CHARS } from '@dashup/protocol';
import { CHAT_PAGE_TEXT_CHARS } from '@dashup/protocol/session';

import { T3, t3Origin } from '../src/harness/t3';
import { Orca, orcaFingerprint } from '../src/harness/orca';
import { chatPage, chatPosition } from '../src/chat';

// =============================================================================
// Published workbench contracts; fixtures run with no provider or workbench launcher
// =============================================================================

function environment(values: Record<string, string | undefined>): () => void {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const until = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= until) throw new Error('The native fixture did not receive its bounded read');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function orcaFixture(count = 90, withApproval = true, longText = false) {
  const root = await mkdtemp(join(tmpdir(), 'dashup-orca-'));
  const endpoint = join(root, 'runtime.sock');
  const path = join(root, 'orca-runtime.json');
  const calls: any[] = [];
  const runtimeId = 'orca-native-runtime';
  const authToken = 'fixture-local-credential';
  let wrongRuntime = false;
  let pending = withApproval;
  let paused = false;
  const replies: (() => void)[] = [];
  const rows = Array.from({ length: count }, (_, index) => ({
    itemId: `native-item-${index + 1}`,
    sequence: index + 1,
    revision: 3,
    observedAt: index,
    body: {
      kind: 'message',
      role: index % 2 ? 'assistant' : 'user',
      blocks: [
        {
          type: 'text',
          text:
            longText && index === count - 1
              ? 'Long Orca response. '.repeat(4_000)
              : longText && index >= count - 3
                ? 'Native Orca fragment. '.repeat(500).slice(0, 9_000)
                : `Message ${index + 1}`,
        },
      ],
    },
  }));
  const approval = {
    itemId: 'native-approval',
    sequence: count + 1,
    revision: 7,
    observedAt: 91,
    body: {
      kind: 'approval',
      title: 'Run unit tests',
      detail: 'pnpm test',
      options: [{ id: 'allow_once', label: 'Allow once' }],
      resolution: { state: 'pending' },
    },
  };
  const server = ipcServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let next: number;
      while ((next = buffer.indexOf('\n')) >= 0) {
        const request = JSON.parse(buffer.slice(0, next));
        buffer = buffer.slice(next + 1);
        calls.push(request);
        assert.equal(request.authToken, authToken);
        let result: any;
        if (request.method === 'worktree.ps')
          result = {
            worktrees: [
              { worktreeId: 'workspace-native', path: '/fixture/project', hostId: 'local' },
            ],
          };
        else if (request.method === 'session.tabs.listAll')
          result = {
            snapshots: [
              {
                worktree: 'workspace-native',
                tabs: [
                  {
                    type: 'agent-session',
                    sessionId: 'agent-session-native',
                    title: 'Existing Orca chat',
                    chatStatus: { state: 'working', updatedAt: 1_000 },
                  },
                ],
              },
            ],
          };
        else if (request.method === 'agentSession.history') {
          assert.equal(request.params.sessionId, 'agent-session-native');
          assert.equal(request.params.limit, 30);
          const available: any[] = pending ? [...rows, approval] : rows;
          const entries =
            request.params.direction === 'before'
              ? available.filter((row) => row.sequence < request.params.cursor.sequence)
              : available;
          const items = entries.slice(-request.params.limit);
          result = {
            ok:
              request.params.direction !== 'before' ||
              request.params.cursor.sequence <= available.at(-1).sequence,
            page: {
              sessionId: 'agent-session-native',
              epoch: 'native-epoch',
              fence: 5,
              items,
              hasOlder: entries.length > items.length,
              window: { nextCursor: { epoch: 'native-epoch', sequence: items[0]?.sequence ?? 0 } },
            },
          };
          if (!result.ok) result.reset = 'cursor_ahead';
        } else if (
          request.method === 'agentSession.send' ||
          request.method === 'agentSession.cancel' ||
          request.method === 'agentSession.respondToApproval'
        ) {
          assert.equal(request.params.envelope.expectedRuntimeFence, 5);
          assert.equal(request.params.envelope.sessionId, 'agent-session-native');
          assert.match(request.params.envelope.clientOperationId, /^\d{13}-[a-f0-9]{32}$/);
          if (request.method === 'agentSession.respondToApproval') pending = false;
          result = { ok: true, value: {} };
        } else throw new Error(`Unexpected native method ${request.method}`);
        const reply = () =>
          socket.write(
            `${JSON.stringify({ id: request.id, ok: true, result, _meta: { runtimeId: wrongRuntime ? 'other-runtime' : runtimeId } })}\n`,
          );
        if (paused && request.method === 'agentSession.history') replies.push(reply);
        else reply();
      }
    });
  });
  server.listen(endpoint);
  await once(server, 'listening');
  await chmod(endpoint, 0o600);
  const record = {
    runtimeId,
    pid: process.pid,
    transports: [{ kind: 'unix', endpoint }],
    authToken,
    startedAt: Date.now(),
  };
  await writeFile(path, JSON.stringify(record), { mode: 0o600 });
  const restore = environment({ DASHUP_LIVE_DISCOVERY: '0', DASHUP_ORCA_DISCOVERY_PATH: path });
  return {
    root,
    path,
    calls,
    record,
    pauseHistory: () => {
      paused = true;
    },
    replyHistory: () => {
      paused = false;
      for (const reply of replies.splice(0)) reply();
    },
    setWrongRuntime: () => {
      wrongRuntime = true;
    },
    close: async () => {
      restore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test(
  'Orca discovers only existing native sessions, reads bounded tail/before pages, and preserves native mutation fences',
  { skip: process.platform === 'win32' },
  async () => {
    const fixture = await orcaFixture();
    const adapter = new Orca(() => {});
    try {
      const [session] = await adapter.refresh();
      assert.equal(session?.id, 'agent-session-native');
      assert.equal(session?.harness, 'orca');
      assert.equal(session?.cwd, '/fixture/project');
      assert.equal(session?.status, 'working');
      assert.deepEqual(session?.messages, []);
      assert.deepEqual(fixture.calls.map((call) => call.method).sort(), [
        'session.tabs.listAll',
        'worktree.ps',
      ]);
      const latest = await session!.readMessages!();
      assert.equal(latest.messages.length, 29);
      assert.equal(latest.more, true);
      assert.match(latest.messages.at(-1)!.id, /native-item-90/);
      const older = await session!.readMessages!(latest.messages[0]!.id);
      assert.equal(older.messages.at(-1)!.id, latest.messages[0]!.id);
      assert.equal(older.messages.length, 30);
      assert.equal(older.more, true);
      assert.ok(
        Number(JSON.parse(older.messages[0]!.id)[1]) <
          Number(JSON.parse(latest.messages[0]!.id)[1]),
      );
      assert.equal(session!.approvals[0]?.title, 'Run unit tests');
      await Promise.all([
        session!.send!('send-native', 'Continue on my phone'),
        session!.send!('send-native', 'Continue on my phone'),
      ]);
      const send = fixture.calls.filter((call) => call.method === 'agentSession.send');
      assert.equal(send.length, 1);
      assert.equal(send[0].params.body.role, 'user');
      assert.equal(
        send[0].params.envelope.payloadFingerprint,
        orcaFingerprint('agentSession.send', session!.id, { body: send[0].params.body }),
      );
      await assert.rejects(session!.send!('send-native', 'Different message'), /already used/);
      await session!.stop!('stop-native');
      await session!.approve!('approval-native', session!.approvals[0]!.id, {
        choice: 'allow_once',
      });
      const approval = fixture.calls.find(
        (call) => call.method === 'agentSession.respondToApproval',
      );
      assert.equal(approval.params.itemId, 'native-approval');
      assert.equal(approval.params.expectedRevision, 7);
      assert.equal(
        approval.params.envelope.payloadFingerprint,
        orcaFingerprint('agentSession.respondTo:approval', session!.id, {
          itemId: 'native-approval',
          expectedRevision: 7,
          optionId: 'allow_once',
        }),
      );
      assert.ok(!fixture.calls.some((call) => /create|attach|ensure|launch/i.test(call.method)));
    } finally {
      adapter.stop();
      await fixture.close();
    }
  },
);

test(
  'Orca refuses public/symlink discovery credentials, stale processes, and a different answering runtime',
  { skip: process.platform === 'win32' },
  async () => {
    const fixture = await orcaFixture();
    const adapter = new Orca(() => {});
    try {
      await chmod(fixture.path, 0o644);
      assert.deepEqual(await adapter.refresh(), []);
      assert.equal(fixture.calls.length, 0);
      await chmod(fixture.path, 0o600);
      await writeFile(fixture.path, JSON.stringify({ ...fixture.record, pid: 2_147_483_647 }));
      assert.deepEqual(await adapter.refresh(), []);
      assert.equal(fixture.calls.length, 0);
      await writeFile(fixture.path, JSON.stringify(fixture.record));
      const linked = join(fixture.root, 'linked.json');
      await symlink(fixture.path, linked);
      const restore = environment({ DASHUP_ORCA_DISCOVERY_PATH: linked });
      try {
        assert.deepEqual(await adapter.refresh(), []);
        assert.equal(fixture.calls.length, 0);
      } finally {
        restore();
      }
      fixture.setWrongRuntime();
      assert.deepEqual(await adapter.refresh(), []);
    } finally {
      adapter.stop();
      await fixture.close();
    }
  },
);

test(
  'Orca keeps whole-message previews and page anchors and rejects a read released during flight',
  { skip: process.platform === 'win32' },
  async () => {
    const fixture = await orcaFixture(40, false, true);
    let changes = 0;
    const adapter = new Orca(() => {
      changes++;
    });
    try {
      const [session] = await adapter.refresh();
      const latest = await session!.readMessages!();
      const target = {
        project: 'orca-project',
        thread: 'orca-thread',
        updatedAt: session!.updatedAt,
      };
      const key = '01'.repeat(32);
      const fragment = chatPage(
        key,
        target,
        latest.messages,
        undefined,
        undefined,
        '',
        latest.more,
      );
      const complete = latest.messages.at(-1)!.text;
      const preview = fragment.messages.at(-1)!;
      assert.ok(complete.length > CHAT_PAGE_TEXT_CHARS);
      assert.equal(preview.text, complete.slice(0, HISTORY_TEXT_CHARS));

      assert.equal(preview.full?.bytes, Buffer.byteLength(complete));
      assert.match(preview.full!.id, /^[a-f0-9]{64}$/);
      assert.ok(fragment.before);
      assert.equal(
        new Set(fragment.messages.map((message) => message.id)).size,
        fragment.messages.length,
      );
      const anchor = chatPosition(key, target, fragment.before!);
      const page = await session!.readMessages!(anchor);
      assert.ok(page.messages.some((message) => message.id === anchor));
      const older = chatPage(key, target, page.messages, fragment.before, undefined, '', page.more);
      assert.ok(older.messages.length);
      assert.notEqual(older.messages.at(-1)!.id, fragment.messages[0]!.id);

      fixture.pauseHistory();
      const pending = session!.readMessages!();
      const rejected = assert.rejects(pending, /no longer selected/);
      await waitFor(
        () => fixture.calls.filter((call) => call.method === 'agentSession.history').length === 3,
      );
      session!.releaseMessages!();
      fixture.replyHistory();
      await rejected;
      assert.deepEqual(session!.approvals, []);
      await new Promise((resolve) => setTimeout(resolve, 450));
      assert.equal(changes, 0);
    } finally {
      adapter.stop();
      fixture.replyHistory();
      await fixture.close();
    }
  },
);

async function t3Fixture(count = 3, longText = false) {
  const root = await mkdtemp(join(tmpdir(), 'dashup-t3-'));
  await mkdir(join(root, 'userdata'));
  const calls: { path: string; authorization?: string }[] = [];
  const commands: any[] = [];
  const token = 'fixture-t3-bearer';
  const item = (id: number) => ({
    position: id,
    visibility: 'local',
    sourceThreadId: 'native-t3-thread',
    sourceItemId: `native-t3-item-${id}`,
    item: {
      id: `native-t3-item-${id}`,
      type: id % 2 ? 'user_message' : 'assistant_message',
      text:
        longText && id === 10 + count
          ? 'Long native answer. '.repeat(4_000)
          : longText && id === 8
            ? 'Earlier native attachment. '.repeat(300)
            : longText && id >= 8 + count
              ? 'Native T3 fragment. '.repeat(500).slice(0, 9_000)
              : `Native T3 message ${id}`,
    },
  });
  const server = httpServer((request, response) => {
    calls.push({ path: request.url!, authorization: request.headers.authorization });
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(request.headers['x-t3-orchestration-protocol'], '2');
    response.setHeader('content-type', 'application/json');
    if (request.url?.startsWith('/api/orchestration/shell?'))
      response.end(
        JSON.stringify({
          projects: [{ id: 'native-project', workspaceRoot: '/fixture/t3-project' }],
          threads: [
            {
              id: 'native-t3-thread',
              projectId: 'native-project',
              title: 'T3 native chat',
              updatedAt: new Date(1000).toISOString(),
              activeRunId: 'native-run',
              status: 'running',
            },
          ],
        }),
      );
    else if (request.url === '/api/orchestration/threads/native-t3-thread/bounded')
      response.end(
        JSON.stringify({
          historyCursor: 'opaque-native-cursor',
          hasMoreHistory: true,
          projection: {
            thread: { id: 'native-t3-thread' },
            visibleTurnItems: Array.from({ length: count }, (_, index) => item(11 + index)),
            runtimeRequests: [
              { id: 't3-native-approval', status: 'pending', responseCapability: { type: 'live' } },
            ],
            turnItems: [
              {
                type: 'approval_request',
                requestId: 't3-native-approval',
                prompt: 'Run pnpm test',
                options: [{ decision: 'accept', label: 'Allow once' }],
              },
            ],
          },
        }),
      );
    else if (
      request.url ===
      '/api/orchestration/threads/native-t3-thread/history?cursor=opaque-native-cursor'
    )
      response.end(
        JSON.stringify({
          items: [item(8), item(9), item(10)],
          nextCursor: 'opaque-older-native-cursor',
          hasMoreHistory: true,
        }),
      );
    else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  const ws = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(request.url, '/ws?orchestrationProtocol=2');
    ws.handleUpgrade(request, socket, head, (client) => ws.emit('connection', client));
  });
  ws.on('connection', (client) =>
    client.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      assert.equal(frame._tag, 'Request');
      assert.equal(frame.tag, 'orchestration.dispatchCommand');
      commands.push(frame.payload);
      client.send(
        JSON.stringify({
          _tag: 'Exit',
          requestId: frame.id,
          exit: { _tag: 'Success', value: { sequence: commands.length } },
        }),
      );
    }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const path = join(root, 'userdata', 'server-runtime.json');
  const record = {
    version: 1,
    pid: process.pid,
    port: (server.address() as { port: number }).port,
    origin,
    startedAt: new Date().toISOString(),
  };
  await writeFile(path, JSON.stringify(record), { mode: 0o644 });
  const auth = join(root, 'dashup-auth.json');
  await writeFile(
    auth,
    JSON.stringify({ origin, token, expiresAt: new Date(Date.now() + 600_000).toISOString() }),
    { mode: 0o600 },
  );
  const restore = environment({
    DASHUP_LIVE_DISCOVERY: '0',
    DASHUP_T3_BASE_DIR: root,
    DASHUP_T3_AUTH_FILE: auth,
  });
  return {
    root,
    auth,
    token,
    path,
    origin,
    calls,
    commands,
    record,
    close: async () => {
      restore();
      for (const client of ws.clients) client.terminate();
      ws.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('T3 Code attaches through authenticated native metadata and pages bounded history without importing or launching', async () => {
  const fixture = await t3Fixture();
  const adapter = new T3(() => {});
  try {
    const [session] = await adapter.refresh();
    assert.equal(session?.id, 'native-t3-thread');
    assert.equal(session?.harness, 't3');
    assert.equal(session?.cwd, '/fixture/t3-project');
    assert.equal(session?.status, 'working');
    assert.deepEqual(session?.messages, []);
    assert.equal(fixture.calls.length, 1);
    assert.match(fixture.calls[0]!.path, /^\/api\/orchestration\/shell\?/);
    const latest = await session!.readMessages!();
    assert.equal(latest.messages.length, 3);
    assert.equal(latest.more, true);
    const older = await session!.readMessages!(latest.messages[0]!.id);
    assert.equal(older.messages.length, 4);
    assert.equal(older.messages.at(-1)!.id, latest.messages[0]!.id);
    assert.match(older.messages[0]!.id, /native-t3-item-8/);
    await Promise.all([
      session!.send!('native-send', 'Continue'),
      session!.send!('native-send', 'Continue'),
    ]);
    assert.equal(fixture.commands.length, 1);
    assert.equal(fixture.commands[0].createdBy, 'user');
    assert.equal(fixture.commands[0].creationSource, 'mobile');
    assert.equal(fixture.commands[0].threadId, 'native-t3-thread');
    assert.equal(fixture.commands[0].dispatchMode.type, 'queue_after_active');
    await session!.stop!('native-stop');
    assert.equal(fixture.commands[1].runId, 'native-run');
    await session!.approve!('native-approve', 't3-native-approval', { choice: 'accept' });
    assert.equal(fixture.commands[2].requestId, 't3-native-approval');
    assert.ok(fixture.calls.every((call) => /\/shell\?|\/bounded$|\/history\?/.test(call.path)));
    adapter.stop();
    await assert.rejects(session!.readMessages!(), /no longer available/);
  } finally {
    adapter.stop();
    await fixture.close();
  }
});

test(
  'T3 Code obtains only a short scoped local auth session and coalesces discovery without dispatching work',
  { skip: process.platform === 'win32' },
  async () => {
    const fixture = await t3Fixture();
    const cli = join(fixture.root, 't3-cli.mjs');
    const argsFile = join(fixture.root, 'auth-arguments.json');
    await writeFile(
      cli,
      `#!/usr/bin/env node\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({ token: ${JSON.stringify(fixture.token)}, expiresAt: new Date(Date.now()+600000).toISOString() }));\n`,
      { mode: 0o700 },
    );
    const restore = environment({ DASHUP_T3_AUTH_FILE: undefined, DASHUP_T3_CLI: cli });
    const adapter = new T3(() => {});
    try {
      const first = adapter.refresh();
      assert.equal(adapter.refresh(), first);
      const [session] = await first;
      assert.equal(session?.id, 'native-t3-thread');
      const args = JSON.parse(await readFile(argsFile, 'utf8'));
      assert.deepEqual(args, [
        'auth',
        'session',
        'issue',
        '--base-dir',
        fixture.root,
        '--scope',
        'orchestration:read',
        '--scope',
        'orchestration:operate',
        '--ttl',
        '10m',
        '--label',
        'Dashup local connector',
        '--json',
      ]);
      assert.ok(!args.includes(fixture.token));
      assert.equal(fixture.commands.length, 0);
      assert.equal(fixture.calls.length, 1);
      assert.deepEqual(session!.messages, []);
      assert.equal(await adapter.refresh().then((sessions) => sessions[0]), session);
      assert.equal(fixture.commands.length, 0);
    } finally {
      adapter.stop();
      restore();
      await fixture.close();
    }
  },
);

test('T3 Code refuses nonlocal endpoints, writable runtime metadata, and public bearer credentials', async () => {
  for (const url of [
    'https://example.com',
    'http://192.168.1.8:3773',
    'http://localhost:3773/path',
    'http://user:pass@127.0.0.1:3773',
    'http://127.0.0.1:3773?token=x',
  ])
    assert.throws(() => t3Origin(url));
  assert.equal(t3Origin('http://localhost:3773'), 'http://127.0.0.1:3773');
  const fixture = await t3Fixture();
  const adapter = new T3(() => {});
  try {
    if (process.platform !== 'win32') {
      await chmod(fixture.path, 0o666);
      assert.deepEqual(await adapter.refresh(), []);
      assert.equal(fixture.calls.length, 0);
      await chmod(fixture.path, 0o644);
      await chmod(fixture.auth, 0o644);
      assert.deepEqual(await adapter.refresh(), []);
      assert.equal(fixture.calls.length, 0);
      await chmod(fixture.auth, 0o600);
    }
    await writeFile(
      fixture.auth,
      JSON.stringify({
        origin: 'http://127.0.0.1:1',
        token: 'wrong-native-token',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      }),
    );
    assert.deepEqual(await adapter.refresh(), []);
    assert.equal(fixture.calls.length, 0);
    await writeFile(
      fixture.path,
      JSON.stringify({ ...fixture.record, origin: 'http://example.com:3773', port: 3773 }),
    );
    assert.deepEqual(await adapter.refresh(), []);
    assert.equal(fixture.calls.length, 0);
  } finally {
    adapter.stop();
    await fixture.close();
  }
});

test('T3 bounded windows page locally before requesting older native history and retain message anchors', async () => {
  const fixture = await t3Fixture(80, true);
  let changes = 0;
  const adapter = new T3(() => {
    changes++;
  });
  try {
    const [session] = await adapter.refresh();
    const latest = await session!.readMessages!();
    assert.equal(latest.messages.length, 30);
    assert.equal(latest.more, true);
    assert.match(latest.messages[0]!.id, /native-t3-item-61/);
    const target = {
      project: 'fixture-project',
      thread: 'fixture-thread',
      updatedAt: session!.updatedAt,
    };
    const key = Buffer.alloc(32, 1).toString('hex');
    const fragment = chatPage(key, target, latest.messages, undefined, undefined, '', latest.more);
    const complete = latest.messages.at(-1)!.text;
    const preview = fragment.messages.at(-1)!;
    assert.ok(complete.length > CHAT_PAGE_TEXT_CHARS);
    assert.equal(preview.text, complete.slice(0, HISTORY_TEXT_CHARS));

    assert.equal(preview.full?.bytes, Buffer.byteLength(complete));
    assert.match(preview.full!.id, /^[a-f0-9]{64}$/);
    assert.ok(fragment.before);
    assert.ok(fragment.messages[0]!.text.startsWith('Native'));
    const anchor = chatPosition(key, target, fragment.before!);
    const anchorPage = await session!.readMessages!(anchor);
    assert.ok(anchorPage.messages.some((message) => message.id === anchor));
    const previous = chatPage(
      key,
      target,
      anchorPage.messages,
      fragment.before,
      'older-fragment',
      '',
      anchorPage.more,
    );
    assert.ok(previous.messages.length);
    assert.ok(previous.before);
    assert.notEqual(previous.messages.at(-1)!.id, fragment.messages[0]!.id);

    const second = await session!.readMessages!(latest.messages[0]!.id);
    assert.equal(second.messages.length, 30);
    assert.match(second.messages[0]!.id, /native-t3-item-32/);
    const third = await session!.readMessages!(second.messages[0]!.id);
    assert.match(third.messages[0]!.id, /native-t3-item-11/);
    assert.equal(fixture.calls.filter((call) => call.path.includes('/history?')).length, 0);
    const fourth = await session!.readMessages!(third.messages[0]!.id);
    assert.match(fourth.messages[0]!.id, /native-t3-item-8/);
    assert.equal(fixture.calls.filter((call) => call.path.includes('/history?')).length, 1);
    const earlierMessage = fourth.messages[0]!;
    const earlierFile = chatPage(key, target, fourth.messages).messages[0]!.full!;
    const resumed = await session!.readMessages!();
    assert.equal(
      resumed.messages.some((message) => message.id === earlierMessage.id),
      false,
    );
    const reopened = await session!.readMessages!(earlierMessage.id);
    assert.equal(reopened.messages.at(-1)!.text, earlierMessage.text);
    assert.equal(
      chatPage(key, target, reopened.messages).messages.at(-1)!.full!.id,
      earlierFile.id,
    );
    assert.equal(fixture.calls.filter((call) => call.path.includes('/history?')).length, 2);
    session!.releaseMessages!();
    assert.deepEqual(session!.approvals, []);
    await session!.readMessages!();
    const afterRelease = await session!.readMessages!(earlierMessage.id);
    assert.equal(afterRelease.messages.at(-1)!.text, earlierMessage.text);
    assert.equal(
      chatPage(key, target, afterRelease.messages).messages.at(-1)!.full!.id,
      earlierFile.id,
    );
    session!.releaseMessages!();
    assert.deepEqual(session!.approvals, []);
    await new Promise((resolve) => setTimeout(resolve, 450));
    assert.equal(changes, 0);
  } finally {
    adapter.stop();
    await fixture.close();
  }
});
