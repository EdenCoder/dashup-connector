import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { newSecret } from './crypto';
import { openSession, sealSession, SESSION_PACKET_BYTES, type SessionContent, type SessionPacket } from './session';

const routing = {
  pairing: 'pair',
  sender: 'phone',
  recipient: 'desktop',
  stream: 'ab'.repeat(16),
  sequence: 1,
};
const content: SessionContent = {
  type: 'command',
  requestId: 'request',
  projectId: 'project',
  threadId: 'thread',
  action: { kind: 'thread.send', text: 'Private prompt' },
};

test('session content opens only on paired devices and each packet receives a fresh nonce', () => {
  const key = newSecret(randomBytes);
  const first = sealSession(key, routing, content, randomBytes);
  const second = sealSession(key, { ...routing, sequence: 2 }, content, randomBytes);
  assert.deepEqual(openSession(key, first), content);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.ok(!JSON.stringify(first).includes('Private prompt'));
  assert.throws(() => openSession(newSecret(randomBytes), first));
});

test('session routing, stream epoch, sequence, nonce and ciphertext are authenticated together', () => {
  const key = newSecret(randomBytes);
  const packet = sealSession(key, routing, content, randomBytes);
  for (const field of [
    'v',
    'pairing',
    'sender',
    'recipient',
    'stream',
    'sequence',
    'nonce',
    'ciphertext',
  ] as const) {
    const value = packet[field];
    const altered =
      typeof value === 'number'
        ? value + 1
        : value.slice(0, -1) + (value.endsWith('0') ? '1' : '0');
    assert.throws(() => openSession(key, { ...packet, [field]: altered } as SessionPacket), field);
  }
});

test('session packets reject oversized content before transport or decryption', () => {
  const key = newSecret(randomBytes);
  assert.throws(
    () =>
      sealSession(
        key,
        routing,
        { type: 'output', terminalId: 'terminal', data: 'x'.repeat(SESSION_PACKET_BYTES) },
        randomBytes,
      ),
    /packet/,
  );
  const packet = sealSession(key, routing, content, randomBytes);
  assert.throws(
    () => openSession(key, { ...packet, ciphertext: '00'.repeat(SESSION_PACKET_BYTES + 1) }),
    /packet/,
  );
});
