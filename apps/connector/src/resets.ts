import { createHmac } from 'node:crypto';

import { HARNESSES, START_HARNESSES, type Usage, type UsageWindow } from '@dashup/protocol';

import type { Login } from './usage';

// =============================================================================
// Provider-advertised allowance resets; identities and content stay on paired devices
// =============================================================================

export type UsageResetEvent = {
  type      : 'usage-reset';
  id        : string;
  reason    : 'reset';
  harness   : Usage['harness'];
  account   : string;
  windows   : Array<{ minutes: number; resets: string }>;
  resetAt   : number;
  expiresAt : number;
  title     : string;
  body      : string;
  alert?    : string;
};

export const USAGE_RESET_EVENTS = 100;
const RESET_WINDOWS = 16;
const ACCOUNT_CHARS = 320;
const MINUTE_MS     = 60_000;
const DAY_MINUTES   = 24 * 60;

function resetTime(window: UsageWindow): number | undefined {
  if (
    !window ||
    !Number.isFinite(window.minutes) ||
    window.minutes <= 0 ||
    !Number.isFinite(window.used) ||
    window.used < 0 ||
    typeof window.resets !== 'string'
  )
    return;
  const at = Date.parse(window.resets);
  return Number.isFinite(at) ? at : undefined;
}

// The name a phone's alert for one reset goes by, the same on every computer that shares the login.
// It is keyed with the vendor's account ID, which the server never sees, so the server can tell two
// reports of one reset apart from two resets but cannot tell whose they are or when the reset was.
// Claude reports a reset time with up to a second of noise, so it counts to the nearest minute.
const alertKey = (identity: string, harness: string, resetAt: number): string =>
  createHmac('sha256', identity)
    .update(JSON.stringify(['dashup:usage-reset', harness, Math.round(resetAt / MINUTE_MS)]))
    .digest('base64url');

export function usageResetEvents(usage: Login[], now = Date.now()): UsageResetEvent[] {
  const groups = new Map<string, UsageResetEvent>();
  for (const login of usage) {
    if (
      !login ||
      !START_HARNESSES.includes(login.harness) ||
      typeof login.account !== 'string' ||
      login.account.length > ACCOUNT_CHARS ||
      !Array.isArray(login.windows)
    )
      continue;
    for (const window of login.windows) {
      const resetAt = resetTime(window);
      if (resetAt === undefined || resetAt <= now || window.used <= 0) continue;
      const id = JSON.stringify([login.harness, login.account, resetAt]);
      let event = groups.get(id);
      if (!event) {
        if (groups.size >= USAGE_RESET_EVENTS) continue;
        event = {
          type      : 'usage-reset',
          id,
          reason    : 'reset',
          harness   : login.harness,
          account   : login.account,
          windows   : [],
          resetAt,
          expiresAt : resetAt + DAY_MINUTES * MINUTE_MS,
          title     : `${HARNESSES[login.harness]} usage reset`,
          body      : `Your usage allowance${login.account ? ` for ${login.account}` : ''} has reset. Open this computer to check its current limits.`,
          ...(typeof login.identity === 'string' && login.identity
            ? { alert: alertKey(login.identity, login.harness, resetAt) }
            : {}),
        };
        groups.set(id, event);
      }
      if (
        event.windows.length < RESET_WINDOWS &&
        !event.windows.some((item) => item.minutes === window.minutes)
      )
        event.windows.push({ minutes: window.minutes, resets: new Date(resetAt).toISOString() });
      event.expiresAt = Math.min(
        event.expiresAt,
        resetAt + Math.min(window.minutes, DAY_MINUTES) * MINUTE_MS,
      );
    }
  }
  return [...groups.values()]
    .map((event) => ({ ...event, windows: event.windows.sort((a, b) => a.minutes - b.minutes) }))
    .sort((a, b) => a.resetAt - b.resetAt || a.id.localeCompare(b.id));
}

// A stale meter may confirm its advertised time, but never invents another reset window.
export function validUsageReset(
  event: UsageResetEvent,
  usage: Usage[],
  ready: boolean,
  now = Date.now(),
): boolean | undefined {
  if (!ready) return;
  if (
    !Number.isFinite(event.resetAt) ||
    !Number.isFinite(event.expiresAt) ||
    event.expiresAt <= now ||
    event.expiresAt <= event.resetAt ||
    !Array.isArray(event.windows) ||
    !event.windows.length ||
    event.windows.length > RESET_WINDOWS
  )
    return false;
  const logins = usage.filter(
    (login) => login.harness === event.harness && login.account === event.account,
  );
  // An expired meter token does not cancel the reset time already reported for the same login.
  if (logins.length && logins.every((login) => !login.windows?.length)) return true;
  return event.windows.some((window) => {
    if (
      !Number.isFinite(window.minutes) ||
      window.minutes <= 0 ||
      Date.parse(window.resets) !== event.resetAt
    )
      return false;
    let latest: { at: number; used: number } | undefined;
    for (const login of logins)
      for (const meter of login.windows ?? []) {
        if (meter.minutes !== window.minutes) continue;
        const at = resetTime(meter);
        if (
          at !== undefined &&
          (!latest || at > latest.at || (at === latest.at && meter.used > latest.used))
        )
          latest = { at, used: meter.used };
      }
    return (
      !!latest &&
      (latest.at === event.resetAt ||
        (now >= event.resetAt && latest.at > event.resetAt && latest.used < 100))
    );
  });
}
