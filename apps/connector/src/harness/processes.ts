import { execFileSync } from 'node:child_process';

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
