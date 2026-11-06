import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connect, createServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { join, resolve } from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, chmod, rm, writeFile, symlink } from 'node:fs/promises';

import dashup from '../pi/index';
import { PI_HOST, PI_VERSION, PI_MAX_FRAME, piFrame, type PiSnapshot } from '../pi/bridge';
import { Pi, piMessages } from '../src/harness/pi';
import type { NativeAttachment } from '../src/harness/session';

// =============================================================================
// An extension in an already-running Pi process
// =============================================================================

const date = '2026-10-29T00:00:00.000Z';
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 8_000;
  let value: T;
  do {
    value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  } while (Date.now() < end);
  assert.fail('The native Pi event did not arrive');
}

test('Pi native transcript mapping preserves roles, tools, errors and bounded previews', () => {
  const snapshot = {
    earlier: true,
    entries: [
      {
        id: 'u',
        timestamp: date,
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'Existing question' },
            { type: 'image', data: 'PRIVATE IMAGE' },
          ],
        },
      },
      {
        id: 'a',
        timestamp: date,
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'PRIVATE THOUGHT' },
            { type: 'text', text: 'Existing answer' },
            { type: 'toolCall', id: 'call', name: 'bash', arguments: '{"command":"pwd"}' },
          ],
        },
      },
      {
        id: 't',
        timestamp: date,
        message: {
          role: 'toolResult',
          toolName: 'bash',
          toolCallId: 'call',
          content: [{ type: 'text', text: 'Failed' }],
          isError: true,
        },
      },
      {
        id: 'b',
        timestamp: date,
        message: {
          role: 'bashExecution',
          command: 'pwd',
          output: '/original/project',
          exitCode: 0,
        },
      },
    ],
  };
  const mapped = piMessages(snapshot);
  assert.deepEqual(
    mapped.map((item) => item.role),
    ['system', 'user', 'assistant', 'tool', 'tool', 'tool'],
  );
  assert.equal(mapped[3]?.tool?.summary, '{"command":"pwd"}');
  assert.equal((mapped[3]!.tool!.input as NativeAttachment).read().toString(), '{"command":"pwd"}');
  assert.equal(mapped[4]?.tool?.status, 'error');
  assert.equal(mapped[5]?.tool?.status, 'ok');
  assert.equal((mapped[5]!.tool!.input as NativeAttachment).read().toString(), 'pwd');
  assert.ok(!JSON.stringify(mapped).includes('PRIVATE'));
});

test('Pi attaches, reconnects and sends real native replies, steering and abort to the same session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dashup-pi-'));
  const previous = process.env.DASHUP_PI_DIRECTORY;
  process.env.DASHUP_PI_DIRECTORY = root;
  const handlers = new Map<string, ((event: any, ctx: any) => unknown)[]>();
  let session = 'existing-session';
  let idle = true;
  let aborts = 0;
  const calls: any[] = [];
  const native = {
    mode: 'tui',
    cwd: '/original/project',
    sessionManager: {
      getSessionId: () => session,
      getSessionName: () => 'Native Pi work',
      getBranch: () => [
        {
          type: 'message',
          id: 'original-user',
          timestamp: date,
          message: { role: 'user', content: 'Existing Pi prompt' },
        },
        {
          type: 'message',
          id: 'original-answer',
          timestamp: date,
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Existing Pi answer' },
              { type: 'thinking', thinking: 'not sent' },
            ],
          },
        },
      ],
    },
    isIdle: () => idle,
    abort: () => {
      aborts++;
    },
  };
  async function emit(event: string, value: any = {}) {
    for (const handler of handlers.get(event) ?? []) await handler(value, native);
  }
  dashup({
    on: (event, handler) => {
      const entries = handlers.get(event) ?? [];
      entries.push(handler);
      handlers.set(event, entries);
    },
    sendUserMessage: (text, options) => {
      calls.push({ text, options });
      idle = false;
      void emit('agent_start');
    },
  });
  let changes = 0;
  let pi = new Pi(() => {
    changes++;
  });
  try {
    // Discovery never starts an agent or creates a bridge itself.
    assert.deepEqual(await pi.refresh(), []);
    assert.deepEqual(await readdir(root), []);
    await emit('session_start');
    const metadata = (await readdir(root)).find((name) => name.endsWith('.json'))!;
    const registry = JSON.parse(await readFile(join(root, metadata), 'utf8'));
    assert.equal(registry.pid, process.pid);
    assert.ok(!JSON.stringify(registry).includes('Existing Pi'));
    const unauthenticated = connect({ host: PI_HOST, port: registry.port });
    let leaked = '';
    unauthenticated.on('data', (bytes) => {
      leaked += bytes;
    });
    unauthenticated.write(piFrame({ type: 'hello', version: PI_VERSION, token: 'wrong' }));
    await once(unauthenticated, 'close');
    assert.equal(leaked, '');

    let [live] = await pi.refresh();
    assert.equal(live?.id, session);
    assert.equal(live?.cwd, '/original/project');
    assert.equal(live?.harness, 'pi');
    assert.deepEqual(
      live?.messages.map((value) => value.text),
      ['Existing Pi prompt', 'Existing Pi answer'],
    );
    assert.equal(live?.status, 'idle');
    assert.equal(live?.stop, undefined);
    assert.equal(live?.approve, undefined);
    const originalSend = live!.send!;
    await originalSend('reply-once', 'Real phone reply');
    await originalSend('reply-once', 'Real phone reply');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.deliverAs, 'followUp');
    [live] = await until(
      () => pi.refresh(),
      (value) => value[0]?.status === 'working',
    );
    await live!.send!('steer', 'Change direction', true);
    assert.equal(calls[1].options.deliverAs, 'steer');
    await live!.stop!('abort');
    await live!.stop!('abort');
    assert.equal(aborts, 1);
    await emit('message_update', {
      message: { role: 'assistant', content: [{ type: 'text', text: 'Streaming answer' }] },
    });
    [live] = await until(
      () => pi.refresh(),
      (value) => value[0]?.typing === 'Streaming answer',
    );
    assert.ok(changes > 0);

    // UI events are observational. Unknown extension questions remain on the computer.
    await emit('ui_prompt_start', { title: 'Allow extension action?' });
    [live] = await until(
      () => pi.refresh(),
      (value) => value[0]?.status === 'attention',
    );
    assert.equal(live!.send, undefined);
    assert.equal(live!.approve, undefined);
    assert.deepEqual(live!.approvals, []);
    await assert.rejects(originalSend('cannot-answer-dialog', 'yes'), /unavailable/);
    assert.equal(calls.length, 2);
    await emit('ui_prompt_end');
    idle = true;
    await emit('agent_settled');
    [live] = await until(
      () => pi.refresh(),
      (value) => value[0]?.status === 'idle',
    );

    // A second connector observes the same live extension without replacing its agent.
    pi.stop();
    pi = new Pi(() => {});
    [live] = await pi.refresh();
    await live!.send!('reply-once', 'Real phone reply');
    assert.equal(calls.length, 2, 'host deduplicates across connector reconnect');

    session = 'new-native-session';
    await emit('session_start');
    await assert.rejects(
      live!.send!('old-session-send', 'must stay in original'),
      /disconnected|changed/,
    );
    [live] = await until(
      () => pi.refresh(),
      (value) => value[0]?.id === session,
    );
    assert.equal(live!.id, 'new-native-session');

    if (process.platform !== 'win32') {
      const current = (await readdir(root)).find((name) => name.endsWith('.json'))!;
      await chmod(join(root, current), 0o644);
      assert.deepEqual(await pi.refresh(), []);
      await assert.rejects(live!.send!('unowned-endpoint', 'must not send'), /disconnected/);
      await chmod(join(root, current), 0o600);
      [live] = await pi.refresh();
      assert.ok(live);
      await chmod(root, 0o755);
      assert.deepEqual(await pi.refresh(), []);
      await chmod(root, 0o700);
    }
    await emit('session_shutdown');
    assert.deepEqual(await pi.refresh(), []);
    assert.deepEqual(await readdir(root), []);
  } finally {
    pi.stop();
    await emit('session_shutdown');
    if (previous === undefined) delete process.env.DASHUP_PI_DIRECTORY;
    else process.env.DASHUP_PI_DIRECTORY = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'Pi refuses identity mismatches, shared registry files, symlinks and oversized frames',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'dashup-pi-identity-'));
    const previous = process.env.DASHUP_PI_DIRECTORY;
    process.env.DASHUP_PI_DIRECTORY = root;
    const instance = '00000000-0000-4000-8000-000000000001';
    const path = join(root, `${process.pid}-${instance}.json`);
    let response: unknown = {
      type: 'snapshot',
      version: PI_VERSION,
      instance: 'wrong-process',
      pid: process.pid,
    };
    let connections = 0;
    const server = createServer((socket) => {
      connections++;
      socket.on('error', () => {});
      socket.once('data', () =>
        socket.end(typeof response === 'string' ? response : piFrame(response)));
    });
    server.listen(0, PI_HOST);
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    const registry = {
      version: PI_VERSION,
      instance,
      pid: process.pid,
      port,
      token: 'a'.repeat(64),
    };
    const pi = new Pi(() => {});
    try {
      await writeFile(path, JSON.stringify(registry), { mode: 0o600 });
      assert.deepEqual(await pi.refresh(), []);
      response = 'x'.repeat(PI_MAX_FRAME + 1);
      assert.deepEqual(await pi.refresh(), []);
      await chmod(path, 0o644);
      const before = connections;
      assert.deepEqual(await pi.refresh(), []);
      assert.equal(connections, before);
      await rm(path);
      await writeFile(join(root, 'target'), JSON.stringify(registry), { mode: 0o600 });
      await symlink(join(root, 'target'), path);
      assert.deepEqual(await pi.refresh(), []);
      assert.equal(connections, before);
    } finally {
      pi.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previous === undefined) delete process.env.DASHUP_PI_DIRECTORY;
      else process.env.DASHUP_PI_DIRECTORY = previous;
      await rm(root, { recursive: true, force: true });
    }
  },
);

// An opt-in real-Pi proof uses only an isolated local OpenAI-compatible fixture, never a real
// provider key. script(1) supplies a terminal so Pi loads its real interactive extension runtime.
test(
  'installed Pi package controls its existing interactive session with a local mock provider',
  {
    skip: !process.env.DASHUP_PI_CLI || process.platform !== 'linux',
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'dashup-pi-native-'));
    const previous = process.env.DASHUP_PI_DIRECTORY;
    const bridge = join(root, 'bridge');
    const agent = join(root, 'agent');
    await mkdir(agent);
    process.env.DASHUP_PI_DIRECTORY = bridge;
    const calls: any[] = [];
    let release: (() => void) | undefined;
    const provider = httpServer((request, response) => {
      let body = '';
      request.on('data', (bytes) => {
        body += bytes;
      });
      request.on('end', () => {
        const value = JSON.parse(body);
        calls.push(value);
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
        send({
          id: 'fixture',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'fixture',
          choices: [
            {
              index: 0,
              delta: { role: 'assistant', content: `Native response ${calls.length}` },
              finish_reason: null,
            },
          ],
        });
        const finish = () => {
          send({
            id: 'fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          });
          response.end('data: [DONE]\n\n');
        };
        const lastUser = value.messages.filter((entry: any) => entry.role === 'user').at(-1);
        if (JSON.stringify(lastUser?.content).includes('hold for')) {
          release = finish;
          return;
        }
        finish();
      });
    });
    provider.listen(0, PI_HOST);
    await once(provider, 'listening');
    const port = (provider.address() as { port: number }).port;
    await writeFile(
      join(agent, 'models.json'),
      JSON.stringify({
        providers: {
          'dashup-fixture': {
            baseUrl: `http://${PI_HOST}:${port}/v1`,
            api: 'openai-completions',
            apiKey: 'local-fixture-only',
            models: [{ id: 'fixture' }],
          },
        },
      }),
    );
    const packagePath = resolve(fileURLToPath(new URL('../pi/', import.meta.url)));
    await writeFile(
      join(agent, 'settings.json'),
      JSON.stringify({ packages: [packagePath], quietStartup: true }),
    );
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const args = [
      process.execPath,
      process.env.DASHUP_PI_CLI!,
      '--offline',
      '--no-approve',
      '--no-context-files',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-tools',
      '--model',
      'dashup-fixture/fixture',
    ];
    const child = spawn(
      'script',
      ['--quiet', '--return', '--command', args.map(quote).join(' '), '/dev/null'],
      {
        cwd: root,
        detached: true,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agent,
          DASHUP_PI_DIRECTORY: bridge,
          TERM: 'xterm-256color',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (bytes) => {
      output = (output + bytes).slice(-8_000);
    });
    child.stderr.on('data', (bytes) => {
      output = (output + bytes).slice(-8_000);
    });
    const pi = new Pi(() => {});
    try {
      let [live] = await until(
        () => pi.refresh(),
        (value) => value.length === 1,
      );
      const id = live!.id;
      const registry = JSON.parse(
        await readFile(join(bridge, (await readdir(bridge))[0]!), 'utf8'),
      );
      const nativePid = registry.pid;
      await live!.send!('native-reply', 'Reply from phone to the existing Pi');
      [live] = await until(
        () => pi.refresh(),
        (value) =>
          value[0]?.status === 'idle' &&
          value[0]?.messages.some((message) => message.text === 'Native response 1'),
      );
      assert.equal(live!.id, id);
      assert.ok(
        live!.messages.some(
          (message) =>
            message.role === 'user' && message.text === 'Reply from phone to the existing Pi',
        ),
      );
      assert.equal(calls.length, 1);
      await live!.send!('native-control-running', 'hold for controls');
      [live] = await until(
        () => pi.refresh(),
        (value) => value[0]?.status === 'working' && !!value[0]?.typing,
      );
      await live!.send!('native-steer', 'Native steering message', true);
      await live!.send!('native-queue', 'Native follow-up message');
      assert.ok(release);
      release!();
      [live] = await until(
        () => pi.refresh(),
        (value) =>
          value[0]?.status === 'idle' &&
          value[0]?.messages.some((message) => message.text === 'Native follow-up message'),
      );
      assert.ok(
        live!.messages.some(
          (message) => message.role === 'user' && message.text === 'Native steering message',
        ),
      );
      await live!.send!('native-running', 'hold for abort');
      [live] = await until(
        () => pi.refresh(),
        (value) => value[0]?.status === 'working' && !!value[0]?.typing,
      );
      await live!.stop!('native-abort');
      [live] = await until(
        () => pi.refresh(),
        (value) => value[0]?.status === 'idle',
      );
      assert.equal(live!.id, id);
      assert.equal(
        JSON.parse(await readFile(join(bridge, (await readdir(bridge))[0]!), 'utf8')).pid,
        nativePid,
      );
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : error}\nPi terminal: ${output
          .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
          .replace(/\x1b\][^\x07]*\x07/g, '')
          .slice(-2_000)}`,
      );
    } finally {
      pi.stop();
      try {
        process.kill(-child.pid!, 'SIGTERM');
      } catch {}
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
      if (previous === undefined) delete process.env.DASHUP_PI_DIRECTORY;
      else process.env.DASHUP_PI_DIRECTORY = previous;
      await rm(root, { recursive: true, force: true });
    }
  },
);
