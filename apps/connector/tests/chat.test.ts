import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_ATTACHMENT_BYTES, HISTORY_TEXT_CHARS, type Message, type PairingRecord } from '@dashup/protocol';
import { openAttachment } from '@dashup/protocol/crypto';
import { CHAT_PAGE_BYTES, CHAT_PAGE_MESSAGES, CHAT_PAGE_TEXT_CHARS } from '@dashup/protocol/session';
import { chatPage } from '../src/chat';
import { shareAttachment } from '../src/attachments';
import { toolInput, textAttachment } from '../src/harness/session';
import type { ConnectorConfig } from '../src/config';

const key = '01'.repeat(32);
const target = { project: 'project', thread: 'thread', updatedAt: '2026-10-30T00:00:00Z' };
function bounded(page: ReturnType<typeof chatPage>) {
  assert.ok(new Set(page.messages.map((m) => m.id)).size <= CHAT_PAGE_MESSAGES);
  assert.ok(
    page.messages.reduce((sum, m) => sum + m.text.length, 0) + (page.typing?.length ?? 0) <=
      CHAT_PAGE_TEXT_CHARS,
  );
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= CHAT_PAGE_BYTES);
  assert.ok(page.messages.length <= CHAT_PAGE_MESSAGES * 2);
}
test('latest native pages stay bounded and older cursors remain anchored when new messages arrive', () => {
  const messages: Message[] = Array.from({ length: 10000 }, (_, index) => ({
    id: String(index),
    role: 'assistant',
    text: `message${index}:` + 'a'.repeat(100),
  }));
  const latest = chatPage(key, target, messages);
  bounded(latest);
  assert.equal(latest.messages.length, 30);
  assert.match(latest.messages.at(-1)!.text, /message9999:/);
  messages.push({ id: 'new', role: 'assistant', text: 'arrived after cursor' });
  const older = chatPage(key, target, messages, latest.before!);
  bounded(older);
  assert.match(older.messages.at(-1)!.text, /message9969:/);
  assert.throws(
    () => chatPage(key, { ...target, thread: 'different' }, messages, latest.before!),
    /cursor/,
  );
});
test('a huge native response previews its beginning without splitting Unicode or hiding older messages', () => {
  const text = 'Opening: ' + '😀'.repeat(650000) + 'Ending';
  const messages: Message[] = [
    { id: 'older', role: 'user', text: 'Earlier request' },
    { id: 'large', role: 'assistant', text },
  ];
  const page = chatPage(key, target, messages);
  bounded(page);
  assert.equal(page.before, null);
  assert.equal(page.messages.length, 2);
  assert.equal(page.messages[0]!.text, 'Earlier request');
  const message = page.messages[1]!;

  assert.ok(message.text.length <= HISTORY_TEXT_CHARS);
  assert.ok(text.startsWith(message.text));
  assert.ok(message.text.startsWith('Opening: '));
  assert.equal(Buffer.from(message.text).toString(), message.text);
  assert.equal(message.full?.bytes, Buffer.byteLength(text));
  assert.equal(message.text.includes('Ending'), false);
});
test('JSON expansion and live typing share the same strict page budget', () => {
  const messages: Message[] = Array.from({ length: 50 }, (_, index) => ({
    id: String(index),
    role: 'assistant',
    text: '\u0000'.repeat(20000),
  }));
  const page = chatPage(key, target, messages, undefined, undefined, 'working'.repeat(10000));
  bounded(page);
  assert.ok(page.before);

  assert.equal(page.messages.at(-1)!.full!.bytes, 20_000);
});

test('native tool previews keep full output on the host and expose only four valid attachments', () => {
  const output = 'x'.repeat(10_000);
  const page = chatPage(key, target, [
    {
      id: 'native-tool',
      role: 'tool',
      text: output,
      attachments: [
        { id: 'invalid', mime: 'invalid', bytes: 1 },
        ...Array.from({ length: 6 }, (_, index) => ({
          id: `native-file-${index}`,
          name: `file-${index}`,
          mime: 'text/plain',
          bytes: index + 1,
        })),
      ],
    },
  ]);
  bounded(page);
  const message = page.messages[0]!;
  assert.equal(message.text.length, 2_000);
  assert.equal(message.full?.bytes, Buffer.byteLength(output));
  assert.deepEqual(
    message.attachments?.map((file) => file.name),
    ['file-0', 'file-1', 'file-2', 'file-3'],
  );
  assert.ok(message.attachments?.every((file) => /^[a-f0-9]{64}$/.test(file.id)));
});

test('canonical request identities survive whole messages without trusting native request fields or leaking another phone mapping', () => {
  const messages: Message[] = [
    {
      id: 'old-user',
      role: 'user',
      text: 'same words',
      requestId: 'not-authorized-for-this-phone',
    },
    { id: 'phone-user', role: 'user', text: 'a'.repeat(12_000) },
    { id: 'other-user', role: 'user', text: 'same words' },
  ];
  const requests = new Map([['phone-user', 'phone-request']]);
  let before: string | undefined;
  let matched = 0;
  do {
    const page = chatPage(key, target, messages, before, undefined, '', false, requests);
    bounded(page);
    for (const message of page.messages) {
      if (message.text.startsWith('a')) {
        assert.equal(message.requestId, 'phone-request');
        matched++;
      } else assert.equal(message.requestId, undefined);
    }
    before = page.before ?? undefined;
  } while (before);
  assert.equal(matched, 1);
  assert.ok(
    chatPage(key, target, messages).messages.every((message) => message.requestId === undefined),
  );
});

const pair: PairingRecord = {
  id: 'phone-pair',
  device: 'computer',
  mobile: 'phone',
  code: '',
  revokedAt: null,
};
const config: ConnectorConfig = {
  api: 'https://isolated.invalid',
  secret: 'device-secret',
  localSecret: '02'.repeat(32),
  device: { id: pair.device, user: 'user', kind: 'desktop', platform: 'linux', name: 'Computer' },
  pairs: { [pair.id]: { key, sequence: 0 } },
};
const tool = (input: unknown): Message => ({
  id: 'native-call',
  role: 'tool',
  text: '',
  tool: { name: 'Write', summary: 'source.ts', input: toolInput('native-call', input) },
});

test('complete tool input is an immutable native snapshot and only encrypted bytes leave the computer on request', async () => {
  const raw = {
    file_path: 'source.ts',
    content: 'private full source\n'.repeat(1000),
    options: { mode: 'replace' },
  };
  const expected = JSON.stringify(raw, null, 2);
  const message = tool(raw);
  raw.content = 'later update';
  const page = chatPage(key, target, [message]);
  bounded(page);
  const file = page.messages[0]!.tool!.input!;
  assert.equal(file.mime, 'application/json');
  assert.equal(file.bytes, Buffer.byteLength(expected));
  assert.match(file.id, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(page).includes('private full source'), false);
  assert.equal(JSON.stringify(page).includes('native-call'), false);
  assert.equal('read' in file, false);
  let received: Uint8Array | undefined;
  let uploads = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    uploads++;
    assert.equal(String(url), `${config.api}/v1/dashup/attachments/${pair.id}/${file.id}`);
    assert.ok(options?.body instanceof Uint8Array);
    received = options.body;
    assert.equal(Buffer.from(received!).includes(Buffer.from('private full source')), false);
    return Response.json({ success: true, result: null });
  };
  try {
    assert.equal(uploads, 0);
    await shareAttachment(config, pair, target.project, target.thread, [message], file.id);
    assert.equal(uploads, 1);
    assert.equal(
      Buffer.from(openAttachment(key, pair.id, file.id, received!)).toString(),
      expected,
    );
    assert.throws(() => openAttachment(key, 'another-pair', file.id, received!));
    await assert.rejects(
      shareAttachment(config, pair, target.project, 'another-thread', [message], file.id),
      /no longer/,
    );
    await assert.rejects(
      shareAttachment(
        config,
        { ...pair, revokedAt: 'now' },
        target.project,
        target.thread,
        [message],
        file.id,
      ),
      /Pairing/,
    );
    assert.equal(uploads, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('same-length native input updates invalidate stale references without increasing the chat page', async () => {
  const first = tool('echo first');
  const second = tool('echo other');
  const before = chatPage(key, target, [first]).messages[0]!.tool!.input!;
  const after = chatPage(key, target, [second]).messages[0]!.tool!.input!;
  assert.equal(before.bytes, after.bytes);
  assert.notEqual(before.id, after.id);
  assert.equal(before.id, chatPage(key, target, [tool('echo first')]).messages[0]!.tool!.input!.id);
  assert.notEqual(
    before.id,
    chatPage('03'.repeat(32), target, [first]).messages[0]!.tool!.input!.id,
  );
  await assert.rejects(
    shareAttachment(config, pair, target.project, target.thread, [second], before.id),
    /no longer/,
  );
});

test('tool inputs honor the eight MiB byte limit and oversized or changed native bytes never upload', async () => {
  const exact = tool('😀'.repeat(MAX_ATTACHMENT_BYTES / 4));
  const page = chatPage(key, target, [exact]);
  bounded(page);
  const file = page.messages[0]!.tool!.input!;
  assert.equal(file.bytes, MAX_ATTACHMENT_BYTES);
  const oversized = tool('😀'.repeat(MAX_ATTACHMENT_BYTES / 4) + '!');
  const oversizedPage = chatPage(key, target, [oversized]);
  bounded(oversizedPage);
  assert.equal(oversizedPage.messages[0]!.tool!.input!.bytes, MAX_ATTACHMENT_BYTES + 1);
  let uploaded = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    uploaded++;
    const plain = openAttachment(key, pair.id, file.id, options!.body as Uint8Array);
    assert.equal(plain.byteLength, MAX_ATTACHMENT_BYTES);
    return Response.json({ success: true, result: null });
  };
  try {
    await shareAttachment(config, pair, target.project, target.thread, [exact], file.id);
    await assert.rejects(
      shareAttachment(
        config,
        pair,
        target.project,
        target.thread,
        [oversized],
        oversizedPage.messages[0]!.tool!.input!.id,
      ),
      /too large/,
    );
    const invalid = {
      ...toolInput('invalid', 'before')!,
      read: () => Buffer.from('changed bytes'),
    };
    const message = { ...tool(''), tool: { name: 'Tool', input: invalid } };
    const id = chatPage(key, target, [message]).messages[0]!.tool!.input!.id;
    await assert.rejects(
      shareAttachment(config, pair, target.project, target.thread, [message], id),
      /changed/,
    );
    assert.equal(uploaded, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('same-length full output edits refresh the message reference and reject stale reads', async () => {
  for (const role of ['user', 'assistant', 'tool'] as const) {
    const original: Message = {
      id: 'streaming',
      role,
      text: 'same opening\n' + 'a'.repeat(12_000) + 'first',
    };
    const changed: Message = { ...original, text: original.text.slice(0, -5) + 'other' };
    const oldPage = chatPage(key, target, [original]);
    const newPage = chatPage(key, target, [changed]);
    bounded(oldPage);
    bounded(newPage);
    const before = oldPage.messages.at(-1)!.full!;
    const after = newPage.messages.at(-1)!.full!;
    assert.equal(before.bytes, after.bytes);
    assert.notEqual(before.id, after.id);
    assert.ok(newPage.messages.every((message) => message.full?.id === after.id));
    assert.equal(after.id, chatPage(key, target, [{ ...changed }]).messages.at(-1)!.full!.id);
    if (role === 'tool') assert.equal(oldPage.messages[0]!.text, newPage.messages[0]!.text);
    await assert.rejects(
      shareAttachment(config, pair, target.project, target.thread, [changed], before.id),
      /no longer/,
    );
  }
});

test('full output uses the bounded text snapshot factory and eight MiB outputs remain encrypted and readable', async () => {
  const text = '😀'.repeat(MAX_ATTACHMENT_BYTES / 4);
  const exact = textAttachment('output', text);
  assert.equal(exact.bytes, MAX_ATTACHMENT_BYTES);
  assert.equal(exact.read().toString(), text);
  const oversized = textAttachment('output', text + '!');
  assert.equal(oversized.bytes, MAX_ATTACHMENT_BYTES + 1);
  assert.throws(() => oversized.read(), /too large/);
  const message: Message = { id: 'output', role: 'tool', text };
  const page = chatPage(key, target, [message]);
  bounded(page);
  const file = page.messages[0]!.full!;
  assert.equal(file.bytes, MAX_ATTACHMENT_BYTES);
  const large: Message = { ...message, text: text + '!' };
  const largePage = chatPage(key, target, [large]);
  bounded(largePage);
  assert.equal(largePage.messages[0]!.full!.bytes, MAX_ATTACHMENT_BYTES + 1);
  let uploaded = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    uploaded++;
    const bytes = options!.body as Uint8Array;
    assert.equal(Buffer.from(bytes).includes(Buffer.from('😀'.repeat(100))), false);
    assert.equal(Buffer.from(openAttachment(key, pair.id, file.id, bytes)).toString(), text);
    return Response.json({ success: true, result: null });
  };
  try {
    await shareAttachment(config, pair, target.project, target.thread, [message], file.id);
    await assert.rejects(
      shareAttachment(
        config,
        pair,
        target.project,
        target.thread,
        [large],
        largePage.messages[0]!.full!.id,
      ),
      /too large/,
    );
    assert.equal(uploaded, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('whole messages keep their opening, tool input, files and full-text reference across page boundaries', () => {
  const messages: Message[] = Array.from({ length: 10 }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 ? 'tool' : 'user',
    text: 'Opening' + 'content'.repeat(1700),
    tool: { name: 'Edit', diff: true, input: toolInput(`input-${index}`, { path: 'file.ts' }) },
    attachments: [{ id: `file-${index}`, name: 'screenshot.png', mime: 'image/png', bytes: 200 }],
  }));
  const seen = new Set<string>();
  let before: string | undefined;
  do {
    const page = chatPage(key, target, messages, before);
    bounded(page);
    for (const message of page.messages) {
      assert.equal(seen.has(message.id), false);
      seen.add(message.id);
      assert.ok(message.text.startsWith('Opening'));
      assert.equal('part' in message || 'parts' in message, false);
      assert.equal(message.full?.bytes, Buffer.byteLength(messages[0]!.text));
      assert.equal(message.attachments?.[0]?.name, 'screenshot.png');
      assert.equal(message.tool?.name, 'Edit');
      assert.ok(message.tool?.input);
    }
    before = page.before ?? undefined;
  } while (before);
  assert.equal(seen.size, messages.length);
});

test('oversized prose and diffs show their opening and open complete native text through encrypted files', async () => {
  const originalFetch = globalThis.fetch;
  let uploaded = 0;
  try {
    for (const role of ['user', 'assistant', 'tool'] as const) {
      const text =
        (role === 'tool' ? '--- old.ts\n+++ new.ts\n@@\n' : 'Read this opening first.\n') +
        'complete source\n'.repeat(3000) +
        'Last native line';
      const native: Message = {
        id: 'large',
        role,
        text,
        ...(role === 'tool'
          ? {
              tool: {
                name: 'Edit',
                summary: 'new.ts',
                diff: true,
                input: toolInput('large', { path: 'new.ts', replacement: text }),
              },
            }
          : {}),
        attachments: [{ id: 'file', name: 'design.png', mime: 'image/png', bytes: 20 }],
      };
      const page = chatPage(key, target, [native]);
      bounded(page);
      assert.equal(page.messages.length, 1);
      const message = page.messages[0]!;
      assert.equal(message.text, text.slice(0, HISTORY_TEXT_CHARS));

      assert.equal(message.attachments?.[0]?.name, 'design.png');
      if (role === 'tool') assert.equal(message.tool?.name, 'Edit');
      const file = message.full!;
      assert.equal(file.bytes, Buffer.byteLength(text));
      globalThis.fetch = async (_url, options) => {
        uploaded++;
        assert.equal(
          Buffer.from(
            openAttachment(key, pair.id, file.id, options!.body as Uint8Array),
          ).toString(),
          text,
        );
        return Response.json({ success: true, result: null });
      };
      await shareAttachment(config, pair, target.project, target.thread, [native], file.id);
    }
    assert.equal(uploaded, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('native delivery confirmations survive paging past the matched message and stay bounded', () => {
  const requests = new Map(Array.from({ length: 200 }, (_, i) => [`native-${i}`, `request-${i}`]));
  const page = chatPage(
    key,
    target,
    [{ id: 'later', role: 'assistant', text: 'Already working' }],
    undefined,
    undefined,
    '',
    false,
    requests,
  );
  assert.equal(page.confirmed?.length, 64);
  assert.equal(page.confirmed?.at(-1), 'request-199');
  assert.equal(
    page.messages.some((message) => message.requestId),
    false,
  );
  bounded(page);
});
