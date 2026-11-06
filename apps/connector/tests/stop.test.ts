import { test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Duplex, PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rmSync, mkdirSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';

import { seal, newSecret } from '@dashup/protocol/crypto';
import type { PairingRecord, ThreadSummary } from '@dashup/protocol';

import type { SessionContent as Content } from '@dashup/protocol/session';

import { Connector } from '../src/connector';
import type { AcpMessage } from '../src/acp';
import type { LiveSession } from '../src/harness/session';
import { saveConfig, connectorPort, type ConnectorConfig } from '../src/config';

// =============================================================================
// Fixtures
// =============================================================================

const INDEX     = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const CONNECTOR = fileURLToPath(new URL('..', import.meta.url));

// A scripted ACP agent: it ends a cancelled turn only once its pending permission is answered.
// Its permission request id 7 is also a valid editor request id.
const AGENT = `
const { createInterface } = require('node:readline');
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
let prompt, cancelled = false, answered = false;
createInterface({ input: process.stdin }).on('line', (line) => {
  process.stderr.write('native ' + line + '\\n');
  const message = JSON.parse(line);
  if (message.method === 'session/new')
    send({ id: message.id, result: { sessionId: 'native-session' } });
  if (message.method === 'session/cancel') cancelled = true;
  if (message.id === 7 && !message.method) answered = true;
  if (message.method === 'session/prompt') {
    prompt = message.id;
    send({ id: 7, method: 'session/request_permission', params: {
      sessionId: 'native-session',
      toolCall: { toolCallId: 'edit', title: 'Edit handler.ts' },
      options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }],
    } });
  }
  if (cancelled && answered && prompt !== undefined) {
    send({ id: prompt, result: { stopReason: 'cancelled' } });
    prompt = undefined;
  }
});
`;

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
  const end = Date.now() + 15_000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Expected stop state was not observed');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// =============================================================================
// Connector
// =============================================================================

test('the connector offers stop only while a live session can interrupt it and routes stop to that session', async () => {
  const root      = mkdtempSync(join(tmpdir(), 'dashup-stop-'));
  const cwd       = join(root, 'project');
  const workspace = join(root, 'code/workspaceStorage/project');
  mkdirSync(join(workspace, 'chatSessions'), { recursive: true });
  writeFileSync(
    join(workspace, 'workspace.json'),
    JSON.stringify({ folder: pathToFileURL(cwd).href }),
  );
  writeFileSync(
    join(workspace, 'chatSessions/saved.json'),
    JSON.stringify({
      requests     : [],
      sessionId    : 'saved',
      customTitle  : 'Saved chat',
      creationDate : 0,
    }),
  );
  const restore = environment({
    DASHUP_CONFIG         : join(root, 'connector.json'),
    DASHUP_ZED_DATA       : join(root, 'zed'),
    DASHUP_VSCODE_DATA    : join(root, 'code'),
    CLAUDE_CONFIG_DIR     : join(root, 'claude'),
    CODEX_HOME            : join(root, 'codex'),
    DASHUP_KIMI_HOME      : join(root, 'kimi'),
    XDG_DATA_HOME         : join(root, 'data'),
    OPENCODE_DB           : undefined,
    DASHUP_LIVE_DISCOVERY : '0',
  });
  const key  = newSecret(randomBytes);
  const pair : PairingRecord = {
    id        : 'pair',
    device    : 'computer',
    mobile    : 'phone',
    code      : '',
    revokedAt : null,
  };
  const config: ConnectorConfig = {
    api         : 'http://127.0.0.1:1',
    secret      : 'fixture',
    localSecret : 'fixture-secret',
    device      : {
      id         : pair.device,
      user       : 'owner',
      name       : 'Computer',
      kind       : 'desktop',
      platform   : 'linux',
    },
    pairs  : { [pair.id]: { key, sequence: 0 } },
  };
  const stopped: string[] = [];
  const native: LiveSession = {
    id        : 'native-session',
    cwd,
    title     : 'Native work',
    harness   : 'opencode',
    updatedAt : '2026-10-26T00:00:00.000Z',
    status    : 'working',
    messages  : [],
    approvals : [],
    stop      : async (requestId) => {
      stopped.push(requestId);
    },
  };
  const observed: LiveSession = { ...native, id: 'observed-session', stop: undefined };
  let sessions = [native, observed];
  const results: Content[] = [];
  const connector = new Connector(config);
  const internal = connector as unknown as {
    changed(): Promise<void>;
    execute(pair: PairingRecord, content: Extract<Content, { type: 'command' }>): Promise<void>;
  };
  let projectId = '';
  let sequence = 0;
  const stop = (requestId: string, threadId: string) =>
    internal.execute(pair, {
      type: 'command',
      requestId,
      projectId,
      threadId,
      action: { kind: 'thread.stop' },
    });
  const result = (requestId: string) =>
    results.find(
      (content): content is Extract<Content, { type: 'result' }> =>
        content.type === 'result' && content.requestId === requestId,
    );
  const states = (match: (thread: ThreadSummary) => boolean) =>
    [...connector.discovery.projects.values()].flatMap((project) => project.threads.filter(match));
  try {
    connector.activePairs = () => [pair];
    connector.send = async (_pair, content) => {
      results.push(content);
    };
    connector.harnesses.refresh = async () => sessions;
    await internal.changed();
    const project = [...connector.discovery.projects.values()].find((project) =>
      project.threads.some((thread) => thread.agent?.sessionId === native.id))!;
    projectId = project.id;
    const saved = project.threads.find((thread) => thread.title === 'Saved chat')!;
    const live = project.threads.find((thread) => thread.agent?.sessionId === native.id)!;
    const watched = project.threads.find((thread) => thread.agent?.sessionId === observed.id)!;
    assert.equal(saved.capabilities.stop, false);
    assert.equal(live.capabilities.stop, true);
    assert.equal(watched.capabilities.stop, false);
    assert.equal(states((thread) => thread.id === live.id).at(-1)?.capabilities.stop, true);

    await stop('stop-native', live.id);
    assert.deepEqual(stopped, ['stop-native']);
    assert.deepEqual(result('stop-native'), { type: 'result', requestId: 'stop-native', ok: true });
    for (const thread of [saved, watched]) {
      await stop(`stop-${thread.id}`, thread.id);
      assert.match(result(`stop-${thread.id}`)!.error!, /no live connection that can stop it/);
    }

    // A session that saved no conversation leaves no thread behind.
    sessions = [];
    await internal.changed();
    assert.ok(!states((thread) => thread.id === live.id).length);
    await stop('stop-detached', live.id);
    assert.match(result('stop-detached')!.error!, /no live connection that can stop it/);
    assert.deepEqual(stopped, ['stop-native']);

    const output = new PassThrough();
    const socket = new Duplex({
      read() {},
      write(chunk, _encoding, callback) {
        output.write(chunk);
        callback();
      },
    });
    const event = (direction: 'editor' | 'agent', message: object) =>
      socket.push(JSON.stringify({ direction, message }) + '\n');
    connector.attach(socket);
    event('editor', { id: 1, method: 'session/new', params: { cwd, mcpServers: [] } });
    event('agent', { id: 1, result: { sessionId: 'acp-session' } });
    await waitFor(() => states((thread) => thread.editor === 'acp').length > 0);
    const acp = states((thread) => thread.editor === 'acp').at(-1)!;
    assert.equal(acp.capabilities.stop, true);
    const wire = new Promise<string>((resolve) =>
      output.once('data', (chunk) => resolve(String(chunk))));
    const pending = stop('stop-acp', acp.id);
    assert.deepEqual(JSON.parse(await wire), {
      kind      : 'cancel',
      requestId : 'stop-acp',
      session   : 'acp-session',
    });
    event('agent', {
      method : 'dashup/command_result',
      params : { session: 'acp-session', requestId: 'stop-acp', ok: true },
    });
    await pending;
    assert.equal(result('stop-acp')?.ok, true);
    socket.destroy();
    await waitFor(
      () => states((thread) => thread.id === acp.id).at(-1)?.capabilities.stop === false,
    );
  } finally {
    connector.stop();
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'pairing with an older running connector explains how to restart it',
  { timeout: 10_000 },
  async () => {
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end('{}');
    });
    let root = '';
    let restore = () => {};
    for (let attempt = 0; ; attempt++) {
      root = mkdtempSync(join(tmpdir(), 'dashup-pair-upgrade-'));
      restore = environment({ DASHUP_CONFIG: join(root, 'connector.json') });
      server.listen(connectorPort(), '127.0.0.1');
      try {
        await once(server, 'listening');
        break;
      } catch (error) {
        restore();
        rmSync(root, { recursive: true, force: true });
        if (attempt === 4) throw error;
      }
    }
    saveConfig({
      api         : 'http://127.0.0.1:1',
      secret      : '',
      pairs       : {},

      localSecret : 'local-secret',
    });
    const child = spawn(process.execPath, ['--import', 'tsx', INDEX, 'pair'], {
      cwd: CONNECTOR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'close');
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      output += String(chunk);
    });
    try {
      const [code] = await exited;
      assert.equal(code, 1);
      assert.match(output, /older Dashup connector/);
      assert.match(output, /dashup stop/);
      assert.match(output, /dashup pair with the updated connector/);
      assert.doesNotMatch(output, /No input text|Pairing code:/);
    } finally {
      child.kill();
      server.closeAllConnections();
      server.close();
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// =============================================================================
// ACP wrapper
// =============================================================================

test(
  'the ACP wrapper cancels only a running turn, answers its pending permission as cancelled, and acknowledges once the agent ends the turn',
  { timeout: 30_000 },
  async () => {
    const server = createServer();
    let root = '';
    let restore = () => {};
    // The wrapper reaches the connector on a port derived from its config path.
    for (let attempt = 0; ; attempt++) {
      root = mkdtempSync(join(tmpdir(), 'dashup-acp-stop-'));
      restore = environment({ DASHUP_CONFIG: join(root, 'connector.json') });
      server.listen(connectorPort(), '127.0.0.1');
      try {
        await once(server, 'listening');
        break;
      } catch (error) {
        restore();
        rmSync(root, { recursive: true, force: true });
        if (attempt === 4) throw error;
      }
    }
    saveConfig({
      api         : 'http://127.0.0.1:1',
      secret      : '',
      pairs       : {},

      localSecret : 'local-secret',
    });
    const linked = new Promise<Duplex>((resolve) =>
      server.on('connect', (request, socket: Duplex) => {
        if (request.url !== '/acp' || request.headers.authorization !== 'Bearer local-secret') {
          socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
          return;
        }
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        resolve(socket);
      }));
    const proxy = spawn(
      process.execPath,
      ['--import', 'tsx', INDEX, 'acp', '--', process.execPath, '-e', AGENT],
      { cwd: CONNECTOR, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const exited = once(proxy, 'exit');
    const editor   : AcpMessage[] = [];
    const agent    : AcpMessage[] = [];
    const observed : AcpMessage[] = [];
    createInterface({ input: proxy.stdout }).on('line', (line) => editor.push(JSON.parse(line)));
    createInterface({ input: proxy.stderr }).on('line', (line) => {
      if (line.startsWith('native ')) agent.push(JSON.parse(line.slice('native '.length)));
    });
    const write = (message: object) =>
      proxy.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    const result = (requestId: string) =>
      observed.find(
        (event) =>
          event.message.method === 'dashup/command_result' &&
          event.message.params.requestId === requestId,
      )?.message.params;
    try {
      const socket = await linked;
      createInterface({ input: socket }).on('line', (line) => observed.push(JSON.parse(line)));
      const command = (requestId: string) =>
        socket.write(
          JSON.stringify({ kind: 'cancel', requestId, session: 'native-session' }) + '\n',
        );
      write({ id: 1, method: 'session/new', params: { cwd: root, mcpServers: [] } });
      await waitFor(() => editor.some((message) => message.id === 1 && message.result));
      command('stop-idle');
      await waitFor(() => Boolean(result('stop-idle')));
      assert.equal(result('stop-idle').ok, false);
      assert.match(result('stop-idle').error, /Nothing is running/);

      write({
        id     : 2,
        method : 'session/prompt',
        params : { sessionId: 'native-session', prompt: [{ type: 'text', text: 'Work' }] },
      });
      await waitFor(() =>
        editor.some((message) => message.method === 'session/request_permission'));
      command('stop');
      await waitFor(() => Boolean(result('stop')));
      assert.equal(result('stop').ok, true);
      const ended = observed.findIndex(
        (event) => event.direction === 'agent' && event.message.id === 2,
      );
      const acknowledged = observed.findIndex(
        (event) => event.message.params?.requestId === 'stop',
      );
      assert.ok(ended >= 0 && ended < acknowledged, 'the stop is acknowledged after the turn ends');
      assert.deepEqual(editor.find((message) => message.id === 2)?.result, {
        stopReason: 'cancelled',
      });
      assert.deepEqual(
        agent
          .filter((message) => message.method === 'session/cancel')
          .map((message) => message.params),
        [{ sessionId: 'native-session' }],
      );
      const answers = () => agent.filter((message) => message.id === 7 && !message.method);
      assert.deepEqual(
        answers().map((message) => message.result),
        [{ outcome: { outcome: 'cancelled' } }],
      );
      // An editor request may reuse id 7; only the editor's late answer to the permission is withheld.
      write({ id: 7, method: 'session/new', params: { cwd: root, mcpServers: [] } });
      write({ id: 7, result: { outcome: { outcome: 'selected', optionId: 'allow' } } });
      write({ id: 8, method: 'session/new', params: { cwd: root, mcpServers: [] } });
      await waitFor(() => agent.some((message) => message.id === 8));
      assert.ok(agent.some((message) => message.id === 7 && message.method === 'session/new'));
      assert.equal(answers().length, 1);
    } finally {
      proxy.kill();
      await exited;
      server.closeAllConnections();
      server.close();
      restore();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('the phone changes what a live session runs with, among the choices it offers', async () => {
  const root    = mkdtempSync(join(tmpdir(), 'dashup-configure-'));
  const cwd     = join(root, 'project');
  const restore = environment({
    DASHUP_CONFIG         : join(root, 'connector.json'),
    DASHUP_ZED_DATA       : join(root, 'zed'),
    DASHUP_VSCODE_DATA    : join(root, 'code'),
    CLAUDE_CONFIG_DIR     : join(root, 'claude'),
    CODEX_HOME            : join(root, 'codex'),
    DASHUP_KIMI_HOME      : join(root, 'kimi'),
    XDG_DATA_HOME         : join(root, 'data'),
    OPENCODE_DB           : undefined,
    DASHUP_LIVE_DISCOVERY : '0',
  });
  // A saved Codex thread beside the live session, and Codex's own catalog.
  const rollout = join(root, 'codex/sessions/2026/10/26/rollout-saved.jsonl');
  mkdirSync(join(rollout, '..'), { recursive: true });
  const row = (value: object) => JSON.stringify(value) + '\n';
  writeFileSync(
    join(root, 'codex/models_cache.json'),
    JSON.stringify({ models: [{ slug: 'gpt-6-luna', display_name: 'GPT-6-Luna' }] }),
  );
  writeFileSync(
    rollout,
    row({ type: 'session_meta', payload: { id: 'saved-codex', cwd } }) +
      row({
        type: 'response_item',
        timestamp: '2026-10-26T00:00:00.000Z',
        payload: { type: 'message', role: 'user', content: 'Plan it' },
      }),
  );
  const key  = newSecret(randomBytes);
  const pair : PairingRecord = {
    id        : 'pair',
    device    : 'computer',
    mobile    : 'phone',
    code      : '',
    revokedAt : null,
  };
  const config: ConnectorConfig = {
    api         : 'http://127.0.0.1:1',
    secret      : 'fixture',
    localSecret : 'fixture-secret',
    device      : {
      id       : pair.device,
      user     : 'owner',
      name     : 'Computer',
      kind     : 'desktop',
      platform : 'linux',
    },
    pairs       : { [pair.id]: { key, sequence: 0 } },
  };
  const changes: unknown[][] = [];
  let sessions: LiveSession[] = [
    {
      id        : 'native-session',
      cwd,
      title     : 'Native work',
      harness   : 'claude',
      updatedAt : '2026-10-26T00:00:00.000Z',
      status    : 'idle',
      messages  : [],
      approvals : [],
      options   : () => [
        {
          id      : 'model',
          name    : 'Model',
          value   : 'opus',
          choices : [
            { value: 'opus', name: 'Opus 5.5' },
            { value: 'sonnet', name: 'Sonnet 5.5' },
          ],
        },
        { id: 'fast', name: 'Fast', value: false },
      ],
      configure : async (...change) => {
        changes.push(change);
      },
    },
  ];
  const results: Content[] = [];
  const connector = new Connector(config);
  const internal = connector as unknown as {
    changed(): Promise<void>;
    execute(pair: PairingRecord, content: Extract<Content, { type: 'command' }>): Promise<void>;
  };
  let projectId = '';
  let threadId = '';
  let sequence = 0;
  const configure = (requestId: string, option: string, value: string | boolean) =>
    internal.execute(pair, {
      type: 'command',
      requestId,
      projectId,
      threadId,
      action: { kind: 'thread.configure', option, value },
    });
  const error = (requestId: string) =>
    results.find(
      (content): content is Extract<Content, { type: 'result' }> =>
        content.type === 'result' && content.requestId === requestId,
    )?.error;
  const state = () =>
    [...connector.discovery.projects.values()]
      .flatMap((project) => project.threads)
      .find((thread) => thread.agent?.sessionId === 'native-session')!;
  try {
    connector.activePairs = () => [pair];
    connector.send = async (_pair, content) => {
      results.push(content);
    };
    connector.harnesses.refresh = async () => sessions;
    await internal.changed();
    const project = [...connector.discovery.projects.values()].find((project) =>
      project.threads.some((thread) => thread.agent?.sessionId === 'native-session'))!;
    projectId = project.id;
    threadId = state().id;
    assert.equal(state().capabilities.configure, true);
    assert.deepEqual(
      state().options?.map((option) => option.id),
      ['model', 'fast'],
    );

    await configure('to-sonnet', 'model', 'sonnet');
    await configure('fast-on', 'fast', true);
    assert.deepEqual(changes, [
      ['to-sonnet', 'model', 'sonnet'],
      ['fast-on', 'fast', true],
    ]);
    assert.equal(error('to-sonnet'), undefined);
    await configure('unknown-model', 'model', 'haiku');
    assert.match(error('unknown-model')!, /can't be set to that/);
    await configure('fast-as-text', 'fast', 'on');
    assert.match(error('fast-as-text')!, /can't be set to that/);
    await configure('no-such-option', 'effort', 'high');
    assert.match(error('no-such-option')!, /only be changed on your computer/);
    // A thread no live session holds shows what its record says it ran with, and no other choice.
    appendFileSync(
      rollout,
      row({ type: 'turn_context', payload: { model: 'gpt-6-luna', effort: 'medium' } }) +
        row({
          type: 'response_item',
          timestamp: '2026-10-26T00:01:00.000Z',
          payload: { type: 'message', role: 'assistant', content: 'Done' },
        }),
    );
    await internal.changed();
    const saved = connector['recorded'](
      [...connector.discovery.projects.values()]
        .flatMap((project) => project.threads)
        .find((thread) => thread.agent?.harness === 'codex')!,
    );
    assert.deepEqual(saved.options, [
      {
        id      : 'model',
        name    : 'Model',
        value   : 'gpt-6-luna',
        choices : [{ value: 'gpt-6-luna', name: 'GPT-6-Luna' }],
      },
      {
        id: 'effort',
        name: 'Effort',
        value: 'medium',
        choices: [{ value: 'medium', name: 'medium effort' }],
      },
    ]);
    assert.ok(!saved.capabilities.configure);

    sessions = [];
    await internal.changed();
    assert.equal(state(), undefined);
    await configure('detached', 'model', 'sonnet');
    assert.ok(error('detached'));
  } finally {
    connector.stop();
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});
