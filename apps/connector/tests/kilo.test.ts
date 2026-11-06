import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { mkdir, mkdtemp, rm, chmod, symlink, writeFile } from 'node:fs/promises';

import { Kilo } from '../src/harness/kilo';

// =============================================================================
// Published Kilo native API fixtures
// =============================================================================

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
  const until = Date.now() + 4_000;
  while (!predicate()) {
    if (Date.now() > until) throw new Error('Native Kilo update was not observed');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dashup-kilo-'));
  const path = join(root, 'daemon.json');
  const streams = new Set<ServerResponse>();
  const calls: { method: string; path: string; body?: any; auth?: string; directory?: string }[] =
    [];
  const sessions = new Map<string, any>([
    [
      'ses_native',
      {
        id: 'ses_native',
        projectID: 'project-native',
        title: 'Original Kilo work',
        location: { directory: '/original/project' },
        time: { created: 1_700_000_000_000, updated: 1_700_000_001_000 },
      },
    ],
  ]);
  let content = 'Original Kilo reply';
  let failPrompt = false;
  let permission = true;
  let question = true;
  let oversized = false;
  let edit = false;
  let healthRedirect = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    const path = url.pathname;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    calls.push({
      method: request.method!,
      path: url.pathname + url.search,
      body,
      auth: request.headers.authorization,
      directory: request.headers['x-kilo-directory'] as string | undefined,
    });
    if (path === '/api/event') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"id":"evt-connected","type":"server.connected","data":{}}\n\n');
      streams.add(response);
      response.on('close', () => streams.delete(response));
      return;
    }
    let value: any;
    if (path === '/global/health') {
      if (healthRedirect) {
        response.writeHead(302, { Location: 'https://example.com/private-content' });
        response.end();
        return;
      }
      value = { healthy: true, version: '7.8.18' };
    } else if (path === '/api/session' && request.method === 'GET') {
      assert.equal(url.searchParams.get('limit'), '100');
      value = { data: [...sessions.values()], cursor: {} };
    } else if (path === '/api/session' && request.method === 'POST') {
      const created = {
        id: 'ses_created',
        title: 'New Kilo work',
        location: body.location,
        time: { created: 1_700_000_003_000, updated: 1_700_000_003_000 },
      };
      sessions.set(created.id, created);
      value = { data: created };
    } else if (path === '/api/session/active')
      value = { data: { ses_native: { type: 'running' } } };
    else if (/^\/api\/session\/[^/]+\/message$/.test(path)) {
      assert.equal(url.searchParams.get('order'), 'desc');
      assert.equal(url.searchParams.get('limit'), '200');
      value = {
        data: [
          {
            id: 'msg_reply',
            type: 'assistant',
            time: { created: 1_700_000_001_000 },
            content: [
              { type: 'text', id: 'text-native', text: content },
              {
                type: 'tool',
                id: 'tool-native',
                name: 'bash',
                time: { created: 1_700_000_001_000 },
                state: {
                  status: 'completed',
                  input: { command: 'pnpm test' },
                  structured: {},
                  content: [{ type: 'text', text: 'Tests passed' }],
                },
              },
            ],
          },
          {
            id: 'msg_request',
            type: 'user',
            text: 'Original Kilo request',
            time: { created: 1_700_000_000_000 },
          },
        ],
        cursor: { next: 'older-native-page' },
      };
    } else if (/^\/api\/session\/[^/]+\/permission$/.test(path))
      value = {
        data: permission
          ? [
              {
                id: 'per_native',
                sessionID: 'ses_native',
                action: edit ? 'edit' : 'bash',
                resources: edit ? ['/original/project/README.md'] : ['pnpm test'],
                save: edit ? ['*'] : ['pnpm *'],
                metadata: oversized ? { diff: 'x'.repeat(70 * 1024) } : {},
              },
              {
                id: 'per_other',
                sessionID: 'ses_other',
                action: 'bash',
                resources: ['dangerous sibling command'],
              },
            ]
          : [],
      };
    else if (/^\/api\/session\/[^/]+\/question$/.test(path))
      value = {
        data: question
          ? [
              {
                id: 'que_native',
                sessionID: 'ses_native',
                questions: [
                  {
                    header: 'Color',
                    question: 'Which color?',
                    custom: false,
                    multiple: false,
                    options: [
                      { label: 'Green', description: 'Use green' },
                      { label: 'Red', description: 'Use red' },
                    ],
                  },
                ],
              },
            ]
          : [],
      };
    else if (/^\/api\/session\/[^/]+\/prompt$/.test(path)) {
      if (failPrompt) {
        request.socket.destroy();
        return;
      }
      value = {
        data: { messageID: body.id ?? 'msg_admitted', delivery: body.delivery ?? 'queue' },
      };
    } else if (/^\/api\/session\/[^/]+\/permission\/[^/]+\/reply$/.test(path)) {
      permission = false;
      response.writeHead(204);
      response.end();
      return;
    } else if (/^\/api\/session\/[^/]+\/question\/[^/]+\/(reply|reject)$/.test(path)) {
      question = false;
      response.writeHead(204);
      response.end();
      return;
    } else if (/^\/api\/session\/[^/]+\/interrupt$/.test(path)) {
      response.writeHead(204);
      response.end();
      return;
    } else {
      response.writeHead(404);
      response.end('{}');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(value));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const record = {
    pid: process.pid,
    hostname: '127.0.0.1',
    port,
    url: `http://127.0.0.1:${port}`,
    username: 'kilo',
    password: 'local-native-password',
    startedAt: new Date().toISOString(),
  };
  await writeFile(path, JSON.stringify(record), { mode: 0o600 });
  const restore = environment({ DASHUP_KILO_DAEMON: path, DASHUP_LIVE_DISCOVERY: '0' });
  return {
    root,
    path,
    record,
    calls,
    streams,
    setContent(text: string) {
      content = text;
    },
    oversize() {
      oversized = true;
    },
    editWithoutDiff() {
      edit = true;
    },
    failPrompt() {
      failPrompt = true;
    },
    redirect() {
      healthRedirect = true;
    },
    emit(event: any) {
      for (const stream of streams) stream.write(`data: ${JSON.stringify(event)}\n\n`);
    },
    async close() {
      restore();
      for (const stream of streams) stream.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('Kilo observes existing native sessions and maps messages, queue/steer, abort and approvals', async () => {
  const native = await fixture();
  const kilo = new Kilo(() => {});
  try {
    const session = (await kilo.refresh())[0]!;
    assert.equal(session.id, 'ses_native');
    assert.equal(session.harness, 'kilo');
    assert.equal(session.title, 'Original Kilo work');
    assert.equal(session.cwd, '/original/project');
    assert.equal(session.status, 'attention');
    assert.equal(session.messages[0]!.id, 'earlier');
    assert.equal(session.messages[1]!.text, 'Original Kilo request');
    assert.equal(session.messages[2]!.text, 'Original Kilo reply');
    assert.equal(session.messages[3]!.text, 'Tests passed');
    assert.equal(session.messages[3]!.tool!.name, 'bash');
    assert.equal(session.messages[3]!.tool!.status, 'ok');
    assert.equal(session.approvals.length, 2);
    assert.ok(
      session.approvals.find((item) => item.id === 'per_native')!.detail.includes('pnpm *'),
    );
    assert.equal(
      session.approvals.some((item) => item.id === 'per_other'),
      false,
    );
    assert.ok(native.calls.every((call) => call.method === 'GET'));
    await Promise.all([
      session.send!('send-once', 'Continue native work'),
      session.send!('send-once', 'Continue native work'),
    ]);
    await session.send!('steer-once', 'Do this first', true);
    const prompts = native.calls.filter((call) => call.path.endsWith('/prompt'));
    assert.equal(prompts.length, 2);
    assert.match(prompts[0]!.body.id, /^msg_[a-f0-9]{32}$/);
    assert.deepEqual(prompts[0]!.body.prompt, { text: 'Continue native work' });
    assert.equal(prompts[0]!.body.delivery, 'queue');
    assert.equal(prompts[1]!.body.delivery, 'steer');
    assert.equal(prompts[0]!.path, '/api/session/ses_native/prompt');
    await session.approve!('permission-once', 'per_native', { choice: 'always' });
    await session.approve!('permission-once', 'per_native', { choice: 'always' });
    assert.deepEqual(
      native.calls.find((call) => call.path.includes('/permission/per_native/reply'))!.body,
      { reply: 'always' },
    );
    assert.equal(
      native.calls.filter((call) => call.path.includes('/permission/per_native/reply')).length,
      1,
    );
    await session.approve!('question-once', 'question:que_native', { answers: [['Green']] });
    assert.deepEqual(
      native.calls.find((call) => call.path.includes('/question/que_native/reply'))!.body,
      { answers: [['Green']] },
    );
    await session.stop!('interrupt-once');
    await session.stop!('interrupt-once');
    assert.equal(native.calls.filter((call) => call.path.endsWith('/interrupt')).length, 1);
    assert.ok(
      native.calls.every(
        (call) =>
          call.auth === `Basic ${Buffer.from('kilo:local-native-password').toString('base64')}`,
      ),
    );
    assert.equal(prompts[0]!.directory, '/original/project');
    assert.equal(
      native.calls.some((call) => call.method === 'POST' && call.path === '/api/session'),
      false,
    );
    assert.equal(
      native.calls.some((call) => call.path.startsWith('/session') || call.path === '/api/info'),
      false,
    );
  } finally {
    kilo.stop();
    await native.close();
  }
});

test('Kilo re-reads original native sessions after event changes and avoids retrying uncertain actions', async () => {
  const native = await fixture();
  let changes = 0;
  const kilo = new Kilo(() => {
    changes++;
  });
  try {
    let session = (await kilo.refresh())[0]!;
    await waitFor(() => native.streams.size > 0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const streaming = changes;
    native.emit({
      id: 'stream-start',
      type: 'session.next.text.started',
      data: {
        sessionID: 'ses_native',
        assistantMessageID: 'msg_stream',
        textID: 'stream-text',
        timestamp: Date.now(),
      },
    });
    native.emit({
      id: 'stream-delta',
      type: 'session.next.text.delta',
      data: {
        sessionID: 'ses_native',
        assistantMessageID: 'msg_stream',
        textID: 'stream-text',
        delta: 'Working live',
        timestamp: Date.now(),
      },
    });
    await waitFor(() => changes > streaming);
    session = (await kilo.refresh())[0]!;
    assert.equal(session.typing, 'Working live');
    const before = changes;
    native.setContent('Reply written in native Kilo');
    native.emit({
      id: 'event-native',
      type: 'session.next.text.ended',
      data: {
        sessionID: 'ses_native',
        assistantMessageID: 'msg_reply',
        textID: 'text-native',
        text: 'Reply written in native Kilo',
        timestamp: Date.now(),
      },
    });
    await waitFor(() => changes > before);
    session = (await kilo.refresh())[0]!;
    assert.equal(session.id, 'ses_native');
    assert.equal(session.messages[2]!.text, 'Reply written in native Kilo');
    for (const stream of native.streams) stream.destroy();
    await waitFor(() => native.streams.size === 0);
    await waitFor(() => native.streams.size > 0);
    assert.equal((await kilo.refresh())[0]!.id, 'ses_native');
    native.failPrompt();
    await assert.rejects(session.send!('uncertain-send', 'Only dispatch once'));
    await assert.rejects(session.send!('uncertain-send', 'Only dispatch once'));
    assert.equal(native.calls.filter((call) => call.path.endsWith('/prompt')).length, 1);
  } finally {
    kilo.stop();
    await native.close();
  }
});

test('Kilo bounds native approval previews and validates native question answers', async () => {
  const native = await fixture();
  const kilo = new Kilo(() => {});
  try {
    native.oversize();
    const session = (await kilo.refresh())[0]!;
    const permission = session.approvals.find((item) => item.id === 'per_native')!;
    assert.equal(
      permission.choices.some((choice) => choice.id === 'once' || choice.id === 'always'),
      false,
    );
    await assert.rejects(
      session.approve!('oversized', 'per_native', { choice: 'once' }),
      /permission choice/,
    );
    await assert.rejects(
      session.approve!('wrong-custom', 'question:que_native', { answers: [['Blue']] }),
      /offered choices/,
    );
    await assert.rejects(
      session.approve!('wrong-multi', 'question:que_native', { answers: [['Green', 'Red']] }),
      /offered choices/,
    );
    await session.approve!('skip', 'question:que_native', { choice: 'skip' });
    assert.deepEqual(
      native.calls.find((call) => call.path.endsWith('/question/que_native/reject'))!.body,
      {},
    );
    await session.approve!('reject', 'per_native', { choice: 'reject' });
    assert.deepEqual(
      native.calls.find((call) => call.path.endsWith('/permission/per_native/reply'))!.body,
      { reply: 'reject' },
    );
  } finally {
    kilo.stop();
    await native.close();
  }
});

test('Kilo leaves edits without a full native diff for review on the computer', async () => {
  const native = await fixture();
  const kilo = new Kilo(() => {});
  try {
    native.editWithoutDiff();
    const session = (await kilo.refresh())[0]!;
    const approval = session.approvals.find((item) => item.id === 'per_native')!;
    assert.deepEqual(
      approval.choices.map((choice) => choice.id),
      ['reject'],
    );
    await assert.rejects(
      session.approve!('edit-once', 'per_native', { choice: 'once' }),
      /permission choice/,
    );
    await assert.rejects(
      session.approve!('edit-always', 'per_native', { choice: 'always' }),
      /permission choice/,
    );
    assert.equal(
      native.calls.some((call) => call.path.endsWith('/permission/per_native/reply')),
      false,
    );
  } finally {
    kilo.stop();
    await native.close();
  }
});

test('Kilo only creates a native session on explicit start and resumes the original id', async () => {
  const native = await fixture();
  const kilo = new Kilo(() => {});
  try {
    await kilo.refresh();
    assert.equal(
      native.calls.some((call) => call.method === 'POST'),
      false,
    );
    const id = await kilo.start('/new/project', 'Begin new work');
    assert.equal(id, 'ses_created');
    const create = native.calls.find(
      (call) => call.method === 'POST' && call.path === '/api/session',
    )!;
    assert.deepEqual(create.body, { location: { directory: '/new/project' } });
    assert.equal(create.directory, '/new/project');
    assert.deepEqual(
      native.calls.find((call) => call.path === '/api/session/ses_created/prompt')!.body.prompt,
      { text: 'Begin new work' },
    );
    await kilo.resume('ses_native', '/original/project', 'Continue original');
    assert.equal(
      native.calls.filter((call) => call.method === 'POST' && call.path === '/api/session').length,
      1,
    );
    assert.deepEqual(
      native.calls.find((call) => call.path === '/api/session/ses_native/prompt')!.body.prompt,
      { text: 'Continue original' },
    );
  } finally {
    kilo.stop();
    await native.close();
  }
});

test('Kilo discovery rejects unsafe, stale and symlinked daemon records without connecting', async () => {
  const native = await fixture();
  const kilo = new Kilo(() => {});
  try {
    for (const url of [
      'http://example.com',
      'http://0.0.0.0:4096',
      'http://user:secret@127.0.0.1:4096',
      'http://127.0.0.1:4096/?token=secret',
    ]) {
      await writeFile(native.path, JSON.stringify({ ...native.record, url }));
      assert.deepEqual(await kilo.refresh(), []);
    }
    await writeFile(native.path, JSON.stringify({ ...native.record, pid: 2_147_483_647 }));
    assert.deepEqual(await kilo.refresh(), []);
    await writeFile(native.path, JSON.stringify(native.record));
    await chmod(native.path, 0o644);
    if (process.getuid) assert.deepEqual(await kilo.refresh(), []);
    await chmod(native.path, 0o600);
    await rm(native.path);
    const target = join(native.root, 'target.json');
    await writeFile(target, JSON.stringify(native.record), { mode: 0o600 });
    await symlink(target, native.path);
    assert.deepEqual(await kilo.refresh(), []);
    assert.equal(await kilo.available(), false);
    assert.equal(native.calls.length, 0);
    await assert.rejects(kilo.start('/new/project', 'No daemon'), /daemon/);
  } finally {
    kilo.stop();
    await native.close();
  }
});

test('Kilo refuses HTTP redirects and closes observation without interrupting the agent', async () => {
  const native = await fixture();
  const kilo = new Kilo(() => {});
  try {
    native.redirect();
    await assert.rejects(kilo.refresh());
    kilo.stop();
    assert.deepEqual(await kilo.refresh(), []);
    assert.equal(
      native.calls.some((call) => call.method === 'POST'),
      false,
    );
  } finally {
    kilo.stop();
    await native.close();
  }
});

// =============================================================================
// Optional published binary reproduction
// =============================================================================

test(
  'published Kilo daemon exposes the same existing session without running an LLM',
  {
    skip: !process.env.DASHUP_KILO_CLI,
    timeout: 30_000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'dashup-kilo-native-'));
    const cwd = join(root, 'project');
    await mkdir(cwd);
    const config = join(root, 'config', 'kilo');
    await mkdir(config, { recursive: true });
    await writeFile(join(config, 'config.json'), JSON.stringify({ permission: { bash: 'ask' } }));
    const authorization = `Basic ${Buffer.from('kilo:native-smoke-password').toString('base64')}`;
    const child = spawn(
      process.env.DASHUP_KILO_CLI!,
      ['serve', '--hostname', '127.0.0.1', '--port', '0'],
      {
        cwd,
        env: {
          ...process.env,
          XDG_DATA_HOME: join(root, 'data'),
          XDG_STATE_HOME: join(root, 'state'),
          XDG_CONFIG_HOME: join(root, 'config'),
          XDG_CACHE_HOME: join(root, 'cache'),
          KILO_SERVER_USERNAME: 'kilo',
          KILO_SERVER_PASSWORD: 'native-smoke-password',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    let restore = () => {};
    const kilo = new Kilo(() => {});
    try {
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Native Kilo did not listen: ${output.slice(-2_000)}`)),
          15_000,
        );
        const read = (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-64 * 1024);
          const found = /kilo server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
          if (found) {
            clearTimeout(timer);
            resolve(found);
          }
        };
        child.stdout!.on('data', read);
        child.stderr!.on('data', read);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', () => {
          clearTimeout(timer);
          reject(new Error(`Native Kilo exited: ${output.slice(-2_000)}`));
        });
      });
      const native = async (path: string, body?: any): Promise<any> => {
        const response = await fetch(url + path, {
          method: body ? 'POST' : 'GET',
          headers: {
            Authorization: authorization,
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(4_000),
        });
        assert.ok(
          response.ok,
          `Native Kilo ${path} returned ${response.status}: ${await response.clone().text()}`,
        );
        return response.status === 204 ? {} : response.json();
      };
      assert.equal((await native('/global/health')).healthy, true);
      const created = await native('/api/session', { location: { directory: cwd } });
      const id = created.data.id;
      assert.ok(typeof id === 'string');
      // This native endpoint durably admits a user message without scheduling the agent loop.
      const admitted = await native(`/api/session/${encodeURIComponent(id)}/prompt`, {
        id: `msg_${randomUUID().replaceAll('-', '')}`,
        prompt: { text: 'Native user message without an LLM turn' },
        delivery: 'queue',
        resume: false,
      });
      assert.equal(admitted.data.sessionID, id);
      assert.equal(admitted.data.prompt.text, 'Native user message without an LLM turn');
      const daemonPath = join(root, 'daemon.json');
      await writeFile(
        daemonPath,
        JSON.stringify({
          pid: child.pid,
          url,
          username: 'kilo',
          password: 'native-smoke-password',
          startedAt: new Date().toISOString(),
        }),
        { mode: 0o600 },
      );
      restore = environment({ DASHUP_KILO_DAEMON: daemonPath, DASHUP_LIVE_DISCOVERY: '0' });
      const before = (await native('/api/session?limit=100')).data.length;
      assert.equal(await kilo.available(), true);
      const sessions = await kilo.refresh();
      const original = sessions.find((session) => session.id === id)!;
      assert.ok(original, `Native session ${id} was not observed`);
      assert.equal(original.cwd, cwd);
      assert.equal(original.harness, 'kilo');
      // Queued input stays outside the projected transcript until the agent promotes it.
      const projected = await native(
        `/api/session/${encodeURIComponent(id)}/message?limit=200&order=desc`,
      );
      assert.equal(original.messages.length, projected.data.length);
      assert.equal((await native('/api/session/active')).data[id], undefined);
      assert.equal((await native('/api/session?limit=100')).data.length, before);
      for (const choice of ['once', 'reject']) {
        // Native ask() stores a pending approval; no tool or command is executed here.
        const request = await native(`/api/session/${encodeURIComponent(id)}/permission`, {
          action: 'bash',
          resources: ['echo native-permission-only'],
          save: ['echo native-permission-only'],
        });
        assert.equal(request.data.effect, 'ask');
        const observed = (await kilo.refresh()).find((session) => session.id === id)!;
        const approval = observed.approvals.find((item) => item.id === request.data.id)!;
        assert.ok(approval, 'Native permission request should reach the existing thread');
        await observed.approve!(`native-permission-${choice}`, approval.id, { choice });
        const pending = await native(`/api/session/${encodeURIComponent(id)}/permission`);
        assert.equal(
          pending.data.some((item: any) => item.id === approval.id),
          false,
        );
      }
      assert.equal((await native('/api/session/active')).data[id], undefined);
      kilo.stop();
      assert.equal((await native('/global/health')).healthy, true);
      assert.equal((await native('/api/session?limit=100')).data.length, before);
    } finally {
      kilo.stop();
      restore();
      const exited =
        child.exitCode !== null || child.signalCode !== null
          ? Promise.resolve()
          : once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2_000);
      await exited;
      clearTimeout(timer);
      await rm(root, { recursive: true, force: true });
    }
  },
);
