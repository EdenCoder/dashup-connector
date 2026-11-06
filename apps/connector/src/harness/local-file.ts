import { promisify } from 'node:util';
import { lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';

// =============================================================================
// Native discovery records belong to this operating-system user
// =============================================================================

const ACL_MS    = 4_000;
const ACL_BYTES = 4_096;

export async function privateRecord(path: string, max: number): Promise<boolean> {
  const file = await lstat(path).catch(() => undefined);
  if (!file || !file.isFile() || file.isSymbolicLink() || file.size > max) return false;
  if (process.platform !== 'win32')
    return !!process.getuid && file.uid === process.getuid() && (file.mode & 0o077) === 0;

  // An encoded literal keeps native paths out of PowerShell syntax. Only this user, SYSTEM,
  // and local administrators may read the discovery credential; inherited grants count too.
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
