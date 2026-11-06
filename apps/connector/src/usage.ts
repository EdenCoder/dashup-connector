import { join } from 'node:path';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { homedir, userInfo } from 'node:os';

import type { Usage, UsageWindow } from '@dashup/protocol';

import { claudeHome, lastRecords } from './harness/history';
import type { HistorySession } from './harness/session';

// =============================================================================
// Agent logins: each one's account and plan, and how much of its windows is spent
// =============================================================================

type Data = Record<string, any>;

const REQUEST_MS = 10_000;

// Claude Code's `/usage` asks Anthropic's meter with the login Claude Code holds, and so does
// Dashup. Refreshing an expired token would rotate that login, so Dashup waits for Claude Code.
const CLAUDE_USAGE   = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_WINDOWS = { five_hour: 300, seven_day: 10_080 } as const;

// Codex writes the limits its server reported into the rollout of the session it ran. A session
// that has not finished a turn yet holds none, so the next newest may.
const CODEX_TAIL     = 256 * 1024;
const CODEX_SESSIONS = 5;

// An agent login as this computer sees it. `identity` is the vendor's own ID for the account: every
// computer that shares the login reads the same one, and it never leaves this computer.
export type Login = Usage & { identity?: string };

export async function planUsage(histories: HistorySession[]): Promise<Login[]> {
  const found = await Promise.all(
    [claude(), codex(histories)].map((usage) => usage.catch(() => undefined)),
  );
  return found.filter((usage): usage is Login => !!usage);
}

// A window as the agent reported it: `resets` is an ISO time, or Unix seconds.
function usageWindow(minutes: unknown, used: unknown, resets: unknown): UsageWindow[] {
  const at = typeof resets === 'number' ? resets * 1000 : Date.parse(String(resets));
  return typeof minutes === 'number' && typeof used === 'number' && Number.isFinite(at)
    ? [{ minutes, used: Math.round(used), resets: new Date(at).toISOString() }]
    : [];
}

// =============================================================================
// Claude Code
// =============================================================================

// A login whose meter can't be read still names its account and plan.
async function claude(): Promise<Login | undefined> {
  const login = await claudeLogin();
  if (!login) return undefined;
  return {
    harness : 'claude',
    ...(await claudeAccount()),
    plan    : login.subscriptionType,
    windows : await claudeWindows(login).catch(() => []),
  };
}

// An expired login waits for Claude Code to renew it.
async function claudeWindows(login: Data): Promise<UsageWindow[]> {
  if (typeof login.accessToken !== 'string' || !(login.expiresAt > Date.now())) return [];
  const response = await fetch(CLAUDE_USAGE, {
    headers : {
      Authorization: `Bearer ${login.accessToken}`,
      'anthropic-beta': 'oauth-2025-04-20',
    },
    signal  : AbortSignal.timeout(REQUEST_MS),
  });
  if (!response.ok) return [];
  const meter = (await response.json()) as Data;
  return Object.entries(CLAUDE_WINDOWS).flatMap(([name, minutes]) =>
    usageWindow(minutes, meter[name]?.utilization, meter[name]?.resets_at));
}

// macOS keeps the login in the Keychain, named for any CLAUDE_CONFIG_DIR; elsewhere it is a file.
async function claudeLogin(): Promise<Data | undefined> {
  const dir   = process.env.CLAUDE_CONFIG_DIR;
  const hash  = dir && createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8);
  const user  = process.env.USER || userInfo().username;
  const saved =
    process.platform === 'darwin'
      ? (
          await promisify(execFile)(
            'security',
            [
              'find-generic-password',
              '-a',
              /^[\w.-]+$/.test(user) ? user : 'claude-code-user',
              '-w',
              '-s',
              `Claude Code-credentials${hash ? `-${hash}` : ''}`,
            ],
            { timeout: REQUEST_MS },
          )
        ).stdout
      : await readFile(join(claudeHome(), '.credentials.json'), 'utf8');
  return JSON.parse(saved).claudeAiOauth;
}

// Claude Code keeps its account in `.claude.json`, in CLAUDE_CONFIG_DIR or the home folder.
async function claudeAccount(): Promise<Pick<Login, 'account' | 'identity'>> {
  try {
    const config = join(process.env.CLAUDE_CONFIG_DIR ?? homedir(), '.claude.json');
    const { emailAddress, accountUuid } =
      JSON.parse(await readFile(config, 'utf8')).oauthAccount ?? {};
    return {
      account : typeof emailAddress === 'string' ? emailAddress : '',
      ...(typeof accountUuid === 'string' && accountUuid ? { identity: accountUuid } : {}),
    };
  } catch {
    return { account: '' };
  }
}

// =============================================================================
// Codex
// =============================================================================

async function codex(histories: HistorySession[]): Promise<Login> {
  const login = await codexLogin();
  const sessions = histories
    .filter((session) => session.harness === 'codex')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, CODEX_SESSIONS);
  for (const session of sessions) {
    const reported = lastRecords(session.files[0]!, CODEX_TAIL)
      .reverse()
      .find((row) => row.payload?.type === 'token_count' && row.payload.rate_limits);
    if (!reported) continue;
    const { primary, secondary } = reported.payload.rate_limits;
    const windows = [primary, secondary].flatMap((limit) =>
      usageWindow(limit?.window_minutes, limit?.used_percent, limit?.resets_at));
    if (windows.length) return { harness: 'codex', ...login, windows };
  }
  return { harness: 'codex', ...login, windows: [] };
}

// Codex's ChatGPT login names its account, plan and workspace seat in the identity token it keeps;
// an API key names none of them.
async function codexLogin(): Promise<Pick<Login, 'account' | 'plan' | 'identity'>> {
  const home  = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  const token = JSON.parse(await readFile(join(home, 'auth.json'), 'utf8')).tokens?.id_token;
  if (typeof token !== 'string') return { account: '' };
  const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString());
  const auth   = claims['https://api.openai.com/auth'];
  const seat   = auth?.chatgpt_account_id;
  return {
    account : typeof claims.email === 'string' ? claims.email : '',
    plan    : auth?.chatgpt_plan_type,
    ...(typeof seat === 'string' && seat
      ? { identity: JSON.stringify([seat, auth.chatgpt_user_id ?? null]) }
      : {}),
  };
}
