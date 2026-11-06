import { createHmac, randomBytes } from 'node:crypto';
import { MAX_ATTACHMENT_BYTES, ATTACHMENT_NAME_CHARS, HISTORY_TEXT_CHARS } from '@dashup/protocol';
import { sealAttachment } from '@dashup/protocol/crypto';
import type { Message, Attachment, PairingRecord } from '@dashup/protocol';
import { api, activePair, type ConnectorConfig } from './config';
import { attached, textAttachment, type NativeAttachment } from './harness/session';

// =============================================================================
// Native message previews
// =============================================================================

const ID                  = /^[a-f0-9]{64}$/;
const MIME                = /^[\w.+-]{1,64}\/[\w.+-]{1,64}$/;
const OUTPUT_PREVIEW      = { lines: 12, chars: 2_000 } as const;
const MESSAGE_ATTACHMENTS = 4;

function prefix(text: string, chars: number): string {
  let end = Math.min(text.length, chars);
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  return text.slice(0, end);
}

const preview = (text: string): string =>
  prefix(text.split('\n', OUTPUT_PREVIEW.lines).join('\n'), OUTPUT_PREVIEW.chars);

function validAttachment(value: Attachment): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.id === 'string' &&
    ID.test(value.id) &&
    typeof value.mime === 'string' &&
    MIME.test(value.mime) &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0 &&
    (value.name === undefined ||
      (typeof value.name === 'string' && value.name.length <= ATTACHMENT_NAME_CHARS))
  );
}

export const opaque = (key: string, value: readonly unknown[]): string =>
  createHmac('sha256', Buffer.from(key, 'hex')).update(JSON.stringify(value)).digest('hex');

export function messageForPhone(
  key: string,
  project: string,
  thread: string,
  message: Message,
): Message {
  const { tool, full, attachments, ...rest } = kept(message);
  const name = (value: Attachment) => named(key, project, thread, value);
  const files = attachments?.map(name).filter(validAttachment).slice(0, MESSAGE_ATTACHMENTS);
  const input = tool?.input ? name(tool.input) : undefined;
  return {
    ...rest,
    ...(tool
      ? { tool: { ...tool, input: input && validAttachment(input) ? input : undefined } }
      : {}),
    ...(full ? { full: name(full) } : {}),
    ...(files?.length ? { attachments: files } : {}),
  };
}

// =============================================================================
// Attachments
// =============================================================================

const ATTACHMENTS_PATH = '/dashup/attachments';
// A base64 data URL longer than a preview is a picture pasted into the text, not something to read.
const PASTED = new RegExp(
  `data:([\\w.+-]+/[\\w.+-]+);base64,([A-Za-z0-9+/]{${OUTPUT_PREVIEW.chars},}={0,2})`,
  'g',
);

// A message too large for one page starts at its beginning. Complete text, pictures pasted into
// prose and named files stay on this computer until the phone asks for them.
function kept(message: Message): Message {
  const files: Attachment[] = [...(message.attachments ?? [])];
  const text  =
    message.role === 'tool'
      ? message.text
      : message.text.replace(PASTED, (_, mime: string, data: string, at: number) => {
          files.push(attached(`${message.id}@${at}`, mime, data));
          return '';
        });
  const start =
    message.role === 'tool' && !message.tool?.diff
      ? preview(text)
      : text.length > HISTORY_TEXT_CHARS
        ? prefix(text, HISTORY_TEXT_CHARS)
        : text;
  const full =
    start.length < text.length || text.length > HISTORY_TEXT_CHARS
      ? textAttachment(`${message.id}:full`, text)
      : undefined;
  return {
    ...message,
    text: start,
    ...(full ? { full } : {}),
    ...(files.length ? { attachments: files } : {}),
  };
}

// The phone's name for an attachment: only its pairing knows which it is, and changed bytes get a
// new name.
const named = (
  key: string,
  project: string,
  thread: string,
  attachment: Attachment,
): Attachment => ({
  id    : opaque(key, ['history-attachment', project, thread, attachment.id, attachment.bytes]),
  mime  : attachment.mime,
  bytes : attachment.bytes,
  ...(attachment.name ? { name: attachment.name } : {}),
});

const readable = (attachment: Attachment): attachment is NativeAttachment => 'read' in attachment;

// Seals the attachment a phone names, read again from its conversation, for the phone to fetch.
export async function shareAttachment(
  config: ConnectorConfig,
  pair: PairingRecord,
  project: string,
  thread: string,
  messages: readonly Message[],
  id: string,
): Promise<void> {
  if (!activePair(config, pair)) throw new Error('Pairing is no longer available');
  const key   = config.pairs[pair.id]!.key;
  const found = messages
    .flatMap((message) => {
      const { tool, full, attachments = [] } = kept(message);
      return [...(tool?.input ? [tool.input] : []), ...(full ? [full] : []), ...attachments];
    })
    .find((attachment) => named(key, project, thread, attachment).id === id);
  if (!found || !readable(found)) throw new Error('This attachment is no longer on your computer');
  if (found.bytes > MAX_ATTACHMENT_BYTES)
    throw new Error('This attachment is too large to open on your phone');
  const content = found.read();
  if (content.byteLength > MAX_ATTACHMENT_BYTES)
    throw new Error('This attachment is too large to open on your phone');
  if (content.byteLength !== found.bytes)
    throw new Error('This attachment changed. Open the conversation again to refresh it.');
  const sealed = sealAttachment(key, pair.id, id, content, randomBytes);
  await api(config, `${ATTACHMENTS_PATH}/${pair.id}/${id}`, sealed);
}
