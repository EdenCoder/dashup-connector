import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToHex, hexToBytes, utf8ToBytes, bytesToUtf8 } from '@noble/ciphers/utils.js';

import { PROTOCOL_VERSION, type Content, type Envelope, type PairingCode } from './index';
import { framedAttachment, openAttachmentFramed, sealAttachmentFramed } from './attachment';

// =============================================================================
// Device content encryption
// =============================================================================

export type Routing = Omit<Envelope, 'v' | 'nonce' | 'ciphertext'>;
export type RandomBytes = (length: number) => Uint8Array;

const KEY_BYTES   = 32;
const NONCE_BYTES = 24;

function associated(envelope: Routing): Uint8Array {
  return utf8ToBytes(
    JSON.stringify([
      PROTOCOL_VERSION,
      envelope.id,
      envelope.pairing,
      envelope.sender,
      envelope.recipient,
      envelope.channel,
      envelope.project,
      envelope.sequence,
      envelope.sentAt,
    ]),
  );
}

function hexDigit(code: number): number {
  return code >= 48 && code <= 57
    ? code - 48
    : code >= 65 && code <= 70
      ? code - 55
      : code >= 97 && code <= 102
        ? code - 87
        : -1;
}

function ciphertextBytes(hex: string): Uint8Array {
  if (typeof hex !== 'string') throw new TypeError('Ciphertext must be hexadecimal');
  if (hex.length % 2) throw new RangeError('Ciphertext must contain complete hexadecimal bytes');
  // PrimJS's fromHex polyfill creates a substring and runs a regex for every byte.
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const high = hexDigit(hex.charCodeAt(i * 2));
    const low  = hexDigit(hex.charCodeAt(i * 2 + 1));
    if (high < 0 || low < 0) throw new RangeError('Ciphertext contains invalid hexadecimal');
    bytes[i] = high * 16 + low;
  }
  return bytes;
}

export function newSecret(random: RandomBytes): string {
  return bytesToHex(random(KEY_BYTES));
}

export function seal(
  key: string,
  routing: Routing,
  content: Content,
  random: RandomBytes,
): Envelope {
  return {
    ...routing,
    v: PROTOCOL_VERSION,
    ...encryptContent(key, associated(routing), content, random),
  };
}

export function open(key: string, envelope: Envelope): Content {
  if (envelope.v !== PROTOCOL_VERSION) throw new Error('Unsupported encryption version');
  const content = decryptContent<Content>(key, associated(envelope), envelope);
  if (content.type !== envelope.channel) throw new Error('Encrypted content channel mismatch');
  return content;
}

export function encryptContent(
  key: string,
  associatedData: Uint8Array,
  content: unknown,
  random: RandomBytes,
): { nonce: string; ciphertext: string } {
  const nonce = random(NONCE_BYTES);
  const ciphertext = xchacha20poly1305(hexToBytes(key), nonce, associatedData).encrypt(
    utf8ToBytes(JSON.stringify(content)),
  );
  return { nonce: bytesToHex(nonce), ciphertext: bytesToHex(ciphertext) };
}

export function decryptContent<T>(
  key: string,
  associatedData: Uint8Array,
  sealed: { nonce: string; ciphertext: string },
): T {
  const cleartext = xchacha20poly1305(
    hexToBytes(key),
    hexToBytes(sealed.nonce),
    associatedData,
  ).decrypt(ciphertextBytes(sealed.ciphertext));
  return JSON.parse(bytesToUtf8(cleartext)) as T;
}

// =============================================================================
// Attachments
// =============================================================================

// An attachment's bytes travel as binary, sealed to its pairing and id, with the nonce in front.
const attachmentData = (pairing: string, id: string): Uint8Array =>
  utf8ToBytes(JSON.stringify([PROTOCOL_VERSION, 'attachment', pairing, id]));

export function sealAttachment(
  key: string,
  pairing: string,
  id: string,
  bytes: Uint8Array,
  random: RandomBytes,
): Uint8Array {
  return sealAttachmentFramed(key, pairing, id, bytes, random);
}

export function openAttachment(
  key: string,
  pairing: string,
  id: string,
  sealed: Uint8Array,
): Uint8Array {
  if (framedAttachment(sealed)) return openAttachmentFramed(key, pairing, id, sealed);
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const cipher = xchacha20poly1305(hexToBytes(key), nonce, attachmentData(pairing, id));
  return cipher.decrypt(sealed.subarray(NONCE_BYTES));
}

// =============================================================================
// Pairing code
// =============================================================================

// Upper case keeps the whole text in QR alphanumeric mode, so the code fits in a terminal.
const PAIRING_CODE = new RegExp(
  `^DASHUP:${PROTOCOL_VERSION}:([0-9A-F]{64}):([0-9A-F]{16}):([0-9A-F]{64}):(.+)$`,
);

export function formatPairingCode({ api, computer, code, key }: PairingCode): string {
  return `DASHUP:${PROTOCOL_VERSION}:${computer}:${code}:${key}:${api}`.toUpperCase();
}

export function parsePairingCode(value: string): PairingCode {
  const match = PAIRING_CODE.exec(value.trim().toUpperCase());
  if (!match) throw new Error('Scan a Dashup pairing code');
  const [computer, code, key, origin] = match.slice(1).map((part) => part.toLowerCase());
  const api = new URL(origin!);
  if (
    api.protocol !== 'https:' &&
    !(api.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(api.hostname))
  ) {
    throw new Error('Pairing requires an HTTPS server');
  }
  if (api.username || api.password || api.search || api.hash || api.pathname !== '/')
    throw new Error('Use the API server origin');
  return { api: api.origin, computer: computer!, code: code!, key: key! };
}
