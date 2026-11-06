import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';

import { OpenCode } from '../src/harness/opencode';

test(
  'OpenCode discovers a Node-hosted working session through filtered native process candidates',
  {
    skip: process.platform !== 'linux',
    timeout: 10_000,
  },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'dashup-opencode-discovery-'));
    const names = [
      'PATH',
      'DASHUP_LIVE_DISCOVERY',
      'DASHUP_OPENCODE_ENDPOINT',
      'DASHUP_OPENCODE_ENDPOINTS',
    ] as const;
    const previous = names.map((name) => process.env[name]);
    const script = join(home, 'opencode.mjs');
    await writeFile(
      script,
      `
import { createServer } from 'node:http';
const server = createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path === '/event') {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"type":"server.connected"}\\n\\n');
    return;
  }
  const value = path === '/global/health' ? { healthy: true, version: '1.2.0' }
    : path === '/session' ? [{ id: 'fixture', directory: '/fixture', title: 'Fixture', time: { updated: 1 } }]
    : path === '/session/status' ? { fixture: { type: 'busy' } }
    : [];
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
});
server.listen(0, '127.0.0.1', () => process.stdout.write('ready\\n'));
`,
    );
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] });
    const openCode = new OpenCode(() => {});
    try {
      await once(child.stdout!, 'data');
      await writeFile(
        join(home, 'ps'),
        '#!/bin/sh\n' +
          '[ "$*" = "-C opencode,node,bun,MainThread -o pid=" ] || exit 1\n' +
          `printf "${child.pid}\\n"\n`,
        { mode: 0o700 },
      );
      process.env.PATH = home;
      process.env.DASHUP_LIVE_DISCOVERY = '1';
      delete process.env.DASHUP_OPENCODE_ENDPOINT;
      delete process.env.DASHUP_OPENCODE_ENDPOINTS;
      const sessions = await openCode.refresh();
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.id, 'fixture');
      assert.equal(sessions[0]?.status, 'working');
    } finally {
      openCode.stop();
      child.kill();
      await once(child, 'exit');
      names.forEach((name, index) => {
        if (previous[index] === undefined) delete process.env[name];
        else process.env[name] = previous[index];
      });
      await rm(home, { recursive: true, force: true });
    }
  },
);
