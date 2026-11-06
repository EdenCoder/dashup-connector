import { notificationDecision, notificationResumeAt, type AttentionReason, type NotificationPolicy } from '@dashup/protocol/attention';
import { encryptContent, decryptContent } from '@dashup/protocol/crypto';
import { randomBytes } from 'node:crypto';
import type { UsageResetEvent } from './resets';

// =============================================================================
// Attention delivery: decide on the computer before the relay can send a push
// =============================================================================

export type ThreadAttentionEvent = {
  type        : 'attention';
  projectId   : string;
  threadId    : string;
  title       : string;
  body        : string;
  reason      : Exclude<AttentionReason, 'reset'>;
  approvalId? : string;
};
export type AttentionEvent = ThreadAttentionEvent | UsageResetEvent;

export type AttentionState = {
  status         : 'working' | 'attention' | 'idle' | 'unknown';
  approvalIds    : string[];
  activeChildren : boolean;
  updatedAt      : string;
};

export type PendingAttention = {
  pairing : string;
  event   : AttentionEvent;
  due     : number;
  silent  : boolean;
  digest  : boolean;
  known?  : boolean;
  offline? : boolean;
  delivered? : boolean;
};

export type StoredAttention = { pairing: string; nonce: string; ciphertext: string };

const pendingData = (pairing: string) => Buffer.from(JSON.stringify(['dashup:attention', pairing]));

export function storeAttention(value: PendingAttention, key: string): StoredAttention {
  return {
    pairing: value.pairing,
    ...encryptContent(key, pendingData(value.pairing), value, randomBytes),
  };
}

export function restoreAttention(value: StoredAttention, key: string): PendingAttention {
  const pending = decryptContent<PendingAttention>(key, pendingData(value.pairing), value);
  if (pending.pairing !== value.pairing) throw new Error('Notification pairing mismatch');
  return pending;
}

type Delivery = {
  policy  : (pairing: string) => NotificationPolicy;
  // Undefined means the adapter cannot establish whether the request is still pending.
  current : (project: string, thread: string) => AttentionState | undefined;
  reset?  : (event: UsageResetEvent) => boolean | undefined;
  deliver : (pairing: string, event: AttentionEvent, notify: boolean) => Promise<void>;
  clear?  : (pairing: string, event: ThreadAttentionEvent) => Promise<void>;
  report  : (error: unknown) => void;
  active? : (pairing: string) => boolean;
  saved?  : PendingAttention[];
  save?   : (pending: PendingAttention[]) => void;
  now?    : () => number;
};

const DECISION_SETTLE_MS   = 1_500;
const COMPLETION_SETTLE_MS = 5_000;
const MAX_TIMER_MS         = 60_000;
const MAX_PENDING         = 1_000;

export class AttentionDelivery {
  private readonly pending = new Map<string, PendingAttention>();
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private stopped = false;
  private saved = '';

  constructor(private readonly delivery: Delivery) {
    for (const item of delivery.saved?.slice(-MAX_PENDING) ?? [])
      this.pending.set(this.key(item.pairing, item.event), item);
    this.saved = JSON.stringify([...this.pending.values()]);
  }

  start(): void {
    this.stopped = false;
    for (const item of this.pending.values())
      if (item.offline)
        item.due =
          item.event.type === 'usage-reset' ? Math.max(item.event.resetAt, this.now()) : this.now();
    this.schedule();
  }

  private now(): number {
    return this.delivery.now?.() ?? Date.now();
  }

  private key(pairing: string, event: AttentionEvent): string {
    if (event.type === 'usage-reset') return JSON.stringify([pairing, event.type, event.id]);
    return JSON.stringify([
      pairing,
      event.projectId,
      event.threadId,
      event.reason,
      event.approvalId ?? (event.reason === 'approval' ? event.title : ''),
    ]);
  }

  // A resolved permission never alerts. A quiet parent is not complete while its children work.
  private pendingNow(event: AttentionEvent, known = false): boolean {
    if (event.type === 'usage-reset')
      return event.expiresAt > this.now() && this.delivery.reset?.(event) !== false;
    const state = this.delivery.current(event.projectId, event.threadId);
    if (!state || state.status === 'unknown') return !known && event.reason !== 'complete';
    if (event.reason === 'approval')
      return event.approvalId
        ? state.approvalIds.includes(event.approvalId)
        : state.approvalIds.length > 0;
    if (event.reason === 'complete')
      return state.status === 'idle' && !state.activeChildren && !state.approvalIds.length;
    return state.status !== 'working';
  }

  valid(event: AttentionEvent): boolean {
    return this.pendingNow(event, event.type === 'attention' && !!event.approvalId);
  }

  async push(pairing: string, event: AttentionEvent): Promise<void> {
    if (this.stopped) return;
    const key = this.key(pairing, event);
    const previous = this.pending.get(key);
    if (previous?.delivered) return;
    const now = this.now();
    const state =
      event.type === 'attention'
        ? this.delivery.current(event.projectId, event.threadId)
        : undefined;
    this.pending.set(key, {
      pairing,
      event,
      due    :
        previous?.due ??
        (event.type === 'usage-reset'
          ? Math.max(now, event.resetAt)
          : now + (event.reason === 'complete' ? COMPLETION_SETTLE_MS : DECISION_SETTLE_MS)),
      silent : previous?.silent ?? false,
      digest : previous?.digest ?? false,
      known  : !!state && state.status !== 'unknown',
    });
    // A disconnected phone cannot grow an unbounded queue of obsolete asks.
    while (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    this.schedule();
  }

  // Configuration changes re-evaluate queued reminders without replaying already-delivered alerts.
  changed(pairing: string, resetsOnly = false): void {
    for (const [key, item] of this.pending)
      if (item.pairing === pairing && (!resetsOnly || item.event.type === 'usage-reset')) {
        if (item.event.type === 'usage-reset') {
          if (!this.delivery.policy(pairing).usageResets || !this.pendingNow(item.event))
            this.pending.delete(key);
          else item.due = Math.max(item.event.resetAt, Math.min(item.due, this.now()));
        } else item.due = Math.min(item.due, this.now());
      }
    this.schedule();
  }

  // Native changes reconsider delivered approvals without shortening queued notification debounce.
  refresh(): void {
    for (const item of this.pending.values()) if (item.delivered) item.due = this.now();
    this.schedule();
  }

  cancel(pairing: string): void {
    for (const [key, item] of this.pending) if (item.pairing === pairing) this.pending.delete(key);
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  flush(): Promise<void> {
    if (this.running) return this.running;
    const run = this.flushNow().finally(() => {
      this.running = undefined;
      this.schedule();
    });
    this.running = run;
    return run;
  }

  private async flushNow(): Promise<void> {
    if (this.stopped) return;
    const now = this.now();
    const digests = new Map<string, PendingAttention[]>();
    for (const [key, item] of this.pending) {
      if (item.due > now) continue;
      if (item.delivered && item.event.type === 'attention') {
        const state = this.delivery.current(item.event.projectId, item.event.threadId);
        if (
          state &&
          state.status !== 'unknown' &&
          item.event.approvalId &&
          !state.approvalIds.includes(item.event.approvalId) &&
          (!this.delivery.active || this.delivery.active(item.pairing))
        ) {
          item.due = now + MAX_TIMER_MS;
          await this.delivery.clear?.(item.pairing, item.event);
          this.pending.delete(key);
        } else item.due = now + MAX_TIMER_MS;
        continue;
      }
      if (item.event.type === 'usage-reset' && !this.pendingNow(item.event, item.known)) {
        this.pending.delete(key);
        continue;
      }
      if (item.event.type === 'usage-reset') {
        if (item.event.resetAt > now) {
          item.due = item.event.resetAt;
          continue;
        }
        if (this.delivery.reset?.(item.event) === undefined) {
          item.due = now + MAX_TIMER_MS;
          continue;
        }
      }
      if (this.delivery.active && !this.delivery.active(item.pairing)) {
        item.offline = true;
        item.due = now + MAX_TIMER_MS;
        continue;
      }
      item.offline = false;
      const state =
        item.event.type === 'attention' && item.event.reason === 'complete'
          ? this.delivery.current(item.event.projectId, item.event.threadId)
          : undefined;
      if (state?.status === 'idle' && state.activeChildren) {
        item.due = now + COMPLETION_SETTLE_MS;
        continue;
      }
      if (item.event.type === 'attention' && !this.pendingNow(item.event, item.known)) {
        this.pending.delete(key);
        continue;
      }
      const policy = this.delivery.policy(item.pairing);
      const project = item.event.type === 'attention' ? item.event.projectId : '';
      const decision = notificationDecision(policy, project, item.event.reason, now);
      if (decision === 'notify') {
        await this.delivery.deliver(item.pairing, item.event, true);
        if (
          this.delivery.clear &&
          item.event.type === 'attention' &&
          item.event.reason === 'approval' &&
          item.event.approvalId
        ) {
          item.delivered = true;
          item.due = now + MAX_TIMER_MS;
        } else this.pending.delete(key);
        continue;
      }
      if (!item.silent) {
        await this.delivery.deliver(item.pairing, item.event, false);
        item.silent = true;
      }
      if (decision === 'silent') {
        const resume = notificationResumeAt(policy, project, item.event.reason, now);
        if (resume === null) this.pending.delete(key);
        else item.due = Math.max(now + 1_000, resume);
        continue;
      }
      if (!item.digest) {
        item.digest = true;
        const next = [...this.pending.values()].find(
          (entry) =>
            entry !== item && entry.pairing === item.pairing && entry.digest && entry.due > now,
        );
        item.due = next?.due ?? now + policy.digestMinutes * 60_000;
        continue;
      }
      const batch = digests.get(item.pairing) ?? [];
      batch.push(item);
      digests.set(item.pairing, batch);
    }
    for (const [pairing, items] of digests) {
      const latest = items.at(-1)!;
      await this.delivery.deliver(
        pairing,
        {
          ...latest.event,
          title:
            items.length === 1
              ? latest.event.title
              : `${items.length} conversations are ready to review`,
          body:
            items.length === 1
              ? 'The agent is idle and its changes are ready to review.'
              : `Open the latest: ${latest.event.title}`,
        },
        true,
      );
      for (const item of items) this.pending.delete(this.key(pairing, item.event));
    }
  }

  private schedule(): void {
    clearTimeout(this.timer);
    const pending = [...this.pending.values()];
    const saved = JSON.stringify(pending);
    if (saved !== this.saved) {
      this.delivery.save?.(pending);
      this.saved = saved;
    }
    if (this.stopped || !this.pending.size) return;
    const next = Math.min(...[...this.pending.values()].map((item) => item.due));
    this.timer = setTimeout(
      () => {
        void this.flush().catch(this.delivery.report);
      },
      Math.max(10, Math.min(MAX_TIMER_MS, next - this.now())),
    );
    this.timer.unref();
  }
}
