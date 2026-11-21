import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { newSecret } from './crypto';
import { openSession, sealSession, sealHello, opensHello, openLegacySession, sealLegacySession, SESSION_VERSION, SESSION_PACKET_BYTES, type SessionContent, type SessionPacket } from './session';

const routing = {
  pairing: 'pair',
  sender: 'phone',
  recipient: 'desktop',
  stream: 'ab'.repeat(16),
  sequence: 1,
};
const peer = 'cd'.repeat(16);
const content: SessionContent = {
  type: 'command',
  requestId: 'request',
  projectId: 'project',
  threadId: 'thread',
  action: { kind: 'thread.send', text: 'Private prompt' },
};

test('session content opens only on paired devices and each packet receives a fresh nonce', () => {
  const key = newSecret(randomBytes);
  const first = sealSession(key, routing, peer, content, randomBytes);
  const second = sealSession(key, { ...routing, sequence: 2 }, peer, content, randomBytes);
  assert.equal(first.v, SESSION_VERSION);
  assert.deepEqual(openSession(key, first, peer), content);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.ok(!JSON.stringify(first).includes('Private prompt'));
  assert.ok(!JSON.stringify(first).includes(peer));
  assert.throws(() => openSession(newSecret(randomBytes), first, peer));
});

test('session routing, stream epoch, sequence, nonce and ciphertext are authenticated together', () => {
  const key = newSecret(randomBytes);
  const packet = sealSession(key, routing, peer, content, randomBytes);
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
    assert.throws(
      () => openSession(key, { ...packet, [field]: altered } as SessionPacket, peer),
      field,
    );
  }
});

test('a packet opens only under the stream its recipient held when it was sealed', () => {
  const key = newSecret(randomBytes);
  const packet = sealSession(key, routing, peer, content, randomBytes);
  assert.throws(() => openSession(key, packet, 'ef'.repeat(16)));
  assert.throws(() => openSession(key, packet, routing.stream));
  assert.throws(() => openSession(key, packet, ''));
  assert.throws(() => sealSession(key, routing, '', content, randomBytes), /peer stream/);
  assert.throws(() => sealSession(key, routing, 'not-a-stream', content, randomBytes));
});

test('the one packet sealed to no stream is a hello, and it opens as nothing else', () => {
  const key = newSecret(randomBytes);
  const hello = sealHello(key, routing, randomBytes);
  assert.equal(hello.v, SESSION_VERSION);
  assert.equal(opensHello(key, hello), true);
  assert.equal(opensHello(newSecret(randomBytes), hello), false);
  assert.equal(opensHello(key, { ...hello, sequence: 2 }), false);
  assert.throws(() => openSession(key, hello, peer));
  assert.throws(() => openSession(key, hello, ''));
  assert.equal(opensHello(key, sealSession(key, routing, peer, content, randomBytes)), false);
  assert.equal(
    opensHello(key, sealSession(key, routing, peer, { type: 'welcome' }, randomBytes)),
    false,
  );
});

test('session packets reject oversized content before transport or decryption', () => {
  const key = newSecret(randomBytes);
  assert.throws(
    () =>
      sealSession(
        key,
        routing,
        peer,
        { type: 'output', terminalId: 'terminal', data: 'x'.repeat(SESSION_PACKET_BYTES) },
        randomBytes,
      ),
    /packet/,
  );
  const packet = sealSession(key, routing, peer, content, randomBytes);
  assert.throws(
    () => openSession(key, { ...packet, ciphertext: '00'.repeat(SESSION_PACKET_BYTES + 1) }, peer),
    /packet/,
  );
});

test('version 1 packets open only as version 1, and version 2 packets never do', () => {
  const key = newSecret(randomBytes);
  const legacy = sealLegacySession(key, routing, content, randomBytes);
  assert.equal(legacy.v, 1);
  assert.deepEqual(openLegacySession(key, legacy), content);
  assert.throws(() => openSession(key, legacy, peer), /packet/);
  assert.throws(() => openSession(key, { ...legacy, v: SESSION_VERSION }, peer));
  assert.equal(opensHello(key, legacy), false);
  const packet = sealSession(key, routing, peer, content, randomBytes);
  assert.throws(() => openLegacySession(key, packet), /packet/);
  assert.throws(() => openLegacySession(key, { ...packet, v: 1 }));
  assert.throws(() => openLegacySession(key, { ...sealHello(key, routing, randomBytes), v: 1 }));
});
