import { timingSafeEqual } from 'node:crypto';

import { SESSION_COMMANDS, CHAT_PAGE_BYTES, CHAT_PAGE_MESSAGES, CHAT_PAGE_TEXT_CHARS, type ChatPage } from '@dashup/protocol/session';
import type { Message, HistoryMessage } from '@dashup/protocol';

import { messageForPhone, opaque } from './attachments';

// =============================================================================
// A bounded view of the native conversation; no exported transcript or database generation
// =============================================================================

type Target = { project: string; thread: string; updatedAt: string };
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const text = (value: string | undefined, length: number) => value?.slice(0, length);
export const historyMessageId = (
  key: string,
  target: Pick<Target, 'project' | 'thread'>,
  id: string,
) => opaque(key, ['history-message', target.project, target.thread, id]);

function cursor(key: string, target: Target, id: string): string {
  const data = Buffer.from(JSON.stringify(id)).toString('base64url');
  return `${data}.${opaque(key, ['chat-cursor', target.project, target.thread, data])}`;
}

export function chatPosition(key: string, target: Target, value: string): string {
  const [data, signature, extra] = value.split('.');
  if (!data || !signature || extra || !/^[a-f0-9]{64}$/.test(signature) || data.length > 2048)
    throw new Error('This conversation page is no longer available. Load the latest messages.');
  const expected = opaque(key, ['chat-cursor', target.project, target.thread, data]);
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex')))
    throw new Error('Conversation cursor does not match this session.');
  const result = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  if (typeof result !== 'string' || !result) throw new Error('Invalid conversation cursor.');
  return result;
}

export function chatPage(
  key: string,
  target: Target,
  messages: readonly Message[],
  before?: string,
  requestId?: string,
  typing = '',
  hasEarlier = false,
  requests?: ReadonlyMap<string, string>,
): ChatPage {
  let at = messages.length - 1;
  if (before) {
    const id = chatPosition(key, target, before);
    at = messages.findIndex((message) => message.id === id);
    if (at < 0) throw new Error('This conversation changed. Load the latest messages.');
    at--;
  }
  const page: ChatPage = {
    type: 'chat.page',
    ...(requestId ? { requestId } : {}),
    projectId: target.project,
    threadId: target.thread,
    updatedAt: target.updatedAt,
    messages: [],
    before: null,
    latest: !before,
    ...(requests?.size
      ? { confirmed: [...new Set(requests.values())].slice(-SESSION_COMMANDS) }
      : {}),
  };
  let characters = 0;
  for (; at >= 0 && page.messages.length < CHAT_PAGE_MESSAGES; at--) {
    const native = messages[at]!;
    const message = messageForPhone(key, target.project, target.thread, native);
    const item: HistoryMessage = {
      id: historyMessageId(key, target, native.id),
      ...(requests?.has(native.id) ? { requestId: requests.get(native.id) } : {}),
      role: message.role,
      text: message.text,
      ...(message.tool
        ? {
            tool: {
              ...message.tool,
              name: text(message.tool.name, 120)!,
              label: text(message.tool.label, 120),
              summary: text(message.tool.summary, 240),
            },
          }
        : {}),
      ...(message.attachments?.length ? { attachments: message.attachments } : {}),
      ...(message.full ? { full: message.full } : {}),
    };
    const older = at > 0 || hasEarlier ? cursor(key, target, native.id) : null;
    const candidate = { ...page, messages: [item, ...page.messages], before: older };
    if (
      characters + item.text.length > CHAT_PAGE_TEXT_CHARS ||
      bytes(candidate) > CHAT_PAGE_BYTES
    ) {
      if (!page.messages.length)
        throw new Error('A message exceeds the live page limit. Open it on your computer.');
      break;
    }
    page.messages.unshift(item);
    page.before = older;
    characters += item.text.length;
  }
  if (!before && typing) {
    let end = Math.min(typing.length, CHAT_PAGE_TEXT_CHARS - characters);
    while (end && bytes({ ...page, typing: typing.slice(0, end) }) > CHAT_PAGE_BYTES)
      end = Math.floor(end / 2);
    if (end && /[\uD800-\uDBFF]/.test(typing[end - 1]!)) end--;
    if (end) page.typing = typing.slice(0, end);
  }
  return page;
}
