import test from 'node:test';
import assert from 'node:assert/strict';
import type { Usage, UsageWindow } from '@dashup/protocol';

import { usageResetEvents, validUsageReset, USAGE_RESET_EVENTS } from '../src/resets';

const NOW    = Date.parse('2026-10-30T00:00:00Z');
const RESET  = NOW + 60_000;
const MINUTE = 60_000;
const window = (minutes = 300, used = 100, at = RESET): UsageWindow => ({
  minutes,
  used,
  resets: new Date(at).toISOString(),
});
const login  = (
  windows = [window()],
  account = 'person@example.com',
  harness: Usage['harness'] = 'codex',
): Usage => ({ harness, account, windows });
const event  = () => usageResetEvents([login()], NOW)[0]!;

test('advertised future windows group by provider, account and reset time with stable identity', () => {
  const codex = login([window(300, 80), window(10_080, 10), window(300, 50)]);
  const events = usageResetEvents(
    [codex, login([window()], 'another@example.com'), login([window()], codex.account, 'claude')],
    NOW,
  );
  assert.equal(events.length, 3);
  const grouped = events.find(
    (item) => item.harness === 'codex' && item.account === codex.account,
  )!;
  assert.deepEqual(
    grouped.windows.map((item) => item.minutes),
    [300, 10_080],
  );
  assert.equal(grouped.expiresAt, RESET + 300 * MINUTE);
  assert.equal(
    grouped.id,
    usageResetEvents([{ ...codex, windows: [...codex.windows].reverse() }], NOW)[0]!.id,
  );
  assert.deepEqual(grouped, usageResetEvents([codex, codex], NOW)[0]);
});

test('first observation cannot create past, empty, unused or malformed reset reminders', () => {
  const windows = [
    window(300, 100, NOW),
    window(300, 100, NOW - 1),
    window(300, 0),
    window(0),
    window(-1),
    window(Infinity),
    window(300, NaN),
    window(300, -1),
    { ...window(), resets: 'invalid' },
  ];
  assert.deepEqual(usageResetEvents([login(windows), login([])], NOW), []);
  assert.equal(usageResetEvents([login([window(300, 0.1)])], NOW).length, 1);
  assert.deepEqual(usageResetEvents([login([window()], 'x'.repeat(321))], NOW), []);
});

test('a repeated stale meter never manufactures recurring resets after its advertised time', () => {
  const original = login();
  const pending = usageResetEvents([original], NOW)[0]!;
  assert.deepEqual(usageResetEvents([original], RESET), []);
  assert.deepEqual(usageResetEvents([original], RESET + 7 * 24 * 60 * MINUTE), []);
  assert.equal(validUsageReset(pending, [original], true, RESET), true);
  assert.equal(validUsageReset(pending, [original], true, pending.expiresAt), false);
});

test('expiration uses the shortest coalesced duration and caps long windows at one day', () => {
  const [short] = usageResetEvents([login([window(10_080), window(60)])], NOW);
  assert.equal(short!.expiresAt, RESET + 60 * MINUTE);
  const [week] = usageResetEvents([login([window(10_080)])], NOW);
  assert.equal(week!.expiresAt, RESET + 24 * 60 * MINUTE);
});

test('an encrypted pending event waits for the first usage read, then requires its original account', () => {
  const pending = JSON.parse(JSON.stringify(event()));
  assert.equal(validUsageReset(pending, [], false, RESET), undefined);
  assert.equal(validUsageReset(pending, [], true, RESET), false);
  assert.equal(validUsageReset(pending, [login([], pending.account)], true, RESET), true);
  assert.equal(
    validUsageReset(pending, [login([window()], 'new-account@example.com')], true, RESET),
    false,
  );
  assert.equal(
    validUsageReset(pending, [login([window()], pending.account, 'claude')], true, RESET),
    false,
  );
  assert.equal(validUsageReset(pending, [login()], true, RESET), true);
});

test('a newer matching window must have available allowance; older or invalid evidence cannot authorize delivery', () => {
  const pending = event();
  assert.equal(
    validUsageReset(pending, [login([window(300, 0, RESET + MINUTE)])], true, RESET),
    true,
  );
  assert.equal(
    validUsageReset(pending, [login([window(300, 99, RESET + MINUTE)])], true, RESET),
    true,
  );
  assert.equal(
    validUsageReset(pending, [login([window(300, 100, RESET + MINUTE)])], true, RESET),
    false,
  );
  assert.equal(
    validUsageReset(pending, [login([window(300, 0, RESET - MINUTE)])], true, RESET),
    false,
  );
  assert.equal(
    validUsageReset(pending, [login([window(300, NaN, RESET + MINUTE)])], true, RESET),
    false,
  );
});

test('newer exhausted evidence wins over an older duplicate meter for the same window', () => {
  const pending = event();
  const current = login([window(300, 100, RESET + MINUTE)]);
  assert.equal(validUsageReset(pending, [login(), current], true, RESET), false);
  assert.equal(validUsageReset(pending, [current, login()], true, RESET), false);
});

test('one relevant available window keeps a coalesced reset valid', () => {
  const [pending] = usageResetEvents([login([window(300), window(10_080)])], NOW);
  assert.equal(
    validUsageReset(
      pending!,
      [login([window(300, 100, RESET + MINUTE), window(10_080, 1, RESET + MINUTE)])],
      true,
      RESET,
    ),
    true,
  );
  assert.equal(
    validUsageReset(
      pending!,
      [login([window(300, 100, RESET + MINUTE), window(10_080, 100, RESET + MINUTE)])],
      true,
      RESET,
    ),
    false,
  );
});

test('many provider windows keep the pending event set and each coalesced payload bounded', () => {
  const [coalesced] = usageResetEvents(
    [login(Array.from({ length: 1_000 }, (_, index) => window(index + 1)))],
    NOW,
  );
  assert.ok(coalesced!.windows.length <= 16);
  const events = usageResetEvents(
    Array.from({ length: 1_000 }, (_, index) => login([window()], `account-${index}`)),
    NOW,
  );
  assert.equal(events.length, USAGE_RESET_EVENTS);
});

test('a temporary meter failure preserves an advertised reset while a provider reschedule retires the old deadline', () => {
  const pending = event();
  assert.equal(validUsageReset(pending, [login([])], true, NOW), true);
  assert.equal(validUsageReset(pending, [login([])], true, RESET), true);
  assert.equal(validUsageReset(pending, [login([])], true, pending.expiresAt), false);
  assert.equal(
    validUsageReset(pending, [login([window(300, 20, RESET + MINUTE)])], true, NOW),
    false,
  );
  assert.equal(
    validUsageReset(pending, [login([window(300, 20, RESET + MINUTE)])], true, RESET),
    true,
  );
});

test('computers that share a login name one reset alike, without the account or its time', () => {
  const shared = (at = RESET, identity = 'vendor-account-id', harness: Usage['harness'] = 'claude') => ({
    ...login([window(10_080, 40, at)], 'person@example.com', harness),
    identity,
  });
  const alert = (value: Usage & { identity?: string }) => usageResetEvents([value], NOW)[0]!.alert;
  // Claude moves a reset time by up to a second from one read to the next.
  const first = alert(shared(RESET + 900))!;
  assert.match(first, /^[\w-]{43}$/);
  assert.equal(alert(shared(RESET - 475)), first);
  assert.notEqual(alert(shared(RESET + 300 * MINUTE)), first);
  assert.notEqual(alert(shared(RESET, 'another-account-id')), first);
  assert.notEqual(alert(shared(RESET, 'vendor-account-id', 'codex')), first);
  // An API key has no account to share.
  assert.equal(alert(login([window(10_080, 40)])), undefined);
});
