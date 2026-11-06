import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';

import { OpenCodeService } from '../src/harness/opencode-service';

// =============================================================================
// Native service activity survives its newest-session page
// =============================================================================

async function waitFor(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 3_000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Native activity event was not observed');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('OpenCode service includes older active sessions and follows native working/idle events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dashup-opencode-active-'));
  const previous = process.env.DASHUP_OPENCODE_SERVICE;
  const calls: string[] = [];
  const streams = new Set<ServerResponse>();
  const session = (id: string) => ({
    id,
    title: id,
    time: { updated: 1_700_000_000_000 },
    location: { directory: '/project' },
  });
  const recent = Array.from({ length: 100 }, (_, index) => session(`ses_recent_${index}`));
  let active = {
    ses_older: { type: 'running' },
    ses_recent_0: { type: 'running' },
    ses_missing: { type: 'running' },
    ses_mismatched: { type: 'running' },
  } as Record<string, { type: string }>;
  const server = createServer((request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname;
    calls.push(`${request.method} ${path}`);
    if (path === '/api/event') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      streams.add(response);
      response.once('close', () => streams.delete(response));
      return void response.write('event: connected\ndata: {}\n\n');
    }
    const routes: Record<string, unknown> = {
      '/api/info'                   : { version: '2.0.21' },
      '/api/session'                : { data: recent },
      '/api/session/active'         : { data: active },
      '/api/session/ses_older'      : { data: session('ses_older') },
      '/api/session/ses_mismatched' : { data: session('ses_wrong') },
      '/api/model'                  : { data: [] },
      '/api/agent'                  : { data: [] },
      '/api/permission/request'     : { data: [] },
    };
    if (/\/form$/.test(path)) routes[path] = { data: [] };
    if (!(path in routes)) return void response.writeHead(404).end();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(routes[path]));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const path = join(root, 'service.json');
  await writeFile(
    path,
    JSON.stringify({ url: `http://127.0.0.1:${port}`, pid: process.pid, password: 'fixture' }),
  );
  process.env.DASHUP_OPENCODE_SERVICE = path;
  let changes = 0;
  const service = new OpenCodeService(() => changes++);
  try {
    let found = await service.refresh();
    assert.equal(found.length, 101);
    assert.equal(found.find((item) => item.id === 'ses_older')?.status, 'working');
    assert.equal(found.find((item) => item.id === 'ses_recent_0')?.status, 'working');
    assert.equal(found.find((item) => item.id === 'ses_recent_1')?.status, 'idle');
    assert.ok(found.find((item) => item.id === 'ses_older')?.stop);
    assert.equal(
      found.some((item) => item.id === 'ses_wrong'),
      false,
    );
    assert.equal(calls.includes('GET /api/session/ses_recent_0'), false);
    await waitFor(() => changes > 0);
    let before = changes;
    active = {};
    for (const stream of streams) stream.write('event: session.idle\ndata: {}\n\n');
    await waitFor(() => changes > before);
    found = await service.refresh();
    assert.equal(found.find((item) => item.id === 'ses_recent_0')?.status, 'idle');
    assert.equal(found.find((item) => item.id === 'ses_recent_0')?.stop, undefined);
    assert.equal(
      found.some((item) => item.id === 'ses_older'),
      false,
    );
    before = changes;
    active = { ses_recent_0: { type: 'running' } };
    for (const stream of streams) stream.write('event: session.active\ndata: {}\n\n');
    await waitFor(() => changes > before);
    found = await service.refresh();
    assert.equal(found.find((item) => item.id === 'ses_recent_0')?.status, 'working');
    assert.ok(calls.every((call) => call.startsWith('GET ')));
  } finally {
    service.stop();
    for (const stream of streams) stream.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.DASHUP_OPENCODE_SERVICE;
    else process.env.DASHUP_OPENCODE_SERVICE = previous;
    await rm(root, { recursive: true, force: true });
  }
});
