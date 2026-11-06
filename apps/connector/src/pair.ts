import { hostname } from 'node:os';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';

import QRCode from 'qrcode';
import * as ui from '@clack/prompts';
import { z } from 'zod';

import { newSecret, formatPairingCode } from '@dashup/protocol/crypto';
import { PAIRING_TTL_MS, type DeviceRecord, type PairingRecord } from '@dashup/protocol';

import { version } from '../package.json';
import { api, saveConfig, type ConnectorConfig } from './config';

export const Invitation = z
  .object({
    code : z.string().regex(/^[a-f0-9]{16}$/),
    key  : z.string().regex(/^[a-f0-9]{64}$/),
    text : z.string().min(1),
  })
  .strict();
export type Invitation = z.infer<typeof Invitation>;

// Someone at a terminal can scan a code and answer; a service or a pipe cannot.
export const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

export const intro = () => ui.intro(`Dashup ${version}`);

// The phone that scans `text` pairs with this computer under `key`.
export function invitation(config: ConnectorConfig, secret = config.secret): Invitation {
  const code     = randomBytes(8).toString('hex');
  const key      = newSecret(randomBytes);
  const computer = createHash('sha256').update(secret).digest('hex');
  return { code, key, text: formatPairingCode({ api: config.api, computer, code, key }) };
}

const SCAN    = 'Scan this in the Dashup app under Pair a computer. It expires in 5 minutes.';
const BROWSER : Partial<Record<NodeJS.Platform, string[]>> = {
  darwin : ['open'],
  win32  : ['rundll32', 'url.dll,FileProtocolHandler'],
};
const NO_BROWSER =
  'No browser here can show the pairing code. Run dashup pair in a terminal on this computer.';

// The code carries the key this computer and the phone encrypt with. Without a terminal, stdout is
// often an agent's transcript, which would take that key off this computer, so a page served only
// here shows the code instead. Returns a function that takes the page down.
async function show(text: string): Promise<() => void> {
  if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)
    throw new Error(NO_BROWSER);
  const path = `/${randomBytes(16).toString('hex')}`;
  const qr   = await QRCode.toString(text, { type: 'svg', margin: 2, errorCorrectionLevel: 'L' });
  const page =
    '<!doctype html><meta charset="utf-8"><title>Pair with Dashup</title><style>' +
    'body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fff;color:#16181d;font:16px/1.5 system-ui,sans-serif}' +
    'main{max-width:22rem;padding:2rem;text-align:center}svg{width:100%;margin:1rem 0}' +
    'code{font-size:11px;word-break:break-all;color:#5d6470}</style>' +
    `<main><p>${SCAN}</p>${qr}<p>Can't scan? Paste this code instead:</p><code>${text}</code></main>`;
  const server = createServer((request, response) => {
    if (request.url !== path) return void response.writeHead(404).end();
    response.writeHead(200, {
      'Content-Type'            : 'text/html; charset=utf-8',
      'Cache-Control'           : 'no-store',
      'Content-Security-Policy' : "default-src 'none'; style-src 'unsafe-inline'",
      'Referrer-Policy'         : 'no-referrer',
    });
    response.end(page);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const [command, ...args] = BROWSER[process.platform] ?? ['xdg-open'];
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`;
  try {
    await promisify(execFile)(command!, [...args, url]);
  } catch {
    server.close();
    throw new Error(NO_BROWSER);
  }
  process.stdout.write(`Opened the pairing code in a browser on this computer. ${SCAN}\n`);
  return () => server.close();
}

// Shows the code until a phone pairs with it, says `done` and returns the account that phone
// signed in to.
export async function scanned(
  config: ConnectorConfig,
  { code, text }: Invitation,
  done: (email: string) => string,
  secret = config.secret,
): Promise<{ pairing: PairingRecord; email: string }> {
  // The text comes first so a short terminal scrolls it away rather than the code. It stays one
  // unprefixed line, so copying it from the terminal pastes cleanly.
  if (interactive) {
    const qr = await QRCode.toString(text, {
      type                 : 'terminal',
      small                : true,
      errorCorrectionLevel : 'L',
    });
    ui.log.step(SCAN);
    ui.log.message("Can't scan? Paste this code instead:", { spacing: 0 });
    process.stdout.write(`   ${text}\n`);
    ui.log.message(qr.split('\n').filter((row) => row.replace(/\x1b\[\d+m/g, '')));
  }
  const close   = interactive ? undefined : await show(text);
  const waiting = interactive ? ui.spinner() : undefined;
  waiting?.start('Waiting for your phone');
  try {
    for (const deadline = Date.now() + PAIRING_TTL_MS; Date.now() < deadline;) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      // Until a phone pairs, the API does not know this computer (401) or this code (404).
      const response = await fetch(`${config.api}/v1/dashup/pairings?code=${code}`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      if (response.status === 401 || response.status === 404) continue;
      const value = (await response.json()) as {
        success : boolean;
        result  : { pairing: PairingRecord; email: string };
        error?  : string;
      };
      if (!response.ok || !value.success)
        throw new Error(value.error ?? `Dashup request failed (${response.status})`);
      if (waiting) waiting.stop(done(value.result.email));
      else process.stdout.write(`${done(value.result.email)}.\n`);
      return value.result;
    }
    throw new Error('The pairing code expired. Run dashup pair for a new one.');
  } catch (error) {
    if (!waiting) throw error;
    waiting.error(error instanceof Error ? error.message : 'Pairing failed');
    throw Object.assign(error as object, { reported: true });
  } finally {
    close?.();
  }
}

// The walkthrough already showed an error it marked as reported.
export const reported = (error: unknown) =>
  (error as { reported?: boolean } | null)?.reported === true;

// A computer's first phone adds the computer to the phone's account. Whoever sees the code can
// scan it, so the computer shares nothing until its owner confirms the account: at the prompt, or
// by naming it beforehand with --account.
export async function link(config: ConnectorConfig, account?: string): Promise<boolean> {
  const secret             = newSecret(randomBytes);
  const invite             = invitation(config, secret);
  const { pairing, email } = await scanned(
    config,
    invite,
    (account) => `Scanned by ${account}`,
    secret,
  );
  const linked             = { ...config, secret };
  const platform =
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  const { device } = await api<{ device: DeviceRecord }>(linked, '/dashup/devices', {
    id   : pairing.device,
    name : hostname(),
    kind : 'desktop',
    platform,
  });
  const confirmed = account
    ? email.toLowerCase() === account.toLowerCase()
    : await ui.confirm({ message: `Pair this computer with ${email}?`, initialValue: false });
  if (confirmed !== true) {
    await api(linked, `/dashup/pairings/${pairing.id}`, undefined, 'DELETE').catch(() => {});
    ui.cancel(
      account
        ? `Pairing cancelled: that phone uses ${email}, not ${account}. Nothing was shared.`
        : 'Pairing cancelled. Nothing was shared.',
    );
    return false;
  }
  Object.assign(config, {
    secret,
    device,
    pairs       : { [pairing.id]: { key: invite.key, sequence: 0 } },
    queued      : {},
    receipts : {},
  });
  saveConfig(config);
  return true;
}
