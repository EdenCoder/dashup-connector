import { randomUUID } from 'node:crypto';
import { PHONE_PENDING, PHONE_WAIT_MS, parsePhoneInput, parsePhoneResponse, type PhoneInput, type PhoneContent, type PhoneRequest } from '@dashup/protocol/phone';
import type { PairingRecord } from '@dashup/protocol';

// =============================================================================
// Pending phone tools belong to one live pairing and never survive a disconnect
// =============================================================================

export type PhoneResult = {
  requestId : string;
  status    : 'completed' | 'declined' | 'cancelled';
  text?     : string;
  choice?   : string;
  files?    : Array<{ path: string; mime: string }>;
};
type Pending = {
  pairing : string;
  request : PhoneRequest;
  resolve : (value: PhoneResult) => void;
  reject  : (error: Error) => void;
  timer   : ReturnType<typeof setTimeout>;
  controller: AbortController;
  release : () => void;
  reading?: boolean;
};
type Options = {
  pairs   : () => PairingRecord[];
  send    : (pairing: string, content: PhoneContent) => void;
  receive : (
    pairing: string,
    attachment: NonNullable<import('@dashup/protocol/phone').PhoneResponse['attachment']>,
    signal: AbortSignal,
  ) => Promise<Array<{ path: string; mime: string }>>;
};

export class PhoneTools {
  private readonly watching = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly options: Options) {}

  list(): Array<{ pairing: string; mobile: string }> {
    return this.options
      .pairs()
      .filter((pair) => this.watching.has(pair.id))
      .map((pair) => ({ pairing: pair.id, mobile: pair.mobile }));
  }

  async request(value: unknown, signal?: AbortSignal): Promise<PhoneResult> {
    const input: PhoneInput = parsePhoneInput(value);
    if (signal?.aborted) throw new Error('Phone request cancelled.');
    if (this.pending.size >= PHONE_PENDING)
      throw new Error('Wait for the pending phone requests to finish.');
    const phones = this.list();
    const pair = input.pairing
      ? phones.find((pair) => pair.pairing === input.pairing)
      : phones.length === 1
        ? phones[0]
        : undefined;
    if (!pair)
      throw new Error(
        phones.length > 1
          ? 'Choose a pairing from phone_list.'
          : 'Open Dashup on a paired phone before requesting input.',
      );
    const { pairing: _, timeoutMs = PHONE_WAIT_MS, ...details } = input;
    const request: PhoneRequest = {
      ...details,
      id: randomUUID(),
      timeoutMs,
      expiresAt: Date.now() + timeoutMs,
    };
    return new Promise<PhoneResult>((resolve, reject) => {
      const cancel = () => this.cancel(request.id, 'Phone request cancelled.');
      const timer = setTimeout(
        () => this.cancel(request.id, 'The phone request expired.'),
        timeoutMs,
      );
      timer.unref();
      const pending: Pending = {
        pairing: pair.pairing,
        request,
        resolve,
        reject,
        timer,
        controller: new AbortController(),
        release: () => signal?.removeEventListener('abort', cancel),
      };
      this.pending.set(request.id, pending);
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        this.options.send(pair.pairing, { type: 'phone.request', request });
      } catch (error) {
        this.cancel(request.id, error instanceof Error ? error.message : 'The phone disconnected.');
      }
    });
  }

  async receive(pairing: string, value: PhoneContent): Promise<void> {
    if (value.type === 'phone.watch') {
      if (value.active) this.watching.add(pairing);
      else this.disconnect(pairing);
      return;
    }
    if (value.type !== 'phone.response') return;
    const response = parsePhoneResponse(value);
    const pending = this.pending.get(response.requestId);
    if (!pending || pending.pairing !== pairing || pending.reading || !this.watching.has(pairing))
      return;
    if (!this.options.pairs().some((pair) => pair.id === pairing && !pair.revokedAt))
      return this.disconnect(pairing);
    if (response.choice && !pending.request.choices?.includes(response.choice))
      throw new Error('This choice does not belong to the request.');
    if (response.status === 'completed') {
      const kind = pending.request.kind;
      if (response.attachment && ['choice', 'text'].includes(kind))
        throw new Error('This request does not accept a file.');
      if (
        response.attachment &&
        ['photo', 'screenshot', 'sketch'].includes(kind) &&
        !response.attachment.mime.startsWith('image/')
      )
        throw new Error('This request needs an image.');
      if (
        kind === 'choice'
          ? !response.choice
          : kind === 'text'
            ? !response.text
            : !response.attachment
      )
        throw new Error('The phone response does not answer this request.');
    }
    pending.reading = true;
    try {
      const files = response.attachment
        ? await this.options.receive(pairing, response.attachment, pending.controller.signal)
        : undefined;
      if (this.pending.get(response.requestId) !== pending) return;
      this.pending.delete(response.requestId);
      clearTimeout(pending.timer);
      pending.release();
      pending.resolve({
        requestId: response.requestId,
        status: response.status,
        ...(response.text ? { text: response.text } : {}),
        ...(response.choice ? { choice: response.choice } : {}),
        ...(files ? { files } : {}),
      });
    } catch (error) {
      this.cancel(
        response.requestId,
        error instanceof Error ? error.message : 'The phone response could not be opened.',
      );
    }
  }

  private cancel(id: string, reason: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.controller.abort();
    clearTimeout(pending.timer);
    pending.release();
    try {
      this.options.send(pending.pairing, { type: 'phone.cancel', requestId: id, reason });
    } catch {}
    pending.reject(new Error(reason));
  }
  disconnect(pairing?: string): void {
    if (pairing) this.watching.delete(pairing);
    else this.watching.clear();
    for (const [id, pending] of this.pending)
      if (!pairing || pending.pairing === pairing)
        this.cancel(id, 'The paired phone disconnected. Request input again when it is open.');
  }
}
