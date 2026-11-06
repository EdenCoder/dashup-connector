import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { constants, openSync, readSync, fstatSync, closeSync, lstatSync } from 'node:fs';

import type { Message } from '@dashup/protocol';

import { EARLIER, type HistorySession } from './session';

// =============================================================================
// Junie's native session index and committed output
// =============================================================================

const MAX_BYTES    = 8 * 1024 * 1024;
const MAX_SESSIONS = 100;
const MAX_RECORD   = 2 * 1024 * 1024;

type Data = Record<string, any>;

export const junieHome = (): string =>
  resolve(process.env.DASHUP_JUNIE_HOME || process.env.JUNIE_HOME || join(homedir(), '.junie'));

function records(path: string): { rows: Data[]; earlier: boolean } {
  if (!lstatSync(path).isFile()) throw new Error('Junie history must be a regular file');
  const file = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(file);
    if (!info.isFile() || (process.getuid && info.uid !== process.getuid()))
      throw new Error('Junie history must be a regular file owned by this user');
    const start = Math.max(0, info.size - MAX_BYTES);
    const buffer = Buffer.alloc(Math.min(info.size, MAX_BYTES));
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(file, buffer, size, buffer.length - size, start + size);
      if (!count) break;
      size += count;
    }
    const lines = buffer.subarray(0, size).toString('utf8').split('\n');
    if (start) lines.shift();
    const rows = lines.flatMap((line): Data[] => {
      if (Buffer.byteLength(line) > MAX_RECORD) return [];
      try {
        const value: unknown = JSON.parse(line);
        return value && typeof value === 'object' && !Array.isArray(value) ? [value] : [];
      } catch {
        // A native append can end in a partial record while a session is working.
        return [];
      }
    });
    return { rows, earlier: start > 0 };
  } finally {
    closeSync(file);
  }
}

function messages(path: string): Message[] {
  try {
    const { rows, earlier } = records(path);
    const output = new Map<string, Message>();
    if (earlier) output.set(EARLIER.id, { ...EARLIER });
    for (const row of rows) {
      if (
        row.kind === 'UserPromptEvent' &&
        typeof row.requestId === 'string' &&
        typeof row.presentablePrompt === 'string'
      )
        output.set(row.requestId, {
          id   : row.requestId,
          role : 'user',
          text : row.presentablePrompt,
        });
      const event = row.kind === 'SessionA2uxEvent' ? row.event?.agentEvent : undefined;
      // The state blob includes internal reasoning and environment; read only native final output.
      if (
        event?.kind === 'ResultBlockUpdatedEvent' &&
        event.agent?.kind === 'MainAgent' &&
        typeof event.stepId === 'string' &&
        typeof event.result === 'string' &&
        event.result.trim()
      )
        output.set(event.stepId, {
          id   : event.stepId,
          role : 'assistant',
          text : event.result,
        });
      if (
        event?.kind === 'AgentFailureEvent' &&
        event.agent?.kind === 'MainAgent' &&
        typeof row.taskId === 'string' &&
        typeof event.message === 'string'
      )
        output.set(`error:${row.taskId}`, {
          id   : `error:${row.taskId}`,
          role : 'system',
          text : event.message,
        });
    }
    return [...output.values()];
  } catch {
    return [];
  }
}

export function scanJunieHistories(): {
  sessions : HistorySession[];
  paths    : string[];
  warnings : string[];
} {
  const home = junieHome();
  const directory = join(home, 'sessions');
  const index = join(directory, 'index.jsonl');
  const sessions: HistorySession[] = [];
  const paths = [directory, index];
  try {
    const { rows } = records(index);
    const entries = new Map<string, Data>();
    for (const row of rows)
      if (
        typeof row.sessionId === 'string' &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(row.sessionId) &&
        typeof row.projectDir === 'string' &&
        isAbsolute(row.projectDir) &&
        !row.projectDir.includes('\0') &&
        typeof row.updatedAt === 'number' &&
        Number.isFinite(new Date(row.updatedAt).getTime())
      )
        entries.set(row.sessionId, row);
    for (const row of [...entries.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, MAX_SESSIONS)) {
      try {
        const folder = join(directory, row.sessionId);
        const info = lstatSync(folder);
        if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid())) continue;
        const events = join(folder, 'events.jsonl');
        const eventInfo = lstatSync(events);
        if (!eventInfo.isFile() || (process.getuid && eventInfo.uid !== process.getuid())) continue;
        paths.push(events);
        sessions.push({
          id        : row.sessionId,
          cwd       : row.projectDir,
          title     :
            typeof row.taskName === 'string' ? row.taskName.slice(0, 120) : 'Junie session',
          harness   : 'junie',
          // Neither task status nor the TUI-only process registry proves no ACP owner exists.
          resumable : false,
          updatedAt : new Date(row.updatedAt).toISOString(),
          files     : [index, events],
          read      : () => messages(events),
        });
      } catch {
        // Junie can remove or rotate a saved session while the index is being read.
      }
    }
  } catch {
    // Discovery remains read-only and works on machines without Junie installed.
  }
  return { sessions, paths, warnings: [] };
}
