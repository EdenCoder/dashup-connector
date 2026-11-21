import assert from 'node:assert/strict';
import { test } from 'node:test';

import { text, frames, MAX_BYTES } from '../src/harness/local-http';

// =============================================================================
// Bounded answers and event framing
// =============================================================================

const stream = (...parts: (string | Uint8Array)[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (const part of parts)
        controller.enqueue(typeof part === 'string' ? new TextEncoder().encode(part) : part);
      controller.close();
    },
  });

async function events(...parts: (string | Uint8Array)[]): Promise<string[]> {
  const found: string[] = [];
  for await (const data of frames(stream(...parts))) found.push(data);
  return found;
}

test("an event stream gives each event's data, whatever its line endings and however it is cut", async () => {
  assert.deepEqual(
    await events(
      'data: {"a":1}\n\nevent: named\r\ndata: one\r\nda',
      'ta:two\r\n\r\n: keepalive\n\nid: 3\n\ndata:\n\n\n',
      'data:   spaced\n\ndata: never finished\n',
    ),
    ['{"a":1}', 'one\ntwo', '', 'spaced'],
  );
  const accented = new TextEncoder().encode('data: "é"\n\n');
  assert.deepEqual(await events(accented.subarray(0, 8), accented.subarray(8)), ['"é"']);
});

test('an event past the content limit ends its stream', async () => {
  await assert.rejects(events('data: ', 'x'.repeat(MAX_BYTES)), /content limit/);
});

test('an answer is read no further than its limit', async () => {
  assert.equal(await text(stream('ab', 'cd'), 4, 'Too large'), 'abcd');
  assert.equal(await text(null, 4, 'Too large'), '');
  let pulled = 0;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(3));
    },
  });
  await assert.rejects(text(endless, 4, 'Too large'), /Too large/);
  assert.ok(pulled < 10);
});
