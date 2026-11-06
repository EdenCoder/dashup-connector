import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hexToBytes, utf8ToBytes } from '@noble/ciphers/utils.js';

import { MAX_ATTACHMENT_BYTES, PROTOCOL_VERSION } from './index';
import type { RandomBytes } from './crypto';

// =============================================================================
// Attachment frames: independently authenticated, ordered and bound to the complete file
// =============================================================================

export const ATTACHMENT_FRAME_BYTES = 32 * 1024;
const MAGIC = new Uint8Array([68, 65, 83, 72, 65, 84, 84, 50]); // DASHATT2
const HEADER_BYTES = MAGIC.length + 24 + 4;
const TAG_BYTES = 16;
const frames = (size: number): number => Math.max(1, Math.ceil(size / ATTACHMENT_FRAME_BYTES));
const sealedSize = (size: number): number => HEADER_BYTES + size + frames(size) * TAG_BYTES;
export const MAX_SEALED_ATTACHMENT_BYTES = sealedSize(MAX_ATTACHMENT_BYTES);
type Yield = () => Promise<void>;
type Read = (offset: number, length: number) => Promise<Uint8Array>;

export function framedAttachment(bytes: Uint8Array): boolean {
  return MAGIC.every((byte, index) => bytes[index] === byte);
}

function validSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ATTACHMENT_BYTES)
    throw new Error('Invalid attachment size');
}

function header(size: number, random: RandomBytes): Uint8Array {
  validSize(size);
  const value = new Uint8Array(HEADER_BYTES);
  value.set(MAGIC);
  const nonce = random(24);
  if (nonce.length !== 24) throw new Error('Invalid attachment nonce');
  value.set(nonce, MAGIC.length);
  new DataView(value.buffer).setUint32(HEADER_BYTES - 4, size);
  return value;
}

function metadata(bytes: Uint8Array): number {
  if (!framedAttachment(bytes) || bytes.length < HEADER_BYTES)
    throw new Error('Invalid attachment header');
  const size = new DataView(bytes.buffer, bytes.byteOffset, HEADER_BYTES).getUint32(
    HEADER_BYTES - 4,
  );
  validSize(size);
  if (bytes.length !== sealedSize(size)) throw new Error('Incomplete attachment');
  return size;
}

function cipher(
  key: Uint8Array,
  head: Uint8Array,
  pairing: string,
  id: string,
  size: number,
  index: number,
) {
  const nonce = Uint8Array.from(head.subarray(MAGIC.length, MAGIC.length + 24));
  // XOR keeps every nonce distinct within one random 192-bit attachment nonce.
  let count = index;
  for (let at = nonce.length - 1; count; at--) {
    nonce[at] = nonce[at]! ^ (count & 255);
    count = Math.floor(count / 256);
  }
  return xchacha20poly1305(
    key,
    nonce,
    utf8ToBytes(
      JSON.stringify([
        PROTOCOL_VERSION,
        'attachment-frames',
        2,
        pairing,
        id,
        size,
        ATTACHMENT_FRAME_BYTES,
        index,
      ]),
    ),
  );
}

export function sealAttachmentFramed(
  key: string,
  pairing: string,
  id: string,
  bytes: Uint8Array,
  random: RandomBytes,
): Uint8Array {
  const head = header(bytes.length, random);
  const secret = hexToBytes(key);
  const result = new Uint8Array(sealedSize(bytes.length));
  result.set(head);
  for (let index = 0; index < frames(bytes.length); index++) {
    const offset = index * ATTACHMENT_FRAME_BYTES;
    result.set(
      cipher(secret, head, pairing, id, bytes.length, index).encrypt(
        bytes.subarray(offset, offset + ATTACHMENT_FRAME_BYTES),
      ),
      HEADER_BYTES + offset + index * TAG_BYTES,
    );
  }
  return result;
}

export async function sealAttachmentAsync(
  key: string,
  pairing: string,
  id: string,
  size: number,
  read: Read,
  random: RandomBytes,
  yieldWork: Yield,
): Promise<Uint8Array> {
  const head = header(size, random);
  const secret = hexToBytes(key);
  const result = new Uint8Array(sealedSize(size));
  result.set(head);
  for (let index = 0; index < frames(size); index++) {
    const offset = index * ATTACHMENT_FRAME_BYTES;
    const length = Math.min(ATTACHMENT_FRAME_BYTES, size - offset);
    const bytes = await read(offset, length);
    if (bytes.length !== length) throw new Error('Attachment changed while reading');
    await yieldWork();
    result.set(
      cipher(secret, head, pairing, id, size, index).encrypt(bytes),
      HEADER_BYTES + offset + index * TAG_BYTES,
    );
  }
  return result;
}

export function openAttachmentFramed(
  key: string,
  pairing: string,
  id: string,
  bytes: Uint8Array,
): Uint8Array {
  const size = metadata(bytes);
  const secret = hexToBytes(key);
  const head = bytes.subarray(0, HEADER_BYTES);
  const result = new Uint8Array(size);
  for (let index = 0; index < frames(size); index++) {
    const offset = index * ATTACHMENT_FRAME_BYTES;
    const start = HEADER_BYTES + offset + index * TAG_BYTES;
    result.set(
      cipher(secret, head, pairing, id, size, index).decrypt(
        bytes.subarray(start, start + Math.min(ATTACHMENT_FRAME_BYTES, size - offset) + TAG_BYTES),
      ),
      offset,
    );
  }
  return result;
}

export async function openAttachmentAsync(
  key: string,
  pairing: string,
  id: string,
  bytes: Uint8Array,
  yieldWork: Yield,
): Promise<Uint8Array> {
  const size = metadata(bytes);
  const secret = hexToBytes(key);
  const head = bytes.subarray(0, HEADER_BYTES);
  const result = new Uint8Array(size);
  for (let index = 0; index < frames(size); index++) {
    await yieldWork();
    const offset = index * ATTACHMENT_FRAME_BYTES;
    const start = HEADER_BYTES + offset + index * TAG_BYTES;
    result.set(
      cipher(secret, head, pairing, id, size, index).decrypt(
        bytes.subarray(start, start + Math.min(ATTACHMENT_FRAME_BYTES, size - offset) + TAG_BYTES),
      ),
      offset,
    );
  }
  return result;
}
