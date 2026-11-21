import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { join, dirname, relative } from 'node:path';
import { rm, stat, mkdir, lstat, mkdtemp, symlink, utimes, lutimes, readFile, writeFile } from 'node:fs/promises';

import { MAX_ATTACHMENT_BYTES, type Attachment, type PairingRecord } from '@dashup/protocol';
import { newSecret, sealAttachment } from '@dashup/protocol/crypto';

import { Connector } from '../src/connector';
import { forgetUploads, expireUploads, receiveUploads } from '../src/uploads';
import type { ConnectorConfig } from '../src/config';

async function fixture(
  run: (value: {
    root: string;
    pair: PairingRecord;
    config: ConnectorConfig;
    item: Attachment;
    sealed: Uint8Array;
    bytes: Buffer;
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'dashup-uploads-'));
  const previous = process.env.DASHUP_CONFIG;
  const originalFetch = globalThis.fetch;
  const pair: PairingRecord = {
    id: 'pair',
    device: 'computer',
    mobile: 'phone',
    code: '',
    revokedAt: null,
  };
  const key = newSecret(randomBytes);
  const config: ConnectorConfig = {
    api: 'https://isolated.invalid',
    secret: 'device-secret',
    localSecret: newSecret(randomBytes),
    pairs: { [pair.id]: { key, sequence: 0 } },
  };
  const bytes = Buffer.from('private file content');
  const item: Attachment = {
    id: randomBytes(32).toString('hex'),
    mime: 'text/plain',
    bytes: bytes.length,
    name: '../../outside.txt',
  };
  const sealed = sealAttachment(key, pair.id, item.id, bytes, randomBytes);
  process.env.DASHUP_CONFIG = join(root, 'connector.json');
  globalThis.fetch = async () => new Response(new Uint8Array(sealed));
  try {
    await run({ root, pair, config, item, sealed, bytes });
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.DASHUP_CONFIG;
    else process.env.DASHUP_CONFIG = previous;
    await rm(root, { recursive: true, force: true });
  }
}

test('phone files are decrypted only on their paired computer and staged privately without traversal', async () => {
  await fixture(async ({ root, config, pair, item, sealed, bytes }) => {
    let called = 0;
    globalThis.fetch = async (url, options) => {
      called++;
      assert.equal(String(url), `${config.api}/v1/dashup/attachments/pair/${item.id}`);
      assert.equal(new Headers(options?.headers).get('Authorization'), 'Bearer device-secret');
      assert.equal(options?.body, undefined);
      assert.equal(options?.redirect, 'error');
      return new Response(new Uint8Array(sealed));
    };
    const prompt = await receiveUploads(config, pair, 'Inspect this', [item]);
    assert.equal(called, 1);
    assert.equal(prompt.files.length, 1);
    const file = prompt.files[0]!;
    assert.ok(relative(root, file.path).startsWith('uploads/'));
    assert.ok(file.path.endsWith('/outside.txt'));
    assert.deepEqual(await readFile(file.path), bytes);
    assert.equal((await stat(file.path)).mode & 0o777, 0o600);
    assert.ok(prompt.text.includes(JSON.stringify(file.path)));
    assert.ok(!prompt.text.includes(bytes.toString()));
    assert.deepEqual(await receiveUploads(config, pair, 'Inspect this', [item]), prompt);
  });
});

test('tampered ciphertext, another pairing, invalid IDs and mismatched sizes never stage a file', async () => {
  await fixture(async ({ config, pair, item, sealed }) => {
    const corrupt = new Uint8Array(sealed);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    globalThis.fetch = async () => new Response(corrupt);
    await assert.rejects(receiveUploads(config, pair, 'inspect', [item]));
    globalThis.fetch = async () => new Response(new Uint8Array(sealed));
    await assert.rejects(
      receiveUploads(config, pair, 'inspect', [{ ...item, bytes: item.bytes + 1 }]),
      /size/,
    );
    await assert.rejects(
      receiveUploads(config, pair, 'inspect', [{ ...item, id: '../escape' }]),
      /identity/,
    );
    config.pairs.other = config.pairs.pair!;
    await assert.rejects(receiveUploads(config, { ...pair, id: 'other' }, 'inspect', [item]));
  });
});

test('revocation during download and oversized streams are rejected before decrypting to disk', async () => {
  await fixture(async ({ config, pair, item, sealed }) => {
    const key = config.pairs.pair!;
    globalThis.fetch = async () => {
      delete config.pairs.pair;
      return new Response(new Uint8Array(sealed));
    };
    await assert.rejects(receiveUploads(config, pair, 'inspect', [item]), /no longer paired/);
    config.pairs.pair = key;
    globalThis.fetch = async () => new Response(new Uint8Array(MAX_ATTACHMENT_BYTES + 65));
    await assert.rejects(receiveUploads(config, pair, 'inspect', [item]), /too large/);
  });
});

test('existing file and directory symlinks cannot redirect uploaded content', async () => {
  await fixture(async ({ root, config, pair, item }) => {
    const prompt = await receiveUploads(config, pair, 'inspect', [item]);
    const outside = join(root, 'outside');
    await writeFile(outside, 'untouched');
    await rm(prompt.files[0]!.path);
    await symlink(outside, prompt.files[0]!.path);
    await assert.rejects(receiveUploads(config, pair, 'inspect', [item]), /conflicts/);
    assert.equal(await readFile(outside, 'utf8'), 'untouched');
    await rm(join(root, 'uploads'), { recursive: true });
    const other = join(root, 'other');
    await mkdir(other);
    await symlink(other, join(root, 'uploads'));
    await assert.rejects(receiveUploads(config, pair, 'inspect', [item]), /not a directory/);
  });
});

// =============================================================================
// Removing uploads
// =============================================================================

const DAY = 24 * 60 * 60_000;
const exists = async (path: string) => !!(await lstat(path).catch(() => undefined));

test('a revoked pairing takes its uploads with it, and a pairing still held keeps its own', async () => {
  await fixture(async ({ config, pair, item, sealed }) => {
    const held = { ...pair, id: 'held' };
    const key = newSecret(randomBytes);
    config.pairs[held.id] = { key, sequence: 0 };
    config.device = {
      id       : pair.device,
      user     : 'user',
      kind     : 'desktop',
      name     : 'Computer',
      platform : 'linux',
    };
    const revoked = (await receiveUploads(config, pair, 'inspect', [item])).files[0]!.path;
    const own = sealAttachment(key, held.id, item.id, Buffer.from('kept'), randomBytes);
    globalThis.fetch = async () => new Response(new Uint8Array(own));
    const [kept] = (await receiveUploads(config, held, 'inspect', [{ ...item, bytes: 4 }])).files;
    globalThis.fetch = async () => new Response(new Uint8Array(sealed));
    const connector = new Connector(config);
    try {
      connector['acceptPairings']([{ ...pair, revokedAt: '2026-11-18T00:00:00.000Z' }, held]);
      for (let wait = 0; wait < 100 && (await exists(dirname(dirname(revoked)))); wait++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(await exists(dirname(dirname(revoked))), false);
      assert.equal(await readFile(kept!.path, 'utf8'), 'kept');
    } finally {
      connector.stop();
    }
  });
});

test('an upload goes a day after the phone last sent it', async () => {
  await fixture(async ({ config, pair, item }) => {
    const path = (await receiveUploads(config, pair, 'inspect', [item])).files[0]!.path;
    const stale = new Date(Date.now() - DAY - 60_000);
    await utimes(dirname(path), stale, stale);
    // Sent again, the same upload stays another day.
    await receiveUploads(config, pair, 'inspect', [item]);
    await expireUploads();
    assert.equal(await exists(path), true);
    await utimes(dirname(path), stale, stale);
    await expireUploads();
    assert.equal(await exists(dirname(path)), false);
    assert.equal(await exists(dirname(dirname(path))), true);
  });
});

test('removing uploads never follows a link out of the uploads folder', async () => {
  await fixture(async ({ root, config, pair, item }) => {
    const path = (await receiveUploads(config, pair, 'inspect', [item])).files[0]!.path;
    const upload = dirname(path);
    const outside = join(root, 'outside');
    await mkdir(join(outside, 'f'.repeat(64)), { recursive: true });
    await writeFile(join(outside, 'kept.txt'), 'untouched');
    const stale = new Date(Date.now() - DAY - 60_000);
    // A link inside an expired upload goes with it; what it names stays.
    await symlink(join(outside, 'kept.txt'), join(upload, 'link'));
    // A link where an upload or a pairing's folder would be is never followed.
    await symlink(outside, join(dirname(upload), 'e'.repeat(64)));
    await lutimes(join(dirname(upload), 'e'.repeat(64)), stale, stale);
    await symlink(outside, join(root, 'uploads', 'd'.repeat(64)));
    await utimes(join(outside, 'f'.repeat(64)), stale, stale);
    await utimes(upload, stale, stale);
    await expireUploads();
    assert.equal(await exists(upload), false);
    assert.equal(await readFile(join(outside, 'kept.txt'), 'utf8'), 'untouched');
    assert.equal(await exists(join(outside, 'f'.repeat(64))), true);
    // Nor when the uploads folder itself is a link.
    const moved = join(root, 'moved', createHash('sha256').update(pair.id).digest('hex'), item.id);
    await mkdir(moved, { recursive: true });
    await utimes(moved, stale, stale);
    await rm(join(root, 'uploads'), { recursive: true });
    await symlink(join(root, 'moved'), join(root, 'uploads'));
    await expireUploads();
    await forgetUploads(pair.id);
    assert.equal(await exists(moved), true);
  });
});
