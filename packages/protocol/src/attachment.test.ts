import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

import { openAttachment, sealAttachment } from './crypto';
import { MAX_ATTACHMENT_BYTES, PROTOCOL_VERSION } from './index';
import { ATTACHMENT_FRAME_BYTES, MAX_SEALED_ATTACHMENT_BYTES, sealAttachmentAsync, openAttachmentAsync } from './attachment';

const key = randomBytes(32).toString('hex');
const pairing = 'paired-computer';
const id = 'attachment-id';

test('framed attachments roundtrip empty, partial and maximum files through Node Buffer without mutating ciphertext', () => {
  for (const size of [
    0,
    1,
    ATTACHMENT_FRAME_BYTES - 1,
    ATTACHMENT_FRAME_BYTES,
    ATTACHMENT_FRAME_BYTES + 1,
    300_000,
    MAX_ATTACHMENT_BYTES,
  ]) {
    const plain = randomBytes(size);
    const sealed = Buffer.from(sealAttachment(key, pairing, id, plain, randomBytes));
    const before = Buffer.from(sealed);
    assert.deepEqual(Buffer.from(openAttachment(key, pairing, id, sealed)), plain);
    assert.deepEqual(sealed, before);
    assert.ok(sealed.length <= MAX_SEALED_ATTACHMENT_BYTES);
  }
});

test('framing authenticates ordering, truncation, file identity, length and every frame', () => {
  const plain = randomBytes(ATTACHMENT_FRAME_BYTES * 3);
  const sealed = sealAttachment(key, pairing, id, plain, randomBytes);
  assert.throws(() => openAttachment(key, 'other-pair', id, sealed));
  assert.throws(() => openAttachment(key, pairing, 'other-file', sealed));
  assert.throws(() => openAttachment(randomBytes(32).toString('hex'), pairing, id, sealed));
  for (const at of [0, 8, 31, 32, 35, 36, sealed.length - 1]) {
    const corrupt = new Uint8Array(sealed);
    corrupt[at] = corrupt[at]! ^ 1;
    assert.throws(() => openAttachment(key, pairing, id, corrupt), `altered byte ${at}`);
  }
  assert.throws(() => openAttachment(key, pairing, id, sealed.subarray(0, sealed.length - 16)));
  assert.throws(() => openAttachment(key, pairing, id, new Uint8Array([...sealed, 0])));
  const frame = ATTACHMENT_FRAME_BYTES + 16;
  const reordered = new Uint8Array(sealed);
  reordered.set(sealed.subarray(36 + frame, 36 + frame * 2), 36);
  reordered.set(sealed.subarray(36, 36 + frame), 36 + frame);
  assert.throws(() => openAttachment(key, pairing, id, reordered));
});

test('async sealing and opening yield for every bounded frame and cancel before returning partial data', async () => {
  const plain = randomBytes(ATTACHMENT_FRAME_BYTES * 3 + 1);
  let reads = 0;
  let turns = 0;
  const sealed = await sealAttachmentAsync(
    key,
    pairing,
    id,
    plain.length,
    async (offset, length) => {
      assert.ok(length <= ATTACHMENT_FRAME_BYTES);
      reads++;
      return plain.subarray(offset, offset + length);
    },
    randomBytes,
    async () => {
      turns++;
    },
  );
  assert.equal(reads, 4);
  assert.equal(turns, 4);
  turns = 0;
  assert.deepEqual(
    Buffer.from(
      await openAttachmentAsync(key, pairing, id, sealed, async () => {
        turns++;
      }),
    ),
    plain,
  );
  assert.equal(turns, 4);
  turns = 0;
  await assert.rejects(
    openAttachmentAsync(key, pairing, id, sealed, async () => {
      if (++turns === 2) throw new Error('cancelled');
    }),
    /cancelled/,
  );
  assert.equal(turns, 2);
});

test('previous unframed encrypted attachments still decrypt', () => {
  const nonce = randomBytes(24);
  const plain = Buffer.from('Previously shared private content');
  const aad = new TextEncoder().encode(
    JSON.stringify([PROTOCOL_VERSION, 'attachment', pairing, id]),
  );
  const encrypted = xchacha20poly1305(Buffer.from(key, 'hex'), nonce, aad).encrypt(plain);
  const old = Buffer.concat([nonce, encrypted]);
  assert.deepEqual(Buffer.from(openAttachment(key, pairing, id, old)), plain);
  assert.throws(() => openAttachment(key, pairing, 'other-file', old));
});
