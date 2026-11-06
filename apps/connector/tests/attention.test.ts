import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';

import { DEFAULT_NOTIFICATION_POLICY, notificationDecision, notificationResumeAt, parseNotificationPolicy, quietHours, type NotificationPolicy } from '@dashup/protocol/attention';

import { AttentionDelivery, storeAttention, restoreAttention, type AttentionEvent, type AttentionState, type PendingAttention } from '../src/attention';
import type { UsageResetEvent } from '../src/resets';
import { open, seal, newSecret } from '@dashup/protocol/crypto';
import type { Content, PairingRecord } from '@dashup/protocol';

import { Connector } from '../src/connector';
import type { ConnectorConfig } from '../src/config';

// =============================================================================
// Policy boundaries and the phone's time zone
// =============================================================================

test('notification policy validates untrusted commands and keeps independent project preferences', () => {
  const policy = parseNotificationPolicy({
    ...DEFAULT_NOTIFICATION_POLICY,
    projects: { one: { muted: true } },
  });
  assert.equal(notificationDecision(policy, 'one', 'approval'), 'silent');
  assert.equal(notificationDecision(policy, 'two', 'approval'), 'notify');
  assert.equal(notificationDecision(policy, 'two', 'complete'), 'silent');
  for (const invalid of [
    null,
    { ...policy, digestMinutes: '15' },
    { ...policy, mode: 'all', unexpected: true },
    { ...policy, projects: { one: { snoozedUntil: NaN } } },
    { ...policy, quiet: { start: 60, end: 60, timeZone: 'UTC' } },
    { ...policy, quiet: { start: 60, end: 120, timeZone: 'Wrong/Zone' } },
    { ...policy, projects: JSON.parse('{"__proto__":{"muted":true}}') },
  ])
    assert.throws(() => parseNotificationPolicy(invalid));
});

test('overnight quiet hours follow the phone time zone, with exact start and end boundaries', () => {
  const policy = {
    ...DEFAULT_NOTIFICATION_POLICY,
    quiet: { start: 22 * 60, end: 8 * 60, timeZone: 'Australia/Brisbane' },
  };
  assert.equal(quietHours(policy, Date.parse('2026-10-30T11:59:59Z')), false);
  assert.equal(quietHours(policy, Date.parse('2026-10-30T12:00:00Z')), true);
  assert.equal(quietHours(policy, Date.parse('2026-10-30T21:59:59Z')), true);
  assert.equal(quietHours(policy, Date.parse('2026-10-30T22:00:00Z')), false);
  assert.equal(
    notificationResumeAt(policy, 'project', 'input', Date.parse('2026-10-30T12:30:00Z')),
    Date.parse('2026-10-30T22:00:00Z'),
  );
});

test('quiet-hour reminders cross daylight-saving gaps and snooze expiration', () => {
  const policy = {
    ...DEFAULT_NOTIFICATION_POLICY,
    quiet: { start: 60, end: 180, timeZone: 'America/New_York' },
  };
  assert.equal(
    notificationResumeAt(policy, 'project', 'input', Date.parse('2026-03-08T06:30:00Z')),
    Date.parse('2026-03-08T07:00:00Z'),
  );
  const snoozed = {
    ...policy,
    projects: { project: { snoozedUntil: Date.parse('2026-03-08T08:00:00Z') } },
  };
  assert.equal(
    notificationResumeAt(snoozed, 'project', 'approval', Date.parse('2026-03-08T06:30:00Z')),
    Date.parse('2026-03-08T08:00:00Z'),
  );
  assert.equal(
    notificationDecision(snoozed, 'project', 'approval', Date.parse('2026-03-08T08:00:00Z')),
    'notify',
  );
});

// =============================================================================
// Delivery after the native decision has settled
// =============================================================================

function fixture(saved: PendingAttention[] = []) {
  let connected = true;
  let reset: boolean | undefined = true;
  let reads = 0,
    writes = 0;
  let now = Date.parse('2026-10-30T00:00:00Z');
  let policy: NotificationPolicy = { ...DEFAULT_NOTIFICATION_POLICY, projects: {} };
  let state: AttentionState | undefined = {
    status: 'attention',
    approvalIds: ['request'],
    activeChildren: false,
    updatedAt: new Date(now).toISOString(),
  };
  let stored: PendingAttention[] = [];
  const sent: { pairing: string; event: AttentionEvent; notify: boolean }[] = [];
  const event: AttentionEvent = {
    type: 'attention',
    projectId: 'project',
    threadId: 'thread',
    title: 'Run tests',
    body: 'Run npm test?',
    reason: 'approval',
    approvalId: 'request',
  };
  const router = new AttentionDelivery({
    saved,
    active: () => connected,
    now: () => now,
    policy: () => policy,
    current: () => {
      reads++;
      return state;
    },
    reset: () => reset,
    deliver: async (pairing, event, notify) => {
      sent.push({ pairing, event, notify });
    },
    save: (pending) => {
      writes++;
      stored = structuredClone(pending);
    },
    report: (error) => {
      throw error;
    },
  });
  return {
    router,
    event,
    sent,
    reads: () => reads,
    writes: () => writes,
    reset: (value: boolean | undefined) => {
      reset = value;
    },
    connected: (value: boolean) => {
      connected = value;
    },
    stored: () => stored,
    now: () => now,
    advance: async (ms: number) => {
      now += ms;
      await router.flush();
    },
    policy: (value: Partial<NotificationPolicy>) => {
      policy = { ...policy, ...value };
    },
    state: (value: Partial<AttentionState> | undefined) => {
      state = value ? { ...state!, ...value } : undefined;
    },
  };
}

test('an automatically resolved approval never sends a false alert; unresolved requests notify once', async () => {
  const f = fixture();
  try {
    await f.router.push('phone', f.event);
    f.state({ status: 'working', approvalIds: [] });
    await f.advance(2_000);
    assert.equal(f.sent.length, 0);
    f.state({ status: 'attention', approvalIds: ['request'] });
    await f.router.push('phone', f.event);
    await f.router.push('phone', f.event);
    await f.advance(2_000);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0]!.notify, true);
  } finally {
    f.router.stop();
  }
});

test('unknown adapter state preserves a genuine input request but cannot announce completion', async () => {
  const f = fixture();
  try {
    f.state(undefined);
    await f.router.push('phone', { ...f.event, reason: 'input' });
    await f.router.push('phone', { ...f.event, reason: 'complete' });
    await f.advance(6_000);
    assert.deepEqual(
      f.sent.map((entry) => entry.event.reason),
      ['input'],
    );
  } finally {
    f.router.stop();
  }
});

test('an approval from a live session that detached during debounce no longer asks for a decision', async () => {
  const f = fixture();
  try {
    await f.router.push('phone', f.event);
    f.state(undefined);
    await f.advance(2_000);
    assert.equal(f.sent.length, 0);
  } finally {
    f.router.stop();
  }
});

test('snooze preserves silent inbox history and revalidates the request before its reminder', async () => {
  const f = fixture();
  try {
    f.policy({ projects: { project: { snoozedUntil: f.now() + 60_000 } } });
    await f.router.push('phone', f.event);
    await f.advance(2_000);
    assert.equal(f.sent[0]?.notify, false);
    assert.equal(f.stored().length, 1);
    f.state({ status: 'working', approvalIds: [] });
    await f.advance(60_000);
    assert.equal(f.sent.length, 1);
    assert.equal(f.stored().length, 0);
  } finally {
    f.router.stop();
  }
});

test('a snoozed pending approval survives connector restart and notifies at expiration', async () => {
  const before = fixture();
  before.policy({ projects: { project: { snoozedUntil: before.now() + 60_000 } } });
  await before.router.push('phone', before.event);
  await before.advance(2_000);
  const saved = before.stored();
  before.router.stop();
  const after = fixture(saved);
  try {
    after.policy({ projects: { project: { snoozedUntil: after.now() + 60_000 } } });
    after.router.start();
    await after.advance(60_000);
    assert.equal(after.sent.length, 1);
    assert.equal(after.sent[0]!.notify, true);
  } finally {
    after.router.stop();
  }
});

test('reconnect rechecks an offline pending decision immediately instead of waiting for its retry timer', async () => {
  const f = fixture();
  try {
    f.connected(false);
    await f.router.push('phone', f.event);
    await f.advance(2_000);
    assert.equal(f.sent.length, 0);
    f.connected(true);
    f.router.start();
    await f.router.flush();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0]!.notify, true);
  } finally {
    f.router.stop();
  }
});

test('a parent with running children and a fleeting idle turn do not announce completion', async () => {
  const f = fixture();
  try {
    f.policy({ mode: 'all', completions: 'immediate' });
    f.state({ status: 'idle', approvalIds: [], activeChildren: true });
    await f.router.push('phone', { ...f.event, reason: 'complete' });
    await f.advance(6_000);
    f.state({ status: 'idle', activeChildren: false });
    await f.router.push('phone', { ...f.event, reason: 'complete' });
    f.state({ status: 'working' });
    await f.advance(6_000);
    assert.equal(f.sent.length, 0);
  } finally {
    f.router.stop();
  }
});

test('completion waits for the last background child before notifying', async () => {
  const f = fixture();
  try {
    f.policy({ mode: 'all', completions: 'immediate' });
    f.state({ status: 'idle', approvalIds: [], activeChildren: true });
    await f.router.push('phone', { ...f.event, reason: 'complete' });
    await f.advance(6_000);
    assert.equal(f.sent.length, 0);
    f.state({ activeChildren: false });
    await f.advance(6_000);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0]!.notify, true);
  } finally {
    f.router.stop();
  }
});

test('completion digests batch idle conversations and keep phones independent', async () => {
  const f = fixture();
  try {
    f.policy({ mode: 'all', completions: 'digest' });
    f.state({ status: 'idle', approvalIds: [] });
    for (const [pairing, threadId] of [
      ['phone', 'one'],
      ['phone', 'two'],
      ['other-phone', 'three'],
    ])
      await f.router.push(pairing!, { ...f.event, threadId: threadId!, reason: 'complete' });
    await f.advance(6_000);
    assert.equal(f.sent.filter((item) => item.notify).length, 0);
    assert.equal(f.sent.filter((item) => !item.notify).length, 3);
    await f.advance(15 * 60_000);
    const pushes = f.sent.filter((item) => item.notify);
    assert.equal(pushes.length, 2);
    assert.equal(pushes[0]!.event.title, '2 conversations are ready to review');
    assert.equal(pushes[1]!.pairing, 'other-phone');
  } finally {
    f.router.stop();
  }
});

test('muting and revocation cancel pending notifications', async () => {
  const f = fixture();
  try {
    await f.router.push('phone', f.event);
    f.policy({ projects: { project: { muted: true } } });
    f.router.changed('phone');
    await f.advance(2_000);
    assert.deepEqual(
      f.sent.map((item) => item.notify),
      [false],
    );
    assert.equal(f.stored().length, 0);
    await f.router.push('phone', f.event);
    f.router.cancel('phone');
    await f.advance(2_000);
    assert.equal(f.sent.length, 1);
  } finally {
    f.router.stop();
  }
});

// =============================================================================
// Provider allowance deadlines use the same delivery preferences without a native thread
// =============================================================================

function resetEvent(now: number, wait = 60_000, lifetime = 300 * 60_000): UsageResetEvent {
  const resetAt = now + wait;
  return {
    type: 'usage-reset',
    id: JSON.stringify(['codex', 'person@example.com', resetAt]),
    reason: 'reset',
    harness: 'codex',
    account: 'person@example.com',
    windows: [{ minutes: 300, resets: new Date(resetAt).toISOString() }],
    resetAt,
    expiresAt: resetAt + lifetime,
    title: 'Codex usage reset',
    body: 'Your usage allowance has reset.',
  };
}

test('a reset never notifies early after preference changes, start, or an offline reconnect', async () => {
  const before = fixture();
  const event = resetEvent(before.now());
  await before.router.push('phone', event);
  before.router.changed('phone');
  before.router.start();
  await before.advance(59_999);
  assert.equal(before.sent.length, 0);
  assert.equal(before.reads(), 0);
  const pending = before.stored().map((item) => ({ ...item, offline: true, due: 0 }));
  before.router.stop();
  const after = fixture(pending);
  try {
    after.router.start();
    after.router.changed('phone', true);
    await after.router.flush();
    assert.equal(after.sent.length, 0);
    await after.advance(59_999);
    assert.equal(after.sent.length, 0);
    await after.advance(1);
    assert.equal(after.sent.length, 1);
    assert.equal(after.sent[0]!.notify, true);
    assert.equal(after.sent[0]!.event.type, 'usage-reset');
    assert.equal(after.reads(), 0);
    await after.advance(60_000);
    assert.equal(after.sent.length, 1);
  } finally {
    after.router.stop();
  }
});

test('expired resets and an account change retire pending alerts without consulting a thread', async () => {
  for (const expired of [true, false]) {
    const f = fixture();
    try {
      const event = resetEvent(f.now(), 100, 1_000);
      await f.router.push('phone', event);
      if (!expired) f.reset(false);
      await f.advance(expired ? 1_100 : 100);
      assert.equal(f.sent.length, 0);
      assert.equal(f.stored().length, 0);
      assert.equal(f.reads(), 0);
    } finally {
      f.router.stop();
    }
  }
});

test('a restored reset waits for a known usage read and is rechecked when meters become ready', async () => {
  const f = fixture();
  try {
    f.reset(undefined);
    await f.router.push('phone', resetEvent(f.now(), 100));
    await f.advance(100);
    assert.equal(f.sent.length, 0);
    assert.equal(f.stored().length, 1);
    f.reset(true);
    f.router.changed('phone', true);
    await f.router.flush();
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0]!.notify, true);
    assert.equal(f.reads(), 0);
  } finally {
    f.router.stop();
  }
});

test('quiet hours defer a reset until allowed, and switching resets off removes the queued reminder', async () => {
  const quiet = fixture();
  try {
    quiet.policy({ quiet: { start: 0, end: 60, timeZone: 'UTC' } });
    await quiet.router.push('phone', resetEvent(quiet.now(), 100));
    await quiet.advance(100);
    assert.deepEqual(
      quiet.sent.map((item) => item.notify),
      [false],
    );
    assert.equal(quiet.stored().length, 1);
    await quiet.advance(60 * 60_000 - 100);
    assert.deepEqual(
      quiet.sent.map((item) => item.notify),
      [false, true],
    );
  } finally {
    quiet.router.stop();
  }
  const disabled = fixture();
  try {
    await disabled.router.push('phone', resetEvent(disabled.now(), 100));
    disabled.policy({ usageResets: false });
    disabled.router.changed('phone', true);
    await disabled.advance(100);
    assert.equal(disabled.sent.length, 0);
    assert.equal(disabled.stored().length, 0);
  } finally {
    disabled.router.stop();
  }
});

test('encrypted reset reminders survive restart without rewriting an unchanged pending queue', async () => {
  const before = fixture();
  const event = resetEvent(before.now());
  await before.router.push('phone', event);
  const key = newSecret(randomBytes);
  const encrypted = storeAttention(before.stored()[0]!, key);
  const encoded = JSON.stringify(encrypted);
  assert.equal(encoded.includes(event.account), false);
  assert.equal(encoded.includes(event.title), false);
  assert.throws(() => restoreAttention({ ...encrypted, pairing: 'other-phone' }, key));
  assert.equal(before.writes(), 1);
  before.router.start();
  before.router.changed('phone', true);
  await before.router.push('phone', event);
  await before.router.flush();
  assert.equal(before.writes(), 1);
  before.router.stop();
  const restored = restoreAttention(encrypted, key);
  const after = fixture([restored]);
  try {
    after.router.start();
    after.router.changed('phone', true);
    await after.router.flush();
    assert.equal(after.writes(), 0);
    await after.advance(59_999);
    assert.equal(after.writes(), 0);
    await after.advance(1);
    assert.equal(after.sent.length, 1);
    const delivered = after.sent[0]!.event;
    assert.ok(delivered.type === 'usage-reset');
    assert.equal(delivered.id, event.id);
    assert.equal(after.writes(), 1);
  } finally {
    after.router.stop();
  }
});

test('usage-only preference refresh does not shortcut a native decision debounce', async () => {
  const f = fixture();
  try {
    await f.router.push('phone', f.event);
    const reads = f.reads();
    await f.router.push('phone', resetEvent(f.now()));
    f.router.changed('phone', true);
    assert.equal(f.reads(), reads);
    await f.advance(1_499);
    assert.equal(f.sent.length, 0);
    f.state({ status: 'working', approvalIds: [] });
    await f.advance(1);
    assert.equal(f.sent.length, 0);
    await f.advance(58_500);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0]!.event.type, 'usage-reset');
  } finally {
    f.router.stop();
  }
});

test('delivered approvals clear once on native resolution, survive restart and never clear another approval', async () => {
  let now = 0;
  let state: AttentionState | undefined = {
    status: 'attention',
    approvalIds: ['first', 'second'],
    activeChildren: false,
    updatedAt: '',
  };
  let saved: PendingAttention[] = [];
  const sent: string[] = [];
  const cleared: string[] = [];
  const setup = () =>
    new AttentionDelivery({
      saved,
      now: () => now,
      policy: () => DEFAULT_NOTIFICATION_POLICY,
      current: () => state,
      deliver: async (_pair, event) => {
        if (event.type === 'attention') sent.push(event.approvalId!);
      },
      clear: async (_pair, event) => {
        cleared.push(event.approvalId!);
      },
      save: (value) => {
        saved = structuredClone(value);
      },
      report: (error) => {
        throw error;
      },
    });
  let router = setup();
  const first: AttentionEvent = {
    type: 'attention',
    projectId: 'project',
    threadId: 'thread',
    title: 'Approve',
    body: '',
    reason: 'approval',
    approvalId: 'first',
  };
  try {
    await router.push('phone', first);
    await router.push('phone', { ...first, approvalId: 'second' });
    now = 2000;
    await router.flush();
    assert.deepEqual(sent, ['first', 'second']);
    assert.ok(saved.every((item) => item.delivered));
    await router.push('phone', first);
    router.stop();
    router = setup();
    state = undefined;
    now += 60_000;
    await router.flush();
    assert.deepEqual(cleared, []);
    state = { status: 'attention', approvalIds: ['second'], activeChildren: false, updatedAt: '' };
    router.refresh();
    await router.flush();
    assert.deepEqual(cleared, ['first']);
    assert.equal(saved.length, 1);
    state.approvalIds = [];
    state.status = 'working';
    router.refresh();
    await router.flush();
    await router.flush();
    assert.deepEqual(cleared, ['first', 'second']);
    assert.deepEqual(sent, ['first', 'second']);
    assert.equal(saved.length, 0);
  } finally {
    router.stop();
  }
});

test('a failed approval dismissal stays queued and retries without sending another alert', async () => {
  let now = 0;
  let pending = true;
  let attempts = 0;
  let sent = 0;
  const router = new AttentionDelivery({
    now: () => now,
    policy: () => DEFAULT_NOTIFICATION_POLICY,
    current: () => ({
      status: 'working',
      approvalIds: pending ? ['ask'] : [],
      activeChildren: false,
      updatedAt: '',
    }),
    deliver: async () => {
      sent++;
    },
    clear: async () => {
      if (++attempts === 1) throw new Error('Push unavailable');
    },
    report: () => {},
  });
  try {
    await router.push('phone', {
      type: 'attention',
      projectId: 'project',
      threadId: 'thread',
      title: '',
      body: '',
      reason: 'approval',
      approvalId: 'ask',
    });
    now = 2000;
    await router.flush();
    pending = false;
    router.refresh();
    await assert.rejects(router.flush(), /Push unavailable/);
    await router.flush();
    assert.equal(attempts, 1);
    now += 60_000;
    await router.flush();
    now += 60_000;
    await router.flush();
    assert.equal(attempts, 2);
    assert.equal(sent, 1);
  } finally {
    router.stop();
  }
});
