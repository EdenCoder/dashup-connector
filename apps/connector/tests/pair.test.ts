import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir, hostname } from 'node:os';
import { rm, mkdtemp, readFile, writeFile } from 'node:fs/promises';

import type { PairingRecord } from '@dashup/protocol';
import { newSecret } from '@dashup/protocol/crypto';

import { link } from '../src/pair';
import { Connector } from '../src/connector';
import { loadConfig, saveConfig, type ConnectorConfig } from '../src/config';

// =============================================================================
// A computer's first pairing
// =============================================================================

type Call = { method: string; path: string; body?: any };

// The API as an unpaired computer meets it once a phone signed in to `scanner` has scanned its
// code. The code opens in a browser that does nothing.
async function scannedBy(
  scanner: string,
  run: (value: {
    config: ConnectorConfig;
    saved: string;
    calls: Call[];
    fail(request: string): void;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'dashup-pair-'));
  const saved = join(root, 'connector.json');
  const names = ['PATH', 'DISPLAY', 'DASHUP_CONFIG'] as const;
  const previous = names.map((name) => process.env[name]);
  const originalFetch = globalThis.fetch;
  const calls: Call[] = [];
  const failing = new Set<string>();
  const answer = (status: number, value: object) => new Response(JSON.stringify(value), { status });
  try {
    for (const browser of ['xdg-open', 'open'])
      await writeFile(join(root, browser), '#!/bin/sh\n', { mode: 0o700 });
    Object.assign(process.env, { PATH: root, DISPLAY: ':0', DASHUP_CONFIG: saved });
    globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ method, path: url.pathname, ...(body ? { body } : {}) });
      if (failing.has(`${method} ${url.pathname}`))
        return answer(500, { success: false, error: 'Unavailable' });
      if (method === 'GET' && url.pathname === '/v1/dashup/pairings')
        return answer(200, {
          success: true,
          result: {
            email: scanner,
            pairing: {
              id: 'pairing',
              device: 'computer',
              mobile: 'phone',
              code: url.searchParams.get('code'),
              revokedAt: null,
            },
          },
        });
      if (method === 'POST' && url.pathname === '/v1/dashup/devices')
        return answer(200, { success: true, result: { device: { ...body, user: 'user' } } });
      if (method === 'DELETE' && url.pathname === '/v1/dashup/pairings/pairing')
        return answer(200, { success: true, result: {} });
      return answer(404, { success: false, error: 'Not found' });
    }) as typeof fetch;
    await run({
      config: { api: 'https://isolated.invalid', secret: '', localSecret: '', pairs: {} },
      saved,
      calls,
      fail: (request) => failing.add(request),
    });
  } finally {
    globalThis.fetch = originalFetch;
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
    await rm(root, { recursive: true, force: true });
  }
}

const unix = { skip: process.platform === 'win32' };

test(
  'a pairing its owner refuses is revoked before the computer says anything about itself',
  unix,
  () =>
    scannedBy('someone@else.example', async ({ config, saved, calls }) => {
      assert.equal(await link(config, 'owner@example.com'), false);
      assert.deepEqual(
        calls.map(({ method, path }) => `${method} ${path}`),
        ['GET /v1/dashup/pairings', 'DELETE /v1/dashup/pairings/pairing'],
      );
      assert.equal(config.secret, '');
      await assert.rejects(readFile(saved), /ENOENT/);
    }),
);

test('a refused pairing that cannot be revoked is reported, and still shares nothing', unix, () =>
  scannedBy('someone@else.example', async ({ config, calls, fail }) => {
    fail('DELETE /v1/dashup/pairings/pairing');
    await assert.rejects(
      link(config, 'owner@example.com'),
      /Nothing was shared, but the pairing could not be removed from that account: Unavailable/,
    );
    assert.equal(
      calls.some(({ path }) => path === '/v1/dashup/devices'),
      false,
    );
    assert.equal(config.secret, '');
  }));

test('a confirmed pairing names the computer and keeps its secret and key', unix, () =>
  scannedBy('Owner@Example.com', async ({ config, saved, calls }) => {
    assert.equal(await link(config, 'owner@example.com'), true);
    assert.deepEqual(calls.at(-1), {
      method: 'POST',
      path: '/v1/dashup/devices',
      body: {
        id: 'computer',
        name: hostname(),
        kind: 'desktop',
        platform: process.platform === 'darwin' ? 'macos' : 'linux',
      },
    });
    assert.match(config.secret, /^[a-f0-9]{64}$/);
    assert.equal(config.device?.id, 'computer');
    assert.match(config.pairs.pairing!.key, /^[a-f0-9]{64}$/);
    assert.deepEqual(JSON.parse(await readFile(saved, 'utf8')).pairs, config.pairs);
  }));

// =============================================================================
// Pairings the computer holds no key for
// =============================================================================

test('a pairing made from a code this computer no longer holds is revoked once, and one whose key it holds never is', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dashup-pairings-'));
  const previous = process.env.DASHUP_CONFIG;
  process.env.DASHUP_CONFIG = join(root, 'connector.json');
  const revoked: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: URL | string, init?: RequestInit) => {
    const { Authorization } = init?.headers as Record<string, string>;
    if (init?.method === 'DELETE')
      revoked.push(`${Authorization} ${new URL(String(input)).pathname}`);
    return Response.json({ success: true, result: {} });
  });
  const record = (id: string, code: string, revokedAt: string | null = null): PairingRecord => ({
    id,
    device : 'computer',
    mobile : 'phone',
    code,
    revokedAt,
  });
  const config: ConnectorConfig = {
    api         : 'https://isolated.invalid',
    secret      : 'computer-secret',
    localSecret : newSecret(randomBytes),
    device      : {
      id       : 'computer',
      user     : 'user',
      kind     : 'desktop',
      name     : 'Computer',
      platform : 'linux',
    },
    pairs       : { held: { key: newSecret(randomBytes), sequence: 0 } },
  };
  saveConfig(config);
  const held = config.pairs.held!.key;
  let connector = new Connector(config);
  try {
    const scanned = connector.invite();
    const outstanding = connector.invite();
    const pairings = [
      record('held', 'held-code'),
      record('scanned', scanned.code),
      record('expired', 'expired-code'),
      record('cancelled', 'cancelled-code', '2026-11-18T00:00:00.000Z'),
      { ...record('elsewhere', 'elsewhere-code'), device: 'another-computer' },
    ];
    connector['acceptPairings'](pairings);
    connector['acceptPairings'](pairings);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(revoked, ['Bearer computer-secret /v1/dashup/pairings/expired']);
    assert.deepEqual(Object.keys(config.pairs).sort(), ['held', 'scanned']);
    assert.equal(config.pairs.scanned!.key, scanned.key);

    // A restart drops the code still outstanding, and keeps every key this computer held.
    connector.stop();
    connector = new Connector(loadConfig());
    connector['acceptPairings']([
      ...pairings.slice(0, 2),
      record('expired', 'expired-code', '2026-11-18T00:00:01.000Z'),
      record('late', outstanding.code),
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(revoked, [
      'Bearer computer-secret /v1/dashup/pairings/expired',
      'Bearer computer-secret /v1/dashup/pairings/late',
    ]);
    assert.equal(connector.config.pairs.held!.key, held);
    assert.equal(connector.config.pairs.scanned!.key, scanned.key);

    // A scan the walkthrough sees first is handed over, and its key outlasts the stop that follows.
    const first = connector.invite();
    connector.accept(record('first', first.code));
    connector.stop();
    connector = new Connector(loadConfig());
    connector['acceptPairings']([...pairings.slice(0, 2), record('first', first.code)]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(connector.config.pairs.first!.key, first.key);
    assert.equal(revoked.length, 2);
  } finally {
    connector.stop();
    if (previous === undefined) delete process.env.DASHUP_CONFIG;
    else process.env.DASHUP_CONFIG = previous;
    await rm(root, { recursive: true, force: true });
  }
});
