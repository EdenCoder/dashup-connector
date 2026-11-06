import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { closeSync, existsSync, openSync, readSync, realpathSync, readdirSync, statSync } from 'node:fs';

import { HISTORY_TOOL_CHARS } from '@dashup/protocol';
import type { Message, ToolStep } from '@dashup/protocol';
import { contextUsage, type ContextUsage } from '@dashup/protocol/context';

import { scanJunieHistories } from './junie-history';
import { EARLIER, attached, toolInput, sessionKey, type Settings, type HistorySession, type NativeAttachment } from './session';

// =============================================================================
// Native files
// =============================================================================

type NativeRecord = Record<string, any>;
type Scan = { sessions: HistorySession[]; paths: Set<string>; warnings: string[] };
type Stamp = { size: number; mtimeMs: number; ino: number };
type Journal = { stamp: Stamp; start: number; offset: number; tail: Buffer; rows: NativeRecord[] };
type Metadata = { stamp: Stamp; value: unknown };
type Marked   = { stamp: Stamp; row: NativeRecord | undefined };

const SAMPLE_BYTES = 128 * 1024;
const READ_BYTES   = 64 * 1024;
const TITLE_LIMIT  = 120;
// A conversation is read from its last 8 MB: the phone shows the latest messages, and a transcript
// hundreds of megabytes long would otherwise be parsed whole and held in memory. Only the most
// recently read files stay parsed.
const LATEST_BYTES = 8 * 1024 * 1024;
const JOURNALS     = 16;
// A record an agent writes only when a setting changes can lie anywhere in its file.
const SEARCH_BYTES = 1024 * 1024;
const MARKED       = 512;

const journals = new Map<string, Journal>();
// What each session file says about its session, until the file changes.
const metadata = new Map<string, Metadata>();
const marked   = new Map<string, Marked>();

function object(value: unknown): NativeRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as NativeRecord)
    : undefined;
}

function list(value: unknown): NativeRecord[] {
  return Array.isArray(value) ? value : [];
}

function parse(value: string): NativeRecord | undefined {
  try {
    return object(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function records(buffer: Buffer): NativeRecord[] {
  return buffer
    .toString('utf8')
    .split('\n')
    .map(parse)
    .filter((row): row is NativeRecord => !!row);
}

function unchanged(left: Stamp, right: Stamp): boolean {
  return left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function readRange(path: string, start: number, length: number): Buffer {
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const count = readSync(fd, buffer, offset, length - offset, start + offset);
      if (!count) break;
      offset += count;
    }
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

// What a session file says about its session, read again only once the file changes. The head
// names a session. The tail reaches back at least SAMPLE_BYTES, and on to the newest row `until`
// accepts, however large the records written after it.
function described<T>(
  path: string,
  until: (row: NativeRecord) => boolean,
  describe: (rows: NativeRecord[], stamp: Stamp) => T,
): T {
  const stamp = statSync(path);
  const saved = metadata.get(path);
  if (saved && unchanged(saved.stamp, stamp)) return saved.value as T;
  let head = readRange(path, 0, Math.min(stamp.size, SAMPLE_BYTES));
  if (head.length < stamp.size && head.at(-1) !== 10) {
    const chunks = [head];
    let offset = head.length;
    while (offset < stamp.size) {
      const chunk = readRange(path, offset, Math.min(READ_BYTES, stamp.size - offset));
      const end = chunk.indexOf(10);
      chunks.push(end < 0 ? chunk : chunk.subarray(0, end + 1));
      offset += chunk.length;
      if (end >= 0 || !chunk.length) break;
    }
    head = Buffer.concat(chunks);
  }
  let tail: NativeRecord[] = [];
  for (let bytes = SAMPLE_BYTES; stamp.size > head.length; bytes *= 2) {
    const start  = Math.max(head.length, stamp.size - bytes);
    const buffer = readRange(path, start, stamp.size - start);
    tail = records(
      readRange(path, start - 1, 1)[0] === 10 ? buffer : buffer.subarray(buffer.indexOf(10) + 1),
    );
    if (start === head.length || tail.some(until)) break;
  }
  const value = describe([...records(head), ...tail], stamp);
  metadata.set(path, { stamp, value });
  return value;
}

// The whole records in a file's last `bytes`.
export function lastRecords(path: string, bytes: number): NativeRecord[] {
  const { size } = statSync(path);
  const start  = Math.max(0, size - bytes);
  const buffer = readRange(path, start, size - start);
  return records(
    !start || readRange(path, start - 1, 1)[0] === 10
      ? buffer
      : buffer.subarray(buffer.indexOf(10) + 1),
  );
}

// The newest record whose line holds `marker`, however far back. A file searched before is searched
// again only from a little before where it ended.
function newest(
  path: string,
  marker: string | RegExp,
  accepts?: (row: NativeRecord) => boolean,
): NativeRecord | undefined {
  const key   = `${path}\0${marker}`;
  const stamp = statSync(path);
  const saved = marked.get(key);
  if (saved && unchanged(saved.stamp, stamp)) return saved.row;
  const grown = saved && saved.stamp.ino === stamp.ino && saved.stamp.size <= stamp.size;
  const start = grown ? Math.max(0, saved.stamp.size - SEARCH_BYTES) : 0;
  const row   = search(path, marker, start, stamp.size, accepts) ?? (grown ? saved.row : undefined);
  marked.delete(key);
  marked.set(key, { stamp, row });
  if (marked.size > MARKED) marked.delete(marked.keys().next().value!);
  return row;
}

// Reads back from `to` a chunk at a time; a line a chunk cuts is finished by the next one read.
function search(
  path: string,
  marker: string | RegExp,
  from: number,
  to: number,
  accepts?: (row: NativeRecord) => boolean,
): NativeRecord | undefined {
  let carry    = Buffer.alloc(0);
  let position = to;
  while (position > from) {
    const begin  = Math.max(from, position - SEARCH_BYTES);
    const buffer = Buffer.concat([readRange(path, begin, position - begin), carry]);
    const first  = begin > from ? buffer.indexOf(10) + 1 : 0;
    position = begin;
    if (begin > from && !first) {
      carry = buffer;
      continue;
    }
    const lines = buffer.subarray(first).toString('utf8').split('\n');
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = lines[index]!;
      const matches = typeof marker === 'string' ? line.includes(marker) : marker.test(line);
      const row = matches ? parse(line) : undefined;
      if (row && (!accepts || accepts(row))) return row;
    }
    carry = buffer.subarray(0, first);
  }
  return undefined;
}

// Keep the final unterminated line uncommitted: an append may finish its JSON or UTF-8.
// Messages read from a file's last LATEST_BYTES say that earlier ones exist.
const windowed = (path: string, messages: Message[]): Message[] =>
  journals.get(path)?.start ? [EARLIER, ...messages] : messages;

// Every record of a JSONL file, or with `latest` only those in its last LATEST_BYTES. Appends are
// read incrementally; a window grown to twice its size starts again from the end.
function journal(path: string, latest = false): NativeRecord[] {
  const stamp = statSync(path);
  let saved = journals.get(path);
  if (saved && unchanged(saved.stamp, stamp)) {
    journals.delete(path);
    journals.set(path, saved);
    const tail = parse(saved.tail.toString('utf8'));
    return tail ? [...saved.rows, tail] : saved.rows;
  }
  if (
    !saved ||
    saved.stamp.ino !== stamp.ino ||
    stamp.size <= saved.offset ||
    (latest && stamp.size - saved.start > 2 * LATEST_BYTES)
  ) {
    const start = latest ? Math.max(0, stamp.size - LATEST_BYTES) : 0;
    saved = { stamp, start, offset: start, tail: Buffer.alloc(0), rows: [] };
  }
  while (saved.offset < stamp.size) {
    const chunk = readRange(path, saved.offset, Math.min(READ_BYTES, stamp.size - saved.offset));
    if (!chunk.length) break;
    // A window starting inside a record begins after its end.
    const first = saved.offset === saved.start && saved.start > 0;
    saved.offset += chunk.length;
    const buffer = Buffer.concat([saved.tail, chunk]);
    const end = buffer.lastIndexOf(10);
    if (end < 0) {
      saved.tail = first ? Buffer.alloc(0) : buffer;
      continue;
    }
    const lines = buffer.subarray(0, end).toString('utf8').split('\n');
    for (const line of first ? lines.slice(1) : lines) {
      const row = parse(line);
      if (row) saved.rows.push(row);
    }
    saved.tail = Buffer.from(buffer.subarray(end + 1));
  }
  saved.stamp = stamp;
  journals.delete(path);
  journals.set(path, saved);
  if (journals.size > JOURNALS) journals.delete(journals.keys().next().value!);
  const tail = parse(saved.tail.toString('utf8'));
  return tail ? [...saved.rows, tail] : saved.rows;
}

function files(root: string, scan: Scan, depth = Infinity): string[] {
  if (!existsSync(root)) {
    watchParent(root, scan);
    return [];
  }
  scan.paths.add(root);
  try {
    return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory() && depth > 0) return files(path, scan, depth - 1);
      return entry.isFile() ? [path] : [];
    });
  } catch {
    scan.warnings.push(`Cannot read session directory: ${root}`);
    return [];
  }
}

function watchParent(path: string, scan: Scan): void {
  while (!existsSync(path) && dirname(path) !== path) path = dirname(path);
  if (existsSync(path)) scan.paths.add(path);
}

function canonical(cwd: unknown): string | undefined {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return undefined;
  try {
    return realpathSync.native(cwd);
  } catch {
    return resolve(cwd);
  }
}

const instant = (value: unknown): number =>
  typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;

function date(value: unknown, fallback: number): string {
  const time = instant(value);
  return new Date(Number.isFinite(time) ? time : fallback).toISOString();
}

function title(value: unknown, fallback: string): string {
  const text = typeof value === 'string' ? value.trim().split('\n')[0]!.trim() : '';
  return text ? text.slice(0, TITLE_LIMIT) : fallback;
}

// Agents add their own user messages: Codex its instructions (AGENTS.md under a heading, the rest
// in tags), Claude Code its slash commands and their output in tags. None is what the person typed.
const injected = (content: unknown): boolean =>
  /^\s*(# AGENTS\.md instructions for |<[a-z_][\w -]*>)/i.test(text(content));

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join('\n');
  const part = object(value);
  return part ? (typeof part.text === 'string' ? part.text : text(part.content)) : '';
}

const DATA_URL = /^data:([^;,]+);base64,/;

// The images and files content holds as base64: Claude's image and document blocks, Codex's
// image data URLs and OpenCode's file parts.
function attachments(id: string, content: unknown): NativeAttachment[] {
  return list(content).flatMap((part, index): NativeAttachment[] => {
    const key    = `${id}:${index}`;
    const name   = [part?.title, part?.filename].find((value) => typeof value === 'string');
    const source = object(part?.source);
    if (source?.type === 'base64' && typeof source.data === 'string')
      return [attached(key, String(source.media_type), source.data, name)];
    const url  = String(object(part?.image_url)?.url ?? part?.image_url ?? part?.url ?? '');
    const data = DATA_URL.exec(url);
    return data ? [attached(key, data[1]!, url.slice(data[0].length), name)] : [];
  });
}

// A message's readable parts and the files it holds; its tool parts become steps of their own.
function prose(id: string, role: Message['role'], content: unknown): Message[] {
  const value = text(
    Array.isArray(content)
      ? content.filter(
          (part) =>
            typeof part === 'string' || ['text', 'input_text', 'output_text'].includes(part?.type),
        )
      : content,
  );
  const files = attachments(id, content);
  return value || files.length
    ? [{ id, role, text: value, ...(files.length ? { attachments: files } : {}) }]
    : [];
}

// =============================================================================
// Tool steps
// =============================================================================

type Result = {
  text         : string;
  status?      : ToolStep['status'];
  ms?          : number;
  diff?        : string;
  attachments? : NativeAttachment[];
};

// A step names its shell command, file or search pattern, else its input. The order is
// load-bearing: a search also names the directory it searches.
const SUMMARY_FIELDS = [
  'command',
  'cmd',
  'file_path',
  'filePath',
  'notebook_path',
  'pattern',
  'query',
  'path',
  'url',
  'description',
  'patchText',
];

// Codex and OpenCode apply_patch bodies are unified hunks under one header per file.
const PATCH_FILE = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;

// A patch is named by its files, a question by what it asks, any other input by its text.
function describe(input: unknown): string | undefined {
  const fields = object(input);
  const named  = SUMMARY_FIELDS.map((key) => fields?.[key]).find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  );
  const asked  = list(fields?.questions)
    .map((item) => item?.question)
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .join('\n');
  const value  =
    typeof input === 'string'
      ? input
      : (named ?? (asked || (fields && Object.keys(fields).length ? JSON.stringify(fields) : '')));
  const paths  = [...value.matchAll(PATCH_FILE)].map((match) => match[2]).join(', ');
  return (paths || value.trim()).slice(0, HISTORY_TOOL_CHARS) || undefined;
}

// What the agent said a step does, as a shell command's `description` says it.
function said(input: unknown, summary?: string): string | undefined {
  const value = object(input)?.description;
  const line  = typeof value === 'string' ? value.trim().split('\n')[0]! : '';
  return line && line !== summary ? line.slice(0, HISTORY_TOOL_CHARS) : undefined;
}

function elapsed(start: unknown, end: unknown): number | undefined {
  const ms = instant(end) - instant(start);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : undefined;
}

// A created file's change is every line it holds.
function added(path: string, content: string): string {
  const lines = content.replace(/\n$/, '').split('\n');
  return [
    '--- /dev/null',
    `+++ ${path}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((line) => `+${line}`),
  ].join('\n');
}

// A binary file's change holds its bytes, which git tells apart by a NUL near the start.
const binary = (diff: string): boolean => diff.slice(0, 8_000).includes('\0');

// A tool call joined with its result: the output, or the change once an edit applied. A step is
// timed once it finishes.
// A step still running says when it started.
function step(
  id: string,
  name: unknown,
  input: unknown,
  result?: Result,
  started?: unknown,
): Message {
  const summary = describe(input);
  const label   = said(input, summary);
  const full    = toolInput(id, input);
  const at      = instant(started);
  const diff    =
    result?.status === 'ok' && result.diff && !binary(result.diff) ? result.diff : undefined;
  return {
    id,
    role : 'tool',
    text : diff || result?.text || '',
    tool : {
      name: typeof name === 'string' && name ? name.slice(0, HISTORY_TOOL_CHARS) : 'Tool',
      ...(label ? { label } : {}),
      ...(summary ? { summary } : {}),
      ...(full ? { input: full } : {}),
      ...(result?.status ? { status: result.status } : {}),
      ...(result?.status && result.ms !== undefined ? { ms: result.ms } : {}),
      ...(!result?.status && Number.isFinite(at) ? { at: new Date(at).toISOString() } : {}),
      ...(diff ? { diff: true } : {}),
    },
    ...(result?.attachments?.length ? { attachments: result.attachments } : {}),
  };
}

function latestStep(messages: Message[]): ToolStep | undefined {
  const tool = messages.filter((message) => message.tool).at(-1)?.tool;
  if (!tool) return undefined;
  const { input, ...summary } = tool;
  return summary;
}

// =============================================================================
// Claude Code
// =============================================================================

export const claudeHome = (): string => process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');

// Message rows stamp the conversation; sidechain rows belong to subagent turns.
const claudeMessage = (row: NativeRecord): boolean =>
  (row.type === 'user' || row.type === 'assistant') && !row.isSidechain;

// Claude Code records a slash command the person ran as a user row naming it in tags, and its
// output as a system row after it. Its own additions, such as a loaded skill, are meta rows.
const OUTPUT_TAGS = /<\/?local-command-std\w+>/g;
const claudeOutput = (row: NativeRecord): string | undefined =>
  row.type === 'system' && row.subtype === 'local_command'
    ? text(row.content).replace(OUTPUT_TAGS, '').trim()
    : undefined;

function claudeCommand(value: string): string | undefined {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(value)?.[1];
  const args = /<command-args>([^<]*)<\/command-args>/.exec(value)?.[1] ?? '';
  return name === undefined ? undefined : `${name} ${args}`.trim();
}

// Claude records an applied edit as unified hunks, and a created file by its content.
function claudeChange(change: NativeRecord | undefined): string | undefined {
  if (typeof change?.filePath !== 'string') return undefined;
  const hunks = list(change.structuredPatch);
  if (!hunks.length)
    return change.type === 'create' && typeof change.content === 'string'
      ? added(change.filePath, change.content)
      : undefined;
  return [
    `--- ${change.filePath}`,
    `+++ ${change.filePath}`,
    ...hunks.flatMap((hunk) => [
      `@@ -${hunk?.oldStart},${hunk?.oldLines} +${hunk?.newStart},${hunk?.newLines} @@`,
      ...list(hunk?.lines),
    ]),
  ].join('\n');
}

function claudeMessages(path: string): Message[] {
  const rows = journal(path, true);
  const chain = new Map<string, NativeRecord>();
  let leaf: string | undefined;
  for (const row of rows) {
    if (typeof row.uuid === 'string' && !row.isSidechain) {
      chain.set(row.uuid, row);
      if (row.type === 'user' || row.type === 'assistant' || claudeOutput(row) !== undefined)
        leaf = row.uuid;
    }
    if (typeof row.leafUuid === 'string' && chain.has(row.leafUuid)) leaf = row.leafUuid;
  }
  const selected: NativeRecord[] = [];
  const seen = new Set<string>();
  while (leaf && !seen.has(leaf)) {
    seen.add(leaf);
    const row = chain.get(leaf);
    if (!row) break;
    selected.push(row);
    leaf = typeof row.parentUuid === 'string' ? row.parentUuid : undefined;
  }
  const conversation = selected.length ? selected.reverse() : rows;
  return windowed(path, claudeConversation(conversation, rows));
}

function claudeConversation(conversation: NativeRecord[], rows: NativeRecord[]): Message[] {
  // A result joins the call it answers. Parallel calls leave their results on side branches, and
  // request records repeat earlier content, so only user rows answer.
  const results = new Map<unknown, { part: NativeRecord; row: NativeRecord }>();
  for (const row of rows)
    for (const part of row.type === 'user' ? list(row.message?.content) : [])
      if (part?.type === 'tool_result') results.set(part.tool_use_id, { part, row });
  return conversation.flatMap((row, index): Message[] => {
    const id      = String(row.uuid ?? row.message?.id ?? index);
    const content = row.message?.content;
    const output  = claudeOutput(row);
    const command = row.type === 'user' ? claudeCommand(text(content)) : undefined;
    if (output !== undefined) return prose(id, 'system', output);
    if ((row.type !== 'user' && row.type !== 'assistant') || row.isMeta) return [];
    if (command !== undefined) return [{ id, role: 'user', text: command }];
    return [
      ...prose(id, row.type, content),
      ...list(content).flatMap((part, position) => {
        if (part?.type !== 'tool_use') return [];
        const result = results.get(part.id);
        const call   = String(part.id ?? `${id}:${position}`);
        return [
          step(
            call,
            part.name,
            part.input,
            result && {
              text        : text(result.part.content),
              status      : result.part.is_error ? 'error' : 'ok',
              ms          : elapsed(row.timestamp, result.row.timestamp),
              diff        : claudeChange(object(result.row.toolUseResult)),
              attachments : attachments(call, result.part.content),
            },
            row.timestamp,
          ),
        ];
      }),
    ];
  });
}

// What a transcript says its session last ran with: the model of its newest reply and whether
// fast mode served it, and whether ultracode was last turned on or off. Claude Code records a
// switch when the next turn starts, so a change shows from the reply after it.
function claudeSettings(path: string): Settings {
  const rows   = journal(path, true);
  const marker = object(newest(path, '"ultra_effort_')?.attachment)?.type;
  const mode = newest(path, '"permissionMode"')?.permissionMode;
  const auto: Settings = typeof mode === 'string' ? { auto: mode === 'auto' } : {};
  for (let index = rows.length - 1; index >= 0; index--) {
    const row     = rows[index]!;
    const message = object(row.message);
    if (
      row.type === 'assistant' &&
      !row.isSidechain &&
      typeof message?.model === 'string' &&
      message.model !== '<synthetic>'
    )
      return {
        model     : message.model,
        fast      : object(message.usage)?.speed === 'fast',
        ultracode : marker === 'ultra_effort_enter',
        ...auto,
      };
  }
  return { ultracode: marker === 'ultra_effort_enter', ...auto };
}

function claude(root: string, scan: Scan): void {
  for (const path of files(join(root, 'projects'), scan, 1).filter((file) =>
    file.endsWith('.jsonl'))) {
    try {
      const session = described(path, claudeMessage, (rows, stamp) => {
        const latest = [...rows].reverse();
        const owner = rows.find((row) => typeof row.sessionId === 'string' && canonical(row.cwd));
        if (!owner) return undefined;
        const named = latest.find((row) => row.type === 'custom-title' || row.type === 'ai-title');
        const first = rows.find(
          (row) =>
            row.type === 'user' &&
            !row.isMeta &&
            !row.isSidechain &&
            !injected(row.message?.content),
        );
        const acted = latest.find(
          (row) =>
            claudeMessage(row) &&
            list(row.message?.content).some((part) => part?.type === 'tool_use'),
        );
        return {
          id        : String(owner.sessionId),
          cwd       : canonical(owner.cwd)!,
          title     : title(
            named?.customTitle ?? named?.aiTitle ?? text(first?.message?.content),
            'Claude Code thread',
          ),
          updatedAt : date(latest.find(claudeMessage)?.timestamp, stamp.mtimeMs),
          step      : acted && latestStep(claudeConversation([acted], rows)),
        };
      });
      if (!session) {
        scan.warnings.push(`Unrecognized Claude Code session: ${path}`);
        continue;
      }
      scan.sessions.push({
        harness  : 'claude',
        ...session,
        files    : [path],
        read     : () => claudeMessages(path),
        settings : () => claudeSettings(path),
      });
    } catch {
      scan.warnings.push(`Cannot read Claude Code session: ${path}`);
    }
  }
}

// =============================================================================
// Codex
// =============================================================================

// Response items are the conversation; the event rows after them are Codex bookkeeping.
const codexItem = (row: NativeRecord): boolean => row.type === 'response_item';

const CODEX_LIFECYCLE = /"type"\s*:\s*"(?:task_started|task_complete|turn_aborted)"/;

// Turns can outgrow the sampled conversation tail; their last lifecycle marker still owns status.
function codexStatus(path: string): ReturnType<NonNullable<HistorySession['status']>> {
  const row = newest(
    path,
    CODEX_LIFECYCLE,
    (row) =>
      row.type === 'event_msg' &&
      ['task_started', 'task_complete', 'turn_aborted'].includes(row.payload?.type),
  );
  return row ? (row.payload.type === 'task_started' ? 'working' : 'idle') : undefined;
}

// A tool output opens with `Key: value` lines ending at `Output:`, or is a single line of its own.
// That head says whether the call is still running or failed.
const CODEX_OUTPUT  = /^([\s\S]*?)\nOutput:\n\n?([\s\S]*)$/;
const CODEX_RUNNING = /^(?:Process|Script) running with /m;
const CODEX_FAILED  =
  /^(?:Script failed|aborted by user|apply_patch verification failed|(?:Process exited with code|Exit code:) (?!0$)-?\d+$)/m;

function codexResult(output: string): Result {
  const [, head = output.split('\n', 1)[0] ?? '', body = output] = CODEX_OUTPUT.exec(output) ?? [];
  return {
    text   : body,
    status : CODEX_RUNNING.test(head) ? undefined : CODEX_FAILED.test(head) ? 'error' : 'ok',
  };
}

// An apply_patch body reads as a unified diff once its file headers become `---`/`+++` lines and
// its other `***` markers drop.
function applyPatch(patch: string): string {
  return patch
    .replace(
      PATCH_FILE,
      (_, kind, path) =>
        `--- ${kind === 'Add' ? '/dev/null' : path}\n+++ ${kind === 'Delete' ? '/dev/null' : path}`,
    )
    .replace(/^\*\*\* .*\n?/gm, '');
}

// What a rollout says its thread last ran with: the model and reasoning effort of its newest turn
// or settings, and whether its newest settings asked for the priority tier, Codex's fast mode.
function codexSettings(path: string): Settings {
  const rows    = journal(path, true);
  const applied = object(newest(path, '"thread_settings_applied"')?.payload?.thread_settings);
  const fast: Settings = applied ? { fast: applied.service_tier === 'priority' } : {};
  const review = applied?.approvals_reviewer;
  const auto: Settings = typeof review === 'string' ? { auto: review === 'auto_review' } : {};
  for (let index = rows.length - 1; index >= 0; index--) {
    const row      = rows[index]!;
    const turn     = row.type === 'turn_context' ? object(row.payload) : undefined;
    const settings =
      row.payload?.type === 'thread_settings_applied'
        ? object(row.payload.thread_settings)
        : undefined;
    const model    = settings?.model ?? turn?.model;
    const effort   = settings?.reasoning_effort ?? turn?.effort;
    if (typeof model === 'string')
      return {
        model,
        ...(typeof effort === 'string' ? { effort } : {}),
        ...fast,
        ...(typeof turn?.approvals_reviewer === 'string'
          ? { auto: turn.approvals_reviewer === 'auto_review' }
          : auto),
      };
  }
  return { ...fast, ...auto };
}

// Codex's latest usage describes the active context; its session total counts repeated inputs.
// A compacted history needs a new report before its former context size is useful again.
function codexContext(path: string): ContextUsage | undefined {
  const rows = journal(path, true);
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index]!;
    if (row.type === 'compacted') return undefined;
    if (row.type !== 'event_msg' || row.payload?.type !== 'token_count') continue;
    const info = row.payload.info;
    if (info == null) continue;
    return contextUsage(info.last_token_usage?.total_tokens, info.model_context_window);
  }
  return undefined;
}

function codexMessages(path: string): Message[] {
  return windowed(path, codexConversation(journal(path, true)));
}

// Codex surrounds native images with generated text blocks. Keep the image's original index
// and bytes, but leave those structural labels out of the person's message and delivery proof.
function codexContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const parts = [...content];
  for (let index = 0; index + 2 < parts.length; index++) {
    const [open, image, close] = parts.slice(index, index + 3);
    if (
      open?.type === 'input_text' &&
      typeof open.text === 'string' &&
      /^<image name=\[Image #\d+\] path="[^"\r\n]+">$/.test(open.text) &&
      image?.type === 'input_image' &&
      close?.type === 'input_text' &&
      close.text === '</image>'
    ) {
      parts[index] = { ...open, text: '' };
      parts[index + 2] = { ...close, text: '' };
      index += 2;
    }
  }
  return parts;
}

function codexConversation(rows: NativeRecord[]): Message[] {
  // An output row answers the call that shares its `call_id`.
  const outputs = new Map<unknown, NativeRecord>();
  for (const row of rows)
    if (['function_call_output', 'custom_tool_call_output'].includes(row.payload?.type))
      outputs.set(row.payload.call_id, row);
  const result = rows.flatMap((row, index): Message[] => {
    if (!codexItem(row)) return [];
    const item = object(row.payload);
    if (!item) return [];
    const id = String(item.id ?? row.ordinal ?? `${index}`);
    if (item.type === 'message' && ['user', 'assistant'].includes(item.role))
      return item.role === 'user' && injected(item.content)
        ? []
        : prose(id, item.role, item.role === 'user' ? codexContent(item.content) : item.content);
    if (!['function_call', 'custom_tool_call'].includes(item.type)) return [];
    const input  =
      item.type === 'function_call'
        ? (parse(String(item.arguments)) ?? item.arguments)
        : item.input;
    const output = outputs.get(item.call_id);
    const patch  = item.name === 'apply_patch' && typeof input === 'string' ? input : '';
    const call   = String(item.call_id ?? id);
    return [
      step(
        call,
        item.name,
        input,
        output && {
          ...codexResult(text(output.payload.output)),
          ms          : elapsed(row.timestamp, output.timestamp),
          diff        : patch && applyPatch(patch),
          attachments : attachments(call, output.payload.output),
        },
        row.timestamp,
      ),
    ];
  });
  if (result.length) return result;
  return rows.flatMap((row, index): Message[] => {
    if (row.type !== 'event_msg') return [];
    const item = object(row.payload);
    if (!item || !['user_message', 'agent_message'].includes(item.type)) return [];
    return prose(
      String(row.ordinal ?? index),
      item.type === 'user_message' ? 'user' : 'assistant',
      item.message,
    );
  });
}

function codex(root: string, scan: Scan): void {
  const index = join(root, 'session_index.jsonl');
  const names = new Map<string, NativeRecord>();
  if (existsSync(index)) {
    scan.paths.add(root);
    try {
      for (const row of journal(index)) if (typeof row.id === 'string') names.set(row.id, row);
    } catch {
      scan.warnings.push(`Cannot read Codex session index: ${index}`);
    }
  }
  const titles  = codexTitles(root);
  const indexed = existsSync(index);
  for (const path of [
    ...files(join(root, 'sessions'), scan),
    ...files(join(root, 'archived_sessions'), scan),
  ].filter((file) => file.endsWith('.jsonl'))) {
    try {
      const session = described(path, codexItem, (rows, stamp) => {
        const owner = rows.find((row) => row.type === 'session_meta')?.payload;
        const cwd = canonical(owner?.cwd);
        if (typeof owner?.id !== 'string' || !cwd) return undefined;
        const first = rows.find(
          (row) =>
            row.type === 'response_item' &&
            row.payload?.type === 'message' &&
            row.payload.role === 'user' &&
            !injected(row.payload.content),
        );
        const parent = owner.parent_thread_id;
        return {
          id        : owner.id as string,
          cwd,
          asked     : text(first?.payload?.content),
          parent    : typeof parent === 'string' ? parent : undefined,
          updatedAt : date([...rows].reverse().find(codexItem)?.timestamp, stamp.mtimeMs),
          step      : latestStep(codexConversation(rows)),
        };
      });
      if (!session) {
        scan.warnings.push(`Unrecognized Codex session: ${path}`);
        continue;
      }
      const { asked, ...found } = session;
      scan.sessions.push({
        harness  : 'codex',
        ...found,
        title    : title(
          names.get(found.id)?.thread_name ?? titles.get(found.id) ?? asked,
          'Codex thread',
        ),
        files    : [path, ...(indexed ? [index] : [])],
        read     : () => codexMessages(path),
        settings : () => codexSettings(path),
        context  : () => codexContext(path),
        status   : () => codexStatus(path),
      });
    } catch {
      scan.warnings.push(`Cannot read Codex session: ${path}`);
    }
  }
}

// =============================================================================
// Kimi Code
// =============================================================================

export const kimiHome = (): string => process.env.DASHUP_KIMI_HOME ?? join(homedir(), '.kimi');

// Kimi marks a failed tool call by the opening of its result.
const KIMI_FAILED = /^<system>ERROR/;

// A session's conversation is its `context.jsonl`; compacting folds earlier turns into
// `context_<n>.jsonl` beside it. Kimi's own rows start with `_`, and its compaction summary
// opens the context as a tagged user message.
function kimiMessages(directory: string): Message[] {
  const path    = join(directory, 'context.jsonl');
  const rows    = journal(path, true);
  const results = new Map<unknown, NativeRecord>();
  for (const row of rows) if (row.role === 'tool') results.set(row.tool_call_id, row);
  const messages = rows.flatMap((row, index): Message[] => {
    const id = String(index);
    if (row.role === 'user') return injected(row.content) ? [] : prose(id, 'user', row.content);
    if (row.role !== 'assistant') return [];
    return [
      ...prose(id, 'assistant', row.content),
      ...list(row.tool_calls).map((call, position) => {
        const result = results.get(call?.id);
        const output = result && text(result.content);
        return step(
          String(call?.id ?? `${id}:${position}`),
          call?.function?.name,
          parse(String(call?.function?.arguments ?? '')) ?? call?.function?.arguments,
          result && {
            text        : output!,
            status      : KIMI_FAILED.test(output!) ? 'error' : 'ok',
            attachments : attachments(String(call?.id), result.content),
          },
        );
      }),
    ];
  });
  const shown = windowed(path, messages);
  return existsSync(join(directory, 'context_1.jsonl')) && shown[0] !== EARLIER
    ? [EARLIER, ...shown]
    : shown;
}

// Kimi records a session's plan mode in its state, and not the model it ran on.
function kimiSettings(directory: string): Settings {
  const state = existsSync(join(directory, 'state.json'))
    ? jsonFile(join(directory, 'state.json'))
    : undefined;
  return typeof state?.plan_mode === 'boolean' ? { plan: state.plan_mode } : {};
}

// Each work folder's sessions sit under the MD5 of its path, which `kimi.json` lists.
function kimi(root: string, scan: Scan): void {
  const listed = existsSync(join(root, 'kimi.json'))
    ? jsonFile(join(root, 'kimi.json'))
    : undefined;
  if (listed) scan.paths.add(root);
  for (const entry of list(listed?.work_dirs)) {
    const cwd = canonical(entry?.path);
    if (!cwd) continue;
    const folder = join(root, 'sessions', createHash('md5').update(entry.path).digest('hex'));
    if (!existsSync(folder)) continue;
    scan.paths.add(folder);
    for (const id of readdirSync(folder)) {
      const directory = join(folder, id);
      const context   = join(directory, 'context.jsonl');
      const wire      = join(directory, 'wire.jsonl');
      if (!existsSync(context)) continue;
      scan.paths.add(directory);
      try {
        const state = existsSync(join(directory, 'state.json'))
          ? jsonFile(join(directory, 'state.json'))
          : undefined;
        if (state?.archived === true) continue;
        const asked = described(
          context,
          (row) => row.role === 'user',
          (rows) =>
            text(rows.find((row) => row.role === 'user' && !injected(row.content))?.content),
        );
        // A turn's events carry their time; the context's rows do not.
        const updated = existsSync(wire)
          ? described(
              wire,
              (row) => typeof row.timestamp === 'number',
              (rows) =>
                [...rows].reverse().find((row) => typeof row.timestamp === 'number')?.timestamp,
            )
          : undefined;
        scan.sessions.push({
          id,
          cwd,
          harness   : 'kimi',
          title     : title(state?.custom_title || asked, 'Kimi thread'),
          updatedAt : date(
            typeof updated === 'number' ? updated * 1000 : undefined,
            statSync(context).mtimeMs,
          ),
          files     : [context, ...(existsSync(wire) ? [wire] : [])],
          read      : () => kimiMessages(directory),
          settings  : () => kimiSettings(directory),
        });
      } catch {
        scan.warnings.push(`Cannot read Kimi session: ${directory}`);
      }
    }
  }
}

// =============================================================================
// OpenCode
// =============================================================================

// OpenCode keeps an applied edit's unified diff; a write marks a new file `exists: false`.
function openCodeChange(state: NativeRecord): string | undefined {
  const metadata = object(state.metadata);
  const input    = object(state.input);
  if (typeof metadata?.diff === 'string') return metadata.diff.replace(/^(?:Index: .*|=+)\n/gm, '');
  return metadata?.exists === false &&
    typeof input?.filePath === 'string' &&
    typeof input.content === 'string'
    ? added(input.filePath, input.content)
    : undefined;
}

function openCodeParts(id: string, role: Message['role'], parts: NativeRecord[]): Message[] {
  return parts.flatMap((part, index): Message[] => {
    const key = String(part.id ?? `${id}:${index}`);
    if (part.type === 'text' && typeof part.text === 'string')
      return [{ id: key, role, text: part.text }];
    if (part.type === 'file') {
      const files = attachments(key, [part]);
      return files.length ? [{ id: key, role, text: '', attachments: files }] : [];
    }
    if (part.type !== 'tool') return [];
    const state  = object(part.state) ?? {};
    const status =
      state.status === 'completed' ? 'ok' : state.status === 'error' ? 'error' : undefined;
    return [
      step(
        key,
        part.tool,
        state.input,
        status && {
          text        : text(state.output ?? state.error),
          status,
          ms          : elapsed(state.time?.start, state.time?.end),
          diff        : openCodeChange(state),
          attachments : attachments(key, state.attachments),
        },
        state.time?.start,
      ),
    ];
  });
}

function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA query_only = ON');
  return db;
}

function databaseMessages(path: string, session: string): Message[] {
  const db = openDatabase(path);
  try {
    db.exec('BEGIN');
    const messages = db
      .prepare('SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created, id')
      .all(session) as NativeRecord[];
    const parts = db
      .prepare(
        'SELECT id, message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id',
      )
      .all(session) as NativeRecord[];
    const grouped = new Map<string, NativeRecord[]>();
    for (const part of parts) {
      const data = parse(String(part.data));
      if (!data) continue;
      const group = grouped.get(part.message_id) ?? [];
      group.push({ ...data, id: part.id });
      grouped.set(part.message_id, group);
    }
    return messages.flatMap((message) => {
      const data = parse(String(message.data));
      return data && ['user', 'assistant'].includes(data.role)
        ? openCodeParts(message.id, data.role, grouped.get(message.id) ?? [])
        : [];
    });
  } finally {
    db.close();
  }
}

// A session runs on the model and agent of its last message from the person.
function databaseSettings(path: string, session: string): Settings {
  const db = openDatabase(path);
  try {
    const row = db
      .prepare(
        "SELECT data FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'user' ORDER BY time_created DESC LIMIT 1",
      )
      .get(session) as NativeRecord | undefined;
    const data  = parse(String(row?.data ?? ''));
    const model = object(data?.model);
    return {
      ...(typeof model?.providerID === 'string' && typeof model.modelID === 'string'
        ? { model: `${model.providerID}/${model.modelID}` }
        : {}),
      ...(typeof data?.agent === 'string' ? { agent: data.agent } : {}),
    };
  } finally {
    db.close();
  }
}

// OpenCode 2 keeps each message as a row of its own: the person's text and files, and the
// assistant's text and tool calls.
function sessionMessages(path: string, session: string): Message[] {
  const db = openDatabase(path);
  try {
    const rows = db
      .prepare(
        "SELECT id, type, data FROM session_message WHERE session_id = ? AND type IN ('user', 'assistant') ORDER BY seq",
      )
      .all(session) as NativeRecord[];
    return rows.flatMap((row): Message[] => {
      const data = parse(String(row.data));
      const id   = String(row.id);
      if (!data) return [];
      if (row.type === 'user') {
        const files = list(data.files)
          .filter((file) => typeof file?.data === 'string')
          .map((file, index) =>
            attached(`${id}:${index}`, String(file.mime), file.data, file.name));
        return [
          {
            id,
            role: 'user',
            text: text(data.text),
            ...(files.length ? { attachments: files } : {}),
          },
        ];
      }
      const content = list(data.content);
      return [
        ...prose(
          id,
          'assistant',
          content.filter((part) => part?.type === 'text'),
        ),
        ...content
          .filter((part) => part?.type === 'tool')
          .map((part) => {
            const state = object(part.state);
            return step(
              String(part.id ?? id),
              part.name,
              state?.input,
              state?.status === 'completed' || state?.status === 'error'
                ? {
                    text   : text(state.content) || String(object(state.error)?.message ?? ''),
                    status : state.status === 'error' ? 'error' : 'ok',
                  }
                : undefined,
              data.time?.created,
            );
          }),
      ];
    });
  } finally {
    db.close();
  }
}

// A subagent nobody typed to is named for its task, as Codex names it: "Beauvoir · camera review".
function codexSubagent(row: NativeRecord): string {
  const spawn = object(object(parse(String(row.source ?? '')))?.subagent)?.thread_spawn;
  const task = typeof spawn?.agent_path === 'string' ? spawn.agent_path.split('/').pop() : '';
  return [row.agent_nickname, task?.replace(/_/g, ' ')].filter(Boolean).join(' · ');
}

// Codex keeps each thread's title in its newest state database; older homes have none. It is read
// again only once the database or its write-ahead log changes.
let codexState: { stamp: string; titles: Map<string, string> } | undefined;

function codexTitles(root: string): Map<string, string> {
  const titles = new Map<string, string>();
  const state = (existsSync(root) ? readdirSync(root) : [])
    .filter((name) => /^state_\d+\.sqlite$/.test(name))
    .sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]))[0];
  if (!state) return titles;
  const path  = join(root, state);
  const stamp = [path, `${path}-wal`]
    .map((file) => statSync(file, { throwIfNoEntry: false }))
    .map((found) => (found ? `${found.ino}:${found.size}:${found.mtimeMs}` : ''))
    .join('|');
  if (codexState?.stamp === stamp) return codexState.titles;
  codexState = { stamp, titles };
  let db: DatabaseSync | undefined;
  try {
    db = openDatabase(path);
    for (const row of db
      .prepare('SELECT id, title, first_user_message, source, agent_nickname FROM threads')
      .all() as NativeRecord[]) {
      const name = [row.title, row.first_user_message].find(
        (value): value is string => typeof value === 'string' && !!value.trim() && !injected(value),
      );
      if (typeof row.id === 'string') titles.set(row.id, name ?? codexSubagent(row));
    }
  } catch {
    // A state database of another shape leaves titles to the session files.
  } finally {
    db?.close();
  }
  return titles;
}

function openCodeDatabase(path: string, scan: Scan): void {
  if (!existsSync(path)) {
    watchParent(path, scan);
    return;
  }
  scan.paths.add(dirname(path));
  let db: DatabaseSync | undefined;
  try {
    db = openDatabase(path);
    // A session is as recent as its newest message; OpenCode restamps `time_updated` in bulk.
    const sessions = db
      .prepare(
        'SELECT id, parent_id, directory, title, coalesce((SELECT max(time_created) FROM message WHERE session_id = session.id), time_created) AS updated FROM session',
      )
      .all() as NativeRecord[];
    const modified = statSync(path).mtimeMs;
    for (const row of sessions) {
      const cwd = canonical(row.directory);
      if (typeof row.id !== 'string' || !cwd) continue;
      scan.sessions.push({
        harness   : 'opencode',
        id        : row.id,
        cwd,
        title     : title(row.title, 'OpenCode thread'),
        parent    : typeof row.parent_id === 'string' ? row.parent_id : undefined,
        updatedAt : date(row.updated, modified),
        files     : [path, `${path}-wal`, `${path}-shm`],
        read      : () => databaseMessages(path, row.id),
        settings  : () => databaseSettings(path, row.id),
      });
    }
    // OpenCode 2 keeps its sessions in tables of their own, with the model and agent on each.
    const later = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'")
      .get();
    for (const row of later
      ? (db
          .prepare(
            "SELECT id, parent_id, directory, title, agent, model, coalesce((SELECT max(time_created) FROM session_message WHERE session_id = session_v2.id AND type IN ('user', 'assistant')), time_created) AS updated FROM session_v2 WHERE time_archived IS NULL",
          )
          .all() as NativeRecord[])
      : []) {
      const cwd   = canonical(row.directory);
      const model = object(parse(String(row.model ?? '')));
      if (typeof row.id !== 'string' || !cwd) continue;
      const settings: Settings = {
        ...(typeof model?.providerID === 'string' && typeof model.id === 'string'
          ? { model: `${model.providerID}/${model.id}` }
          : {}),
        ...(typeof row.agent === 'string' ? { agent: row.agent } : {}),
      };
      scan.sessions.push({
        harness   : 'opencode',
        id        : row.id,
        cwd,
        title     : title(row.title, 'OpenCode thread'),
        parent    : typeof row.parent_id === 'string' ? row.parent_id : undefined,
        updatedAt : date(row.updated, modified),
        files     : [path, `${path}-wal`, `${path}-shm`],
        read      : () => sessionMessages(path, row.id),
        settings  : () => settings,
      });
    }
  } catch {
    scan.warnings.push(`Unrecognized or unavailable OpenCode database: ${path}`);
  } finally {
    db?.close();
  }
}

function jsonFile(path: string): NativeRecord | undefined {
  return parse(readRange(path, 0, statSync(path).size).toString('utf8'));
}

function legacyMessages(root: string, session: string): Message[] {
  const scan: Scan = { sessions: [], paths: new Set(), warnings: [] };
  const messages = files(join(root, 'message', session), scan, 0)
    .map((path) => {
      try {
        return jsonFile(path);
      } catch {
        return undefined;
      }
    })
    .filter((message): message is NativeRecord => !!message);
  messages.sort(
    (left, right) =>
      (left.time?.created ?? 0) - (right.time?.created ?? 0) ||
      String(left.id).localeCompare(String(right.id)),
  );
  return messages.flatMap((message) => {
    if (!['user', 'assistant'].includes(message.role)) return [];
    const parts = files(join(root, 'part', message.id), scan, 0)
      .sort()
      .flatMap((path) => {
        try {
          const part = jsonFile(path);
          return part ? [part] : [];
        } catch {
          return [];
        }
      });
    return openCodeParts(message.id, message.role, parts);
  });
}

function openCodeLegacy(root: string, scan: Scan): void {
  const parts = join(root, 'part');
  if (existsSync(parts)) files(parts, scan, 1);
  for (const path of files(join(root, 'session'), scan).filter((file) => file.endsWith('.json'))) {
    try {
      const row = jsonFile(path);
      const cwd = canonical(row?.directory);
      if (typeof row?.id !== 'string' || !cwd) {
        scan.warnings.push(`Unrecognized OpenCode session: ${path}`);
        continue;
      }
      if (scan.sessions.some((session) => session.harness === 'opencode' && session.id === row.id))
        continue;
      scan.paths.add(root);
      const messages = join(root, 'message', row.id);
      // Message ids ascend with time, so the last file holds the newest message.
      const newest   = files(messages, scan, 0)
        .filter((file) => file.endsWith('.json'))
        .sort()
        .at(-1);
      scan.sessions.push({
        harness   : 'opencode',
        id        : row.id,
        cwd,
        title     : title(row.title, 'OpenCode thread'),
        parent    : typeof row.parentID === 'string' ? row.parentID : undefined,
        updatedAt : date(
          newest ? jsonFile(newest)?.time?.created : row.time?.created,
          statSync(path).mtimeMs,
        ),
        files     : [path, messages, join(root, 'part')],
        read      : () => legacyMessages(root, row.id),
      });
    } catch {
      scan.warnings.push(`Cannot read OpenCode session: ${path}`);
    }
  }
}

// =============================================================================
// Discovery
// =============================================================================

export function scanHistories(): {
  sessions: HistorySession[];
  paths: string[];
  warnings: string[];
} {
  const home = homedir();
  const scan: Scan = { sessions: [], paths: new Set(), warnings: [] };
  claude(claudeHome(), scan);
  codex(process.env.CODEX_HOME ?? join(home, '.codex'), scan);
  kimi(kimiHome(), scan);
  const opencode = join(process.env.XDG_DATA_HOME ?? join(home, '.local/share'), 'opencode');
  openCodeDatabase(process.env.OPENCODE_DB ?? join(opencode, 'opencode.db'), scan);
  openCodeLegacy(join(opencode, 'storage'), scan);
  const junie = scanJunieHistories();
  scan.sessions.push(...junie.sessions);
  scan.warnings.push(...junie.warnings);
  for (const path of junie.paths) scan.paths.add(path);
  const sessions = new Map<string, HistorySession>();
  for (const session of scan.sessions) {
    const key = sessionKey(session);
    const prior = sessions.get(key);
    if (!prior || session.updatedAt > prior.updatedAt) sessions.set(key, session);
  }
  const retained = new Set(scan.sessions.flatMap((session) => session.files));
  for (const path of journals.keys()) if (!retained.has(path)) journals.delete(path);
  for (const path of metadata.keys()) if (!retained.has(path)) metadata.delete(path);
  return { sessions: [...sessions.values()], paths: [...scan.paths], warnings: scan.warnings };
}
