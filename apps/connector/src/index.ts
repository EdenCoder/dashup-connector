#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';

import * as ui from '@clack/prompts';
import { z } from 'zod';

import { HARNESSES } from '@dashup/protocol';
import { newSecret } from '@dashup/protocol/crypto';
import { SESSION_PACKET_BYTES } from '@dashup/protocol/session';

import { proxyAcp } from './acp';
import { link, intro, scanned, reported, interactive, Invitation } from './pair';
import { Discovery } from './discovery';
import { Connector } from './connector';
import { runPhoneMcp } from './phone-mcp';
import { installStartup, startupInstalled, uninstallStartup } from './install';
import { LiveHarnesses } from './harness/live';
import { loadConfig, saveConfig, connectorPort } from './config';

const config  = loadConfig();
const args    = process.argv.slice(2);
const command = args[0] ?? 'watch';
const option  = (name: string) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

// A running connector serves loopback requests that carry this computer's local secret.
const running = (path: string, init?: RequestInit) =>
  fetch(`http://127.0.0.1:${connectorPort()}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.localSecret}` },
  });
const refused = (error: unknown) => {
  if ((error as { cause?: NodeJS.ErrnoException }).cause?.code === 'ECONNREFUSED') return null;
  throw error;
};
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Waits up to ten seconds for this config's connector to start (or stop) answering.
async function answering(expected: boolean): Promise<boolean> {
  for (let tries = 0; tries < 40; tries++) {
    const status = await running('/status', { signal: AbortSignal.timeout(1000) }).catch(
      () => null,
    );
    if (Boolean(status?.ok) === expected) return true;
    await pause(250);
  }
  return false;
}
const BACKGROUND = 'Run Dashup in the background and start it when you sign in?';
const DONE       = 'Your projects appear on your phone.';

// The startup service takes over from whichever connector runs for this config.
async function background(): Promise<boolean> {
  const waiting = interactive ? ui.spinner() : undefined;
  waiting?.start('Starting Dashup in the background');
  let failure = 'Dashup did not start in the background. Run dashup watch to see why.';
  try {
    await running('/stop', { method: 'POST' }).catch(() => null);
    await answering(false);
    const note = await installStartup();
    if (await answering(true)) {
      const message = `Dashup runs in the background and starts when you sign in.${note ? ` ${note}` : ''}`;
      if (waiting) waiting.stop(message);
      else process.stdout.write(`${message}\n`);
      return true;
    }
  } catch (error) {
    if (error instanceof Error) failure = error.message;
  }
  if (waiting) waiting.error(failure);
  else process.stderr.write(`${failure}\n`);
  return false;
}

const authorized = (request: IncomingMessage): boolean => {
  const expected = Buffer.from(`Bearer ${config.localSecret}`);
  const actual   = Buffer.from(request.headers.authorization ?? '');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

const Attention = z
  .object({
    projectId : z.string().min(1),
    threadId  : z.string().default(''),
    title     : z.string().min(1).max(200),
    body      : z.string().max(4000).default(''),
    reason    : z.enum(['input', 'approval', 'error', 'complete']).default('input'),
  })
  .strict();

async function main(): Promise<void> {
  if (command === 'phone-tools') {
    if (!config.localSecret) throw new Error('Start dashup watch on this computer first.');
    return runPhoneMcp({
      call: async (path, value, signal) => {
        const response = await running(path, {
          method: 'POST',
          body: JSON.stringify(value),
          signal,
        });
        const result = (await response.json().catch(() => null)) as { error?: string } | null;
        if (!response.ok)
          throw new Error(
            result?.error || 'The local connector could not complete the phone request.',
          );
        return result;
      },
    });
  }
  if (option('--api')) {
    const url = new URL(option('--api')!);
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      throw new Error('Use an HTTPS API origin');
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
      throw new Error('Use the API origin without a path');
    if (config.secret && config.api !== url.origin)
      throw new Error('Use a separate DASHUP_CONFIG file to connect a different server');
    config.api = url.origin;
  }
  const account = option('--account');
  if (account !== undefined && !/^[^\s@]+@[^\s@]+$/.test(account))
    throw new Error('Use --account with the email you sign in to the Dashup app with');
  if (command === 'install') {
    if (!config.secret) throw new Error('Pair this computer first: run dashup pair.');
    if (!(await background())) process.exitCode = 1;
    return;
  }
  if (command === 'uninstall') {
    await running('/stop', { method: 'POST' }).catch(() => null);
    await answering(false);
    await uninstallStartup();
    process.stdout.write('Dashup no longer starts when you sign in. This computer stays paired.\n');
    return;
  }
  if (command === 'stop') {
    const response = await running('/stop', { method: 'POST' }).catch(refused);
    if (!response) throw new Error('Dashup is not running on this computer');
    if (!response.ok) throw new Error('Could not stop Dashup');
    return;
  }

  if (command === 'acp') {
    const native = args[1] === '--' ? args.slice(2) : args.slice(1);
    const [executable, ...agentArgs] = native;
    if (!executable)
      throw new Error('Usage: dashup acp -- <original-agent-command> [arguments...]');
    return proxyAcp(config, executable, agentArgs);
  }

  if (command === 'doctor' || command === 'projects') {
    const discovery = new Discovery(config.device?.id ?? 'local', config.localSecret);
    discovery.scan();
    const live = new LiveHarnesses();
    try {
      for (const session of await live.refresh()) discovery.observe(session);
    } finally {
      live.stop();
    }
    const projects = [...discovery.projects.values()];
    process.stdout.write(
      JSON.stringify(
        command === 'doctor'
          ? {
              node: process.version,
              paired: Boolean(config.secret),
              platform: process.platform,
              projectCount: projects.length,
              harnesses: Object.fromEntries(
                Object.keys(HARNESSES)
                  .filter((harness) => harness !== 'other')
                  .map((harness) => [
                    harness,
                    new Set(
                      projects
                        .flatMap((project) => project.threads)
                        .filter((thread) => thread.agent?.harness === harness)
                        .map((thread) => thread.id),
                    ).size,
                  ]),
              ),
              warnings: discovery.warnings,
            }
          : projects,
        null,
        2,
      ) + '\n',
    );
    return;
  }
  if (command === 'alert') {
    if (!config.localSecret) throw new Error('Start dashup watch on this computer first');
    const input = Attention.parse({
      projectId: option('--project'),
      threadId: option('--thread') ?? '',
      title: option('--title') ?? 'Your computer needs attention',
      body: option('--body') ?? '',
      reason: option('--reason') ?? 'input',
    });
    const response = await running('/attention', { method: 'POST', body: JSON.stringify(input) });
    if (!response.ok) throw new Error('Could not deliver the alert to this computer connector');
    process.stdout.write('Encrypted alert queued.\n');
    return;
  }
  if (!['pair', 'watch'].includes(command)) {
    process.stdout.write(
      'Dashup: pair [--account <email>] | watch | projects | alert --project <id> | phone-tools | doctor | stop | acp -- <original-agent-command> | install | uninstall\n',
    );
    return;
  }
  const pairPhone = (invite: Invitation) =>
    scanned(config, invite, (email) => `Paired a phone signed in as ${email}`);
  // Pairing in a terminal ends by asking whether Dashup keeps running once it closes. A startup
  // service already installed for this state file takes over without asking. Without a terminal,
  // pairing ends there and leaves the service to dashup install.
  const keepRunning = async (stopHere: () => void) => {
    const answer =
      startupInstalled() || (interactive && (await ui.confirm({ message: BACKGROUND })) === true);
    if (answer) {
      stopHere();
      const started = await background();
      ui.outro(started ? DONE : 'Run dashup to keep Dashup running in this terminal.');
      process.exit(started ? 0 : 1);
    }
    if (!interactive) {
      stopHere();
      process.stdout.write(
        'Paired. Run dashup install to keep Dashup running in the background.\n',
      );
      process.exit(0);
    }
    ui.log.info('Dashup runs in this terminal. Keep it open; Ctrl+C stops it.');
    ui.outro(DONE);
  };
  const status = await running('/status', { signal: AbortSignal.timeout(1000) }).catch(refused);
  if (status?.ok) {
    if (command !== 'pair')
      throw new Error(
        'Dashup is already running on this computer. Use dashup pair to add a phone.',
      );
    const response = await running('/pair', { method: 'POST' });
    if (!response.ok) throw new Error('Could not make a pairing code');
    const invite = Invitation.safeParse(await response.json().catch(() => null));
    if (!invite.success)
      throw new Error(
        'An older Dashup connector is running. Run dashup stop, then run dashup pair with the updated connector.',
      );
    if (interactive) intro();
    await pairPhone(invite.data);
    if (interactive && !startupInstalled()) {
      const answer = await ui.confirm({ message: BACKGROUND });
      if (answer === true && !(await background())) process.exitCode = 1;
    }
    if (interactive) ui.outro(DONE);
    process.exit();
  }
  if (!config.secret && !interactive && !account)
    throw new Error(
      'To pair this computer, run dashup pair in a terminal, or add --account with your Dashup email.',
    );
  let connector: Connector | undefined;
  const server = createServer(async (request, response) => {
    if (!authorized(request)) {
      response.writeHead(403).end();
      return;
    }
    try {
      if (request.url === '/status' && request.method === 'GET') {
        response.end('{}');
        return;
      }
      if (request.url === '/stop' && request.method === 'POST') {
        response.once('finish', () => process.exit(0));
        response.end('{}');
        connector?.stop();
        server.close();
        return;
      }
      if (!connector) {
        response.writeHead(503).end('{}');
        return;
      }
      if (request.url === '/pair' && request.method === 'POST') {
        response.end(JSON.stringify(connector.invite()));
        return;
      }
      if (
        (request.url === '/phone/list' || request.url === '/phone/request') &&
        request.method === 'POST'
      ) {
        let body = '';
        for await (const chunk of request) {
          body += String(chunk);
          if (Buffer.byteLength(body) > SESSION_PACKET_BYTES)
            throw new Error('Phone request too large.');
        }
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/phone/list') {
          response.end(JSON.stringify({ phones: connector.phone.list() }));
          return;
        }
        const controller = new AbortController();
        response.once('close', () => {
          if (!response.writableEnded) controller.abort();
        });
        try {
          response.end(
            JSON.stringify(await connector.phone.request(JSON.parse(body), controller.signal)),
          );
        } catch (error) {
          if (!response.destroyed)
            response.writeHead(400).end(
              JSON.stringify({
                error: error instanceof Error ? error.message : 'Phone input unavailable.',
              }),
            );
        }
        return;
      }
      if (request.url !== '/attention' || request.method !== 'POST') {
        response.writeHead(404).end();
        return;
      }
      let value = '';
      for await (const chunk of request) {
        value += String(chunk);
        if (value.length > 20000) throw new Error('Alert too large');
      }
      const input = Attention.parse(JSON.parse(value));
      await connector.attention(
        input.projectId,
        input.threadId,
        input.title,
        input.body,
        input.reason,
      );
      response.end('{}');
    } catch {
      response.writeHead(400).end('{}');
    }
  });
  server.on('connect', (request, socket) => {
    if (!connector || request.url !== '/acp' || !authorized(request)) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    connector.attach(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(connectorPort(), '127.0.0.1', resolve);
  });
  const selectedApi = config.api;
  Object.assign(config, loadConfig(), { api: selectedApi });
  config.localSecret ||= newSecret(randomBytes);
  saveConfig(config);
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      connector?.stop();
      server.close();
      process.exit(0);
    });
  try {
    const linking = !config.secret;
    if (linking) {
      intro();
      if (!(await link(config, account))) process.exit(1);
      await keepRunning(() => server.close());
    }
    connector = new Connector(config);
    await connector.start();
    if (command === 'pair' && !linking) {
      if (interactive) intro();
      const paired = await pairPhone(connector.invite()).catch((error: unknown) => {
        if (!reported(error))
          process.stderr.write(`${error instanceof Error ? error.message : 'Pairing failed'}\n`);
      });
      if (paired)
        await keepRunning(() => {
          connector?.stop();
          server.close();
        });
    }
  } catch (error) {
    connector?.stop();
    server.close();
    throw error;
  }
}

main().catch((error: unknown) => {
  if (!reported(error))
    process.stderr.write(`${error instanceof Error ? error.message : 'Dashup failed'}\n`);
  process.exit(1);
});
