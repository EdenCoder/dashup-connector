import { join, basename, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, realpath, open } from 'node:fs/promises';
import { MAX_ATTACHMENT_BYTES, ATTACHMENT_NAME_CHARS, type Attachment, type PairingRecord } from '@dashup/protocol';
import { openAttachment } from '@dashup/protocol/crypto';
import { configPath, type ConnectorConfig } from './config';
import type { InputFile } from './harness/session';

// =============================================================================
// Files the paired phone sends to its computer
// =============================================================================

const DOWNLOAD_MS = 30_000;

export type UploadedPrompt = { text: string; files: InputFile[] };

async function folder(pairing: string, id: string): Promise<string> {
  const home = dirname(configPath());
  await mkdir(home, { recursive: true, mode: 0o700 });
  let current = await realpath(home);
  for (const part of ['uploads', createHash('sha256').update(pairing).digest('hex'), id]) {
    current = join(current, part);
    await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('The private upload folder is not a directory.');
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      throw new Error('The upload folder must only be accessible to your operating-system user.');
  }
  return current;
}

async function store(path: string, bytes: Uint8Array): Promise<void> {
  let file;
  try {
    file = await open(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes.length)
      throw new Error('An existing file conflicts with this attachment.');
    const existing = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!(await existing.readFile()).equals(Buffer.from(bytes)))
        throw new Error('An existing file conflicts with this attachment.');
    } finally {
      await existing.close();
    }
    return;
  }
  try {
    await file.writeFile(bytes);
  } finally {
    await file.close();
  }
}

export async function receiveUploads(
  config: ConnectorConfig,
  pair: PairingRecord,
  text: string,
  attachments: Attachment[] = [],
  signal?: AbortSignal,
): Promise<UploadedPrompt> {
  if (!attachments.length) return { text, files: [] };
  const key = config.pairs[pair.id]?.key;
  if (!key || pair.revokedAt) throw new Error('Pair this phone again before uploading.');
  const files: InputFile[] = [];
  for (const item of attachments) {
    signal?.throwIfAborted();
    if (
      !/^[a-f0-9]{64}$/.test(item.id) ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 1 ||
      item.bytes > MAX_ATTACHMENT_BYTES
    )
      throw new Error('The attachment identity or size is invalid.');
    const response = await fetch(
      `${config.api}/v1/dashup/attachments/${encodeURIComponent(pair.id)}/${item.id}`,
      {
        headers: { Authorization: `Bearer ${config.secret}` },
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_MS)])
          : AbortSignal.timeout(DOWNLOAD_MS),
      },
    );
    if (!response.ok)
      throw new Error('An uploaded attachment is no longer available. Attach it again.');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('The attachment could not be downloaded.');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.length;
      if (bytes > MAX_ATTACHMENT_BYTES + 64) {
        await reader.cancel();
        throw new Error('The uploaded attachment is too large.');
      }
      chunks.push(part.value);
    }
    const opened = openAttachment(key, pair.id, item.id, Buffer.concat(chunks));
    signal?.throwIfAborted();
    if (opened.length !== item.bytes) throw new Error('Attachment size does not match.');
    if (config.pairs[pair.id]?.key !== key || pair.revokedAt)
      throw new Error('This phone is no longer paired.');
    const directory = await folder(pair.id, item.id);
    signal?.throwIfAborted();
    const name = basename((item.name || 'attachment').replaceAll('\\', '/'))
      .replace(/[\x00-\x1f<>:"|?*]/g, '_')
      .replace(/[. ]+$/, '')
      .slice(-ATTACHMENT_NAME_CHARS);
    const safe = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? `_${name}` : name;
    const path = join(directory, safe || 'attachment');
    signal?.throwIfAborted();
    await store(path, opened);
    files.push({ path, mime: item.mime });
  }
  return {
    text: `${text}\n\nFiles attached from my phone are available on this computer. Read these files as context for my message:\n${files.map((file) => JSON.stringify(file.path)).join('\n')}`,
    files,
  };
}
