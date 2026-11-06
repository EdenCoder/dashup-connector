import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_NOTIFICATION_POLICY, parseNotificationPolicy, notificationDecision, notificationResumeAt } from './attention';

const now = Date.parse('2026-10-30T12:30:00Z');

test('usage reset preferences migrate old saved policies and preserve an explicit opt-out', () => {
  const { usageResets, ...old } = DEFAULT_NOTIFICATION_POLICY;
  assert.equal(usageResets, true);
  assert.equal(parseNotificationPolicy(old).usageResets, true);
  assert.equal(parseNotificationPolicy({ ...old, usageResets: false }).usageResets, false);
  for (const invalid of ['true', 1, null, []])
    assert.throws(() => parseNotificationPolicy({ ...old, usageResets: invalid }));
});

test('reset alerts are account-wide and independent of completions and project muting', () => {
  const policy = {
    ...DEFAULT_NOTIFICATION_POLICY,
    projects: { project: { muted: true, snoozedUntil: now + 60_000 } },
  };
  assert.equal(notificationDecision(policy, 'project', 'complete', now), 'silent');
  assert.equal(notificationDecision(policy, 'project', 'approval', now), 'silent');
  assert.equal(notificationDecision(policy, 'project', 'reset', now), 'notify');
  assert.equal(notificationResumeAt(policy, 'project', 'reset', now), now);
  assert.equal(notificationDecision({ ...policy, usageResets: false }, '', 'reset', now), 'silent');
  assert.equal(notificationResumeAt({ ...policy, usageResets: false }, '', 'reset', now), null);
});

test('quiet hours postpone enabled reset alerts and never revive disabled reset alerts', () => {
  const policy = {
    ...DEFAULT_NOTIFICATION_POLICY,
    quiet: { start: 22 * 60, end: 8 * 60, timeZone: 'Australia/Brisbane' },
  };
  assert.equal(notificationDecision(policy, '', 'reset', now), 'silent');
  assert.equal(notificationResumeAt(policy, '', 'reset', now), Date.parse('2026-10-30T22:00:00Z'));
  assert.equal(notificationResumeAt({ ...policy, usageResets: false }, '', 'reset', now), null);
});
