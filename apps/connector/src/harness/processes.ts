import { promisify } from 'node:util';
import { execFile, execFileSync } from 'node:child_process';

// =============================================================================
// Installed agent commands
// =============================================================================

// What a command prints as its version, where it runs on this computer.
export const commandVersion = (command: string): Promise<string | undefined> =>
  promisify(execFile)(command, ['--version'], {
    timeout: 10_000,
    shell: process.platform === 'win32',
  }).then(
    ({ stdout }) => stdout,
    () => undefined,
  );

export const commandRuns = async (command: string): Promise<boolean> =>
  (await commandVersion(command)) !== undefined;

// =============================================================================
// Linux native process candidates
// =============================================================================

const MAX_PROCESSES = 4_096;

// Bound native candidates, not arbitrary PIDs: long-lived hosts may have thousands of unrelated
// processes ahead of every agent in /proc. The executable and user are verified after this list.
export function nativeProcesses(...names: string[]): number[] {
  if (process.platform !== 'linux') return [];
  try {
    return execFileSync('ps', ['-C', names.join(','), '-o', 'pid='], {
      timeout: 3_000,
      maxBuffer: MAX_PROCESSES * 16,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    })
      .split('\n')
      .filter((value) => /^\s*\d+\s*$/.test(value))
      .slice(0, MAX_PROCESSES)
      .map(Number);
  } catch {
    return [];
  }
}
