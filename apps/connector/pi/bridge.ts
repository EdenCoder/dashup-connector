import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// =============================================================================
// Local Pi bridge contract
// =============================================================================

export const PI_VERSION     = 1;
export const PI_HOST        = '127.0.0.1';
export const PI_REQUEST_MS  = 4_000;
export const PI_MAX_HOSTS   = 32;
export const PI_MAX_CLIENTS = 4;
export const PI_MAX_FRAME   = 2 * 1024 * 1024;
export const PI_MAX_TEXT    = 64 * 1024;
export const PI_MAX_ENTRIES = 200;
export const PI_MAX_HISTORY = 512 * 1024;
export const PI_MAX_COMMAND = 128 * 1024;
export const PI_MAX_REQUESTS = 1_000;

export type PiEntry = {
  id        : string;
  timestamp : string;
  message   : Record<string, any>;
};

export type PiRegistry = {
  version  : typeof PI_VERSION;
  instance : string;
  pid      : number;
  port     : number;
  token    : string;
};

export type PiSnapshot = {
  type      : 'snapshot';
  version   : typeof PI_VERSION;
  instance  : string;
  pid       : number;
  session   : string;
  cwd       : string;
  title?    : string;
  updatedAt : string;
  working   : boolean;
  prompt?   : string;
  entries   : PiEntry[];
  earlier   : boolean;
  typing?   : string;
};

export type PiCommand = {
  type    : 'command';
  id      : string;
  session : string;
  method  : 'send' | 'abort';
  text?   : string;
  now?    : boolean;
};

export const piDirectory = (): string =>
  resolve(process.env.DASHUP_PI_DIRECTORY ?? join(homedir(), '.dashup', 'pi'));

// Registry ownership authenticates the local host before its token is sent. Symlinks and
// shared directories are refused; the bridge never binds a non-loopback interface.
export async function piPrivate(path: string, directory = false): Promise<boolean> {
  const file = await lstat(path).catch(() => undefined);
  if (!file || file.isSymbolicLink() || (directory ? !file.isDirectory() : !file.isFile()))
    return false;
  if (!directory && file.size > 4_096) return false;
  if (process.platform !== 'win32')
    return (!process.getuid || file.uid === process.getuid()) && (file.mode & 0o077) === 0;
  const encoded = Buffer.from(path).toString('base64');
  const script = `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')); $a=Get-Acl -LiteralPath $p -ErrorAction Stop; $sid=[Security.Principal.SecurityIdentifier]; $me=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $ok=$a.GetOwner($sid).Value -eq $me; foreach($r in $a.Access){if($r.AccessControlType -eq 'Allow' -and $r.IdentityReference.Translate($sid).Value -notin @($me,'S-1-5-18','S-1-5-32-544')){$ok=$false}}; $ok`;
  try {
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { timeout: PI_REQUEST_MS, maxBuffer: 4_096 },
    );
    return stdout.trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
}

export function piFrame(value: unknown): string {
  const frame = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(frame) > PI_MAX_FRAME) throw new Error('Pi bridge frame is too large');
  return frame;
}
