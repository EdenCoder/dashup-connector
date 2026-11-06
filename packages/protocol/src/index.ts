import type { WorkspaceTarget } from './workspace';
import type { NotificationPolicy } from './attention';
export type { Workspace, WorkspaceTarget } from './workspace';
export type { NotificationPolicy } from './attention';

// =============================================================================
// Product and wire version
// =============================================================================

// `storeProduct` is the subscription's product id in both the App Store and Google Play.
export const PRODUCT = {
  name         : 'Dashup',
  shorthand    : '-up',
  app          : 'com.dashup.mobile',
  site         : 'https://dashup.com',
  api          : 'https://api.dashup.com',
  support      : 'support@dashup.com',
  currency     : 'USD',
  trialDays    : 14,
  monthlyPrice : 10,
  storeProduct : 'dashup.monthly',
} as const;

export const PAIRING_TTL_MS     = 5 * 60_000;
export const PROTOCOL_VERSION   = 1;

// =============================================================================
// Billing
// =============================================================================

// Stripe, the App Store and Google Play each own the subscriptions they bill; `subscription` is
// the account's one that has not ended. Only a first subscription gets Stripe's free trial, while
// the stores decide their own. Store purchases carry `accountToken`, so only this account can
// claim them.
export type BillingStatus = {
  trial        : boolean;
  accountToken : string;
  subscription : {
    provider  : 'stripe' | 'apple' | 'google';
    status    : 'trialing' | 'active' | 'past_due' | 'unpaid' | 'paused';
    periodEnd : string;
    cancelAt  : string | null;
  } | null;
};

// =============================================================================
// Native conversation previews
// =============================================================================

export const HISTORY_TEXT_CHARS              = 4_000;
// A tool step's name, label and input summary each fit this.
export const HISTORY_TOOL_CHARS              = 500;

export const MAX_ATTACHMENT_BYTES  = 8 * 1024 * 1024;
export const ATTACHMENT_NAME_CHARS = 100;

export type HistoryMessage = Message;

// =============================================================================
// Encrypted dashboard
// =============================================================================

export type Platform = 'windows' | 'macos' | 'linux' | 'ios' | 'android';
export type Editor   = 'zed' | 'vscode' | 'cli' | 'acp' | 'accessibility';

export const MESSAGE_ROLES = ['user', 'assistant', 'system', 'tool'] as const;

export const HARNESSES = {
  t3       : 'T3 Code',
  orca     : 'Orca',
  pi       : 'Pi',
  kilo     : 'Kilo Code',
  cline    : 'Cline',
  junie    : 'Junie',
  claude   : 'Claude Code',
  codex    : 'Codex',
  kimi     : 'Kimi',
  opencode : 'OpenCode',
  other    : 'Agent',
  terminal : 'Terminal',
} as const;

export type Harness = keyof typeof HARNESSES;
// A live bridge can follow an agent without being allowed to launch another instance of it.
export const START_HARNESSES = [
  'claude',
  'codex',
  'kimi',
  'opencode',
  'kilo',
  'junie',
] as const satisfies readonly Harness[];
export type StartHarness = (typeof START_HARNESSES)[number];
export const isStartHarness = (harness: Harness): harness is StartHarness =>
  START_HARNESSES.some((candidate) => candidate === harness);

export type AgentSession = {
  harness   : Harness;
  sessionId : string;
};

// What a computer's QR code gives the phone. `computer` is the SHA-256 of the secret the computer
// signs in with, `code` names the pairing the phone makes, and `key` stays on the two devices.
export type PairingCode = {
  api      : string;
  computer : string;
  code     : string;
  key      : string;
};

export type Envelope = {
  v          : typeof PROTOCOL_VERSION;
  id         : string;
  pairing    : string;
  sender     : string;
  recipient  : string;
  channel    : 'dashboard';
  project    : string;
  sequence   : number;
  sentAt     : string;
  nonce      : string;
  ciphertext : string;
};

// `now`: a reply can stop what the agent is doing and be taken at once. `configure`: the
// thread's options can be changed.
export type Capabilities = {
  read       : boolean;
  send       : boolean;
  queue?     : boolean;
  stop?      : boolean;
  now?       : boolean;
  approve    : boolean;
  configure? : boolean;
};

// What the agent runs with, as ACP's session config options spell them: a choice such as the
// model, or a switch such as Claude Code's fast mode, which has no `choices`.
export type AgentOption = {
  id       : string;
  name     : string;
  value    : string | boolean;
  choices? : { value: string; name: string }[];
  readOnly? : boolean;
  category? : string;
};

export type Remote = {
  host  : string;
  path  : string;
  user? : string;
  port? : number;
};

// `updatedAt` is the last message in the conversation. `parent` names the thread a subagent
// session works for. `step` is what a working session did last.
export type ThreadSummary = {
  id           : string;
  title        : string;
  editor       : Editor;
  status       : 'working' | 'attention' | 'idle' | 'unknown';
  updatedAt    : string;
  capabilities : Capabilities;
  agent?       : AgentSession;
  parent?      : string;
  // What a running session runs with.
  options?     : AgentOption[];
  step?        : ToolStep;
};

export type ProjectSummary = {
  id       : string;
  name     : string;
  path     : string;
  deviceId : string;
  threads  : ThreadSummary[];
  remote?  : Remote;
};

// A project without its threads: `active` is its newest started conversation, `started` how
// many conversations people started there.
export type ProjectOverview = Omit<ProjectSummary, 'threads'> & { active: string; started: number };
export type SessionAttention = {
  reason: 'approval' | 'input' | 'error' | 'complete';
  title: string;
  body: string;
};
export type SessionOverview = {
  projectId: string;
  thread: ThreadSummary;
  attention?: SessionAttention;
};

// An agent login on one computer: its email, the plan its vendor names, and how much of each
// window the plan has spent, as the computer last heard. `used` is a percentage, and a window of
// `minutes` starts over at `resets`.
export type UsageWindow = { minutes: number; used: number; resets: string };
export type Usage = {
  harness : StartHarness;
  account : string;
  plan?   : string;
  windows : UsageWindow[];
};

// A tool call joined with its result. The message text is the result, or a unified diff of
// the change when `diff` is set.
// `label` is what the agent said the step does, `summary` its input as far as the phone shows it,
// `input` names its complete native input, and `at` when a step still running started.
export type ToolStep = {
  name     : string;
  label?   : string;
  summary? : string;
  input?   : Attachment;
  status?  : 'ok' | 'error';
  ms?      : number;
  at?      : string;
  diff?    : boolean;
};

// What a message names without holding: an image, a file, or the whole of a long output. The phone
// fetches its encrypted bytes on press; `bytes` is their size.
export type Attachment = {
  id    : string;
  mime  : string;
  bytes : number;
  name? : string;
};

export type Message = {
  id           : string;
  requestId?   : string;
  role         : (typeof MESSAGE_ROLES)[number];
  text         : string;
  tool?        : ToolStep;
  // The whole text, when `text` is only its preview.
  full?        : Attachment;
  attachments? : Attachment[];
};

// What an agent waits on the person for. A choice with `text` can carry the person's own words.
// `plan` is the plan the agent asks to carry out, in markdown. `questions` are answered together.
export type Approval = {
  id         : string;
  title      : string;
  detail     : string;
  choices    : { id: string; label: string; text?: true; intent?: 'approve' | 'reject' }[];
  change?    : { path: string; diff: string; added?: number; deleted?: number };
  plan?      : string;
  questions? : Question[];
};

// Each question takes one option, several with `multiple`, or the person's own words.
export type Question = {
  header?   : string;
  question  : string;
  options   : { label: string; description?: string }[];
  multiple? : boolean;
};

// One of the approval's choices, with the person's words where it takes them, or what the person
// answered each question, in order.
export type ApprovalReply = { choice: string; text?: string } | { answers: string[][] };

export type CommandAction =

    | { kind: 'projects.refresh' }
    | { kind: 'sessions.list'; cursor?: string; query?: string; parent?: string }
    | { kind: 'notifications.configure'; policy: NotificationPolicy }
    | { kind: 'workspace.read'; baseline?: string }
    | { kind: 'workspace.check'; command: string }
    | { kind: 'thread.send'; text: string; now?: boolean; attachments?: Attachment[] }
    | { kind: 'thread.queue'; text: string; attachments?: Attachment[] }
    | { kind: 'thread.stop' }
    // Sets one of the thread's options; a switch takes a boolean.
    | { kind: 'thread.configure'; option: string; value: string | boolean }
    | ({ kind: 'approval.respond'; approvalId: string } & ApprovalReply)
    // Shares one attachment of the thread's messages for the phone to fetch.
    | { kind: 'attachment.read'; id: string }
    // Starts a session in the project, or in a new folder `name` inside one the computer offers.
    | {
        kind     : 'session.start';
        harness  : StartHarness;
        model?   : string;
        text     : string;
        attachments? : Attachment[];
        workspace? : WorkspaceTarget;
        folder?  : { parent: string; name: string };
      };

// Native acceptance is not delivery. Known native identities cannot change for a request.
export type QueueReceipt =

    | { state: 'unknown'; queueId?: string; clientUserMessageId?: string }
    | { state: 'accepted'; queueId: string; clientUserMessageId?: string }
    | { state: 'delivered'; queueId?: string; clientUserMessageId: string; turnId?: string }
    | {
        state               : 'responded';
        queueId?            : string;
        clientUserMessageId : string;
        turnId              : string;
        responseId          : string;
      };

// The only cached product content: the current dashboard, encrypted separately for each phone.
export const DASHBOARD_BYTES = 64 * 1024;
export const STATE_EVENT = 'dashup:state';
export type Dashboard = {
  updatedAt: string;
  version: string;
  features: Array<'terminal' | 'workspace' | 'uploads' | 'attention'>;
  projects: ProjectOverview[];
  sessions: SessionOverview[];
  agents: StartHarness[];
  models?: Partial<Record<StartHarness, NonNullable<AgentOption['choices']>>>;
  folders: string[];
  usage: Usage[];
};
export type Content = { type: 'dashboard'; dashboard: Dashboard };

export type DeviceRecord = {
  id         : string;
  user       : string;
  name       : string;
  kind       : 'desktop' | 'mobile';
  platform   : Platform;
  connected? : boolean;
};

export type PairingRecord = {
  id        : string;
  device    : string;
  mobile    : string;
  code      : string;
  revokedAt : string | null;
};

export type DashboardRecord = { pairing: string; device: string; envelope: Envelope };
export type State = {
  devices: DeviceRecord[];
  pairings: PairingRecord[];
  dashboards: DashboardRecord[];
};
export type StateEvent =

    | { type: 'dashboard'; record: DashboardRecord }
    | { type: 'pairing'; pairing: PairingRecord }
    | { type: 'refresh' };
