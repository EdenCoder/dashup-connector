import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { constants, type Stats } from 'node:fs';
import { open, stat, lstat } from 'node:fs/promises';

// =============================================================================
// Native discovery records belong to this operating-system user
// =============================================================================

export const MAX_RECORD = 64 * 1024;
const ACL_MS            = 4_000;
const ACL_BYTES         = 4_096;

// On Windows, only this user, SYSTEM, and local administrators may read the discovery credential;
// inherited grants count too. An encoded literal keeps native paths out of PowerShell syntax.
export async function privateAcl(path: string): Promise<boolean> {
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
      { timeout: ACL_MS, maxBuffer: ACL_BYTES },
    );
    return stdout.trim().toLowerCase() === 'true';
  } catch {
    return false;
  }
}

export async function privateRecord(path: string, max: number): Promise<boolean> {
  const file = await lstat(path).catch(() => undefined);
  if (!file || !file.isFile() || file.isSymbolicLink() || file.size > max) return false;
  if (process.platform !== 'win32')
    return !!process.getuid && file.uid === process.getuid() && (file.mode & 0o077) === 0;
  return privateAcl(path);
}

// A regular file of this user's, not a link, within the record limit, on which other users hold
// none of `others`.
const owned = (file: Stats | undefined, others: number): boolean =>
  !!file?.isFile() &&
  !file.isSymbolicLink() &&
  file.size <= MAX_RECORD &&
  (!process.getuid || (file.uid === process.getuid() && (file.mode & others) === 0));

// The JSON a record holds, or undefined where its file is not this user's own. The file is checked
// where it lies and again once it is open, so one swapped in between is never read. `readable`
// admits a record that holds no credential, which other users may read but never write.
export async function readRecord(path: string, readable = false): Promise<any> {
  const others = readable ? 0o022 : 0o077;
  if (
    readable
      ? !owned(await lstat(path).catch(() => undefined), others)
      : !(await privateRecord(path, MAX_RECORD))
  )
    return undefined;
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!owned(await file.stat(), others)) return undefined;
    return JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
}

// Whether the process a record names runs as this user. One that has gone throws.
export async function ownProcess(pid: number): Promise<boolean> {
  process.kill(pid, 0);
  return !(
    process.platform === 'linux' &&
    process.getuid &&
    (await stat(`/proc/${pid}`)).uid !== process.getuid()
  );
}
