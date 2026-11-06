import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { test } from 'node:test';
import { isStartHarness } from '@dashup/protocol';
import { Codex } from '../src/harness/codex';
import { Claude } from '../src/harness/claude';
import { agentHarness, type LiveSession } from '../src/harness/session';
import { LiveHarnesses } from '../src/harness/live';
import { localEndpoint } from '../src/harness/opencode';

// =============================================================================
// Existing native endpoint fixtures
// =============================================================================

test('live-only integrations keep native identities without gaining permission to launch sessions', () => {
  for (const name of ['cline', '@cline/core', 'pi-coding-agent']) {
    const harness = agentHarness(name);
    assert.ok(harness);
    assert.equal(isStartHarness(harness), false);
  }
  assert.equal(agentHarness('copilot'), undefined);
  assert.equal(agentHarness('decline'), undefined);
  assert.equal(agentHarness('kilocode'), 'kilo');
  assert.equal(agentHarness('junie'), 'junie');
});

test('OpenCode activity and controls come from the executing server when several servers list the same history', async () => {
  const live = new LiveHarnesses();
  const adapters = live as unknown as Record<string, { refresh?: () => Promise<LiveSession[]> }>;
  for (const adapter of Object.values(adapters))
    if (typeof adapter?.refresh === 'function') adapter.refresh = async () => [];
  const sent: string[] = [];
  const session = (owner: string, status: LiveSession['status']): LiveSession => ({
    id: 'shared-opencode-session',
    cwd: '/project',
    harness: 'opencode',
    status,
    updatedAt: '2026-10-30T00:00:00.000Z',
    messages: [],
    approvals: [],
    send: async () => {
      sent.push(owner);
    },
  });
  let native = session('service', 'idle');
  let other = session('other-server', 'working');
  adapters.service!.refresh = async () => [native];
  adapters.opencode!.refresh = async () => [session('idle-server', 'idle'), other];
  try {
    let [current] = await live.refresh();
    assert.equal(current, other);
    await current!.send!('running-reply', 'Continue');
    assert.deepEqual(sent, ['other-server']);
    other = session('other-server', 'attention');
    [current] = await live.refresh();
    assert.equal(current, other);
    native = session('service', 'working');
    other = session('other-server', 'idle');
    [current] = await live.refresh();
    assert.equal(current, native);
    native = session('service', 'idle');
    [current] = await live.refresh();
    assert.equal(current, native);
    assert.equal(current!.status, 'idle');
  } finally {
    live.stop();
  }
});

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

// A session whose record names nothing it ran with.
const unrecorded = () => ({});

async function waitFor(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Native event was not observed');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('existing OpenCode endpoint reads, observes, sends and resolves native controls without spawning or creating sessions', async () => {
  const streams = new Set<ServerResponse>();
  const calls: { method: string; path: string; body: any; directory?: string }[] = [];
  let permissions: any[] = [
    {
      id: 'perm_original',
      sessionID: 'ses_original',
      permission: 'bash',
      patterns: ['pnpm *'],
      metadata: {},
      always: ['pnpm *'],
      tool: { messageID: 'msg_native', callID: 'call_native' },
    },
  ];
  let questions: any[] = [];
  let statuses: Record<string, { type: string }> = {};
  const history: any[] = [
    {
      info: { id: 'msg_native', role: 'assistant' },
      parts: [
        { type: 'text', text: 'Original native conversation' },
        {
          type: 'tool',
          tool: 'bash',
          callID: 'call_native',
          state: {
            status: 'running',
            input: { command: 'pnpm test --filter native', workdir: '/original/project' },
          },
        },
      ],
    },
  ];
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url!, 'http://localhost').pathname;
    if (pathname === '/global/event') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write('data: {"payload":{"type":"server.connected"}}\n\n');
      streams.add(response);
      response.on('close', () => streams.delete(response));
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    calls.push({
      method: request.method!,
      path: pathname,
      body,
      directory: request.headers['x-opencode-directory'] as string,
    });
    let value: unknown;
    if (pathname === '/global/health') value = { healthy: true, version: '1.19.3' };
    else if (pathname === '/session' && request.method === 'GET')
      value = [
        {
          id: 'ses_original',
          directory: '/original/project',
          title: 'Native work',
          time: { updated: 1700000000000 },
        },
        {
          id: 'ses_sibling',
          directory: '/original/project',
          title: 'Sibling',
          time: { updated: 1700000000000 },
        },
        {
          id: 'ses_other',
          directory: '/other/project',
          title: 'Other project',
          time: { updated: 1700000000000 },
        },
      ];
    else if (pathname === '/session/status') value = statuses;
    else if (pathname === '/permission') value = permissions;
    else if (pathname === '/question') value = questions;
    else if (pathname === '/session/ses_original/message') value = history;
    else if (pathname === '/session/ses_original/prompt_async' && request.method === 'POST') {
      history.push({
        info: {
          id: body.messageID,
          role: 'user',
          agent: body.agent,
          model: body.model,
          variant: body.variant,
        },
        parts: body.parts,
      });
      response.writeHead(204).end();
      return;
    } else if (pathname === '/session/ses_original/abort' && request.method === 'POST') {
      statuses = {};
      value = true;
    } else if (pathname === '/permission/perm_original/reply') {
      permissions = [];
      value = true;
    } else if (pathname === '/permission/perm_blind/reply') {
      permissions = permissions.filter((permission) => permission.id !== 'perm_blind');
      value = true;
    } else if (pathname === '/question/q_original/reply') {
      questions = [];
      value = true;
    } else {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(value));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const restore = environment({
    DASHUP_LIVE_DISCOVERY: '0',
    DASHUP_CODEX_SOCKET: '',
    DASHUP_OPENCODE_ENDPOINT: `http://127.0.0.1:${address.port}`,
    DASHUP_OPENCODE_ENDPOINTS: undefined,
  });
  const live = new LiveHarnesses();
  let changes = 0;
  const unwatch = live.watch(() => {
    changes++;
  });
  try {
    const observed = await live.refresh();
    let [session] = observed;
    assert.deepEqual(
      observed.map((item) => item.id),
      ['ses_original', 'ses_sibling', 'ses_other'],
    );
    const commonPaths = ['/session/status', '/permission', '/question'];
    const commonReads = () => calls.filter((call) => commonPaths.includes(call.path));
    for (const directory of ['/original/project', '/other/project'])
      for (const path of commonPaths)
        assert.equal(
          commonReads().filter((call) => call.directory === directory && call.path === path).length,
          1,
        );
    // OpenCode's storage owns the conversation; only a pending permission needs its messages.
    assert.deepEqual(
      calls.filter((call) => call.path.endsWith('/message')).map((call) => call.path),
      ['/session/ses_original/message'],
    );
    assert.equal(session?.id, 'ses_original');
    assert.equal(session?.cwd, '/original/project');
    assert.deepEqual(session?.messages, []);
    assert.equal(session?.status, 'attention');
    assert.deepEqual(
      session?.approvals[0]?.choices.map((choice) => choice.id),
      ['once', 'always', 'reject'],
    );
    assert.match(session!.approvals[0]!.detail, /Command:\npnpm test --filter native/);
    assert.match(session!.approvals[0]!.detail, /Permission scope:\npnpm \*/);
    assert.match(session!.approvals[0]!.detail, /Always allow scope:\npnpm \*/);
    await session!.approve!('dashup-approval-1', 'perm_original', { choice: 'once' });
    await session!.approve!('dashup-approval-1', 'perm_original', { choice: 'once' });
    assert.equal(calls.filter((call) => call.path === '/permission/perm_original/reply').length, 1);
    await assert.rejects(
      session!.approve!('dashup-stale-approval', 'perm_original', { choice: 'once' }),
      /no longer pending/,
    );
    [session] = await live.refresh();
    assert.equal(session?.status, 'idle');
    await assert.rejects(session!.stop!('dashup-stop-idle'), /Nothing is running/);
    statuses = { ses_original: { type: 'busy' } };
    [session] = await live.refresh();
    assert.equal(session?.status, 'working');
    await session!.stop!('dashup-stop');
    await session!.stop!('dashup-stop');
    assert.deepEqual(
      calls
        .filter((call) => call.path.endsWith('/abort'))
        .map(({ method, path, directory }) => ({ method, path, directory })),
      [{ method: 'POST', path: '/session/ses_original/abort', directory: '/original/project' }],
    );
    [session] = await live.refresh();
    assert.equal(session?.status, 'idle');
    history.push({
      info: {
        id: 'msg_native_plan',
        role: 'user',
        agent: 'plan',
        model: { providerID: 'native-provider', modelID: 'native-model', variant: 'high' },
      },
      parts: [{ type: 'text', text: 'Continue in the original Plan agent' }],
    });
    await session!.send!('dashup-reply-1', 'Continue the same work');
    await session!.send!('dashup-reply-1', 'Continue the same work');
    const sent = calls.filter((call) => call.path.endsWith('/prompt_async'));
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.directory, '/original/project');
    assert.equal(sent[0]!.body.parts[0].text, 'Continue the same work');
    assert.equal(sent[0]!.body.agent, 'plan');
    assert.deepEqual(sent[0]!.body.model, {
      providerID: 'native-provider',
      modelID: 'native-model',
    });
    assert.equal(sent[0]!.body.variant, 'high');
    assert.match(sent[0]!.body.messageID, /^msg_/);
    history.push({ info: { id: 'msg_invalid_context', role: 'user', agent: '' }, parts: [] });
    await assert.rejects(
      session!.send!('dashup-invalid-context', 'Must not switch agents'),
      /current agent or model/,
    );
    assert.equal(calls.filter((call) => call.path.endsWith('/prompt_async')).length, 1);
    assert.equal(
      calls.filter((call) => call.method === 'POST' && call.path === '/session').length,
      0,
    );
    const diff = '--- handler.ts\n+++ handler.ts\n@@ -1 +1 @@\n-old\n+new\n';
    permissions = [
      {
        id: 'perm_edit',
        sessionID: 'ses_original',
        permission: 'edit',
        patterns: ['handler.ts'],
        always: ['*'],
        metadata: { filepath: '/original/project/handler.ts', diff },
      },
      {
        id: 'perm_blind',
        sessionID: 'ses_original',
        permission: 'bash',
        patterns: ['pnpm *'],
        always: ['pnpm *'],
        metadata: {},
        tool: { messageID: 'msg_native', callID: 'unrelated_call' },
      },
      {
        id: 'perm_large',
        sessionID: 'ses_original',
        permission: 'bash',
        patterns: ['*'],
        always: ['*'],
        metadata: { command: 'x'.repeat(70_000) },
      },
    ];
    [session] = await live.refresh();
    const edit = session!.approvals.find((approval) => approval.id === 'perm_edit')!;
    assert.deepEqual(edit.change, { path: '/original/project/handler.ts', diff });
    assert.deepEqual(
      edit.choices.map((choice) => choice.id),
      ['once', 'always', 'reject'],
    );
    for (const id of ['perm_blind', 'perm_large']) {
      const approval = session!.approvals.find((approval) => approval.id === id)!;
      assert.deepEqual(
        approval.choices.map((choice) => choice.id),
        ['reject'],
      );
      assert.match(approval.detail, /Review the full request on your computer/);
    }
    permissions[0].metadata = {};
    await assert.rejects(
      session!.approve!('dashup-missing-preview', 'perm_edit', { choice: 'once' }),
      /on your computer/,
    );
    assert.equal(
      calls.some((call) => call.path === '/permission/perm_edit/reply'),
      false,
    );
    await session!.approve!('dashup-reject-blind', 'perm_blind', { choice: 'reject' });
    assert.deepEqual(calls.find((call) => call.path === '/permission/perm_blind/reply')?.body, {
      reply: 'reject',
    });
    permissions = [];
    questions = [
      {
        id: 'q_original',
        sessionID: 'ses_original',
        questions: [
          {
            header: 'Choose',
            question: 'Which existing action?',
            options: [{ label: 'Continue', description: 'Continue work' }],
            multiple: false,
          },
        ],
      },
    ];
    await waitFor(() => streams.size > 0);
    const before = changes;
    const beforeReads = commonReads().length;
    for (const stream of streams)
      stream.write(
        'data: {"directory":"/original/project","payload":{"type":"message.part.updated","sessionID":"ses_sibling"}}\n\n',
      );
    await waitFor(() => changes > before);
    const refreshed = await live.refresh();
    [session] = refreshed;
    assert.equal(
      calls.some((call) => call.path === '/session/ses_sibling/message'),
      false,
    );
    assert.equal(commonReads().length - beforeReads, 6);
    assert.equal(refreshed.find((item) => item.id === 'ses_sibling')?.approvals.length, 0);
    assert.equal(session?.approvals[0]?.id, 'question:q_original');
    await session!.approve!('dashup-question-1', 'question:q_original', {
      answers: [['Continue']],
    });
    assert.deepEqual(calls.find((call) => call.path === '/question/q_original/reply')?.body, {
      answers: [['Continue']],
    });
    live.stop();
    await assert.rejects(
      session!.send!('dashup-after-disconnect', 'Must not send'),
      /disconnected/,
    );
    await assert.rejects(session!.stop!('dashup-stop-after-disconnect'), /disconnected/);
    assert.equal(calls.filter((call) => call.path.endsWith('/abort')).length, 1);
  } finally {
    unwatch();
    live.stop();
    restore();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('an OpenCode session shows the model and agent it runs with, and switches them on the session', async () => {
  const calls: { method: string; path: string; body: any }[] = [];
  let session: any = {
    id    : 'ses_native',
    agent : 'orchestrator',
    model : { providerID: 'kimi-for-coding', id: 'k3', variant: 'default' },
  };
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url!, 'http://localhost').pathname;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    calls.push({ method: request.method!, path: pathname, body });
    const routes: Record<string, unknown> = {
      '/global/health'               : { healthy: true, version: '1.19.3' },
      '/session'                     : [
        { id: 'ses_native', directory: '/project', title: 'Native' },
      ],
      '/session/status'              : {},
      '/permission'                  : [],
      '/question'                    : [],
      '/session/ses_native/message'  : [],
      '/api/session'                 : { data: [session] },
      '/api/session/ses_native'      : { data: session },
      '/api/model'                   : {
        data : [{ providerID: 'anthropic', id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }],
      },
      '/api/agent'                   : {
        data : [
          { id: 'build', mode: 'primary' },
          { id: 'explore', mode: 'subagent' },
          { id: 'title', mode: 'primary', hidden: true },
        ],
      },
    };
    if (request.method === 'POST') {
      if (pathname === '/api/session/ses_native/model') session = { ...session, model: body.model };
      if (pathname === '/api/session/ses_native/agent') session = { ...session, agent: body.agent };
      response.writeHead(204).end();
      return;
    }
    if (!(pathname in routes)) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(routes[pathname]));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const state = await mkdtemp(join(tmpdir(), 'dashup-opencode-state-'));
  const restore = environment({
    DASHUP_LIVE_DISCOVERY     : '0',
    DASHUP_CODEX_SOCKET       : '',
    DASHUP_OPENCODE_ENDPOINT  : `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    DASHUP_OPENCODE_ENDPOINTS : undefined,
    XDG_STATE_HOME            : state,
  });
  const live = new LiveHarnesses();
  try {
    let [native] = await live.refresh();
    // A model OpenCode does not list still names the session's own.
    assert.deepEqual(native!.options!(unrecorded), [
      {
        id      : 'model',
        name    : 'Model',
        value   : 'kimi-for-coding/k3',
        choices : [
          { value: 'anthropic/claude-haiku-5-5', name: 'Claude Haiku 5.5' },
          { value: 'kimi-for-coding/k3', name: 'k3' },
        ],
      },
      {
        id      : 'agent',
        name    : 'Agent',
        value   : 'orchestrator',
        choices : [
          { value: 'build', name: 'build' },
          { value: 'orchestrator', name: 'orchestrator' },
        ],
      },
    ]);
    await native!.configure!('dashup-model', 'model', 'anthropic/claude-haiku-5-5');
    await native!.configure!('dashup-agent', 'agent', 'build');
    assert.deepEqual(
      calls.filter((call) => call.method === 'POST').map(({ path, body }) => ({ path, body })),
      [
        {
          path : '/api/session/ses_native/model',
          body : { model: { providerID: 'anthropic', id: 'claude-haiku-5-5' } },
        },
        { path: '/api/session/ses_native/agent', body: { agent: 'build' } },
      ],
    );
    // A message from the phone goes in what the session now runs with.
    [native] = await live.refresh();
    await native!.send!('dashup-send', 'Carry on');
    const sent = calls.find((call) => call.path === '/session/ses_native/prompt_async')!.body;
    assert.deepEqual(
      [sent.agent, sent.model],
      ['build', { providerID: 'anthropic', modelID: 'claude-haiku-5-5' }],
    );
  } finally {
    restore();
    live.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(state, { recursive: true, force: true });
  }
});

test('OpenCode 2 sessions are reached through its background service, with its password', async () => {
  const state = await mkdtemp(join(tmpdir(), 'dashup-opencode-service-'));
  const posts: { path: string; body: any }[] = [];
  let running = true;
  const session = {
    id       : 'ses_v2',
    title    : 'Service work',
    agent    : 'orchestrator',
    model    : { providerID: 'kimi-for-coding', id: 'k3' },
    time     : { updated: 1700000000000 },
    location : { directory: '/project' },
  };
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url!, 'http://localhost').pathname;
    if (request.headers.authorization !== `Basic ${Buffer.from('opencode:pw').toString('base64')}`)
      return void response.writeHead(401).end();
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    if (request.method === 'POST' || request.method === 'DELETE') {
      posts.push({
        path: `${request.method} ${pathname}`,
        body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined,
      });
      return void response.writeHead(204).end();
    }
    const routes: Record<string, unknown> = {
      '/api/info'                : { version: '2.2.0', pid: 1, urls: [], paths: { tmp: '/tmp' } },
      '/api/session'             : { data: [session] },
      '/api/session/active'      : { data: running ? { ses_v2: { type: 'running' } } : {} },
      '/api/permission/request'  : {
        data : [{ id: 'per_1', sessionID: 'ses_v2', action: 'bash', resources: ['pnpm test'] }],
      },
      '/api/session/ses_v2/form' : {
        data : [
          {
            id     : 'frm_1',
            title  : 'Which colour?',
            fields : [
              {
                key     : 'colour',
                type    : 'multiselect',
                options : [
                  { value: 'blue', label: 'Blue' },
                  { value: 'red', label: 'Red' },
                ],
              },
            ],
          },
        ],
      },
      '/api/model'               : {
        data : [{ providerID: 'anthropic', id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' }],
      },
      '/api/agent'               : { data: [{ id: 'build', name: 'Build', mode: 'primary' }] },
    };
    if (pathname === '/api/event') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return void response.write('data: {"type":"server.connected"}\n\n');
    }
    if (!(pathname in routes)) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(routes[pathname]));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await writeFile(
    join(state, 'service.json'),
    JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid, password: 'pw' }),
  );
  // The models the person picked in OpenCode come first, named by its catalog.
  await mkdir(join(state, 'opencode'), { recursive: true });
  await writeFile(
    join(state, 'opencode/model.json'),
    JSON.stringify({
      recent: [{ providerID: 'anthropic', modelID: 'claude-haiku-5-5' }],
      favorite: [],
    }),
  );
  const restore = environment({
    DASHUP_LIVE_DISCOVERY     : '0',
    DASHUP_CODEX_SOCKET       : '',
    DASHUP_OPENCODE_ENDPOINT  : undefined,
    DASHUP_OPENCODE_ENDPOINTS : '[]',
    DASHUP_OPENCODE_SERVICE   : join(state, 'service.json'),
    XDG_STATE_HOME            : state,
  });
  const live = new LiveHarnesses();
  try {
    const [native] = await live.refresh();
    assert.equal(native?.id, 'ses_v2');
    assert.equal(native?.status, 'attention');
    assert.deepEqual(
      native!.approvals.map((approval) => [approval.id, approval.title]),
      [
        ['per_1', 'Allow bash?'],
        ['form:frm_1', 'Which colour?'],
      ],
    );
    assert.deepEqual(native!.options!(unrecorded)[0]!.choices, [
      { value: 'anthropic/claude-haiku-5-5', name: 'Claude Haiku 5.5' },
      { value: 'kimi-for-coding/k3', name: 'k3' },
    ]);
    // While it works, a message steers it at once or waits for its turn.
    await native!.send!('dashup-now', 'Stop and look here', true);
    await native!.send!('dashup-later', 'Then this');
    await native!.approve!('dashup-allow', 'per_1', { choice: 'once' });
    await native!.approve!('dashup-form', 'form:frm_1', { answers: [['Blue']] });
    await native!.configure!('dashup-model', 'model', 'anthropic/claude-haiku-5-5');
    await native!.stop!('dashup-stop');
    // A session the phone starts or answers goes to the service too.
    await live.resume('opencode', 'ses_v2', '/project', 'One more thing');
    assert.deepEqual(
      posts.map(({ path, body }) => [path, body && { ...body, id: undefined }]),
      [
        [
          'POST /api/session/ses_v2/prompt',
          { id: undefined, text: 'Stop and look here', delivery: 'steer' },
        ],
        [
          'POST /api/session/ses_v2/prompt',
          { id: undefined, text: 'Then this', delivery: 'queue' },
        ],
        ['POST /api/session/ses_v2/permission/per_1/reply', { id: undefined, decision: 'once' }],
        [
          'POST /api/session/ses_v2/form/frm_1/reply',
          { id: undefined, answer: { colour: ['blue'] } },
        ],
        [
          'POST /api/session/ses_v2/model',
          { id: undefined, model: { providerID: 'anthropic', id: 'claude-haiku-5-5' } },
        ],
        ['POST /api/session/ses_v2/interrupt', { id: undefined }],
        ['POST /api/session/ses_v2/prompt', { id: undefined, text: 'One more thing' }],
      ],
    );
  } finally {
    restore();
    live.stop();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(state, { recursive: true, force: true });
  }
});

test('local endpoint policy rejects remote hosts, URL credentials, path routing, query strings and redirects', async () => {
  for (const value of [
    'https://127.0.0.1:1234',
    'http://example.com:1234',
    'http://127.0.0.1.example.com',
    'http://user:secret@127.0.0.1',
    'http://127.0.0.1?token=secret',
    'http://127.0.0.1/other',
    'http://127.0.0.1/#secret',
  ])
    assert.throws(() => localEndpoint(value));
  assert.equal(localEndpoint('http://localhost:1234'), 'http://127.0.0.1:1234');
  let remoteRequests = 0;
  const remote = createServer((_request, response) => {
    remoteRequests++;
    response.end('{}');
  });
  remote.listen(0, '127.0.0.1');
  await once(remote, 'listening');
  const redirect = createServer((_request, response) =>
    response
      .writeHead(302, {
        Location: `http://127.0.0.1:${(remote.address() as { port: number }).port}`,
      })
      .end());
  redirect.listen(0, '127.0.0.1');
  await once(redirect, 'listening');
  const restore = environment({
    DASHUP_LIVE_DISCOVERY: '0',
    DASHUP_CODEX_SOCKET: '',
    DASHUP_OPENCODE_ENDPOINTS: JSON.stringify([
      `http://127.0.0.1:${(redirect.address() as { port: number }).port}`,
      'http://example.com',
    ]),
  });
  const live = new LiveHarnesses();
  try {
    assert.deepEqual(await live.refresh(), []);
    assert.equal(remoteRequests, 0);
  } finally {
    live.stop();
    restore();
    redirect.closeAllConnections();
    remote.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => redirect.close(() => resolve())),
      new Promise<void>((resolve) => remote.close(() => resolve())),
    ]);
  }
});

test(
  'existing Codex Unix socket observes loaded sessions and replies only to their native ids without resume or load',
  { skip: process.platform === 'win32' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dashup-codex-live-'));
    const path = join(directory, 'native.sock');
    const server = createServer();
    const websocket = new WebSocketServer({ server });
    const calls: any[] = [];
    let peer: WebSocket | undefined;
    let nativeStatus = 'idle';
    websocket.on('connection', (socket) => {
      peer = socket;
      socket.on('message', (data) => {
        const request = JSON.parse(data.toString());
        calls.push(request);
        let result: any;
        if (!request.method) return;
        if (request.method === 'initialize') result = { userAgent: 'codex-app-server/0.163.0' };
        else if (request.method === 'thread/loaded/list')
          result = { data: ['original-codex-id'], nextCursor: null };
        else if (request.method === 'thread/read')
          result = {
            thread: {
              id: 'original-codex-id',
              cwd: '/original/project',
              name: 'Native Codex',
              updatedAt: 1700000000,
              status: { type: nativeStatus },
              turns: [
                {
                  id: 'native-turn',
                  status: nativeStatus === 'active' ? 'inProgress' : 'completed',
                  items: [
                    {
                      id: 'native-message',
                      type: 'agentMessage',
                      text: 'Already running native conversation',
                    },
                  ],
                },
              ],
            },
          };
        else if (request.method === 'turn/start') result = { turn: { id: 'next-native-turn' } };
        else if (request.method === 'turn/interrupt') {
          nativeStatus = 'idle';
          result = {};
        } else if (request.method === 'initialized') return;
        else {
          socket.send(JSON.stringify({ id: request.id, error: { code: -32601 } }));
          return;
        }
        socket.send(JSON.stringify({ id: request.id, result }));
      });
    });
    server.listen(path);
    await once(server, 'listening');
    const restore = environment({
      DASHUP_LIVE_DISCOVERY: '0',
      DASHUP_CODEX_SOCKET: path,
      DASHUP_OPENCODE_ENDPOINTS: '[]',
    });
    const live = new LiveHarnesses();
    let changes = 0;
    live.watch(() => {
      changes++;
    });
    try {
      let [session] = await live.refresh();
      assert.equal(session?.id, 'original-codex-id');
      assert.equal(session?.messages[0]?.text, 'Already running native conversation');
      assert.equal(session?.status, 'idle');
      assert.ok(session?.send);
      assert.equal(session?.context, undefined);
      const contextEvent = async (method: string, tokenUsage?: object) => {
        const previous = changes;
        peer!.send(
          JSON.stringify({
            method,
            params: { threadId: 'original-codex-id', turnId: 'native-turn', tokenUsage },
          }),
        );
        await waitFor(() => changes > previous);
        [session] = await live.refresh();
      };
      await contextEvent('thread/tokenUsage/updated', {
        last: { totalTokens: 50_000 },
        total: { totalTokens: 2_000_000 },
        modelContextWindow: 200_000,
      });
      assert.deepEqual(session?.context, { used: 50_000, size: 200_000 });
      await contextEvent('thread/compacted');
      assert.equal(session?.context, null);
      await contextEvent('thread/tokenUsage/updated', {
        last: { totalTokens: 0 },
        modelContextWindow: 200_000,
      });
      assert.deepEqual(session?.context, { used: 0, size: 200_000 });
      await contextEvent('thread/tokenUsage/updated', {
        last: { totalTokens: -1 },
        modelContextWindow: 200_000,
      });
      assert.equal(session?.context, null);
      await contextEvent('thread/closed');
      assert.equal(session?.context, undefined);
      await assert.rejects(session!.stop!('dashup-native-stop-idle'), /Nothing is running/);
      await session!.send!('dashup-native-send', 'Same process, same conversation');
      await session!.send!('dashup-native-send', 'Same process, same conversation');
      const sent = calls.filter((call) => call.method === 'turn/start');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].params.threadId, 'original-codex-id');
      assert.equal(sent[0].params.clientUserMessageId, 'dashup-native-send');
      assert.deepEqual(sent[0].params.input, [
        { type: 'text', text: 'Same process, same conversation', text_elements: [] },
      ]);
      // A change applies from the next turn the phone starts, which keeps it.
      await session!.configure!('dashup-native-model', 'model', 'gpt-6.1-sol');
      await session!.configure!('dashup-native-effort', 'effort', 'ultra');
      await session!.configure!('dashup-native-fast', 'fast', false);
      await session!.configure!('dashup-native-auto', 'auto', true);
      await session!.send!('dashup-native-next', 'Now with another model', false, [
        { path: '/private/uploads/phone.png', mime: 'image/png' },
        { path: '/private/uploads/context.txt', mime: 'text/plain' },
      ]);
      const next = calls.filter((call) => call.method === 'turn/start').at(-1).params;
      assert.deepEqual([next.model, next.effort, next.serviceTier], ['gpt-6.1-sol', 'ultra', null]);
      assert.equal(next.approvalsReviewer, 'auto_review');
      assert.equal(next.approvalPolicy, 'on-request');
      assert.equal(next.sandboxPolicy, undefined);
      await session!.configure!('dashup-native-manual', 'auto', false);
      await session!.send!('dashup-native-manual-send', 'Back to manual');
      assert.equal(
        calls.filter((call) => call.method === 'turn/start').at(-1).params.approvalsReviewer,
        'user',
      );
      assert.deepEqual(next.input, [
        { type: 'text', text: 'Now with another model', text_elements: [] },
        { type: 'localImage', path: '/private/uploads/phone.png' },
      ]);
      assert.ok(
        !calls.some(
          (call) =>
            /thread\/(start|resume|load|fork)/.test(call.method ?? '') &&
            call.method !== 'thread/loaded/list',
        ),
      );
      const before = changes;
      peer!.send(
        JSON.stringify({
          id: 'native-approval',
          method: 'item/commandExecution/requestApproval',
          params: {
            threadId: 'original-codex-id',
            turnId: 'native-turn',
            itemId: 'native-command',
            kind: 'command',
            command: 'pnpm test',
            cwd: '/original/project',
            reason: 'Run existing tests',
          },
        }),
      );
      await waitFor(() => changes > before);
      [session] = await live.refresh();
      assert.equal(session?.status, 'attention');
      const approval = session!.approvals[0]!;
      assert.match(approval.detail, /pnpm test/);
      assert.match(approval.detail, /Working directory: \/original\/project/);
      assert.deepEqual(
        approval.choices.map((choice) => choice.id),
        ['accept', 'decline'],
      );
      await session!.approve!('dashup-native-approval', approval.id, { choice: 'accept' });
      await waitFor(() => calls.some((call) => call.id === 'native-approval' && call.result));
      assert.deepEqual(calls.find((call) => call.id === 'native-approval' && call.result).result, {
        decision: 'accept',
      });
      await assert.rejects(
        session!.approve!('dashup-native-stale', approval.id, { choice: 'accept' }),
        /no longer pending/,
      );
      // A restarted app server numbers its requests again; the same id is a new ask.
      const repeated = changes;
      peer!.send(
        JSON.stringify({
          id: 'native-approval',
          method: 'item/commandExecution/requestApproval',
          params: { threadId: 'original-codex-id', turnId: 'native-turn', command: 'pnpm lint' },
        }),
      );
      await waitFor(() => changes > repeated);
      [session] = await live.refresh();
      const again = session!.approvals[0]!;
      assert.notEqual(again.id, approval.id);
      await session!.approve!('dashup-native-again', again.id, { choice: 'decline' });

      for (const request of [
        {
          id: 'command-without-preview',
          method: 'item/commandExecution/requestApproval',
          params: { command: null, reason: 'Needs approval without command input' },
        },
        {
          id: 'file-change-without-diff',
          method: 'item/fileChange/requestApproval',
          params: { reason: 'Needs write access', grantRoot: '/original/project' },
        },
        {
          id: 'stdin-without-preview',
          method: 'item/commandExecution/requestApproval',
          params: { kind: 'writeStdin', command: 'existing terminal process' },
        },
        {
          id: 'oversized-command-preview',
          method: 'item/commandExecution/requestApproval',
          params: { command: 'x'.repeat(128 * 1024) },
        },
      ]) {
        const previous = changes;
        peer!.send(
          JSON.stringify({
            ...request,
            params: {
              threadId: 'original-codex-id',
              turnId: 'native-turn',
              itemId: request.id,
              ...request.params,
            },
          }),
        );
        await waitFor(() => changes > previous);
        [session] = await live.refresh();
        assert.equal(session!.approvals.length, 1);
        const pending = session!.approvals[0]!;
        assert.deepEqual(
          pending.choices.map((choice) => choice.id),
          ['decline'],
        );
        assert.match(pending.detail, /on your computer/);
        assert.ok(Buffer.byteLength(pending.detail) < 65 * 1024);
        await assert.rejects(
          session!.approve!(`reject-unpreviewed-${request.id}`, pending.id, { choice: 'accept' }),
          /no longer pending/,
        );
        assert.ok(!calls.some((call) => call.id === request.id && call.result));
        await session!.approve!(`decline-${request.id}`, pending.id, { choice: 'decline' });
        await waitFor(() => calls.some((call) => call.id === request.id && call.result));
        assert.deepEqual(calls.find((call) => call.id === request.id && call.result).result, {
          decision: 'decline',
        });
      }
      nativeStatus = 'active';
      [session] = await live.refresh();
      assert.equal(session?.status, 'working');
      assert.equal(session?.send, undefined);
      await session!.stop!('dashup-native-stop');
      await session!.stop!('dashup-native-stop');
      assert.deepEqual(
        calls.filter((call) => call.method === 'turn/interrupt').map((call) => call.params),
        [{ threadId: 'original-codex-id', turnId: 'native-turn' }],
      );
      [session] = await live.refresh();
      assert.equal(session?.status, 'idle');
      await assert.rejects(session!.stop!('dashup-native-stop-ended'), /Nothing is running/);
      assert.equal(calls.filter((call) => call.method === 'turn/interrupt').length, 1);
    } finally {
      live.stop();
      restore();
      for (const client of websocket.clients) client.terminate();
      await new Promise<void>((resolve) => websocket.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  'Codex paginated threads keep live controls when history is unavailable and accept input while working',
  { skip: process.platform === 'win32' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dashup-codex-paginated-'));
    const path = join(directory, 'native.sock');
    const server = createServer();
    const websocket = new WebSocketServer({ server });
    const calls: any[] = [];
    let peer: WebSocket | undefined;
    let nativeStatus = 'active';
    let canAcceptDirectInput = true;
    let historyUnavailable = true;
    websocket.on('connection', (socket) => {
      peer = socket;
      socket.on('message', (data) => {
        const request = JSON.parse(data.toString());
        calls.push(request);
        let result: any;
        if (request.method === 'initialize') result = { userAgent: 'codex-app-server/0.165.0' };
        else if (request.method === 'initialized') return;
        else if (request.method === 'thread/loaded/list') result = { data: ['running-thread'] };
        else if (request.method === 'thread/read') {
          assert.equal(request.params.includeTurns, false);
          result = {
            thread: {
              id: 'running-thread',
              cwd: '/original/project',
              historyMode: 'paginated',
              status: { type: nativeStatus },
              canAcceptDirectInput,
              turns: [],
            },
          };
        } else if (request.method === 'thread/turns/list') {
          if (historyUnavailable) {
            socket.send(JSON.stringify({ id: request.id, error: { code: -32603 } }));
            return;
          }
          result = {
            data: [{ id: 'running-turn', status: 'inProgress', items: [] }],
            nextCursor: 'older-turns',
          };
        } else if (request.method === 'turn/start') result = { turn: { id: 'running-turn' } };
        else if (request.method === 'turn/interrupt') result = {};
        else throw new Error(`Unexpected request: ${request.method}`);
        socket.send(JSON.stringify({ id: request.id, result }));
      });
    });
    server.listen(path);
    await once(server, 'listening');
    const restore = environment({ DASHUP_LIVE_DISCOVERY: '0', DASHUP_CODEX_SOCKET: path });
    let changes = 0;
    const codex = new Codex(() => changes++);
    const notify = async (method: string, params: object) => {
      const before = changes;
      peer!.send(JSON.stringify({ method, params: { threadId: 'running-thread', ...params } }));
      await waitFor(() => changes > before);
    };
    try {
      let [session] = await codex.refresh();
      assert.equal(session?.status, 'working');
      assert.deepEqual(session?.messages, []);
      assert.ok(session?.send);
      await session.send('active-input', 'Continue with the failing tests');
      await session.send('active-input', 'Continue with the failing tests');
      assert.equal(calls.filter((call) => call.method === 'turn/start').length, 1);
      assert.equal(
        calls.find((call) => call.method === 'turn/start').params.threadId,
        'running-thread',
      );

      canAcceptDirectInput = false;
      await assert.rejects(session.send('input-disabled', 'Do not send'), /busy or unavailable/);
      [session] = await codex.refresh();
      assert.equal(session?.send, undefined);
      assert.equal(session?.status, 'working');
      canAcceptDirectInput = true;
      historyUnavailable = false;

      await notify('item/agentMessage/delta', { itemId: 'draft', delta: 'Thinking through it' });
      [session] = await codex.refresh();
      assert.equal(session?.typing, 'Thinking through it');
      assert.equal(session?.messages[0]?.id, 'earlier');
      await notify('item/completed', { item: { id: 'draft', type: 'agentMessage' } });
      [session] = await codex.refresh();
      assert.equal(session?.typing, undefined);
      await notify('item/agentMessage/delta', { itemId: 'next', delta: 'Next reply' });
      await notify('turn/completed', { turn: { id: 'running-turn' } });
      [session] = await codex.refresh();
      assert.equal(session?.typing, undefined);
      await session!.stop!('stop-paginated');
      assert.deepEqual(calls.find((call) => call.method === 'turn/interrupt').params, {
        threadId: 'running-thread',
        turnId: 'running-turn',
      });
      assert.ok(
        calls.some(
          (call) =>
            call.method === 'thread/turns/list' &&
            call.params.limit === 1 &&
            call.params.itemsView === 'notLoaded',
        ),
      );

      await notify('item/agentMessage/delta', { itemId: 'last', delta: 'Last reply' });
      nativeStatus = 'idle';
      [session] = await codex.refresh();
      assert.equal(session?.typing, undefined);
      assert.equal(session?.status, 'idle');
      assert.ok(session?.send);
      assert.ok(!calls.some((call) => /thread\/(start|resume|fork)$/.test(call.method)));
    } finally {
      codex.stop();
      restore();
      for (const client of websocket.clients) client.terminate();
      await new Promise<void>((resolve) => websocket.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test('a running Claude Code session takes replies, redirects and stops through the stream its plugin holds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dashup-claude-'));
  const home = process.env.CLAUDE_CONFIG_DIR;
  const socket = join(root, 'claude.sock');
  await mkdir(join(root, 'sessions'));
  await writeFile(
    join(root, 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, cwd: root, status: 'busy', sessionId: 'running-session' }),
  );
  process.env.CLAUDE_CONFIG_DIR = root;
  const claude = new Claude(() => {}, socket);
  // What the plugin's curl reads: one delivery per line, until the stream ends.
  const plugin = async () => {
    const asked = request({ socketPath: socket, path: '/sessions/running-session' });
    asked.end();
    const [response] = (await once(asked, 'response')) as [IncomingMessage];
    const stream = { lines: [] as unknown[], ended: false, close: () => asked.destroy() };
    let buffer = '';
    response.on('data', (chunk: Buffer) => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
        stream.lines.push(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
      }
    });
    response.on('end', () => (stream.ended = true));
    return stream;
  };
  // The server hears a closed stream a moment later.
  const detached = async () => {
    for (let wait = 0; wait < 50; wait++) {
      if (!(await claude.refresh())[0]!.send) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  };
  try {
    await claude.listen();
    assert.equal((await claude.refresh())[0]!.send, undefined);

    const first = await plugin();
    const session = (await claude.refresh())[0]!;
    assert.equal(session.now, true);
    await session.send!('steer', 'Use the staging database');
    await session.send!('force', 'Stop and use staging', true);
    await session.stop!('stop');
    await session.stop!('stop');
    await waitFor(() => first.lines.length === 3);
    assert.deepEqual(first.lines, [
      { text: 'Use the staging database' },
      { text: 'Stop and use staging', now: true },
      { now: true },
    ]);

    // A reloaded plugin's stream takes over from the one before it.
    const second = await plugin();
    await waitFor(() => first.ended);
    await session.send!('after', 'Carry on');
    await waitFor(() => second.lines.length === 1);
    assert.deepEqual(second.lines, [{ text: 'Carry on' }]);

    second.close();
    assert.ok(await detached());
    await assert.rejects(session.send!('late', 'Anyone there?'), /not taking messages/);
  } finally {
    claude.stop();
    if (home === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = home;
    await rm(root, { recursive: true, force: true });
  }
});

test('a running Claude Code session’s permission requests wait for the phone until it answers or the session settles them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dashup-claude-asks-'));
  const home = process.env.CLAUDE_CONFIG_DIR;
  const socket = join(root, 'claude.sock');
  await mkdir(join(root, 'sessions'));
  await writeFile(
    join(root, 'sessions', `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      cwd: root,
      status: 'waiting',
      sessionId: 'running-session',
    }),
  );
  process.env.CLAUDE_CONFIG_DIR = root;
  const claude = new Claude(() => {}, socket);
  // What the plugin's curl sends for a request, and reads back once the phone answers.
  const plugin = (body: unknown) => {
    const asked = request({
      socketPath: socket,
      path: '/sessions/running-session/prompts',
      method: 'POST',
    });
    asked.end(typeof body === 'string' ? body : JSON.stringify(body));
    const answer = (async () => {
      const [response] = (await once(asked, 'response')) as [IncomingMessage];
      let text = '';
      for await (const chunk of response) text += chunk;
      return { status: response.statusCode, text };
    })();
    answer.catch(() => {});
    return { answer, close: () => asked.destroy() };
  };
  // The server hears a request open or close a moment later.
  const asked = async (count: number) => {
    for (let wait = 0; wait < 100; wait++) {
      const session = (await claude.refresh())[0]!;
      if (session.approvals.length === count) return session;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Expected ${count} approvals`);
  };
  try {
    await claude.listen();
    assert.equal((await plugin('not json').answer).status, 400);

    const run = plugin({
      tool: 'Bash',
      input: { command: 'pnpm test', description: 'Run the tests' },
      suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'pnpm test:*' }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
    });
    let session = await asked(1);
    assert.equal(session.status, 'attention');
    const [command] = session.approvals;
    assert.deepEqual(
      [command!.detail, command!.choices.map((choice) => choice.label)],
      ['Run the tests\n\npnpm test', ['Allow once', 'Always allow pnpm test:*', 'Reject']],
    );
    await session.approve!('always', command!.id, { choice: 'always' });
    assert.deepEqual(JSON.parse((await run.answer).text), {
      behavior: 'allow',
      updatedInput: { command: 'pnpm test', description: 'Run the tests' },
      updatedPermissions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'pnpm test:*' }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
    });
    await asked(0);

    // A plugin can only send a plan back; the person approves it at the computer.
    const plan = plugin({ tool: 'ExitPlanMode', input: { plan: '1. Fix it' } });
    session = await asked(1);
    assert.deepEqual(session.approvals[0]!.choices, [
      { id: 'revise', label: 'Keep planning', text: true },
    ]);
    await session.approve!('revise', session.approvals[0]!.id, {
      choice: 'revise',
      text: 'Use echo',
    });
    assert.deepEqual(JSON.parse((await plan.answer).text), {
      behavior: 'deny',
      message: 'Use echo',
    });

    // The person answers at the computer, so the plugin closes the request.
    const question = plugin({
      tool: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'Which color?',
            header: 'Color',
            options: [{ label: 'Red', description: '' }],
            multiSelect: false,
          },
        ],
      },
    });
    session = await asked(1);
    assert.equal(session.approvals[0]!.title, 'Which color?');
    question.close();
    session = await asked(0);
    assert.equal(session.approve, undefined);
  } finally {
    claude.stop();
    if (home === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = home;
    await rm(root, { recursive: true, force: true });
  }
});
