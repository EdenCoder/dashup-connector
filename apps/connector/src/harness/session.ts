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
  // The conversation its store keeps. One read in windows gives the newest, or the one holding
  // `before`, with more than a phone's page before it unless the conversation starts within it.
  read(before?: string) : Message[];
  settings?() : Settings;
  context?()  : ContextUsage | undefined;
  // A saved lifecycle marker needs a live writer before it describes present activity.
  status?()   : 'working' | 'idle' | undefined;
};

// A conversation's messages, oldest first, holding its newest or the one a page ends at; `more`
// says earlier messages exist before the first.
export type Page = { messages: Message[]; more: boolean };

// A page read from another process is refused past these bounds.
const PAGE_MESSAGES = 64;
const PAGE_BYTES    = 2 * 1024 * 1024;

export function bounded(page: Page): Page {
  if (
    page.messages.length > PAGE_MESSAGES ||
    Buffer.byteLength(JSON.stringify(page.messages)) > PAGE_BYTES
  )
    throw new Error('The native conversation page exceeds its limit.');
  return page;
}

// A live session without a `title` leaves the one its saved history gives. The connector's stored
// receipt runs each request once, so `stop`, `send`, `approve` and `configure` act on every call;
// `requestId` names the request to hosts that take a client id.
export type LiveSession<H extends Harness = Harness> = {
  id         : string;
  cwd        : string;
  title?     : string;
  harness    : H;
  editor?    : Editor;
  updatedAt  : string;
  status     : ThreadSummary['status'];
  // Null clears a previous report; undefined permits a saved native report before live usage arrives.
  context?   : ContextUsage | null;
  // The reply the agent is writing, as far as it has streamed, when its host reports one.
  typing?    : string;
  approvals  : Approval[];
  // Read only when a phone opens the conversation: the whole list its host gives, or a native
  // workbench's bounded page, which holds `before` when supplied.
  readMessages? : (before?: string) => Promise<Page>;
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

// Whether integrations look for agents where each keeps its own records, sockets and processes.
// Turned off, an integration reads only what a setting of its own names.
export const liveDiscovery = (): boolean => process.env.DASHUP_LIVE_DISCOVERY !== '0';

// One read at a time: a call made while one is under way takes its result.
export function singleFlight<T>(read: () => Promise<T>): () => Promise<T> {
  let reading: Promise<T> | undefined;
  return () => (reading ??= read().finally(() => (reading = undefined)));
}

// A burst of native events is one change: `changed` hears of it once, a tenth of a second after
// the first. `cancel` drops a change it has not heard of yet.
export function debounced(changed: () => void): (() => void) & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const soon = (): void => {
    timer ??= setTimeout(() => {
      timer = undefined;
      changed();
    }, 100).unref();
  };
  soon.cancel = (): void => {
    clearTimeout(timer);
    timer = undefined;
  };
  return soon;
}

// =============================================================================
// Sessions Dashup hosts
// =============================================================================

// The title of a session Dashup starts: the first line of its first message.
export const firstLine = (text: string): string => text.trim().split('\n')[0]!.slice(0, 80);

// What a session Dashup hosts holds of its conversation, which its agent's own history keeps: the
// messages of a turn under way, and after it only while a phone reads them.
export class HostedConversation {
  readonly messages: Message[] = [];
  private followed = false;

  constructor(private readonly running: () => boolean) {}

  // A phone that reads the conversation holds it until it lets go.
  readonly read = async (): Promise<Page> => {
    this.followed = true;
    return { messages: [...this.messages], more: false };
  };

  readonly release = (): void => {
    this.followed = false;
    this.ended();
  };

  ended(): void {
    if (!this.running() && !this.followed) this.messages.length = 0;
  }
}

// Hands a session its message. Nothing runs between turns, so a session that could not take its
// first message is forgotten.
export async function hand<S extends { readonly id: string }>(
  sessions: Map<string, S>,
  session: S,
  say: () => Promise<void>,
): Promise<void> {
  const known = sessions.has(session.id);
  sessions.set(session.id, session);
  try {
    await say();
  } catch (error) {
    if (!known) sessions.delete(session.id);
    throw error;
  }
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
