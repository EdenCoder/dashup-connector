import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, stat, symlink, mkdir } from 'node:fs/promises';

import { MAX_ATTACHMENT_BYTES, type Attachment, type PairingRecord } from '@dashup/protocol';
import { newSecret, sealAttachment } from '@dashup/protocol/crypto';

import { receiveUploads } from '../src/uploads';
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
