import { z } from 'zod';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { createClient } from '@parcae/sdk';
import { HARNESSES, isStartHarness, PAIRING_TTL_MS, START_HARNESSES, DASHBOARD_BYTES, STATE_EVENT } from '@dashup/protocol';
import { seal, newSecret } from '@dashup/protocol/crypto';
import { SESSION_JOIN, SESSION_READY, SESSION_PACKET, SESSION_PEER, SESSION_VERSION, SESSION_STREAMS, SESSION_STREAM_BYTES, sealSession, openSession, opensHello, sealLegacySession, openLegacySession } from '@dashup/protocol/session';
import type { SessionContent as Content, SessionCommand, SessionResult, SessionPacket, SessionReady, SessionPeer } from '@dashup/protocol/session';
import type { Message, Approval, QueueReceipt, StartHarness, ApprovalReply, CommandAction, PairingRecord, ThreadSummary, ProjectSummary, ProjectOverview, Dashboard, Envelope, State, StateEvent, Harness } from '@dashup/protocol';
import { parseNotificationPolicy, DEFAULT_NOTIFICATION_POLICY } from '@dashup/protocol/attention';
import { TERMINAL_INPUT_CHARS } from '@dashup/protocol/terminal';
import { parsePhoneResponse } from '@dashup/protocol/phone';
import { version } from '../package.json';
import { planUsage, type Login } from './usage';
import { usageResetEvents, validUsageReset, type UsageResetEvent } from './resets';
import { Terminals } from './terminal';
import { forgetUploads, expireUploads, receiveUploads } from './uploads';
import { Workspaces } from './workspace';
import { alertThread, storeAttention, restoreAttention, AttentionDelivery } from './attention';
import { invitation, type Invitation } from './pair';
import { Discovery } from './discovery';
import { shareAttachment, opaque } from './attachments';
import { chatPage, chatPosition, historyMessageId } from './chat';
import { GROUP_MEMBERS } from '@dashup/protocol/group';
import { PhoneTools } from './phone';
import { LiveHarnesses } from './harness/live';
import { sessionKey, type InputFile, type LiveSession } from './harness/session';
import { NativeQueue, queueOwner, writerOwner } from './harness/queue';
import { bridgeAcp, commandAcp, type AcpSession } from './acp';
import { api, activePair, saveConfig, type ConnectorConfig } from './config';

// =============================================================================
// Current dashboard and selected session bounds
// =============================================================================

const HOME_RECENT     = 30;
const SESSION_ITEMS   = 30;
const SESSION_BYTES   = 40 * 1024;
const PROJECT_CARDS   = 100;
const RECEIPTS        = 1_000;
const ATTACHMENT_ORIGINS = 2_048;
const ATTENTION_ITEMS = 1_000;
const CATALOG_MS      = 10_000;
const SELECTED_MS     = 120;
const JOIN_MS         = 5_000;
const HEARTBEAT_MS    = 30_000;
const USAGE_MS        = 5 * 60_000;
const AGENTS_MS       = 5 * 60_000;
type Attention = import('./attention').ThreadAttentionEvent;
type ThreadState = Extract<Content, { type: 'thread-state' }>;
type Started = NonNullable<SessionResult['started']>;
type Selected = {
  pairing: string;
  project: string;
  thread: string;
  latest: boolean;
  live?: LiveSession;
  page?: string;
  state?: string;
  pending?: Promise<void>;
};
const selectionKey = (pairing: string, project: string, thread: string) =>
  JSON.stringify([pairing, project, thread]);
// Whether the approval takes the reply: one of its choices, or an answer to each of its questions.
const answers = (approval: Approval, reply: ApprovalReply): boolean =>
  'answers' in reply
    ? reply.answers.length === approval.questions?.length
    : approval.choices.some((choice) => choice.id === reply.choice);

const Uploaded = z
  .array(
    z
      .object({
        id: z.string().regex(/^[a-f0-9]{64}$/),
        name: z.string().min(1).max(255).optional(),
        mime: z.string().min(1).max(200),
        bytes: z
          .number()
          .int()
          .min(1)
          .max(8 * 1024 * 1024),
      })
      .strict(),
  )
  .max(4)
  .optional();
const Size       = {
  cols: z.number().int().min(20).max(160),
  rows: z.number().int().min(10).max(60),
};
const TerminalId = z.string().uuid();
const Command    = z
  .object({
    type: z.literal('command'),
    requestId: z.string().min(1).max(128),
    projectId: z.string().max(128),
    threadId: z.string().min(1).max(128).optional(),
    action: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('projects.refresh') }).strict(),
      z
        .object({
          kind: z.literal('sessions.list'),
          cursor: z.string().max(1024).optional(),
          query: z.string().max(200).optional(),
          parent: z.string().max(128).optional(),
        })
        .strict(),
      z
        .object({
          kind: z.literal('notifications.configure'),
          policy: z.unknown().transform(parseNotificationPolicy),
        })
        .strict(),
      z
        .object({
          kind: z.literal('workspace.read'),
          baseline: z.string().min(1).max(255).optional(),
        })
        .strict(),
      z
        .object({ kind: z.literal('workspace.check'), command: z.string().min(1).max(4000) })
        .strict(),
      z
        .object({
          kind: z.literal('thread.send'),
          text: z.string().min(1).max(100000),
          now: z.boolean().optional(),
          attachments: Uploaded,
        })
        .strict(),
      z
        .object({
          kind: z.literal('thread.queue'),
          text: z.string().max(100000),
          attachments: Uploaded,
        })
        .strict(),
      z.object({ kind: z.literal('thread.stop') }).strict(),
      z
        .object({
          kind: z.literal('thread.configure'),
          option: z.string().min(1).max(100),
          value: z.union([z.string().min(1).max(200), z.boolean()]),
        })
        .strict(),
      z
        .object({
          kind: z.literal('approval.respond'),
          approvalId: z.string(),
          choice: z.string().optional(),
          text: z.string().max(100000).optional(),
          answers: z
            .array(z.array(z.string().min(1).max(100000)).min(1))
            .min(1)
            .optional(),
        })
        .strict()
        // One of the approval's choices, with or without the person's words, or their answers.
        .refine(
          (action) =>
            (action.choice === undefined) !== (action.answers === undefined) &&
            (action.text === undefined || action.choice !== undefined),
        ),
      z
        .object({ kind: z.literal('attachment.read'), id: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict(),
      z
        .object({
          kind: z.literal('session.start'),
          harness: z.enum(START_HARNESSES),
          model: z.string().min(1).max(200).optional(),
          attachments: Uploaded,
          workspace: z
            .discriminatedUnion('kind', [
              z
                .object({
                  kind: z.literal('new'),
                  branch: z.string().min(1).max(255),
                  base: z.string().min(1).max(255),
                })
                .strict(),
              z.object({ kind: z.literal('existing'), path: z.string().min(1).max(4096) }).strict(),
            ])
            .optional(),
          text: z.string().min(1).max(100000),
          folder: z
            .object({ parent: z.string().min(1), name: z.string().min(1).max(255) })
            .strict()
            .optional(),
        })
        .strict(),
    ]),
  })
  .strict();

const ThreadScope = {
  projectId: z.string().min(1).max(128),
  threadId: z.string().min(1).max(128),
};
const Controls = z.discriminatedUnion('type', [
  z.object({ type: z.literal('chat.attach'), ...ThreadScope }).strict(),
  z.object({ type: z.literal('chat.detach'), ...ThreadScope }).strict(),
  z
    .object({
      type: z.literal('chat.history'),
      requestId: z.string().min(1).max(128),
      ...ThreadScope,
      before: z.string().max(4096).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('open'),
      requestId: z.string().min(1).max(128),
      projectId: z.string().min(1).max(128),
      ...Size,
    })
    .strict(),
  z.object({ type: z.literal('attach'), terminalId: TerminalId }).strict(),
  z.object({ type: z.literal('detach'), terminalId: TerminalId }).strict(),
  z.object({ type: z.literal('close'), terminalId: TerminalId }).strict(),
  z.object({ type: z.literal('resize'), terminalId: TerminalId, ...Size }).strict(),
  z
    .object({
      type: z.literal('input'),
      terminalId: TerminalId,
      data: z.string().min(1).max(TERMINAL_INPUT_CHARS),
      binary: z.boolean().optional(),
    })
    .strict(),
]);

export class Connector {
  readonly client;
  readonly discovery;
  readonly nativeQueue;
  readonly notifications: AttentionDelivery;
  readonly agents = new Map<string, AcpSession>();
  readonly harnesses = new LiveHarnesses();
  readonly workspace = new Workspaces();
  readonly phone = new PhoneTools({
    pairs: () => this.activePairs().filter((pair) => this.isActive(pair.id)),
    send: (id, content) => {
      const pair = this.activePairs().find((pair) => pair.id === id);
      if (!pair) throw new Error('The phone is no longer paired.');
      this.sendSession(pair, content);
    },
    receive: async (id, attachment, signal) => {
      const pair = this.activePairs().find((pair) => pair.id === id);
      if (!pair) throw new Error('The phone is no longer paired.');
      return (await receiveUploads(this.config, pair, '', [attachment], signal)).files;
    },
  });
  readonly terminals = new Terminals(
    (id) => this.activePairs().some((pair) => pair.id === id && activePair(this.config, pair)),
    (id) => {
      if (id) this.terminalChanged(id);
      else this.scheduleCatalogue();
    },
    (error) => this.report(error),
    undefined,
    (id, _project, content) => {
      const pair = this.activePairs().find((item) => item.id === id);
      if (pair) this.sendSession(pair, content);
    },
  );
  private pairRecords: PairingRecord[] = [];
  private stateLoading?: Promise<void>;
  private stopped = false;
  private stopWatching = () => {};
  private stopHarnesses = () => {};
  private heartbeat?: ReturnType<typeof setInterval>;
  private catalogueTimer?: ReturnType<typeof setTimeout>;
  private selectedTimer?: ReturnType<typeof setTimeout>;
  private dashboardTimer?: ReturnType<typeof setTimeout>;
  private retry?: ReturnType<typeof setTimeout>;
  private cataloguing?: Promise<void>;
  private selecting?: Promise<void>;
  private nativeDirty = false;
  private lastCatalogue = 0;
  private startable: StartHarness[] = [];
  private usage: Login[] = [];
  private usageAt = 0;
  private agentsAt = 0;
  private usageReady = false;
  private stream = '';
  private sequence = 0;
  private readonly ready = new Set<string>();
  private readonly joining = new Map<string, ReturnType<typeof setTimeout>>();
  // Each pairing's phone streams met under this computer's streams, with the highest sequence taken
  // from each. `stream` is the phone's current one; a packet from any other met stream is refused.
  private readonly phones = new Map<string, { stream: string; seen: Map<string, number> }>();
  private readonly selected = new Map<string, Selected>();
  private readonly attachmentOrigins = new Map<
    string,
    {
      pairing: string;
      project: string;
      thread: string;
      message: string;
    }
  >();
  private readonly opened = new Map<string, Extract<Content, { type: 'opened' }>>();
  private readonly nativeSnapshots = new Map<
    string,
    { status: ThreadSummary['status']; approvals: Set<string> }
  >();
  private readonly currentAttention = new Map<string, { event: Attention; updatedAt: string }>();
  private readonly queueReceipts = new Map<string, string>();
  private readonly invitations = new Map<string, string>();
  // Pairings this computer asked the API to revoke, each asked once.
  private readonly revoked = new Set<string>();
  private readonly dashboardText = new Map<string, string>();
  private readonly dashboards = new Map<string, Envelope>();
  private readonly publishing = new Set<string>();

  constructor(readonly config: ConnectorConfig) {
    config.queued ??= {};
    config.receipts ??= {};
    config.usageResetReceipts ??= {};
    for (const pair of Object.values(config.pairs))
      if (pair.attention) pair.attention = parseNotificationPolicy(pair.attention);
    // Retired relay state is never replayed into a live native session after an upgrade.
    const legacy = config as ConnectorConfig & {
      outbox?: unknown;
      unconfirmed?: unknown;
      liveCommands?: unknown;
    };
    if ('outbox' in legacy || 'unconfirmed' in legacy || 'liveCommands' in legacy) {
      delete legacy.outbox;
      delete legacy.unconfirmed;
      delete legacy.liveCommands;
      saveConfig(config);
    }
    if (!config.device || !config.secret)
      throw new Error('Pair this computer with dashup pair first');
    this.client = createClient({
      url: config.api,
      getToken: async () => config.secret,
      autoConnect: false,
    });
    this.discovery = new Discovery(config.device.id, config.localSecret, {
      queue: (history) => Boolean(queueOwner(this.nativeQueue.owners, history)),
      writer: (history) => Boolean(writerOwner(this.nativeQueue.writers, history)),
      starts: (harness) => isStartHarness(harness) && this.startable.includes(harness),
    });
    this.nativeQueue = new NativeQueue(
      config.queued,
      () => saveConfig(config),
      (request) => this.isActive(request.pairing),
    );
    this.notifications = new AttentionDelivery({
      policy: (id) => config.pairs[id]?.attention ?? DEFAULT_NOTIFICATION_POLICY,
      reset: (event) => validUsageReset(event, this.usage, this.usageReady),
      current: (projectId, threadId) => {
        const thread = this.discovery.projects
          .get(projectId)
          ?.threads.find((item) => item.id === threadId);
        if (!thread) return;
        const live = this.discovery.locations.get(threadId)?.live;
        const agent = this.attached(thread);
        if (!live && (!agent || agent.socket.destroyed)) return;
        return {
          status: live?.status ?? agent!.status,
          approvalIds: (live?.approvals ?? [...agent!.approvals.values()]).map((item) => item.id),
          activeChildren: [...this.discovery.projects.values()].some((project) =>
            project.threads.some(
              (item) => item.parent === threadId && ['working', 'attention'].includes(item.status),
            )),
          updatedAt: live?.updatedAt ?? agent!.updatedAt,
        };
      },
      active: (id) => this.isActive(id),
      deliver: async (id, event, notify) => {
        const pair = this.activePairs().find((item) => item.id === id);
        if (!pair) return;
        if (
          event.type === 'usage-reset' &&
          config.usageResetReceipts![this.resetReceipt(id, event)]
        )
          return;
        this.refreshOverview();
        if (notify) {
          await api(config, '/dashup/attention', {
            pairing: id,
            ...(event.type === 'attention'
              ? {
                  projectId: event.projectId,
                  threadId: event.threadId,
                  ...(event.reason === 'approval' && event.approvalId
                    ? {
                        notification: opaque(config.localSecret!, [
                          'approval',
                          id,
                          event.threadId,
                          event.approvalId,
                        ]),
                      }
                    : {}),
                }
              : event.alert
                ? { reset: event.alert }
                : {}),
          });
          if (event.type === 'usage-reset') {
            config.usageResetReceipts![this.resetReceipt(id, event)] = event.expiresAt;
            this.pruneResetReceipts();
            saveConfig(config);
          }
        }
      },
      clear: async (pairing, event) => {
        await api(config, '/dashup/attention', {
          pairing,
          projectId: event.projectId,
          threadId: event.threadId,
          notification: opaque(config.localSecret!, [
            'approval',
            pairing,
            event.threadId,
            event.approvalId,
          ]),
          clear: true,
        });
      },
      report: (error) => this.report(error),
      saved: (config.attentionPending ?? []).flatMap((item) => {
        const key = config.pairs[item.pairing]?.key;
        if (!key) return [];
        try {
          return [restoreAttention(item, key)];
        } catch (error) {
          this.report(error);
          return [];
        }
      }),
      save: (pending) => {
        config.attentionPending = pending.flatMap((item) => {
          const key = config.pairs[item.pairing]?.key;
          return key ? [storeAttention(item, key)] : [];
        });
        saveConfig(config);
      },
    });
  }

  activePairs(): PairingRecord[] {
    return this.pairRecords.filter((pair) => !pair.revokedAt);
  }
  private isActive(id: string): boolean {
    return (
      this.client.isConnected &&
      this.activePairs().some((pair) => pair.id === id && activePair(this.config, pair))
    );
  }

  async start(): Promise<void> {
    this.client.subscribe(STATE_EVENT, (event: StateEvent) => {
      if (event.type === 'pairing') this.accept(event.pairing);
      if (event.type !== 'dashboard') void this.refreshState().catch((error) => this.report(error));
    });
    this.client.on('disconnected', () => {
      this.stream = '';
      this.ready.clear();
      this.joining.clear();
      this.dropPhone();
    });
    this.client.subscribe(SESSION_READY, (value: SessionReady) => {
      if (value.device !== this.config.device!.id || value.stream !== this.stream) return;
      this.joining.delete(value.pairing);
      if (value.ok) {
        this.ready.add(value.pairing);
        void this.publishQueueReceipts(value.pairing);
      } else {
        this.ready.delete(value.pairing);
        this.dropPhone(value.pairing);
        this.report(new Error(value.error ?? 'The session connection is unavailable.'));
      }
    });
    // The relay's word about the phone is unauthenticated. It can end what this computer pushes to
    // a phone that left; only a version 1 phone's new stream is taken on it.
    this.client.subscribe(SESSION_PEER, (peer: SessionPeer) => {
      const pair = this.activePairs().find(
        (item) => item.id === peer.pairing && item.mobile === peer.device,
      );
      const current = this.phones.get(peer.pairing)?.stream;
      if (!pair || (!peer.connected && current && current !== peer.stream)) return;
      if (!peer.connected || current !== peer.stream) this.dropPhone(pair.id);
      if (peer.connected && current !== peer.stream && this.legacy(pair.id)) {
        this.admit(pair.id, peer.stream, 0);
        void this.publishQueueReceipts(pair.id);
        this.rotate(pair.id);
      }
    });
    this.client.subscribe(SESSION_PACKET, (packet: SessionPacket) => {
      void this.receiveSession(packet).catch((error) => this.report(error));
    });
    this.client.on('resync-required', () => {
      // Custom socket events need the completed hello; transport connection alone is not enough.
      this.client.send('dashup:presence', { device: this.config.device!.id });
      this.restream();
      void this.refreshState().catch((error) => this.report(error));
    });
    this.client.on('error', () =>
      this.report(new Error('Connection interrupted. Dashup will reconnect.')));
    await this.refreshState();
    await this.changed();
    void this.findAgents().catch((error) => this.report(error));
    this.stopHarnesses = this.harnesses.watch(() => {
      this.scheduleSelected(true);
      this.scheduleCatalogue();
    });
    await this.client.reconnect();
    this.heartbeat = setInterval(() => {
      if (this.client.isConnected)
        this.client.send('dashup:presence', { device: this.config.device!.id });
      this.joinSessions();
      void this.findAgents().catch((error) => this.report(error));
      expireUploads().catch((error) => this.report(error));
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
    this.refreshOverview();
    process.stdout.write(
      `Dashup is connected. ${this.discovery.projects.size} existing projects found.\n`,
    );
  }

  private refreshState(): Promise<void> {
    if (this.stateLoading) return this.stateLoading;
    this.stateLoading = api<State>(this.config, '/dashup/state', undefined, 'GET')
      .then((state) => this.acceptPairings(state.pairings))
      .finally(() => {
        this.stateLoading = undefined;
      });
    return this.stateLoading;
  }

  // One pairing as the API reports it, from its own event or to whoever saw the scan first.
  accept(pairing: PairingRecord): void {
    this.acceptPairings([...this.pairRecords.filter((pair) => pair.id !== pairing.id), pairing]);
  }

  // A pairing made from a code this computer no longer holds, because it expired or the connector
  // restarted, has a key no one here kept, so the computer revokes it.
  private acceptPairings(records: PairingRecord[]): void {
    this.pairRecords = records.filter((pair) => pair.device === this.config.device!.id);
    for (const pair of this.activePairs()) {
      const key = this.invitations.get(pair.code);
      if (key) {
        this.invitations.delete(pair.code);
        this.config.pairs[pair.id] = { key, sequence: 0 };
      } else if (!this.config.pairs[pair.id] && !this.revoked.has(pair.id)) {
        this.revoked.add(pair.id);
        api(this.config, `/dashup/pairings/${pair.id}`, undefined, 'DELETE').catch((error) =>
          this.report(error));
      }
    }
    const known = new Set(this.activePairs().map((pair) => pair.id));
    for (const id of Object.keys(this.config.pairs))
      if (!known.has(id)) {
        this.phone.disconnect(id);
        this.terminals.revoke(id);
        this.notifications.cancel(id);
        this.clearSelected(id);
        this.ready.delete(id);
        this.phones.delete(id);
        this.dashboards.delete(id);
        forgetUploads(id).catch((error) => this.report(error));
        delete this.config.pairs[id];
      }
    for (const [id, receipt] of Object.entries(this.config.receipts!))
      if (!known.has(receipt.pairing)) delete this.config.receipts![id];
    for (const [id, origin] of this.attachmentOrigins)
      if (!known.has(origin.pairing)) this.attachmentOrigins.delete(id);
    for (const [id, queued] of Object.entries(this.config.queued!))
      if (!known.has(queued.pairing)) delete this.config.queued![id];
    saveConfig(this.config);
    this.notifications.start();
    this.armUsageResets();
    this.joinSessions();
    this.refreshOverview();
  }

  // A join or its answer can be lost, so one unanswered after JOIN_MS goes again on the same
  // stream; a timer acts only for the join it was armed for. A refusal can pass, so each heartbeat
  // joins every pairing that is neither ready nor joining.
  private joinSessions(): void {
    if (this.stopped || !this.stream || !this.client.isConnected) return;
    for (const pair of this.activePairs())
      if (activePair(this.config, pair) && !this.ready.has(pair.id) && !this.joining.has(pair.id)) {
        const retry = setTimeout(() => {
          if (this.joining.get(pair.id) !== retry) return;
          this.joining.delete(pair.id);
          this.joinSessions();
        }, JOIN_MS).unref();
        this.joining.set(pair.id, retry);
        this.client.send(SESSION_JOIN, {
          pairing: pair.id,
          device: pair.device,
          stream: this.stream,
        });
      }
  }

  // This computer's stream for the connection. Nothing sealed to an earlier one opens, so every
  // pairing joins again on it.
  private restream(): void {
    this.stream = randomBytes(SESSION_STREAM_BYTES).toString('hex');
    this.sequence = 0;
    this.ready.clear();
    this.joining.clear();
    this.joinSessions();
  }

  // Whether the pairing's phone has yet to speak session version 2. Once it has, it is held to it.
  private legacy(id: string): boolean {
    return this.config.pairs[id]?.session !== SESSION_VERSION;
  }

  // The phone's first version 2 packet: from here its version 1 packets, and what the relay said of
  // its streams, count for nothing.
  private upgrade(id: string): void {
    if (!this.legacy(id)) return;
    this.config.pairs[id]!.session = SESSION_VERSION;
    this.phones.delete(id);
    saveConfig(this.config);
  }

  // Records a packet's place in its phone stream. A stream first met becomes the phone's current one.
  private admit(id: string, stream: string, sequence: number): boolean {
    const phone = this.phones.get(id) ?? { stream: '', seen: new Map<string, number>() };
    const fresh = phone.stream !== stream;
    phone.stream = stream;
    phone.seen.set(stream, sequence);
    this.phones.set(id, phone);
    return fresh;
  }

  // Forgetting a met stream would let its packets back in. Past the bound this computer takes a new
  // stream instead, which nothing sealed to the old one can follow.
  private rotate(id: string): void {
    const phone = this.phones.get(id);
    if (!phone || phone.seen.size <= SESSION_STREAMS) return;
    phone.seen = new Map([[phone.stream, phone.seen.get(phone.stream)!]]);
    if (this.stream) this.restream();
  }

  // What this computer pushes to a phone ends with the phone's stream.
  private dropPhone(id?: string): void {
    this.phone.disconnect(id);
    this.clearSelected(id);
    this.terminals.disconnect(id);
  }

  // Whether the phone can be sent to: this computer's join stands and, for a version 2 phone, the
  // stream it holds is known.
  private linked(id: string): boolean {
    return this.isActive(id) && this.ready.has(id) && (this.legacy(id) || this.phones.has(id));
  }

  // A version 2 packet is sealed to `peer`, the phone's stream.
  private seal(pair: PairingRecord, content: Content, peer = ''): SessionPacket {
    const key = this.config.pairs[pair.id]!.key;
    const routing = {
      pairing: pair.id,
      sender: pair.device,
      recipient: pair.mobile,
      stream: this.stream,
      sequence: ++this.sequence,
    };
    return this.legacy(pair.id)
      ? sealLegacySession(key, routing, content, randomBytes)
      : sealSession(key, routing, peer, content, randomBytes);
  }

  private sendSession(pair: PairingRecord, content: Content): void {
    if (!this.linked(pair.id))
      throw new Error('This computer is not connected. Reopen the session.');
    this.client.send(SESSION_PACKET, this.seal(pair, content, this.phones.get(pair.id)?.stream));
  }

  async send(pair: PairingRecord, content: Content): Promise<void> {
    if (!activePair(this.config, pair)) return;
    if (content.type === 'thread-state') {
      const selected = this.selected.get(
        selectionKey(pair.id, content.projectId, content.thread.id),
      );
      if (
        !selected ||
        selected.project !== content.projectId ||
        selected.thread !== content.thread.id ||
        !this.visible(pair, content.thread)
      )
        return;
    }
    if (this.linked(pair.id)) this.sendSession(pair, content);
  }

  private async receiveSession(packet: SessionPacket): Promise<void> {
    const pair = this.activePairs().find((item) => item.id === packet?.pairing);
    if (
      !pair ||
      !this.isActive(pair.id) ||
      !this.ready.has(pair.id) ||
      packet.sender !== pair.mobile ||
      packet.recipient !== pair.device ||
      !/^[a-f0-9]{32}$/.test(packet.stream) ||
      !Number.isSafeInteger(packet.sequence) ||
      packet.sequence < 1
    )
      return;
    const key = this.config.pairs[pair.id]!.key;
    const modern = packet.v === SESSION_VERSION;
    const legacy = this.legacy(pair.id);
    if (!modern && !legacy) return;
    // What the relay said of a version 1 phone's streams does not judge its first version 2 packet.
    const phone = modern && legacy ? undefined : this.phones.get(pair.id);
    const last = phone?.seen.get(packet.stream);
    if (last !== undefined && (packet.stream !== phone!.stream || packet.sequence <= last)) return;
    let raw: Content;
    if (modern) {
      try {
        raw = openSession(key, packet, this.stream);
      } catch {
        // Not sealed to this stream: a hello to answer, or a packet from before a reconnect.
        if (opensHello(key, packet)) {
          this.upgrade(pair.id);
          this.client.send(SESSION_PACKET, this.seal(pair, { type: 'welcome' }, packet.stream));
        }
        return;
      }
      this.upgrade(pair.id);
    } else raw = openLegacySession(key, packet);
    const content = (
      raw.type === 'phone.watch'
        ? z
            .object({ type: z.literal('phone.watch'), active: z.boolean() })
            .strict()
            .parse(raw)
        : raw.type === 'phone.response'
          ? { type: 'phone.response', ...parsePhoneResponse(raw) }
          : raw.type === 'command'
            ? Command.parse(raw)
            : Controls.parse(raw)
    ) as Content;
    if (this.admit(pair.id, packet.stream, packet.sequence)) {
      this.dropPhone(pair.id);
      void this.publishQueueReceipts(pair.id);
    }
    try {
      if (content.type === 'phone.watch' || content.type === 'phone.response')
        return await this.phone.receive(pair.id, content);
      if (content.type === 'command') return await this.execute(pair, content);
      if (content.type === 'chat.attach' || content.type === 'chat.history') {
        const thread = this.discovery.projects
          .get(content.projectId)
          ?.threads.find((item) => item.id === content.threadId);
        if (!thread || !this.visible(pair, thread) || thread.agent?.harness === 'terminal')
          throw new Error('This conversation is no longer available.');
        const key = selectionKey(pair.id, content.projectId, content.threadId);
        const previous = this.selected.get(key);
        if (
          !previous &&
          [...this.selected.values()].filter((item) => item.pairing === pair.id).length >=
            GROUP_MEMBERS
        )
          throw new Error('Close another conversation before adding a participant.');
        const before = content.type === 'chat.history' ? content.before : undefined;
        if (before)
          chatPosition(
            this.config.pairs[pair.id]!.key,
            { project: content.projectId, thread: thread.id, updatedAt: thread.updatedAt },
            before,
          );
        const selected: Selected = {
          pairing: pair.id,
          project: content.projectId,
          thread: content.threadId,
          latest: !before,
          live: this.discovery.locations.get(thread.id)?.live,
        };
        this.selected.set(key, selected);
        if (previous?.live && !this.followed(previous.live)) previous.live.releaseMessages?.();
        try {
          await this.sendPage(
            pair,
            selected,
            before,
            content.type === 'chat.history' ? content.requestId : undefined,
          );
          await this.thread(pair, this.discovery.projects.get(content.projectId)!, thread);
        } catch (error) {
          if (this.selected.get(key) === selected) {
            if (previous) this.selected.set(key, previous);
            else this.removeSelected(key);
          }
          throw error;
        }
        return;
      }
      if (content.type === 'chat.detach') {
        this.removeSelected(selectionKey(pair.id, content.projectId, content.threadId));
        return;
      }
      if (content.type === 'open') {
        const request = `${pair.id}:${content.requestId}`;
        const known = this.opened.get(request);
        if (known) return this.sendSession(pair, known);
        const project = this.discovery.projects.get(content.projectId);
        if (!project) throw new Error('Project is no longer open on this computer.');
        if (project.remote) throw new Error('Pair the execution host to start its terminal.');
        const id = await this.terminals.open(
          pair.id,
          project.id,
          project.path,
          content.cols,
          content.rows,
        );
        const found = this.discovery.observe(this.terminals.session(id)!);
        const opened: Extract<Content, { type: 'opened' }> = {
          type: 'opened',
          requestId: content.requestId,
          projectId: found.project.id,
          threadId: found.thread.id,
          terminalId: id,
          thread: found.thread,
          project: this.projectOverview(found.project),
        };
        this.opened.set(request, opened);
        if (this.opened.size > 100) this.opened.delete(this.opened.keys().next().value!);
        this.sendSession(pair, opened);
        this.refreshOverview();
        return;
      }
      if ('terminalId' in content && content.terminalId) {
        const project = this.terminals.project(pair.id, content.terminalId);
        if (!project)
          throw new Error('This terminal belongs to another phone or is no longer available.');
        if (content.type === 'attach')
          return await this.terminals.follow(pair.id, project, content.terminalId);
        if (content.type === 'detach')
          return this.terminals.unfollow(pair.id, project, content.terminalId);
        if (content.type === 'close')
          return await this.terminals.close(pair.id, project, content.terminalId);
        if (content.type === 'input')
          return this.terminals.input(
            pair.id,
            project,
            content.terminalId,
            content.data,
            content.binary,
          );
        if (content.type === 'resize')
          return this.terminals.resize(
            pair.id,
            project,
            content.terminalId,
            content.cols,
            content.rows,
          );
      }
    } catch (error) {
      this.sendSession(pair, {
        type: 'error',
        ...('requestId' in content ? { requestId: content.requestId } : {}),
        ...('terminalId' in content ? { terminalId: content.terminalId } : {}),
        ...('projectId' in content ? { projectId: content.projectId } : {}),
        ...('threadId' in content ? { threadId: content.threadId } : {}),
        message: error instanceof Error ? error.message : 'Session operation failed.',
      });
    } finally {
      this.rotate(pair.id);
    }
  }

  // A selection follows a session through each listing of it that a refresh brings.
  private followed(live: LiveSession): boolean {
    return [...this.selected.values()].some(
      (item) => !!item.live && sessionKey(item.live) === sessionKey(live),
    );
  }

  private removeSelected(key: string): void {
    const live = this.selected.get(key)?.live;
    this.selected.delete(key);
    if (live && !this.followed(live)) live.releaseMessages?.();
  }

  private clearSelected(pairing?: string): void {
    for (const [key, selected] of this.selected)
      if (!pairing || selected.pairing === pairing) this.removeSelected(key);
  }

  private sendPage(
    pair: PairingRecord,
    selected: Selected,
    before?: string,
    requestId?: string,
  ): Promise<void> {
    if (selected.pending) return selected.pending;
    const work = (async () => {
      const thread = this.discovery.projects
        .get(selected.project)
        ?.threads.find((item) => item.id === selected.thread);
      if (!thread) return;
      const key = this.config.pairs[pair.id]?.key;
      if (!key) return;
      const target = { project: selected.project, thread: thread.id, updatedAt: thread.updatedAt };
      const live = this.discovery.locations.get(thread.id)?.live;
      const previous = selected.live;
      selected.live = live;
      if (previous && !this.followed(previous)) previous.releaseMessages?.();
      const { messages, more } = await this.discovery.read(
        thread,
        before ? chatPosition(key, target, before) : undefined,
      );
      if (
        this.selected.get(selectionKey(pair.id, selected.project, selected.thread)) !== selected ||
        !this.linked(pair.id)
      )
        return;
      const view = this.phoneMessages(pair, selected.project, selected.thread, messages);
      const page = chatPage(
        key,
        target,
        view.messages,
        before,
        requestId,
        live?.typing ?? '',
        more,
        view.requests,
      );
      const encoded = JSON.stringify({ ...page, requestId: undefined });
      if (!requestId && selected.page === encoded) return;
      selected.page = encoded;
      this.sendSession(pair, page);
      const origins = new Map(
        messages.map((message) => [historyMessageId(key, target, message.id), message.id]),
      );
      for (const message of page.messages) {
        const nativeId = origins.get(message.id)!;
        for (const file of [message.full, message.tool?.input, ...(message.attachments ?? [])]) {
          if (!file) continue;
          this.attachmentOrigins.delete(file.id);
          this.attachmentOrigins.set(file.id, {
            pairing: pair.id,
            project: selected.project,
            thread: selected.thread,
            message: nativeId,
          });
        }
      }
      while (this.attachmentOrigins.size > ATTACHMENT_ORIGINS)
        this.attachmentOrigins.delete(this.attachmentOrigins.keys().next().value!);
    })();
    selected.pending = work;
    void work
      .finally(() => {
        if (selected.pending === work) selected.pending = undefined;
      })
      .catch(() => {});
    return work;
  }

  private scheduleSelected(native: boolean): void {
    this.nativeDirty ||= native;
    if (this.stopped || this.selectedTimer) return;
    this.selectedTimer = setTimeout(() => {
      this.selectedTimer = undefined;
      void this.refreshSelected().catch((error) => this.report(error));
    }, SELECTED_MS);
    this.selectedTimer.unref();
  }

  private refreshSelected(): Promise<void> {
    if (this.selecting) return this.selecting;
    const native = this.nativeDirty;
    this.nativeDirty = false;
    this.selecting = (async () => {
      if (native) {
        const harnesses = new Set<Harness>();
        for (const selected of this.selected.values()) {
          const harness = this.discovery.projects
            .get(selected.project)
            ?.threads.find((thread) => thread.id === selected.thread)?.agent?.harness;
          if (harness && harness !== 'terminal') harnesses.add(harness);
        }
        await Promise.all([...harnesses].map((harness) => this.refreshNative(harness)));
      }
      await Promise.all(
        [...this.selected.values()].map(async (selected) => {
          const pair = this.activePairs().find((item) => item.id === selected.pairing);
          if (!pair || !this.linked(pair.id)) return;
          const project = this.discovery.projects.get(selected.project);
          const thread = project?.threads.find((item) => item.id === selected.thread);
          if (!project || !thread) return;
          try {
            if (selected.latest) await this.sendPage(pair, selected);
          } catch (error) {
            this.sendSession(pair, {
              type: 'error',
              projectId: selected.project,
              threadId: selected.thread,
              message:
                error instanceof Error ? error.message : 'Conversation updates are unavailable.',
            });
            return;
          }
          const state = this.threadState(project, thread);
          const encoded = JSON.stringify(state);
          if (selected.state !== encoded) {
            selected.state = encoded;
            await this.thread(pair, project, thread);
          }
        }),
      );
    })().finally(() => {
      this.selecting = undefined;
      if (this.nativeDirty) this.scheduleSelected(true);
    });
    return this.selecting;
  }

  private async refreshNative(harness: Harness): Promise<void> {
    const sessions = await this.harnesses.sessionsFor(harness);
    this.discovery.retire(sessions, harness);
    for (const session of sessions) this.observe(session);
    this.refreshOverview();
  }

  private observe(session: import('./harness/session').LiveSession): void {
    const { project, thread } = this.discovery.observe(session);
    const prior = this.nativeSnapshots.get(thread.id);
    this.nativeSnapshots.set(thread.id, {
      status: thread.status,
      approvals: new Set(session.approvals.map((approval) => approval.id)),
    });
    for (const approval of session.approvals)
      if (!prior?.approvals.has(approval.id))
        void this.attention(
          project.id,
          thread.id,
          approval.title,
          approval.detail,
          'approval',
          approval.id,
        );
    if (session.harness !== 'terminal' && prior?.status === 'working' && thread.status === 'idle')
      void this.attention(
        project.id,
        thread.id,
        thread.title,
        'The agent finished its turn.',
        'complete',
      );
  }

  private scheduleCatalogue(): void {
    if (this.stopped || this.catalogueTimer) return;
    this.catalogueTimer = setTimeout(
      () => {
        this.catalogueTimer = undefined;
        void this.changed().catch((error) => this.report(error));
      },
      Math.max(0, CATALOG_MS - (Date.now() - this.lastCatalogue)),
    );
    this.catalogueTimer.unref();
  }

  private changed(): Promise<void> {
    if (this.cataloguing) return this.cataloguing;
    this.cataloguing = (async () => {
      if (this.stopped) return;
      this.lastCatalogue = Date.now();
      const current = [...(await this.harnesses.refresh()), ...this.terminals.list()];
      this.discovery.retire(current);
      // Each thread the scan makes starts read-only, so nothing awaits until all have their controls.
      this.discovery.scan();
      this.refreshQueues();
      for (const session of current) this.observe(session);
      for (const agent of this.agents.values())
        if (!agent.socket.destroyed) this.discovery.adopt(agent);
      for (const id of this.nativeSnapshots.keys())
        if (!this.discovery.locations.has(id)) this.nativeSnapshots.delete(id);
      this.refreshUsage();
      this.stopWatching();
      this.stopWatching = this.discovery.watch(() => {
        this.scheduleSelected(false);
        this.scheduleCatalogue();
      });
      this.refreshOverview();
      this.scheduleSelected(false);
      await this.publishQueueReceipts();
    })().finally(() => {
      this.cataloguing = undefined;
    });
    return this.cataloguing;
  }

  private terminalChanged(id: string): void {
    const session = this.terminals.session(id);
    if (session && !this.stopped) {
      this.discovery.observe(session);
      this.refreshOverview();
    }
  }
  private visible(pair: PairingRecord | undefined, thread: ThreadSummary): boolean {
    return (
      thread.agent?.harness !== 'terminal' ||
      (!!pair && this.terminals.owns(thread.agent.sessionId, pair.id))
    );
  }
  private projectOverview({ threads, ...project }: ProjectSummary): ProjectOverview {
    const started = threads.filter((thread) => !thread.parent);
    return {
      ...project,
      active: started.reduce(
        (newest, thread) => (thread.updatedAt > newest ? thread.updatedAt : newest),
        '',
      ),
      started: started.length,
    };
  }
  private compact(thread: ThreadSummary): ThreadSummary {
    const { options, step, ...card } = thread;
    return { ...card, title: card.title.slice(0, 160) };
  }

  private overview(pair: PairingRecord): Dashboard {
    const projects = [...this.discovery.projects.values()]
      .map((project) => ({
        ...project,
        threads: project.threads.filter((thread) => this.visible(pair, thread)),
      }))
      .filter((project) => project.threads.length);
    const sessions = projects
      .flatMap((project) =>
        project.threads.map((thread) => ({
          projectId: project.id,
          thread: this.compact(thread),
          attention: this.attentionFor(thread),
        })))
      .sort((a, b) => {
        const busy = (thread: ThreadSummary) =>
          thread.status === 'working' || thread.status === 'attention';
        return (
          Number(busy(b.thread)) - Number(busy(a.thread)) ||
          b.thread.updatedAt.localeCompare(a.thread.updatedAt)
        );
      })
      .slice(0, HOME_RECENT);
    const byId = new Map(projects.map((project) => [project.id, this.projectOverview(project)]));
    const cards = [
      ...new Map([
        ...sessions.map((session) => [session.projectId, byId.get(session.projectId)!] as const),
        ...[...byId].sort(([, a], [, b]) => b.active.localeCompare(a.active)),
      ]).values(),
    ].slice(0, PROJECT_CARDS);
    const dashboard: Dashboard = {
      updatedAt: '',
      version,
      session: SESSION_VERSION,
      features: ['terminal', 'workspace', 'uploads', 'attention'],
      projects: cards,
      sessions,
      agents: this.startable,
      models: Object.fromEntries(
        this.startable.map((harness) => [harness, this.harnesses.startModels(harness)]),
      ),
      folders: this.discovery.folders(),
      usage: this.usage.map(({ identity, ...login }) => login),
    };
    while (
      Buffer.byteLength(JSON.stringify({ type: 'dashboard', dashboard })) + 256 >
      DASHBOARD_BYTES
    ) {
      const referenced = new Set(dashboard.sessions.map((session) => session.projectId));
      let removable = dashboard.projects.length - 1;
      while (removable >= 0 && referenced.has(dashboard.projects[removable]!.id)) removable--;
      if (removable >= 0) dashboard.projects.splice(removable, 1);
      else if (dashboard.sessions.length) dashboard.sessions.pop();
      else {
        dashboard.projects = [];
        dashboard.usage = [];
        dashboard.models = {};
        dashboard.folders = [];
        break;
      }
    }
    return dashboard;
  }

  private refreshOverview(): void {
    this.notifications.refresh();
    if (this.stopped || this.dashboardTimer) return;
    this.dashboardTimer = setTimeout(() => {
      this.dashboardTimer = undefined;
      for (const pair of this.activePairs()) this.publishDashboard(pair);
    }, 100);
    this.dashboardTimer.unref();
  }

  private publishDashboard(pair: PairingRecord): void {
    if (!activePair(this.config, pair)) return;
    const dashboard = this.overview(pair);
    const text = JSON.stringify(dashboard);
    if (this.dashboardText.get(pair.id) === text) return;
    this.dashboardText.set(pair.id, text);
    dashboard.updatedAt = new Date().toISOString();
    const local = this.config.pairs[pair.id]!;
    const envelope = seal(
      local.key,
      {
        id: newSecret(randomBytes),
        pairing: pair.id,
        sender: pair.device,
        recipient: pair.mobile,
        channel: 'dashboard',
        project: '',
        sequence: ++local.sequence,
        sentAt: dashboard.updatedAt,
      },
      { type: 'dashboard', dashboard },
      randomBytes,
    );
    this.dashboards.set(pair.id, envelope);
    saveConfig(this.config);
    void this.flushDashboard(pair.id);
  }

  private async flushDashboard(id: string): Promise<void> {
    if (this.publishing.has(id)) return;
    this.publishing.add(id);
    try {
      while (!this.stopped && this.dashboards.has(id)) {
        const envelope = this.dashboards.get(id)!;
        this.dashboards.delete(id);
        try {
          await api(this.config, '/dashup/dashboard', { envelope });
        } catch (error) {
          if (!this.dashboards.has(id)) this.dashboards.set(id, envelope);
          this.report(error);
          clearTimeout(this.retry);
          this.retry = setTimeout(() => {
            for (const id of this.dashboards.keys()) void this.flushDashboard(id);
          }, 5000);
          this.retry.unref();
          break;
        }
      }
    } finally {
      this.publishing.delete(id);
    }
  }

  // Agents get installed and update themselves while Dashup runs.
  private async findAgents(): Promise<void> {
    if (Date.now() - this.agentsAt < AGENTS_MS) return;
    this.agentsAt = Date.now();
    this.startable = await this.harnesses.agents();
    this.discovery.refresh();
    this.refreshOverview();
  }
  private refreshUsage(): void {
    if (Date.now() - this.usageAt < USAGE_MS) return;
    this.usageAt = Date.now();
    const histories = [...this.discovery.locations.values()].flatMap(
      (location) => location.history ?? [],
    );
    void planUsage(histories).then((usage) => {
      if (this.stopped) return;
      this.usage = usage;
      this.usageReady = true;
      this.armUsageResets();
      this.refreshOverview();
    });
  }

  private resetReceipt(pairing: string, event: UsageResetEvent): string {
    return opaque(this.config.localSecret, ['usage-reset', pairing, event.id]);
  }

  private pruneResetReceipts(): void {
    const receipts = this.config.usageResetReceipts!;
    for (const [id, expires] of Object.entries(receipts))
      if (!Number.isFinite(expires) || expires <= Date.now()) delete receipts[id];
    const entries = Object.entries(receipts).sort((a, b) => b[1] - a[1]);
    for (const [id] of entries.slice(RECEIPTS)) delete receipts[id];
  }

  private armUsageResets(): void {
    this.pruneResetReceipts();
    const events = usageResetEvents(this.usage);
    for (const pair of this.activePairs()) {
      this.notifications.changed(pair.id, true);
      if (!(this.config.pairs[pair.id]?.attention ?? DEFAULT_NOTIFICATION_POLICY).usageResets)
        continue;
      for (const event of events)
        if (!this.config.usageResetReceipts![this.resetReceipt(pair.id, event)])
          void this.notifications.push(pair.id, event).catch((error) => this.report(error));
    }
  }

  private sessionList(
    pair: PairingRecord,
    projectId: string,
    action: Extract<CommandAction, { kind: 'sessions.list' }>,
  ): Pick<SessionResult, 'sessions' | 'next' | 'projects'> {
    const query = action.query?.trim().toLowerCase();
    const found = [...this.discovery.projects.values()]
      .filter((project) => !projectId || project.id === projectId)
      .flatMap((project) =>
        project.threads
          .filter(
            (thread) =>
              this.visible(pair, thread) &&
              (!action.parent || thread.parent === action.parent) &&
              (!query || `${thread.title} ${project.name}`.toLowerCase().includes(query)),
          )
          .map((thread) => ({ project, thread })))
      .sort(
        (a, b) =>
          b.thread.updatedAt.localeCompare(a.thread.updatedAt) ||
          a.thread.id.localeCompare(b.thread.id),
      );
    const edge = action.cursor
      ? found.findIndex((item) => item.thread.id === action.cursor) + 1
      : 0;
    if (action.cursor && !edge) throw new Error('This session list changed. Load it again.');
    const page = found.slice(edge, edge + SESSION_ITEMS);
    const result = () => ({
      sessions: page.map(({ project, thread }) => ({
        ...this.compact(thread),
        projectId: project.id,
      })),
      next: edge + page.length < found.length ? (page.at(-1)?.thread.id ?? null) : null,
      projects: [
        ...new Map(page.map(({ project }) => [project.id, this.projectOverview(project)])).values(),
      ],
    });
    while (page.length && Buffer.byteLength(JSON.stringify(result())) > SESSION_BYTES) page.pop();
    if (!page.length && found.length > edge)
      throw new Error('Session metadata is too large. Open it on your computer.');
    return result();
  }

  private async sendingMessage(
    pair: PairingRecord,
    command: SessionCommand,
    text: string,
    originalLength: number,
  ): Promise<void> {
    const receipt = this.config.receipts![`${pair.id}:${command.requestId}`];
    const thread = this.discovery.projects
      .get(command.projectId)
      ?.threads.find((item) => item.id === command.threadId);
    if (!receipt || !thread) return;
    let messages: readonly Message[];
    try {
      const page = await this.discovery.read(thread);
      if (!page.messages.length && page.more) return;
      messages = page.messages;
    } catch {
      // An unreadable baseline cannot prove which later message belongs to this handoff.
      return;
    }
    receipt.at = Math.max(
      Date.now(),
      ...Object.values(this.config.receipts!)
        .filter((item) => item.message)
        .map((item) => item.at + 1),
    );
    receipt.message = {
      thread: thread.id,
      before: messages.at(-1)?.id,
      hash: opaque(this.config.localSecret, ['sent-message', text.trim()]),
      originalLength,
    };
    saveConfig(this.config);
  }

  private sentMessages(
    pair: PairingRecord,
    project: string,
    thread: string,
    messages: readonly Message[],
  ): ReadonlyMap<string, string> {
    // Every phone shares this native history. Assign each native message once, in actual handoff
    // order, then reveal only the current phone's request identity.
    const receipts = Object.entries(this.config.receipts!)
      .filter(([, receipt]) => receipt.project === project && receipt.message?.thread === thread)
      .sort((a, b) => a[1].at - b[1].at);
    const used = new Set(
      receipts.flatMap(([, receipt]) => (receipt.message?.id ? [receipt.message.id] : [])),
    );
    let changed = false;
    for (const [id, receipt] of receipts) {
      const message = receipt.message!;
      if (message.id) continue;
      const result = receipt.result;
      const queue = result?.queue;
      const knownId = queue?.clientUserMessageId;
      const request = id.slice(receipt.pairing.length + 1);
      const exact = messages.find(
        (item) =>
          item.role === 'user' &&
          !used.has(item.id) &&
          (item.requestId === request || (!!knownId && item.id === knownId)),
      );
      if (!exact && !result?.ok) continue;
      const before = message.before ? messages.findIndex((item) => item.id === message.before) : -1;
      if (!exact && message.before && before < 0) continue;
      const found =
        exact ??
        messages
          .slice(before + 1)
          .find(
            (item) =>
              item.role === 'user' &&
              !used.has(item.id) &&
              opaque(this.config.localSecret, ['sent-message', item.text.trim()]) === message.hash,
          );
      if (found) {
        message.id = found.id;
        used.add(found.id);
        changed = true;
      }
    }
    if (changed) saveConfig(this.config);
    return new Map(
      receipts.flatMap(([id, receipt]) =>
        receipt.pairing === pair.id && receipt.message?.id
          ? [[receipt.message.id, id.slice(pair.id.length + 1)] as const]
          : []),
    );
  }

  // Only a proven phone handoff hides the connector's appended file instructions. Native history
  // stays authoritative; an edited, unconfirmed or unrelated message is shown exactly as stored.
  private phoneMessages(
    pair: PairingRecord,
    project: string,
    thread: string,
    messages: readonly Message[],
  ) {
    const requests = this.sentMessages(pair, project, thread, messages);
    return {
      requests,
      messages: messages.map((message) => {
        const request = requests.get(message.id);
        const proof = request
          ? this.config.receipts?.[`${pair.id}:${request}`]?.message
          : undefined;
        const length = proof?.originalLength;
        return message.role === 'user' &&
          proof &&
          typeof length === 'number' &&
          Number.isSafeInteger(length) &&
          length >= 0 &&
          length < message.text.length &&
          opaque(this.config.localSecret, ['sent-message', message.text.trim()]) === proof.hash
          ? { ...message, text: message.text.slice(0, length) }
          : message;
      }),
    };
  }

  private async execute(pair: PairingRecord, content: SessionCommand): Promise<void> {
    const durable = [
      'session.start',
      'thread.send',
      'thread.queue',
      'thread.stop',
      'thread.configure',
      'approval.respond',
      'workspace.check',
    ].includes(content.action.kind);
    const key = `${pair.id}:${content.requestId}`;
    const known = durable ? this.config.receipts![key] : undefined;
    if (known) {
      const queue =
        this.config.queued![content.requestId]?.pairing === pair.id
          ? this.nativeQueue.reconcile(content.requestId)
          : undefined;
      return this.send(pair, {
        type: 'result',
        requestId: content.requestId,
        ...(queue
          ? { ok: queue.state !== 'unknown', queue }
          : (known.result ?? {
              ok: false,
              error:
                'The previous handoff is unconfirmed. Review the native session before sending a new request.',
            })),
      });
    }
    const receipt = durable
      ? ({ pairing: pair.id, project: content.projectId, at: Date.now() } as NonNullable<
          ConnectorConfig['receipts']
        >[string])
      : undefined;
    if (receipt) {
      if (Object.keys(this.config.receipts!).length >= RECEIPTS) {
        const completed = Object.entries(this.config.receipts!)
          .filter(([id, item]) => {
            const queue = this.config.queued![id.slice(item.pairing.length + 1)];
            return (
              item.result && (!queue || ['delivered', 'responded'].includes(queue.receipt.state))
            );
          })
          .sort((a, b) => a[1].at - b[1].at);
        if (!completed.length)
          throw new Error(
            'Previous requests are still unconfirmed. Review the native sessions before continuing.',
          );
        const [id, prior] = completed[0]!;
        delete this.config.queued![id.slice(prior.pairing.length + 1)];
        delete this.config.receipts![id];
      }
      this.config.receipts![key] = receipt;
      saveConfig(this.config);
    }
    let result: SessionResult;
    try {
      const outcome = await this.command(pair, content);
      result = { type: 'result', requestId: content.requestId, ok: true };
      if (outcome) {
        if ('state' in outcome) {
          result.queue = outcome;
          result.ok = outcome.state !== 'unknown';
        } else if ('projectId' in outcome) {
          result.started = outcome;
          const project = this.discovery.projects.get(outcome.projectId);
          const thread = project?.threads.find((item) => item.id === outcome.threadId);
          if (thread && project) {
            result.thread = thread;
            result.project = this.projectOverview(project);
          }
        } else Object.assign(result, outcome);
      }
    } catch (error) {
      result = {
        type: 'result',
        requestId: content.requestId,
        ok: false,
        error: error instanceof Error ? error.message : 'Command failed.',
      };
    }
    if (receipt) {
      receipt.result = {
        ok: result.ok,
        ...(result.error ? { error: result.error.slice(0, 500) } : {}),
        ...(result.queue ? { queue: result.queue } : {}),
        ...(result.started ? { started: result.started } : {}),
      };
      saveConfig(this.config);
    }
    await this.send(pair, result);
    if (durable) {
      this.scheduleSelected(true);
      this.refreshOverview();
    }
  }

  private async publishQueueReceipts(reconnected?: string): Promise<void> {
    for (const [requestId, pending] of Object.entries(this.config.queued!)) {
      if (reconnected && pending.pairing !== reconnected) continue;
      const pair = this.activePairs().find((item) => item.id === pending.pairing);
      if (!pair || !this.linked(pair.id)) continue;
      const queue = this.nativeQueue.reconcile(requestId);
      const encoded = JSON.stringify(queue);
      if (!reconnected && this.queueReceipts.get(requestId) === encoded) continue;
      await this.send(pair, { type: 'result', requestId, ok: queue.state !== 'unknown', queue });
      this.queueReceipts.set(requestId, encoded);
    }
  }

  // An alert that names no conversation is for the one `alertThread` picks in its project.
  async attention(
    projectId: string,
    threadId: string,
    title: string,
    body: string,
    reason: Attention['reason'] = 'input',
    approvalId?: string,
  ): Promise<void> {
    const threads = this.discovery.projects.get(projectId)?.threads;
    const thread = threadId
      ? threads?.find((thread) => thread.id === threadId)
      : threads && alertThread(threads);
    if (!thread)
      throw new Error(
        threads && !threadId
          ? 'No conversation in this project is waiting for you. Name one with --thread to alert about it anyway.'
          : 'Choose an existing project from dashup projects',
      );
    const event: Attention = {
      type: 'attention',
      projectId,
      threadId: thread.id,
      title: title.slice(0, 200),
      body: body.slice(0, 1000),
      reason,
      ...(approvalId ? { approvalId } : {}),
    };
    this.currentAttention.set(thread.id, { event, updatedAt: thread.updatedAt });
    if (this.currentAttention.size > ATTENTION_ITEMS)
      this.currentAttention.delete(this.currentAttention.keys().next().value!);
    this.refreshOverview();
    this.scheduleSelected(false);
    for (const pair of this.activePairs())
      if (this.visible(pair, thread)) await this.notifications.push(pair.id, event);
  }

  private attentionFor(
    thread: ThreadSummary,
  ): import('@dashup/protocol').SessionAttention | undefined {
    const current = this.currentAttention.get(thread.id);
    if (!current) return;
    const native = this.discovery.locations.get(thread.id)?.live;
    const agent = this.attached(thread);
    const approvals = native?.approvals ?? (agent ? [...agent.approvals.values()] : undefined);
    // An approval asks until the session no longer holds it, however its transcript moves on;
    // any other ask lasts until the thread's next message.
    const asking =
      current.event.approvalId && approvals
        ? approvals.some((approval) => approval.id === current.event.approvalId)
        : current.updatedAt === thread.updatedAt;
    if (!asking) {
      this.currentAttention.delete(thread.id);
      return;
    }
    const { reason, title, body } = current.event;
    return { reason, title, body };
  }

  attach(socket: Duplex): void {
    const sessions = bridgeAcp(socket, (session, approval) => {
      this.agents.set(session.id, session);
      const { project, thread } = this.discovery.adopt(session);
      this.refreshOverview();
      this.scheduleSelected(false);
      if (approval)
        void this.attention(
          project.id,
          thread.id,
          approval.title,
          approval.detail,
          'approval',
          approval.id,
        ).catch((error) => this.report(error));
    });
    socket.once('close', () => {
      for (const [id, agent] of sessions) {
        if (this.agents.get(id) !== agent) continue;
        this.agents.delete(id);
        this.discovery.adopt(agent, false);
      }
      this.refreshOverview();
      this.scheduleSelected(false);
    });
  }

  private attached(thread: ThreadSummary): AcpSession | undefined {
    return this.discovery.locations.get(thread.id)?.acp;
  }
  private threadState(project: ProjectSummary, thread: ThreadSummary): ThreadState {
    const location = this.discovery.locations.get(thread.id);
    const native = location?.live;
    const agent = this.attached(thread);
    let context = native?.context !== undefined ? native.context : agent?.context;
    if (context === undefined)
      try {
        context = location?.history?.context?.();
      } catch {
        // A native history can disappear between discovery and opening its thread.
      }
    return {
      type: 'thread-state',
      projectId: project.id,
      thread,
      approvals: native?.approvals ?? (agent ? [...agent.approvals.values()] : []),
      attention: this.attentionFor(thread),
      context: context ?? undefined,
    };
  }
  private thread(
    pair: PairingRecord,
    project: ProjectSummary,
    thread: ThreadSummary,
  ): Promise<void> {
    const state = this.threadState(project, thread);
    return this.send(pair, { ...state, thread: this.recorded(state.thread) });
  }

  invite(): Invitation {
    const invite = invitation(this.config);
    this.invitations.set(invite.code, invite.key);
    setTimeout(() => this.invitations.delete(invite.code), PAIRING_TTL_MS).unref();
    return invite;
  }
  stop(): void {
    this.stopped = true;
    this.phone.disconnect();
    this.clearSelected();
    this.attachmentOrigins.clear();
    this.stopWatching();
    this.stopHarnesses();
    clearInterval(this.heartbeat);
    clearTimeout(this.catalogueTimer);
    clearTimeout(this.selectedTimer);
    clearTimeout(this.dashboardTimer);
    clearTimeout(this.retry);
    this.client.disconnect();
    this.notifications.stop();
    this.terminals.stop();
    this.workspace.stop();
    this.harnesses.stop();
    this.nativeQueue.stop();
    for (const agent of this.agents.values()) agent.socket.destroy();
  }
  private async command(
    pair: PairingRecord,
    command: Extract<Content, { type: 'command' }>,
  ): Promise<
    | void
    | QueueReceipt
    | Started
    | Pick<SessionResult, 'workspace' | 'sessions' | 'next' | 'projects'>
  > {
    if (command.action.kind === 'notifications.configure') {
      this.config.pairs[pair.id]!.attention = parseNotificationPolicy(command.action.policy);
      saveConfig(this.config);
      this.notifications.changed(pair.id);
      this.armUsageResets();
      return;
    }
    if (command.action.kind === 'projects.refresh') {
      this.scheduleCatalogue();
      this.refreshOverview();
      return;
    }
    if (command.action.kind === 'sessions.list')
      return this.sessionList(pair, command.projectId, command.action);
    if (command.action.kind === 'session.start') {
      const prompt = await receiveUploads(
        this.config,
        pair,
        command.action.text,
        command.action.attachments,
      );
      return this.startSession(
        command.projectId,
        { ...command.action, text: prompt.text },
        prompt.files,
      );
    }
    const project = this.discovery.projects.get(command.projectId);
    if (!project) throw new Error('Project is no longer open on this computer');
    const thread = project.threads.find((item) => item.id === command.threadId);
    if (thread && !this.visible(pair, thread))
      throw new Error('This terminal belongs to another paired phone.');
    if (command.action.kind.startsWith('workspace.') && project.remote)
      throw new Error('Install Dashup on the remote host to use its workspace and terminal.');
    switch (command.action.kind) {
      case 'workspace.read':
        return { workspace: await this.workspace.inspect(project.path, command.action.baseline) };
      case 'workspace.check':
        return { workspace: await this.workspace.check(project.path, command.action.command) };
      case 'attachment.read': {
        if (!thread) throw new Error('Thread not found');
        const origin = this.attachmentOrigins.get(command.action.id);
        if (
          origin &&
          (origin.pairing !== pair.id ||
            origin.project !== project.id ||
            origin.thread !== thread.id)
        )
          throw new Error('This attachment belongs to another conversation.');
        const { messages } = await this.discovery.read(thread, origin?.message);
        return shareAttachment(
          this.config,
          pair,
          project.id,
          thread.id,
          this.phoneMessages(pair, project.id, thread.id, messages).messages,
          command.action.id,
        );
      }
      case 'thread.send': {
        if (thread?.agent?.harness === 'terminal')
          throw new Error('Use the live terminal connection.');
        const prompt = await receiveUploads(
          this.config,
          pair,
          command.action.text,
          command.action.attachments,
        );
        if (!thread || !thread.capabilities.send)
          throw new Error(
            'This session has no live reply connection. Use the existing agent on your computer.',
          );
        const location = this.discovery.locations.get(thread.id);
        await this.sendingMessage(pair, command, prompt.text, command.action.text.length);
        if (location?.live?.send)
          return location.live.send(
            command.requestId,
            prompt.text,
            command.action.now,
            prompt.files,
          );
        const agent = this.attached(thread);
        const saved = thread.agent;
        if (!agent && !location?.live && location?.history?.resumable === false)
          throw new Error(
            'This saved session has no verified reply owner. Continue it on your computer.',
          );
        if (!agent && location?.history && saved && isStartHarness(saved.harness)) {
          if (saved.harness === 'codex') {
            this.nativeQueue.refresh();
            if (writerOwner(this.nativeQueue.writers, location.history))
              throw new Error(
                queueOwner(this.nativeQueue.owners, location.history)
                  ? 'This Codex session is open on your computer. Queue a reply or continue it there.'
                  : 'This Codex session is open on your computer. Continue it there.',
              );
          }
          await this.harnesses.resume(
            saved.harness,
            saved.sessionId,
            project.path,
            prompt.text,
            prompt.files,
          );
          await this.refreshNative(saved.harness);
          return;
        }
        if (!agent || agent.socket.destroyed || agent.status === 'working')
          throw new Error('Wait for the current ACP turn to finish');
        return commandAcp(agent, command.requestId, { kind: 'prompt', text: prompt.text });
      }
      case 'thread.stop': {
        const native = thread && this.discovery.locations.get(thread.id)?.live;
        if (native?.stop) return native.stop(command.requestId);
        const agent = thread && this.attached(thread);
        if (!agent || agent.socket.destroyed)
          throw new Error(
            'This session has no live connection that can stop it. Stop the agent on your computer.',
          );
        return commandAcp(agent, command.requestId, { kind: 'cancel' });
      }
      case 'thread.configure': {
        const { option, value } = command.action;
        const native = thread && this.discovery.locations.get(thread.id)?.live;
        const known = thread?.options?.find((item) => item.id === option);
        const agent = thread && this.attached(thread);
        if ((!native?.configure && (!agent || agent.socket.destroyed)) || !known || known.readOnly)
          throw new Error('This session can only be changed on your computer.');
        if (
          typeof value !== typeof known.value ||
          (known.choices && !known.choices.some((choice) => choice.value === value))
        )
          throw new Error(`${known.name} can't be set to that.`);
        if (agent?.options.some((item) => item.id === option))
          return commandAcp(agent, command.requestId, { kind: 'configure', option, value });
        if (!native?.configure) throw new Error('This option is no longer available.');
        return native.configure(command.requestId, option, value);
      }
      case 'thread.queue': {
        if (!thread) throw new Error('Thread not found');
        this.nativeQueue.refresh();
        const owner = queueOwner(
          this.nativeQueue.owners,
          this.discovery.locations.get(thread.id)?.history,
        );
        if (!owner) throw new Error('This exact native conversation has no supported queue owner');
        const prompt = await receiveUploads(
          this.config,
          pair,
          command.action.text,
          command.action.attachments,
        );
        await this.sendingMessage(pair, command, prompt.text, command.action.text.length);
        return this.nativeQueue.submit(
          command.requestId,
          {
            pairing: pair.id,
            project: project.id,
            thread: thread.id,
            owner,
          },
          prompt.text,
        );
      }
      case 'approval.respond': {
        if (!thread) throw new Error('Thread not found');
        const { kind, approvalId, ...reply } = command.action;
        const native = this.discovery.locations.get(thread.id)?.live;
        if (native?.approve) {
          const approval = native.approvals.find((item) => item.id === approvalId);
          if (!approval || !answers(approval, reply))
            throw new Error('Approval is no longer available');
          return native.approve(command.requestId, approval.id, reply);
        }
        const agent = this.attached(thread);
        if (!agent)
          throw new Error('Approval requires an attached ACP session. Answer it on your computer.');
        const [request, approval] =
          [...agent.approvals].find(([, item]) => item.id === approvalId) ?? [];
        if (!approval || !('choice' in reply) || !answers(approval, reply))
          throw new Error('Approval is no longer available');
        return commandAcp(agent, command.requestId, {
          kind: 'approval',
          id: request,
          choice: reply.choice,
        });
      }
    }
  }

  // Starts an agent in a project, or in a new folder inside one this computer offers. Commands run
  // in the work queue, so this refreshes directly rather than queueing a change behind itself.
  private async startSession(
    projectId: string,
    { harness, text, folder, workspace, model }: Extract<CommandAction, { kind: 'session.start' }>,
    files?: InputFile[],
  ): Promise<Started> {
    if (!this.startable.includes(harness))
      throw new Error(`${HARNESSES[harness]} doesn't run on this computer`);
    if (model && !this.harnesses.startModels(harness).some((choice) => choice.value === model))
      throw new Error('That model is no longer offered by this agent. Choose a model again.');
    let cwd: string;
    if (folder) {
      const name = folder.name.trim();
      if (!this.discovery.folders().includes(folder.parent))
        throw new Error('That folder is no longer offered for new projects');
      if (!name || name === '.' || name === '..' || /[\\/:*?"<>|\x00-\x1f]/.test(name))
        throw new Error('Name the folder without slashes or special characters');
      cwd = join(folder.parent, name);
      await mkdir(cwd).catch((error: NodeJS.ErrnoException) => {
        throw new Error(
          error.code === 'EEXIST' ? `${name} already exists` : `Couldn't create ${name}`,
        );
      });
    } else {
      const project = this.discovery.projects.get(projectId);
      if (!project) throw new Error('Project is no longer open on this computer');
      if (project.remote)
        throw new Error(`Install -up on ${project.remote.host} to start sessions there`);
      cwd = project.path;
    }
    if (workspace) cwd = await this.workspace.target(cwd, workspace);
    const session = await this.harnesses.start(harness, cwd, text, files, model);
    await this.refreshNative(harness);
    for (const project of this.discovery.projects.values())
      for (const thread of project.threads)
        if (thread.agent?.harness === harness && thread.agent.sessionId === session)
          return { projectId: project.id, threadId: thread.id };
    throw new Error(`${HARNESSES[harness]} started, but this computer has not listed it yet.`);
  }

  // Who owns each saved session's native queue and rollout is read again, and every thread nothing
  // holds shows it.
  private refreshQueues(): void {
    this.nativeQueue.refresh();
    this.discovery.refresh();
  }

  // A thread no live session holds shows what its record says it last ran with, without the
  // choices only a live session takes. Only its own state carries them: a project's snapshot
  // holds every thread.
  private recorded(thread: ThreadSummary): ThreadSummary {
    const settings =
      thread.options || !thread.agent
        ? undefined
        : this.discovery.locations.get(thread.id)?.history?.settings?.();
    if (!settings) return thread;
    const options = this.harnesses
      .recorded(thread.agent!.harness, settings)
      .map((option) =>
        option.choices
          ? { ...option, choices: option.choices.filter((choice) => choice.value === option.value) }
          : option);
    return options.length ? { ...thread, options } : thread;
  }

  private report(error: unknown): void {
    process.stderr.write(`${error instanceof Error ? error.message : 'Dashup operation failed'}\n`);
  }
}
