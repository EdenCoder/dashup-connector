import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { rmSync, mkdtempSync } from 'node:fs';

import type { Harness, ThreadSummary } from '@dashup/protocol';

import { Connector } from '../src/connector';
import { alertThread } from '../src/attention';
import { saveConfig, connectorPort } from '../src/config';

// =============================================================================
// dashup alert
// =============================================================================

const INDEX     = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const CONNECTOR = fileURLToPath(new URL('..', import.meta.url));

const thread = (
  id: string,
  updatedAt: string,
  status: ThreadSummary['status'],
  harness?: Harness,
): ThreadSummary => ({
  id,
  title: id,
  editor: 'cli',
  status,
  updatedAt,
  capabilities: { read: true, send: false, approve: false },
  ...(harness ? { agent: { harness, sessionId: id } } : {}),
});

test('an alert about a project is for its latest conversation that is not working', () => {
  assert.equal(
    alertThread([
      thread('older', '2026-11-01T00:00:00.000Z', 'idle'),
      thread('latest-waiting', '2026-11-03T00:00:00.000Z', 'unknown'),
      thread('working', '2026-11-05T00:00:00.000Z', 'working'),
      thread('terminal', '2026-11-06T00:00:00.000Z', 'idle', 'terminal'),
    ])?.id,
    'latest-waiting',
  );
  assert.equal(alertThread([thread('working', '2026-11-05T00:00:00.000Z', 'working')]), undefined);
  assert.equal(alertThread([]), undefined);
});

test('the connector picks the conversation for an alert that names only its project', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashup-alert-project-'));
  const previous = process.env.DASHUP_CONFIG;
  process.env.DASHUP_CONFIG = join(root, 'connector.json');
  const connector = new Connector({
    api         : 'http://127.0.0.1:1',
    secret      : 'fixture',
    localSecret : 'fixture-secret',
    device      : {
      id       : 'computer',
      user     : 'owner',
      name     : 'Computer',
      kind     : 'desktop',
      platform : 'linux',
    },
    pairs       : {},
  });
  const internal = connector as unknown as { attentionFor(thread: ThreadSummary): unknown };
  const threads = [
    thread('older', '2026-11-01T00:00:00.000Z', 'idle'),
    thread('latest-waiting', '2026-11-03T00:00:00.000Z', 'unknown'),
    thread('working', '2026-11-05T00:00:00.000Z', 'working'),
  ];
  connector.discovery.projects.set('project', {
    id       : 'project',
    name     : 'project',
    path     : root,
    deviceId : 'computer',
    threads,
  });
  try {
    await connector.attention('project', '', 'Dashup is connected', '', 'input');
    assert.deepEqual(
      threads.map((item) => !!internal.attentionFor(item)),
      [false, true, false],
    );
    threads.splice(0, 2);
    await assert.rejects(
      connector.attention('project', '', 'Dashup is connected', '', 'input'),
      /No conversation in this project is waiting for you/,
    );
    await assert.rejects(
      connector.attention('another-project', '', 'Dashup is connected', '', 'input'),
      /Choose an existing project/,
    );
  } finally {
    connector.stop();
    if (previous === undefined) delete process.env.DASHUP_CONFIG;
    else process.env.DASHUP_CONFIG = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  'dashup alert reaches the running connector with a project alone, and says why it is refused',
  { timeout: 30_000 },
  async () => {
    const received: unknown[] = [];
    let refusal = '';
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      if (
        request.url !== '/attention' ||
        request.method !== 'POST' ||
        request.headers.authorization !== 'Bearer local-secret'
      )
        return void response.writeHead(403).end();
      received.push(JSON.parse(body));
      if (refusal) response.writeHead(400).end(JSON.stringify({ error: refusal }));
      else response.end('{}');
    });
    const previous = process.env.DASHUP_CONFIG;
    let root = '';
    // The command reaches the connector on a port derived from its config path.
    for (let attempt = 0; ; attempt++) {
      root = mkdtempSync(join(tmpdir(), 'dashup-alert-'));
      process.env.DASHUP_CONFIG = join(root, 'connector.json');
      server.listen(connectorPort(), '127.0.0.1');
      try {
        await once(server, 'listening');
        break;
      } catch (error) {
        rmSync(root, { recursive: true, force: true });
        if (attempt === 4) throw error;
      }
    }
    const alert = async (...args: string[]) => {
      const child = spawn(process.execPath, ['--import', 'tsx', INDEX, 'alert', ...args], {
        cwd: CONNECTOR,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', (chunk) => (output += String(chunk)));
      child.stderr.on('data', (chunk) => (output += String(chunk)));
      const [code] = await once(child, 'close');
      return { code, output };
    };
    try {
      saveConfig({ api: 'http://127.0.0.1:1', secret: '', pairs: {}, localSecret: 'local-secret' });
      const sent = await alert('--project', 'project', '--title', 'Dashup is connected');
      assert.match(sent.output, /Encrypted alert queued/);
      assert.equal(sent.code, 0);
      assert.deepEqual(received, [
        {
          projectId: 'project',
          threadId: '',
          title: 'Dashup is connected',
          body: '',
          reason: 'input',
        },
      ]);
      refusal = 'No conversation in this project is waiting for you.';
      const refused = await alert('--project', 'project', '--thread', 'thread');
      assert.match(refused.output, /No conversation in this project is waiting for you\./);
      assert.equal(refused.code, 1);
      assert.equal((received[1] as { threadId: string }).threadId, 'thread');
      server.closeAllConnections();
      server.close();
      await once(server, 'close');
      const stopped = await alert('--project', 'project');
      assert.match(stopped.output, /Start dashup watch on this computer first/);
      assert.equal(stopped.code, 1);
    } finally {
      server.closeAllConnections();
      server.close();
      if (previous === undefined) delete process.env.DASHUP_CONFIG;
      else process.env.DASHUP_CONFIG = previous;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
