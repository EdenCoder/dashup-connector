import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { cp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep, delimiter } from 'node:path';

import { configPath } from './config';

const run = promisify(execFile);
const xml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// Node 24 still calls node:sqlite experimental; the service's log keeps to Dashup's own output.
const NODE_FLAGS = ['--disable-warning=ExperimentalWarning'];

// A shell outside a login session, such as some SSH and editor terminals, lacks the runtime
// directory where the user's systemd manager listens; it is still at the standard place.
const systemctl = (...args: string[]) =>
  run('systemctl', ['--user', ...args], {
    env: {
      ...process.env,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${userInfo().uid}`,
    },
  });

// The file each platform reads at sign-in to start Dashup.
const serviceFile = (): string =>
  process.platform === 'darwin'
    ? join(homedir(), 'Library/LaunchAgents/com.dashup.connector.plist')
    : process.platform === 'win32'
      ? join(
          process.env.APPDATA ?? join(homedir(), 'AppData/Roaming'),
          'Microsoft/Windows/Start Menu/Programs/Startup/Dashup.vbs',
        )
      : join(homedir(), '.config/systemd/user/dashup.service');

export const startupInstalled = (): boolean => existsSync(serviceFile());

// The service runs `watch` against the state file this computer was paired with. A clean exit
// (`dashup stop`) stays stopped; a crash restarts.
export function service(
  platform: NodeJS.Platform,
  node: string,
  entry: string,
  config: string,
  path = process.env.PATH ?? '',
): string {
  const command = [node, ...NODE_FLAGS, entry];
  const environmentPath = [
    ...new Set([dirname(node), ...path.split(delimiter)].filter(Boolean)),
  ].join(delimiter);
  if (platform === 'darwin')
    return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.dashup.connector</string><key>EnvironmentVariables</key><dict><key>DASHUP_CONFIG</key><string>${xml(config)}</string><key>PATH</key><string>${xml(environmentPath)}</string></dict><key>ProgramArguments</key><array>${[...command, 'watch'].map((value) => `<string>${xml(value)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict></dict></plist>`;
  if (platform === 'win32') {
    const quote = (value: string) => '""' + value.replaceAll('"', '""') + '""';
    return (
      'Set shell = CreateObject("WScript.Shell")\r\n' +
      `shell.Environment("Process")("DASHUP_CONFIG") = "${config.replaceAll('"', '""')}"\r\n` +
      `shell.Run "${command.map(quote).join(' ')} watch", 0, False\r\n`
    );
  }
  const quote = (value: string) =>
    '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
  return `[Unit]\nDescription=Dashup desktop connector\nAfter=network-online.target\n\n[Service]\nEnvironment=${quote(`DASHUP_CONFIG=${config}`)}\nEnvironment=${quote(`PATH=${environmentPath}`)}\nExecStart=${command.map(quote).join(' ')} watch\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
}

// npx and pnpm dlx run Dashup from a cache that can be cleared, so the service runs a copy of
// that install kept beside this computer's state. A checkout or global install runs in place.
async function durableEntry(): Promise<string> {
  const entry = fileURLToPath(import.meta.url);
  if (!entry.endsWith(`${sep}dist${sep}index.js`))
    throw new Error(
      'Build the connector before installing startup: pnpm --filter @dashup/connector build',
    );
  if (!['_npx', 'dlx'].some((cache) => entry.includes(`${sep}${cache}${sep}`))) return entry;
  const root = entry.slice(0, entry.indexOf(`${sep}node_modules${sep}`));
  const app  = join(dirname(configPath()), 'app');
  await rm(app, { recursive: true, force: true });
  await cp(join(root, 'node_modules'), join(app, 'node_modules'), {
    recursive        : true,
    verbatimSymlinks : true,
  });
  return join(app, relative(root, entry));
}

// Claude Code takes the phone's replies as the person's own only from a plugin. This package carries
// it beside `dist` as its own marketplace, and Claude Code reads it in place. It streams over a Unix
// socket, which the connector does not serve on Windows.
const claude = (...args: string[]) => run('claude', ['plugin', ...args], { timeout: 60_000 });
const pi = (...args: string[]) => {
  if (process.platform !== 'win32') return run('pi', args, { timeout: 60_000 });
  const encoded = Buffer.from(JSON.stringify(args)).toString('base64');
  const script = `$piArgs=ConvertFrom-Json([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))); & pi @piArgs; exit $LASTEXITCODE`;
  return run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    { timeout: 60_000 },
  );
};
const piPackageFile = () => join(dirname(configPath()), 'pi-package');

async function installClaude(entry: string): Promise<boolean> {
  if (process.platform === 'win32') return false;
  try {
    await claude('marketplace', 'add', join(dirname(entry), '..', 'claude'));
    await claude('install', 'dashup@dashup', '--scope', 'user');
    return true;
  } catch {
    // Claude Code does not run here.
    return false;
  }
}

async function installPi(entry: string): Promise<boolean> {
  try {
    const path = join(dirname(entry), '..', 'pi');
    await pi('install', path);
    // An npx invocation can change cache paths. Removal must name the installed durable copy.
    await writeFile(piPackageFile(), path, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// Writes the service, (re)starts it, and installs the native plugins that run here. Returns what
// the person still has to do, if anything.
export async function installStartup(): Promise<string | undefined> {
  const path  = serviceFile();
  const entry = await durableEntry();
  await mkdir(dirname(configPath()), { recursive: true, mode: 0o700 });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, service(process.platform, process.execPath, entry, configPath()));
  const restart = (await installClaude(entry))
    ? 'Restart Claude Code sessions that are already open to answer them from your phone.'
    : undefined;
  const reload = (await installPi(entry))
    ? 'Run /reload in Pi sessions that are already open to connect them to Dashup.'
    : undefined;
  return [await start(path), restart, reload].filter(Boolean).join(' ') || undefined;
}

async function start(path: string): Promise<string | undefined> {
  if (process.platform === 'darwin') {
    await run('launchctl', ['unload', path]).catch(() => {});
    await run('launchctl', ['load', path]);
  } else if (process.platform === 'win32') {
    spawn('wscript.exe', [path], { detached: true, stdio: 'ignore' }).unref();
  } else {
    // Without a desktop session, as over SSH, a user service stops at logout unless the user
    // lingers, which also starts the user's manager if no session has. A desktop's service starts
    // with its session.
    const note =
      process.env.DISPLAY || process.env.WAYLAND_DISPLAY
        ? undefined
        : await run('loginctl', ['enable-linger']).then(
            () => undefined,
            () =>
              `It stops when you log out. To keep it running, run sudo loginctl enable-linger ${userInfo().username}.`,
          );
    await systemctl('daemon-reload');
    await systemctl('enable', 'dashup.service');
    await systemctl('restart', 'dashup.service');
    return note;
  }
}

// Stops the service and removes what install wrote; this computer stays paired.
export async function uninstallStartup(): Promise<void> {
  const path = serviceFile();
  await claude('uninstall', 'dashup@dashup').catch(() => {});
  await claude('marketplace', 'remove', 'dashup').catch(() => {});
  const packagePath = await readFile(piPackageFile(), 'utf8').catch(() => undefined);
  if (packagePath) await pi('remove', packagePath).catch(() => {});
  await rm(piPackageFile(), { force: true });
  if (process.platform === 'darwin') await run('launchctl', ['unload', path]).catch(() => {});
  else if (process.platform !== 'win32')
    await systemctl('disable', 'dashup.service').catch(() => {});
  await rm(path, { force: true });
  await rm(join(dirname(configPath()), 'app'), { recursive: true, force: true });
}
