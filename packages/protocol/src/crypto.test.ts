import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { DASHBOARD_BYTES, type Content, type PairingCode } from './index';

// Mobile provides these methods through core-js before Noble detects them.
const FROM_HEX = Object.getOwnPropertyDescriptor(Uint8Array, 'fromHex');
const TO_HEX   = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toHex');
if (!FROM_HEX)
  Object.defineProperty(Uint8Array, 'fromHex', {
    configurable: true,
    value: (hex: string) => {
      if (hex.length % 2 || /[^0-9a-f]/i.test(hex)) throw new RangeError('Invalid hex');
      return new Uint8Array(Buffer.from(hex, 'hex'));
    },
  });
if (!TO_HEX)
  Object.defineProperty(Uint8Array.prototype, 'toHex', {
    configurable: true,
    value(this: Uint8Array) {
      return Buffer.from(this).toString('hex');
    },
  });
const {
  open,
  seal,
  newSecret,
  openAttachment,
  sealAttachment,
  formatPairingCode,
  parsePairingCode,
} = await import('./crypto');
after(() => {
  if (FROM_HEX) Object.defineProperty(Uint8Array, 'fromHex', FROM_HEX);
  else Reflect.deleteProperty(Uint8Array, 'fromHex');
  if (TO_HEX) Object.defineProperty(Uint8Array.prototype, 'toHex', TO_HEX);
  else Reflect.deleteProperty(Uint8Array.prototype, 'toHex');
});

const ROUTING = {
  id        : 'message-1',
  pairing   : 'pair-1',
  sender    : 'desktop-1',
  recipient : 'phone-1',
  channel   : 'dashboard' as const,
  project   : '',
  sequence  : 1,
  sentAt    : '2026-10-17T00:00:00Z',
};

const CONTENT: Content = {
  type: 'dashboard',
  dashboard: {
    updatedAt: ROUTING.sentAt,
    version: 'test',
    features: [],
    projects: [
      {
        id: 'project-1',
        name: 'Private project',
        path: '/private/code',
        deviceId: 'desktop-1',
        active: '',
        started: 0,
      },
    ],
    sessions: [],
    agents: [],
    folders: [],
    usage: [],
  },
};

test('only the paired content key opens content; each send has a new nonce', () => {
  const key = newSecret(randomBytes);
  const first = seal(key, ROUTING, CONTENT, randomBytes);
  const second = seal(key, ROUTING, CONTENT, randomBytes);
  assert.deepEqual(open(key, first), CONTENT);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.ok(!JSON.stringify(first).includes('Private project'));
  assert.throws(() => open(newSecret(randomBytes), first));
});

test('ciphertext and routing metadata are authenticated together', () => {
  const key = newSecret(randomBytes);
  const envelope = seal(key, ROUTING, CONTENT, randomBytes);
  for (const field of [
    'v',
    'id',
    'pairing',
    'sender',
    'recipient',
    'channel',
    'project',
    'sequence',
    'sentAt',
    'nonce',
    'ciphertext',
  ] as const) {
    const value = envelope[field];
    const altered =
      typeof value === 'number'
        ? value + 1
        : value.slice(0, -1) + (value.endsWith('0') ? '1' : '0');
    assert.throws(() => open(key, { ...envelope, [field]: altered }), field);
  }
});

test('ciphertext hexadecimal is strict and accepts either ASCII letter case', () => {
  const key = newSecret(randomBytes);
  const envelope = seal(key, ROUTING, CONTENT, randomBytes);
  assert.deepEqual(
    open(key, { ...envelope, ciphertext: envelope.ciphertext.toUpperCase() }),
    CONTENT,
  );
  assert.throws(() => open(key, { ...envelope, ciphertext: envelope.ciphertext.slice(1) }), {
    name: 'RangeError',
    message: /complete hexadecimal bytes/,
  });
  for (const ciphertext of [
    ` ${envelope.ciphertext} `,
    `0x${envelope.ciphertext}`,
    envelope.ciphertext.slice(0, -2) + '0g',
    envelope.ciphertext.slice(0, -2) + 'a\n',
    envelope.ciphertext.slice(0, -2) + 'ＦＦ',
    envelope.ciphertext.slice(0, -2) + '🙂',
  ])
    assert.throws(() => open(key, { ...envelope, ciphertext }), {
      name: 'RangeError',
      message: /invalid hexadecimal/,
    });
  assert.throws(() => open(key, { ...envelope, ciphertext: '' }));
});

test('a bounded Unicode dashboard opens without the per-byte fromHex polyfill', () => {
  const key  = newSecret(randomBytes);
  const unit = '工作🙂 café\n';
  const size = DASHBOARD_BYTES / 2;
  const text = unit.repeat(Math.ceil(size / Buffer.byteLength(unit)));
  const content: Content = {
    ...CONTENT,
    dashboard: { ...CONTENT.dashboard, folders: [text] },
  };
  assert.ok(Buffer.byteLength(text) >= size);
  const envelope = seal(key, ROUTING, content, randomBytes);
  const descriptor = Object.getOwnPropertyDescriptor(Uint8Array, 'fromHex');
  const fromHex = descriptor?.value as ((hex: string) => Uint8Array) | undefined;
  // Both methods existed when Noble loaded, so this exercises its polyfill-selection branch.
  assert.equal(typeof fromHex, 'function');
  assert.equal(typeof (Uint8Array.prototype as unknown as { toHex?: unknown }).toHex, 'function');
  let largeCalls = 0;
  Object.defineProperty(Uint8Array, 'fromHex', {
    configurable: true,
    value: (hex: string) => {
      if (hex.length > 64) {
        largeCalls++;
        throw new Error('Large payload reached the per-byte hex polyfill');
      }
      return fromHex!.call(Uint8Array, hex);
    },
  });
  try {
    assert.deepEqual(open(key, envelope), content);
    assert.equal(largeCalls, 0);
  } finally {
    Object.defineProperty(Uint8Array, 'fromHex', descriptor!);
  }
});

test('attachment bytes open only with their pairing key, pairing and id', () => {
  const key    = newSecret(randomBytes);
  const id     = newSecret(randomBytes);
  const bytes  = randomBytes(100_000);
  const sealed = sealAttachment(key, 'pair-1', id, bytes, randomBytes);
  assert.ok(sealed.length > bytes.length);
  assert.ok(Buffer.from(openAttachment(key, 'pair-1', id, sealed)).equals(bytes));
  assert.ok(!Buffer.from(sealed).includes(bytes.subarray(0, 32)));
  assert.notDeepEqual(sealAttachment(key, 'pair-1', id, bytes, randomBytes), sealed);
  assert.throws(() => openAttachment(newSecret(randomBytes), 'pair-1', id, sealed));
  assert.throws(() => openAttachment(key, 'pair-2', id, sealed));
  assert.throws(() => openAttachment(key, 'pair-1', newSecret(randomBytes), sealed));
  const altered = sealed.slice();
  altered[altered.length - 1]! ^= 1;
  assert.throws(() => openAttachment(key, 'pair-1', id, altered));
});

test('pairing codes are upper case, survive any case and reject untrusted API origins', () => {
  const code: PairingCode = {
    api      : 'https://api.example.com',
    computer : newSecret(randomBytes),
    code     : newSecret(randomBytes).slice(0, 16),
    key      : newSecret(randomBytes),
  };
  const text = formatPairingCode(code);
  assert.equal(text, text.toUpperCase());
  assert.deepEqual(parsePairingCode(text), code);
  assert.deepEqual(parsePairingCode(` ${text.toLowerCase()}\n`), code);
  assert.throws(() => parsePairingCode(text.replace('DASHUP:1:', 'DASHUP:2:')));
  for (const api of [
    'http://example.com',
    'javascript:alert(1)',
    'https://user:password@example.com',
    'https://example.com/path',
    'https://example.com/?key=leak',
  ]) {
    assert.throws(() => parsePairingCode(formatPairingCode({ ...code, api })));
  }
});
