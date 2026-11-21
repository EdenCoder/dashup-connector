import assert from 'node:assert/strict';
import { test } from 'node:test';

import { debounced, singleFlight } from '../src/harness/session';

// =============================================================================
// What every integration shares
// =============================================================================

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a burst of native events is told as one change, and a cancelled one not at all', async () => {
  let changes = 0;
  const soon = debounced(() => changes++);
  soon();
  soon();
  soon();
  assert.equal(changes, 0);
  await pause(150);
  assert.equal(changes, 1);
  soon();
  soon.cancel();
  await pause(150);
  assert.equal(changes, 1);
  soon();
  await pause(150);
  assert.equal(changes, 2);
});

test('a read under way is shared by every caller that arrives during it, and the next reads again', async () => {
  let reads = 0;
  let settle!: { resolve(value: number): void; reject(error: Error): void };
  const read = singleFlight(() => {
    reads++;
    return new Promise<number>((resolve, reject) => (settle = { resolve, reject }));
  });
  const [first, second] = [read(), read()];
  assert.equal(reads, 1);
  settle.resolve(7);
  assert.deepEqual(await Promise.all([first, second]), [7, 7]);
  const third = read();
  assert.equal(reads, 2);
  settle.reject(new Error('The agent went away'));
  await assert.rejects(third, /went away/);
  void read();
  assert.equal(reads, 3);
  settle.resolve(0);
});
