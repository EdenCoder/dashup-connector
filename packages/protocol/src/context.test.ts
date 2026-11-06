import test from 'node:test';
import assert from 'node:assert/strict';

import { contextUsage } from './context';

test('context accepts native zero and over-capacity counts without inventing or clamping tokens', () => {
  assert.deepEqual(contextUsage(0, 200000), { used: 0, size: 200000 });
  assert.deepEqual(contextUsage(210000, 200000), { used: 210000, size: 200000 });
});

test('context rejects missing, malformed and unsafe token counts', () => {
  for (const value of [
    undefined,
    null,
    '100',
    -1,
    NaN,
    Infinity,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(contextUsage(value, 200000), undefined);
    assert.equal(contextUsage(100, value), undefined);
  }
  assert.equal(contextUsage(100, 0), undefined);
});
