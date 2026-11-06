import { MAX_ATTACHMENT_BYTES, type Attachment } from './index';

// =============================================================================
// Deliberate phone input requested by an agent on its paired computer
// =============================================================================

export const PHONE_KINDS       = [
  'photo',
  'screenshot',
  'file',
  'sketch',
  'choice',
  'text',
] as const;
export const PHONE_TEXT          = 16_000;
export const PHONE_PROMPT        = 4_000;
export const PHONE_CHOICES       = 12;
export const PHONE_PENDING       = 4;
export const PHONE_WAIT_MS       = 120_000;
export const PHONE_MAX_WAIT_MS   = 300_000;
export const PHONE_CLOCK_SKEW_MS = 5_000;

export type PhoneKind = (typeof PHONE_KINDS)[number];
export type PhoneInput = {
  kind       : PhoneKind;
  prompt     : string;
  pairing?   : string;
  projectId? : string;
  threadId?  : string;
  choices?   : string[];
  timeoutMs? : number;
};
export type PhoneRequest = Omit<PhoneInput, 'pairing'> & {
  id        : string;
  expiresAt : number;
};
export type PhoneResponse = {
  requestId  : string;
  status     : 'completed' | 'declined' | 'cancelled';
  text?      : string;
  choice?    : string;
  attachment?: Attachment;
};
export type PhoneContent =

    | { type: 'phone.watch'; active: boolean }
    | { type: 'phone.request'; request: PhoneRequest }
    | ({ type: 'phone.response' } & PhoneResponse)
    | { type: 'phone.cancel'; requestId: string; reason: string };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid phone request.');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, optional = false): string | undefined {
  if (optional && value === undefined) return;
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error('Invalid phone request text.');
  return value;
}

export function parsePhoneInput(value: unknown): PhoneInput {
  const input = record(value);
  if (
    Object.keys(input).some(
      (key) =>
        !['kind', 'prompt', 'pairing', 'projectId', 'threadId', 'choices', 'timeoutMs'].includes(
          key,
        ),
    )
  )
    throw new Error('Unknown phone request option.');
  if (!PHONE_KINDS.includes(input.kind as PhoneKind))
    throw new Error('Choose a supported phone input kind.');
  const kind = input.kind as PhoneKind;
  const prompt = text(input.prompt, PHONE_PROMPT)!;
  const pairing = text(input.pairing, 128, true);
  const projectId = text(input.projectId, 128, true);
  const threadId = text(input.threadId, 128, true);
  let choices: string[] | undefined;
  if (input.choices !== undefined) {
    if (
      kind !== 'choice' ||
      !Array.isArray(input.choices) ||
      input.choices.length < 2 ||
      input.choices.length > PHONE_CHOICES
    )
      throw new Error('A choice request needs between 2 and 12 choices.');
    choices = input.choices.map((value) => text(value, 200)!);
    if (new Set(choices).size !== choices.length)
      throw new Error('Phone choices must be distinct.');
  }
  if (kind === 'choice' && !choices) throw new Error('Provide the choices to show on the phone.');
  const timeoutMs = input.timeoutMs;
  if (
    timeoutMs !== undefined &&
    (!Number.isInteger(timeoutMs) ||
      Number(timeoutMs) < 10_000 ||
      Number(timeoutMs) > PHONE_MAX_WAIT_MS)
  )
    throw new Error('Phone requests may wait between 10 and 300 seconds.');
  return {
    kind,
    prompt,
    ...(pairing ? { pairing } : {}),
    ...(projectId ? { projectId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(choices ? { choices } : {}),
    ...(timeoutMs === undefined ? {} : { timeoutMs: Number(timeoutMs) }),
  };
}

export function parsePhoneResponse(value: unknown): PhoneResponse {
  const input = record(value);
  if (
    Object.keys(input).some(
      (key) => !['type', 'requestId', 'status', 'text', 'choice', 'attachment'].includes(key),
    )
  )
    throw new Error('Unknown phone response field.');
  const requestId = text(input.requestId, 128)!;
  if (!['completed', 'declined', 'cancelled'].includes(String(input.status)))
    throw new Error('Invalid phone response.');
  const result: PhoneResponse = { requestId, status: input.status as PhoneResponse['status'] };
  if (input.text !== undefined) result.text = text(input.text, PHONE_TEXT)!;
  if (input.choice !== undefined) result.choice = text(input.choice, 200)!;
  if (input.attachment !== undefined) {
    const item = record(input.attachment);
    if (
      Object.keys(item).some((key) => !['id', 'name', 'mime', 'bytes'].includes(key)) ||
      typeof item.mime !== 'string' ||
      !/^[\w.+-]+\/[\w.+-]+$/.test(item.mime)
    )
      throw new Error('Invalid phone attachment type.');
    if (
      typeof item.id !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.id) ||
      !Number.isInteger(item.bytes) ||
      Number(item.bytes) < 1 ||
      Number(item.bytes) > MAX_ATTACHMENT_BYTES
    )
      throw new Error('Invalid phone attachment.');
    result.attachment = {
      id: item.id,
      name: text(item.name, 255)!,
      mime: text(item.mime, 200)!,
      bytes: Number(item.bytes),
    };
  }
  if (result.status !== 'completed' && (result.text || result.choice || result.attachment))
    throw new Error('A declined request cannot return content.');
  return result;
}
