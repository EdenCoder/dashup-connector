import { utf8ToBytes } from '@noble/ciphers/utils.js';

import { encryptContent, decryptContent, type RandomBytes } from './crypto';
import type { Approval, SessionAttention, CommandAction, HistoryMessage, ProjectOverview, QueueReceipt, ThreadSummary } from './index';
import type { Workspace } from './workspace';
import type { PhoneContent } from './phone';
import type { ContextUsage } from './context';

// =============================================================================
// The selected session: ephemeral, end-to-end encrypted device traffic
// =============================================================================

export const SESSION_VERSION      = 1;
export const SESSION_PACKET_BYTES = 64 * 1024;
export const SESSION_STREAM_BYTES = 16;
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
export type SessionReady = SessionJoin & { ok: boolean; error?: string };
export type SessionPeer = SessionJoin & { connected: boolean };
export type SessionRouting = {
  pairing: string;
  sender: string;
  recipient: string;
  stream: string;
  sequence: number;
};
export type SessionPacket = SessionRouting & {
  v: typeof SESSION_VERSION;
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

function associated({ pairing, sender, recipient, stream, sequence }: SessionRouting): Uint8Array {
  return utf8ToBytes(
    JSON.stringify([
      'dashup:session',
      SESSION_VERSION,
      pairing,
      sender,
      recipient,
      stream,
      sequence,
    ]),
  );
}

export function sealSession(
  key: string,
  routing: SessionRouting,
  content: SessionContent,
  random: RandomBytes,
): SessionPacket {
  const bytes = utf8ToBytes(JSON.stringify(content));
  if (bytes.length + 16 > SESSION_PACKET_BYTES)
    throw new Error('Session update exceeds its live packet limit.');
  return {
    v: SESSION_VERSION,
    ...routing,
    ...encryptContent(key, associated(routing), content, random),
  };
}

export function openSession(key: string, packet: SessionPacket): SessionContent {
  if (packet.v !== SESSION_VERSION || packet.ciphertext.length > SESSION_PACKET_BYTES * 2)
    throw new Error('Invalid encrypted session packet.');
  return decryptContent<SessionContent>(key, associated(packet), packet);
}
