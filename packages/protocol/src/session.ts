import { utf8ToBytes } from '@noble/ciphers/utils.js';

import { encryptBytes, decryptContent, type RandomBytes } from './crypto';
import type { Approval, SessionAttention, CommandAction, HistoryMessage, ProjectOverview, QueueReceipt, ThreadSummary } from './index';
import type { Workspace } from './workspace';
import type { PhoneContent } from './phone';
import type { ContextUsage } from './context';

// =============================================================================
// The selected session: ephemeral, end-to-end encrypted device traffic
// =============================================================================

export const SESSION_VERSION      = 2;
export const SESSION_PACKET_BYTES = 64 * 1024;
export const SESSION_STREAM_BYTES = 16;
// The peer streams an end remembers. Past these it takes a new stream of its own rather than forget
// one, since nothing sealed to its old stream opens under the new.
export const SESSION_STREAMS      = 32;
export const SESSION_JOIN         = 'dashup:session:join';
export const SESSION_READY        = 'dashup:session:ready';
export const SESSION_PACKET       = 'dashup:session:packet';
export const SESSION_PEER         = 'dashup:session:peer';
export const CHAT_PAGE_MESSAGES   = 30;
export const SESSION_COMMANDS     = 64;
export const CHAT_PAGE_TEXT_CHARS = 16 * 1024;
export const CHAT_PAGE_BYTES      = 40 * 1024;
export const COMPOSER_TEXT_CHARS  = 12 * 1024;

export type SessionJoin = { pairing: string; device: string; stream: string };
// A refusal the phone can act on names why: `subscription` is an account without Dashup Cloud.
export type SessionReady = SessionJoin & { ok: boolean; error?: string; reason?: 'subscription' };
export type SessionPeer = SessionJoin & { connected: boolean };
export type SessionRouting = {
  pairing: string;
  sender: string;
  recipient: string;
  stream: string;
  sequence: number;
};
export type SessionPacket = SessionRouting & {
  v: number;
  nonce: string;
  ciphertext: string;
};
export type SessionCommand = {
  type: 'command';
  requestId: string;
  projectId: string;
  threadId?: string;
  action: CommandAction;
};
export type SessionResult = {
  type: 'result';
  requestId: string;
  ok: boolean;
  error?: string;
  queue?: QueueReceipt;
  workspace?: Workspace;
  started?: { projectId: string; threadId: string };
  thread?: ThreadSummary;
  project?: ProjectOverview;
  sessions?: Array<ThreadSummary & { projectId: string }>;
  next?: string | null;
  projects?: ProjectOverview[];
};
export type ChatPage = {
  type: 'chat.page';
  requestId?: string;
  projectId: string;
  threadId: string;
  updatedAt: string;
  messages: HistoryMessage[];
  before: string | null;
  latest: boolean;
  typing?: string;
  confirmed?: string[];
};
export type SessionContent =

    | PhoneContent
    | SessionCommand
    | SessionResult
    | ChatPage
    | {
        type: 'thread-state';
        projectId: string;
        thread: ThreadSummary;
        approvals: Approval[];
        attention?: SessionAttention;
        context?: ContextUsage;
      }
    // The computer's answer to a hello. Its packet names the computer's stream.
    | { type: 'welcome' }
    | { type: 'chat.attach' | 'chat.detach'; projectId: string; threadId: string }
    | {
        type: 'chat.history';
        requestId: string;
        projectId: string;
        threadId: string;
        before?: string;
      }
    | { type: 'open'; requestId: string; projectId: string; cols: number; rows: number }
    | {
        type: 'opened';
        requestId: string;
        projectId: string;
        threadId: string;
        terminalId: string;
        thread: ThreadSummary;
        project: ProjectOverview;
      }
    | { type: 'attach' | 'detach' | 'close'; terminalId: string }
    | { type: 'input'; terminalId: string; data: string; binary?: boolean }
    | {
        type: 'output';
        terminalId: string;
        data: string;
        reset?: boolean;
        cols?: number;
        rows?: number;
      }
    | { type: 'resize'; terminalId: string; cols: number; rows: number }
    | { type: 'exit'; terminalId: string; exitCode?: number }
    | {
        type: 'error';
        requestId?: string;
        terminalId?: string;
        projectId?: string;
        threadId?: string;
        message: string;
      };

// =============================================================================
// Packets: sealed to the pair of streams their two ends hold
// =============================================================================

const STREAM = new RegExp(`^[a-f0-9]{${SESSION_STREAM_BYTES * 2}}$`);
const HELLO  = { type: 'hello' } as const;

// What authenticates with a packet. `peer` is the recipient's stream when the packet was sealed, so
// nothing sealed before either end's current stream opens again.
const associated = (
  version: number,
  { pairing, sender, recipient, stream, sequence }: SessionRouting,
  ...peer: string[]
): Uint8Array =>
  utf8ToBytes(
    JSON.stringify([
      'dashup:session',
      version,
      pairing,
      sender,
      recipient,
      stream,
      ...peer,
      sequence,
    ]),
  );

function sealed(
  version: number,
  key: string,
  routing: SessionRouting,
  data: Uint8Array,
  content: unknown,
  random: RandomBytes,
): SessionPacket {
  const bytes = utf8ToBytes(JSON.stringify(content));
  if (bytes.length + 16 > SESSION_PACKET_BYTES)
    throw new Error('Session update exceeds its live packet limit.');
  return { v: version, ...routing, ...encryptBytes(key, data, bytes, random) };
}

function opened<T>(version: number, key: string, packet: SessionPacket, data: Uint8Array): T {
  if (packet.v !== version || packet.ciphertext.length > SESSION_PACKET_BYTES * 2)
    throw new Error('Invalid encrypted session packet.');
  return decryptContent<T>(key, data, packet);
}

export function sealSession(
  key: string,
  routing: SessionRouting,
  peer: string,
  content: SessionContent,
  random: RandomBytes,
): SessionPacket {
  if (!STREAM.test(peer)) throw new Error('The session has no peer stream.');
  const data = associated(SESSION_VERSION, routing, peer);
  return sealed(SESSION_VERSION, key, routing, data, content, random);
}

// `stream` is the opener's own. A packet sealed to another stream, or to none, does not open.
export function openSession(key: string, packet: SessionPacket, stream: string): SessionContent {
  if (!STREAM.test(stream)) throw new Error('Invalid encrypted session packet.');
  return opened(SESSION_VERSION, key, packet, associated(SESSION_VERSION, packet, stream));
}

// An end that has yet to learn its peer's stream says hello, the one packet sealed to no stream.
// It carries nothing and changes nothing: its answer is a welcome sealed to the hello's stream.
export const sealHello = (
  key: string,
  routing: SessionRouting,
  random: RandomBytes,
): SessionPacket =>
  sealed(SESSION_VERSION, key, routing, associated(SESSION_VERSION, routing, ''), HELLO, random);

export function opensHello(key: string, packet: SessionPacket): boolean {
  try {
    const data = associated(SESSION_VERSION, packet, '');
    return opened<{ type?: unknown }>(SESSION_VERSION, key, packet, data).type === HELLO.type;
  } catch {
    return false;
  }
}

// =============================================================================
// Version 1: sealed to the sender's stream alone
// =============================================================================

// A relay can replay an earlier version 1 stream. A connector speaks it with a phone only until
// that phone's app speaks version 2. This section goes when no supported app build speaks version 1.
export const sealLegacySession = (
  key: string,
  routing: SessionRouting,
  content: SessionContent,
  random: RandomBytes,
): SessionPacket => sealed(1, key, routing, associated(1, routing), content, random);

export const openLegacySession = (key: string, packet: SessionPacket): SessionContent =>
  opened(1, key, packet, associated(1, packet));
