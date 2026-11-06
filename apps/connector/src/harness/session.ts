import { createHash } from 'node:crypto';
import { MAX_ATTACHMENT_BYTES, ATTACHMENT_NAME_CHARS } from '@dashup/protocol';
import type { ContextUsage } from '@dashup/protocol/context';
import type { Editor, Harness, Message, Approval, ToolStep, Attachment, AgentOption, ApprovalReply, ThreadSummary } from '@dashup/protocol';

// =============================================================================
// Existing harness sessions
// =============================================================================

// What a session's own record says it last ran with, by option id: its model, and switches such
// as fast mode.
export type Settings = Record<string, string | boolean>;

// Decrypted uploads stay on this computer. Native image inputs use their local paths.
export type InputFile = { path: string; mime: string };
export const INPUT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// `parent` is the native id of the session a subagent works for, in the same harness. `step` is
// the newest tool step its saved history holds.
export type HistorySession = {
  id          : string;
  cwd         : string;
  title       : string;
  harness     : Harness;
  parent?     : string;
  updatedAt   : string;
  step?       : ToolStep;
  files       : string[];
  // Native history can exist while another process still owns the session.
  resumable?  : false;
  read()      : Message[];
  settings?() : Settings;
  context?()  : ContextUsage | undefined;
  // A saved lifecycle marker needs a live writer before it describes present activity.
  status?()   : 'working' | 'idle' | undefined;
};

// A live session without a `title` leaves the one its saved history gives.
export type LiveSession = {
  id         : string;
  cwd        : string;
  title?     : string;
  harness    : Harness;
  editor?    : Editor;
  updatedAt  : string;
  status     : ThreadSummary['status'];
  messages   : Message[];
  // Null clears a previous report; undefined permits a saved native report before live usage arrives.
  context?   : ContextUsage | null;
  // The reply the agent is writing, as far as it has streamed, when its host reports one.
  typing?    : string;
  approvals  : Approval[];
  // Native workbenches return one bounded page, including `before` when supplied.
  readMessages? : (before?: string) => Promise<{ messages: Message[]; more: boolean }>;
  // Release selected native content when no paired phone is viewing this session.
  releaseMessages? : () => void;
  stop?      : (requestId: string) => Promise<void>;
  // With `now`, the agent stops what it is doing and takes the message at once, when `now` says
  // the session can.
  send?      : (
    requestId: string,
    text: string,
    now?: boolean,
    files?: InputFile[],
  ) => Promise<void>;
  now?       : boolean;
  approve?   : (requestId: string, approvalId: string, reply: ApprovalReply) => Promise<void>;
  // What the session runs with; `recorded` reads what its record says it last ran with.
  options?   : (recorded: () => Settings) => AgentOption[];
  // Takes effect from the agent's next reply.
  configure? : (requestId: string, option: string, value: string | boolean) => Promise<void>;
};

// What the phone shows where a conversation's published messages begin after its first.
export const EARLIER: Message = {
  id   : 'earlier',
  role : 'system',
  text : 'Earlier messages stay on your computer.',
};

export const sessionKey = (session: { harness: Harness; id: string }): string =>
  `${session.harness}\0${session.id}`;

// Zed agent ids and VS Code agent providers contain their harness's name.
export function agentHarness(name: string): Harness | undefined {
  if (/\bpi(?:-coding-agent)?\b/i.test(name)) return 'pi';
  if (/\bkilo(?:code)?\b/i.test(name)) return 'kilo';
  if (/\bcline\b/i.test(name)) return 'cline';
  if (/\bjunie\b/i.test(name)) return 'junie';
  if (/claude/i.test(name)) return 'claude';
  if (/codex/i.test(name)) return 'codex';
  if (/kimi/i.test(name)) return 'kimi';
  if (/opencode/i.test(name)) return 'opencode';
  return undefined;
}

// =============================================================================
// Attachments
// =============================================================================

// An image or file a message names, as this computer holds it: `id` is unique within its
// conversation, and `read` gives the bytes once the phone asks for them.
export type NativeAttachment = Attachment & { read(): Buffer };

// Base64 a native message carries, decoded only when the phone asks for it.
export const attached = (
  id: string,
  mime: string,
  data: string,
  name?: string,
): NativeAttachment => ({
  id,
  mime,
  bytes : Buffer.byteLength(data, 'base64'),
  ...(name ? { name: name.slice(-ATTACHMENT_NAME_CHARS) } : {}),
  read  : () => Buffer.from(data, 'base64'),
});

// Native text stays on this computer as a bounded immutable snapshot. Equal-length edits also
// invalidate the phone's reference; oversized content keeps only metadata for the size notice.
export function textAttachment(
  id: string,
  text: string,
  mime = 'text/plain',
  name?: string,
): NativeAttachment {
  const bytes = Buffer.byteLength(text);
  const meta  = {
    mime,
    bytes,
    ...(name ? { name: name.slice(-ATTACHMENT_NAME_CHARS) } : {}),
  };
  if (bytes > MAX_ATTACHMENT_BYTES)
    return {
      ...meta,
      id   : `${id}:oversized`,
      read : oversizedAttachment,
    };
  return {
    ...meta,
    id   : `${id}:${createHash('sha256').update(text).digest('hex')}`,
    read : () => Buffer.from(text),
  };
}

function oversizedAttachment(): never {
  throw new Error('This attachment is too large to open on your phone. Open it on your computer.');
}

export function toolInput(id: string, value: unknown): NativeAttachment | undefined {
  if (value === undefined) return undefined;
  const plain = typeof value === 'string';
  const text  = plain ? value : JSON.stringify(value, null, 2);
  if (text === undefined) return undefined;
  return textAttachment(
    `${id}:input`,
    text,
    plain ? 'text/plain' : 'application/json',
    plain ? 'Tool input.txt' : 'Tool input.json',
  );
}

// =============================================================================
// Approval previews
// =============================================================================

// A request too large to preview, or whose content stays in the native editor, is approved there.
export const MAX_PREVIEW = 64 * 1024;
export const NO_PREVIEW  = 'Review the full request on your computer before approving.';

// An agent's questions, as the phone asks them; `multiple` says which take several options.
export function questionApproval(
  id: string,
  items: Record<string, any>[],
  multiple: (item: Record<string, any>) => boolean,
): Approval {
  const asked = items.map((item) => ({
    ...(typeof item?.header === 'string' ? { header: item.header } : {}),
    question : String(item?.question ?? ''),
    options  : (Array.isArray(item?.options) ? item.options : [])
      .filter((option: Record<string, any>) => typeof option?.label === 'string')
      .map((option: Record<string, any>) => ({
        label : String(option.label),
        ...(typeof option.description === 'string' ? { description: option.description } : {}),
      })),
    ...(multiple(item) ? { multiple: true as const } : {}),
  }));
  return {
    id,
    title     : asked.length === 1 ? asked[0]!.question : `${asked.length} questions`,
    detail    : '',
    choices   : [{ id: 'skip', label: 'Skip' }],
    questions : asked,
  };
}
