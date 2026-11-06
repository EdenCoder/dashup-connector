import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { test } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { mkdir, mkdtemp, rm, chmod, symlink, writeFile } from 'node:fs/promises';

import { Cline, clineEndpoint } from '../src/harness/cline';
import { privateRecord } from '../src/harness/local-file';
import type { NativeAttachment } from '../src/harness/session';

// =============================================================================
// Native hub v1 fixtures
// =============================================================================

test(
  'local discovery records require a private current-user regular file within the byte limit',
  {
    skip: process.platform === 'win32',
  },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'dashup-private-record-'));
    const path = join(root, 'owner.json');
    try {
      await writeFile(path, 'private-native-credential', { mode: 0o600 });
      assert.equal(await privateRecord(path, 128), true);
      assert.equal(await privateRecord(path, 4), false);
      assert.equal(await privateRecord(root, 128), false);
      assert.equal(await privateRecord(join(root, 'missing'), 128), false);
      await chmod(path, 0o640);
      assert.equal(await privateRecord(path, 128), false);
      await chmod(path, 0o600);
      const uid = process.getuid!();
      context.mock.method(
        process as NodeJS.Process & { getuid(): number },
        'getuid',
        () => uid + 1,
      );
      assert.equal(await privateRecord(path, 128), false);
      context.mock.restoreAll();
      const link = join(root, 'linked.json');
      await symlink(path, link);
      assert.equal(await privateRecord(link, 128), false);
    } finally {
      context.mock.restoreAll();
      await rm(root, { recursive: true, force: true });
    }
  },
);

function environment(values: Record<string, string | undefined>): () => void {
  const prior = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const until = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('Native Cline event was not observed');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dashup-cline-'));
  const directory = join(root, 'locks', 'hub', 'owners');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'hub-native.json');
  const token = 'a'.repeat(64);
  const calls: any[] = [];
  const frames: any[] = [];
  const clients = new Set<WebSocket>();
  const requests: { headers: any; url?: string }[] = [];
  let sequence = 0;
  let pending = true;
  let content = 'Original Cline conversation';
  let failSend = false;
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const record = {
    hubId: 'hub-native',
    protocolVersion: 'v1',
    authToken: token,
    host: '127.0.0.1',
    port,
    url: `ws://127.0.0.1:${port}/`,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(path, JSON.stringify(record), { mode: 0o600 });
  function event(socket: WebSocket, name: string, payload: any = {}, sequenced = true) {
    socket.send(
      JSON.stringify({
        kind: 'event',
        envelope: {
          version: 'v1',
          event: name,
          sessionId: 'original-session',
          payload,
          ...(sequenced ? { sequence: ++sequence } : {}),
        },
      }),
    );
  }
  const approval = (
    socket: WebSocket,
    id = 'native-approval',
    inputJson = '{"command":"pnpm test"}',
  ) =>
    event(
      socket,
      'approval.requested',
      { approvalId: id, toolName: 'execute_command', inputJson },
      false,
    );
  server.on('connection', (socket, request) => {
    clients.add(socket);
    requests.push({ headers: request.headers, url: request.url });
    socket.on('close', () => clients.delete(socket));
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      frames.push(frame);
      if (frame.kind === 'stream.subscribe') {
        if (pending) approval(socket);
        return;
      }
      assert.equal(frame.kind, 'command');
      const command = frame.envelope;
      calls.push(command);
      let payload: any = {};
      if (command.command === 'client.register')
        payload = { client: { clientId: command.clientId } };
      else if (command.command === 'session.list')
        payload = {
          sessions: [
            {
              sessionId: 'original-session',
              workspaceRoot: '/original/project',
              cwd: '/original/project',
              updatedAt: 1_700_000_000_000,
              status: 'running',
              metadata: { prompt: 'Native work' },
            },
          ],
        };
      else if (command.command === 'session.messages')
        payload = {
          messages: [
            { id: 'user', role: 'user', content: [{ type: 'text', text: 'Original request' }] },
            {
              id: 'assistant',
              role: 'assistant',
              content: [
                { type: 'text', text: content },
                {
                  type: 'tool_use',
                  id: 'tool-native',
                  name: 'execute_command',
                  input: { command: 'pnpm test' },
                },
              ],
            },
            {
              id: 'tool',
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tool-native',
                  name: 'execute_command',
                  content: 'Tests passed',
                  is_error: false,
                },
              ],
            },
          ],
        };
      else if (command.command === 'session.send_input') {
        if (failSend) {
          socket.terminate();
          return;
        }
        // Native session.send_input replies only when the turn ends; run.started acknowledges dispatch.
        event(socket, 'run.started', { requestId: command.requestId });
        return;
      } else if (command.command === 'approval.respond') {
        pending = false;
        event(socket, 'approval.resolved', {
          approvalId: command.payload.approvalId,
          approved: command.payload.approved,
        });
      } else if (command.command !== 'run.abort')
        throw new Error(`Unexpected native command ${command.command}`);
      socket.send(
        JSON.stringify({
          kind: 'reply',
          envelope: {
            version: 'v1',
            requestId: command.requestId,
            ok: true,
            payload,
          },
        }),
      );
    });
  });
  const restore = environment({
    CLINE_DATA_DIR: root,
    CLINE_HUB_DISCOVERY_PATH: undefined,
    DASHUP_LIVE_DISCOVERY: undefined,
  });
  return {
    root,
    directory,
    path,
    record,
    calls,
    frames,
    clients,
    requests,
    approval,
    event,
    setContent(value: string) {
      content = value;
    },
    failSend() {
      failSend = true;
    },
    async close() {
      restore();
      for (const client of clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('Cline observes original hub sessions, streams and maps native commands without creating a runtime', async () => {
  const native = await fixture();
  let changes = 0;
  const cline = new Cline(() => {
    changes++;
  });
  try {
    let sessions = await cline.refresh();
    let session = sessions[0]!;
    assert.equal(sessions.length, 1);
    assert.equal(session.id, 'original-session');
    assert.equal(session.harness, 'cline');
    assert.equal(session.cwd, '/original/project');
    assert.equal(session.status, 'attention');
    assert.equal(session.title, 'Native work');
    assert.equal(session.messages[1]!.text, 'Original Cline conversation');
    assert.deepEqual(session.messages[2], {
      id: 'cline:tool:tool-native',
      role: 'tool',
      text: 'Tests passed',
      tool: {
        name: 'execute_command',
        summary: '{"command":"pnpm test"}',
        status: 'ok',
        input: session.messages[2]!.tool!.input,
      },
    });
    assert.deepEqual(
      JSON.parse((session.messages[2]!.tool!.input as NativeAttachment).read().toString()),
      { command: 'pnpm test' },
    );
    assert.equal(
      native.requests[0]!.headers['sec-websocket-protocol'],
      `cline-hub-auth.${native.record.authToken}`,
    );
    assert.equal(native.requests[0]!.url, '/');
    assert.deepEqual(
      native.calls.map((call) => call.command),
      ['client.register', 'session.list', 'session.messages'],
    );
    const socket = [...native.clients][0]!;
    const before = changes;
    native.event(socket, 'assistant.delta', { text: 'Live response' });
    await waitFor(() => changes > before);
    session = (await cline.refresh())[0]!;
    assert.equal(session.typing, 'Live response');
    const toolChange = changes;
    native.event(socket, 'tool.started', {
      toolCallId: 'stream-tool',
      toolName: 'read_file',
      input: { path: 'README.md' },
    });
    await waitFor(() => changes > toolChange);
    session = (await cline.refresh())[0]!;
    assert.equal(session.messages.at(-1)!.tool!.name, 'read_file');
    assert.equal(session.messages.at(-1)!.tool!.summary, '{"path":"README.md"}');
    const input = session.messages.at(-1)!.tool!.input as NativeAttachment;
    assert.deepEqual(JSON.parse(input.read().toString()), { path: 'README.md' });
    const finishedChange = changes;
    native.event(socket, 'tool.finished', {
      toolCallId: 'stream-tool',
      toolName: 'read_file',
      output: 'Native file contents',
    });
    await waitFor(() => changes > finishedChange);
    session = (await cline.refresh())[0]!;
    assert.equal(session.messages.at(-1)!.text, 'Native file contents');
    assert.equal(session.messages.at(-1)!.tool!.status, 'ok');
    assert.equal(session.messages.at(-1)!.tool!.input?.id, input.id);
    await Promise.all([
      session.send!('send-once', 'Carry on'),
      session.send!('send-once', 'Carry on'),
    ]);
    const sent = native.calls.filter((call) => call.command === 'session.send_input');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].sessionId, 'original-session');
    assert.deepEqual(sent[0].payload, { prompt: 'Carry on', delivery: 'queue' });
    await session.send!('steer-once', 'Do this first', true);
    assert.equal(
      native.calls.filter((call) => call.command === 'session.send_input')[1].payload.delivery,
      'steer',
    );
    await session.approve!('approve-once', 'native-approval', { choice: 'once' });
    await session.approve!('approve-once', 'native-approval', { choice: 'once' });
    assert.equal(native.calls.filter((call) => call.command === 'approval.respond').length, 1);
    assert.deepEqual(native.calls.find((call) => call.command === 'approval.respond').payload, {
      approvalId: 'native-approval',
      approved: true,
    });
    await assert.rejects(
      session.approve!('approve-again', 'native-approval', { choice: 'once' }),
      /no longer pending/,
    );
    await session.stop!('stop-once');
    await session.stop!('stop-once');
    assert.equal(native.calls.filter((call) => call.command === 'run.abort').length, 1);
    assert.ok(
      native.calls.every((call) => !/create|resume|detach|delete|configure/.test(call.command)),
    );
    assert.equal((await cline.refresh())[0]!.approvals.length, 0);
  } finally {
    cline.stop();
    await native.close();
  }
});

test('Cline reconnects the same session with a replay cursor and never retries an uncertain action', async () => {
  const native = await fixture();
  let changes = 0;
  const cline = new Cline(() => {
    changes++;
  });
  try {
    let session = (await cline.refresh())[0]!;
    native.event([...native.clients][0]!, 'assistant.delta', { text: 'Before disconnect' });
    await waitFor(() => changes > 0);
    native.failSend();
    await assert.rejects(session.send!('uncertain', 'One dispatch'), /disconnected/);
    await assert.rejects(session.stop!('stale-stop'), /disconnected/);
    native.setContent('Native reply while Dashup was offline');
    session = (await cline.refresh())[0]!;
    assert.equal(session.id, 'original-session');
    assert.equal(session.messages[1]!.text, 'Native reply while Dashup was offline');
    assert.equal(native.requests.length, 2);
    const subscriptions = native.frames.filter((frame) => frame.kind === 'stream.subscribe');
    assert.equal(subscriptions[1].sinceSequence, 1);
    const registrations = native.calls.filter((call) => call.command === 'client.register');
    assert.equal(registrations[0].clientId, registrations[1].clientId);
    assert.equal(session.approvals[0]!.id, 'native-approval');
    await assert.rejects(session.send!('uncertain', 'One dispatch'), /disconnected/);
    assert.equal(native.calls.filter((call) => call.command === 'session.send_input').length, 1);
    await session.approve!('reject-native', 'native-approval', { choice: 'reject' });
    assert.equal(
      native.calls.find((call) => call.command === 'approval.respond').payload.approved,
      false,
    );
  } finally {
    cline.stop();
    await native.close();
  }
});

test('Cline leaves unpreviewable approvals native and refuses unsupported choices', async () => {
  const native = await fixture();
  let changes = 0;
  const cline = new Cline(() => {
    changes++;
  });
  try {
    let session = (await cline.refresh())[0]!;
    await assert.rejects(
      session.approve!('always', 'native-approval', { choice: 'always' }),
      /reviewed on your computer/,
    );
    const before = changes;
    native.approval([...native.clients][0]!, 'large', 'x'.repeat(64 * 1024 + 1));
    await waitFor(() => changes > before);
    session = (await cline.refresh())[0]!;
    assert.deepEqual(session.approvals.find((value) => value.id === 'large')!.choices, []);
    await assert.rejects(
      session.approve!('large-approval', 'large', { choice: 'once' }),
      /reviewed on your computer/,
    );
    assert.equal(native.calls.filter((call) => call.command === 'approval.respond').length, 0);
  } finally {
    cline.stop();
    await native.close();
  }
});

test('Cline discovery rejects remote, credentialed, stale, symlinked and nonprivate owner records', async () => {
  for (const url of [
    'wss://example.com/',
    'ws://example.com/',
    'ws://0.0.0.0:25463/',
    'ws://127.0.0.1/?authToken=secret',
    'ws://user:secret@127.0.0.1/',
  ])
    assert.throws(() => clineEndpoint(url), /loopback/);
  assert.equal(clineEndpoint('ws://localhost:25463'), 'ws://127.0.0.1:25463/');
  assert.equal(clineEndpoint('ws://localhost:25463/hub'), 'ws://127.0.0.1:25463/hub');
  const native = await fixture();
  const cline = new Cline(() => {});
  try {
    await writeFile(native.path, JSON.stringify({ ...native.record, url: 'ws://example.com/' }));
    assert.deepEqual(await cline.refresh(), []);
    await writeFile(native.path, JSON.stringify({ ...native.record, pid: 2_147_483_647 }));
    assert.deepEqual(await cline.refresh(), []);
    await writeFile(native.path, JSON.stringify(native.record));
    await chmod(native.path, 0o644);
    if (process.getuid) assert.deepEqual(await cline.refresh(), []);
    await chmod(native.path, 0o600);
    await rm(native.path);
    const target = join(native.root, 'target.json');
    await writeFile(target, JSON.stringify(native.record), { mode: 0o600 });
    await symlink(target, native.path);
    assert.deepEqual(await cline.refresh(), []);
    assert.equal(native.requests.length, 0);
  } finally {
    cline.stop();
    await native.close();
  }
});

test('Cline supports the native explicit discovery path and close never stops the agent', async () => {
  const native = await fixture();
  const restore = environment({
    CLINE_HUB_DISCOVERY_PATH: native.path,
    DASHUP_LIVE_DISCOVERY: '0',
  });
  const cline = new Cline(() => {});
  try {
    assert.equal((await cline.refresh())[0]!.id, 'original-session');
    cline.stop();
    assert.deepEqual(await cline.refresh(), []);
    assert.equal(
      native.calls.some((call) => /abort|detach|unregister|shutdown/.test(call.command)),
      false,
    );
  } finally {
    cline.stop();
    restore();
    await native.close();
  }
});
