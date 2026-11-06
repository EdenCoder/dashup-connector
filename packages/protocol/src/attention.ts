// =============================================================================
// Notification preferences: content decisions belong to paired devices
// =============================================================================

export type NotificationPolicy = {
  mode          : 'decisions' | 'all';
  completions   : 'off' | 'immediate' | 'digest';
  usageResets   : boolean;
  digestMinutes : number;
  quiet?        : { start: number; end: number; timeZone: string };
  projects      : Record<string, { muted?: boolean; snoozedUntil?: number }>;
};

export type AttentionReason = 'approval' | 'input' | 'error' | 'complete' | 'reset';

export const DEFAULT_NOTIFICATION_POLICY: NotificationPolicy = {
  mode          : 'decisions',
  completions   : 'off',
  usageResets   : true,
  digestMinutes : 15,
  projects      : {},
};

const DAY_MINUTES = 24 * 60;
const MINUTE_MS   = 60_000;
const MAX_PROJECTS = 10_000;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function parseNotificationPolicy(value: unknown): NotificationPolicy {
  if (
    !record(value) ||
    !keys(value, ['mode', 'completions', 'usageResets', 'digestMinutes', 'quiet', 'projects']) ||
    !['decisions', 'all'].includes(String(value.mode)) ||
    !['off', 'immediate', 'digest'].includes(String(value.completions)) ||
    (value.usageResets !== undefined && typeof value.usageResets !== 'boolean') ||
    ![15, 30, 60].includes(Number(value.digestMinutes)) ||
    typeof value.digestMinutes !== 'number' ||
    !record(value.projects) ||
    Object.keys(value.projects).length > MAX_PROJECTS
  )
    throw new Error('Invalid notification preferences');
  const projects: NotificationPolicy['projects'] = {};
  for (const [id, project] of Object.entries(value.projects)) {
    if (
      !id ||
      id.length > 128 ||
      ['__proto__', 'constructor', 'prototype'].includes(id) ||
      !record(project) ||
      !keys(project, ['muted', 'snoozedUntil']) ||
      (project.muted !== undefined && typeof project.muted !== 'boolean') ||
      (project.snoozedUntil !== undefined &&
        (typeof project.snoozedUntil !== 'number' ||
          !Number.isSafeInteger(project.snoozedUntil) ||
          project.snoozedUntil < 0))
    )
      throw new Error('Invalid project notification preferences');
    projects[id] = {
      ...(project.muted === undefined ? {} : { muted: project.muted }),
      ...(project.snoozedUntil === undefined ? {} : { snoozedUntil: project.snoozedUntil }),
    };
  }
  let quiet: NotificationPolicy['quiet'];
  if (value.quiet !== undefined) {
    const item = value.quiet;
    if (
      !record(item) ||
      !keys(item, ['start', 'end', 'timeZone']) ||
      ![item.start, item.end].every(
        (minute) =>
          typeof minute === 'number' &&
          Number.isInteger(minute) &&
          minute >= 0 &&
          minute < DAY_MINUTES,
      ) ||
      item.start === item.end ||
      typeof item.timeZone !== 'string' ||
      item.timeZone.length > 100
    )
      throw new Error('Choose different start and end times for quiet hours');
    try {
      new Intl.DateTimeFormat('en', { timeZone: item.timeZone }).format(0);
    } catch {
      throw new Error('Choose a valid time zone for quiet hours');
    }
    quiet = { start: item.start as number, end: item.end as number, timeZone: item.timeZone };
  }
  return {
    mode          : value.mode as NotificationPolicy['mode'],
    completions   : value.completions as NotificationPolicy['completions'],
    usageResets   :
      value.usageResets === undefined ? DEFAULT_NOTIFICATION_POLICY.usageResets : value.usageResets,
    digestMinutes : value.digestMinutes,
    projects,
    ...(quiet ? { quiet } : {}),
  };
}

export function quietHours(policy: NotificationPolicy, now = Date.now()): boolean {
  if (!policy.quiet) return false;
  const { start, end, timeZone } = policy.quiet;
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const minute =
    Number(parts.find((part) => part.type === 'hour')?.value) * 60 +
    Number(parts.find((part) => part.type === 'minute')?.value);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export function notificationDecision(
  policy: NotificationPolicy,
  projectId: string,
  reason: AttentionReason,
  now = Date.now(),
): 'silent' | 'notify' | 'digest' {
  const project = policy.projects[projectId];
  if (
    (reason !== 'reset' && (project?.muted || (project?.snoozedUntil ?? 0) > now)) ||
    (reason === 'reset' && !policy.usageResets) ||
    quietHours(policy, now)
  )
    return 'silent';
  if (reason !== 'complete') return 'notify';
  if (policy.mode === 'decisions' || policy.completions === 'off') return 'silent';
  return policy.completions === 'digest' ? 'digest' : 'notify';
}

// Snooze and quiet hours postpone a still-pending decision. Mute and disabled completions do not.
// Walking UTC minutes handles daylight-saving gaps and repeated local hours in the phone's zone.
export function notificationResumeAt(
  policy: NotificationPolicy,
  projectId: string,
  reason: AttentionReason,
  now = Date.now(),
): number | null {
  const project = policy.projects[projectId];
  if (
    (reason !== 'reset' && project?.muted) ||
    (reason === 'reset' && !policy.usageResets) ||
    (reason === 'complete' && (policy.mode === 'decisions' || policy.completions === 'off'))
  )
    return null;
  let at = Math.max(now, reason === 'reset' ? 0 : (project?.snoozedUntil ?? 0));
  if (!quietHours(policy, at)) return at;
  at = Math.ceil(at / MINUTE_MS) * MINUTE_MS;
  for (let minute = 0; minute <= DAY_MINUTES + 180; minute++, at += MINUTE_MS)
    if (!quietHours(policy, at)) return at;
  return null;
}
