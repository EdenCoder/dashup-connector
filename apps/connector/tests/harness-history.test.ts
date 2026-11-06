import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';

import type { Message } from '@dashup/protocol';

import { planUsage } from '../src/usage';
import { codexOptions } from '../src/harness/codex';
import { scanHistories } from '../src/harness/history';
import { Discovery } from '../src/discovery';
import type { LiveSession, HistorySession, NativeAttachment } from '../src/harness/session';

// =============================================================================
// Native fixtures
// =============================================================================

const HOMES = [
  'CODEX_HOME',
  'DASHUP_KIMI_HOME',
  'CLAUDE_CONFIG_DIR',
  'XDG_DATA_HOME',
  'OPENCODE_DB',
  'DASHUP_ZED_DATA',
  'DASHUP_VSCODE_DATA',
] as const;
const TIME  = '2026-10-20T12:00:00.000Z';
const at    = (seconds: number): string =>
  new Date(Date.parse(TIME) + seconds * 1000).toISOString();

function fixture(run: (root: string, cwd: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'dashup-histories-'));
  const prior = HOMES.map((name) => process.env[name]);
  try {
    process.env.CODEX_HOME = join(root, 'codex');
    process.env.DASHUP_KIMI_HOME = join(root, 'kimi');
    process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
    process.env.XDG_DATA_HOME = join(root, 'data');
    process.env.DASHUP_ZED_DATA = join(root, 'zed');
    process.env.DASHUP_VSCODE_DATA = join(root, 'code');
    delete process.env.OPENCODE_DB;
    const cwd = join(root, 'project');
    mkdirSync(cwd);
    run(root, cwd);
  } finally {
    HOMES.forEach((name, index) => {
      if (prior[index] === undefined) delete process.env[name];
      else process.env[name] = prior[index];
    });
    rmSync(root, { recursive: true, force: true });
  }
}

function write(path: string, value: object): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function lines(path: string, rows: object[]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
}

function claudeRow(
  cwd: string,
  type: string,
  uuid: string,
  parentUuid: string | null,
  content: unknown,
): object {
  return {
    sessionId: 'claude-native',
    cwd,
    type,
    uuid,
    parentUuid,
    timestamp: TIME,
    version: 'future-version',
    message: { role: type, content },
  };
}

function codexRow(ordinal: number, payload: object): object {
  return { type: 'response_item', ordinal, timestamp: TIME, payload };
}

function discover(): Discovery {
  return new Discovery('paired-computer', 'fixture-private-key');
}

// Preview assertions stay separate from complete native input, verified below.
function preview(message: Message): Message {
  if (!message.tool) return message;
  const { input, ...tool } = message.tool;
  return { ...message, tool };
}

function database(path: string, cwd: string): DatabaseSync {
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    'PRAGMA journal_mode=WAL; CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER, unknown_future_column TEXT); CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);',
  );
  db.prepare('INSERT INTO session VALUES (?, NULL, ?, ?, ?, ?, ?)').run(
    'ses_native',
    cwd,
    'OpenCode native title',
    Date.parse(TIME),
    Date.parse(TIME),
    'ignored',
  );
  return db;
}

// Zed's sidebar lists each thread on the SSH host; `agent` null is Zed's own agent.
function zed(
  root: string,
  cwd: string,
  threads: { agent: string | null; session: string; interacted?: string }[],
  ssh = false,
): void {
  const path = join(root, 'zed/db/0-stable/db.sqlite');
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(
      'CREATE TABLE remote_connections (id INTEGER, host TEXT, user TEXT, port INTEGER); CREATE TABLE workspaces (paths TEXT, remote_connection_id INTEGER); CREATE TABLE sidebar_threads (thread_id BLOB, session_id TEXT, agent_id TEXT, title TEXT, title_override TEXT, updated_at TEXT, interacted_at TEXT, folder_paths TEXT, remote_connection TEXT, archived INTEGER);',
    );
    db.prepare('INSERT INTO remote_connections VALUES (1, ?, ?, 2222)').run(
      '192.0.2.10',
      'developer',
    );
    db.prepare('INSERT INTO workspaces VALUES (?, 1)').run(cwd);
    threads.forEach((thread, index) =>
      db.prepare('INSERT INTO sidebar_threads VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 0)').run(
        Buffer.alloc(16, index),
        thread.session,
        thread.agent,
        'Existing Zed conversation',
        TIME,
        thread.interacted ?? null,
        cwd,
        ssh
          ? JSON.stringify({
              Ssh: { host: { IpAddr: '192.0.2.10' }, username: 'developer', port: 2222 },
            })
          : null,
      ));
  } finally {
    db.close();
  }
}

// =============================================================================
// Discovery and identity
// =============================================================================

test('discovers actual native layouts through custom homes and keeps provider thread identities', () =>
  fixture((root, cwd) => {
    const alias = join(root, 'project-alias');
    symlinkSync(cwd, alias, 'dir');
    const claude = join(root, 'claude/projects/encoded-project/claude-native.jsonl');
    lines(claude, [
      claudeRow(alias, 'user', 'user-1', null, 'Inspect existing changes'),
      claudeRow(alias, 'assistant', 'assistant-1', 'user-1', [
        { type: 'text', text: 'Existing response' },
      ]),
      { type: 'ai-title', sessionId: 'claude-native', aiTitle: 'Native Claude title' },
    ]);
    const codex = join(root, 'codex/sessions/2026/10/20/rollout-native.jsonl');
    lines(codex, [
      {
        type: 'session_meta',
        timestamp: TIME,
        payload: {
          id: 'codex-thread',
          session_id: 'different-tree-root',
          cwd: alias,
          cli_version: 'future-version',
        },
      },
      codexRow(1, {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Existing prompt' }],
      }),
      { type: 'event_msg', payload: { type: 'user_message', message: 'Existing prompt' } },
      codexRow(2, {
        type: 'message',
        id: 'native-answer',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Existing answer' }],
      }),
    ]);
    lines(join(root, 'codex/session_index.jsonl'), [
      { id: 'codex-thread', thread_name: 'Native Codex title', updated_at: TIME },
    ]);
    const path = join(root, 'data/opencode/opencode.db');
    const db = database(path, alias);
    const original = readFileSync(claude);
    try {
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(
        'msg_1',
        'ses_native',
        Date.parse(TIME),
        JSON.stringify({ role: 'user', time: { created: Date.parse(TIME) } }),
      );
      db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(
        'prt_1',
        'msg_1',
        'ses_native',
        Date.parse(TIME),
        JSON.stringify({ type: 'text', text: 'Existing OpenCode prompt' }),
      );
      const scan = scanHistories();
      assert.deepEqual(scan.warnings, []);
      assert.deepEqual(
        scan.sessions.map(({ harness, id, title }) => ({ harness, id, title })),
        [
          { harness: 'claude', id: 'claude-native', title: 'Native Claude title' },
          { harness: 'codex', id: 'codex-thread', title: 'Native Codex title' },
          { harness: 'opencode', id: 'ses_native', title: 'OpenCode native title' },
        ],
      );
      assert.ok(
        scan.sessions.every((session) => session.cwd === cwd && session.updatedAt === TIME),
      );
      assert.deepEqual(
        scan.sessions[0]!.read().map((message) => message.text),
        ['Inspect existing changes', 'Existing response'],
      );
      assert.deepEqual(
        scan.sessions[1]!.read().map((message) => message.text),
        ['Existing prompt', 'Existing answer'],
      );
      assert.deepEqual(
        scan.sessions[2]!.read().map((message) => message.text),
        ['Existing OpenCode prompt'],
      );
      assert.ok(scan.paths.includes(join(root, 'codex/sessions/2026/10/20')));
      assert.ok(scan.paths.includes(join(root, 'data/opencode')));
      assert.deepEqual(readFileSync(claude), original);
    } finally {
      db.close();
    }
  }));

test('reads only the selected Claude branch with original message and tool identities', () =>
  fixture((root, cwd) => {
    const path = join(root, 'claude/projects/project/claude-native.jsonl');
    lines(path, [
      claudeRow(cwd, 'user', 'u1', null, 'Original request'),
      claudeRow(cwd, 'assistant', 'old-branch', 'u1', [{ type: 'text', text: 'Abandoned branch' }]),
      claudeRow(cwd, 'assistant', 'a1', 'u1', [
        { type: 'text', text: 'Selected branch' },
        { type: 'tool_use', id: 'tool-native', name: 'Read', input: { file_path: 'handler.ts' } },
      ]),
      claudeRow(cwd, 'user', 'u2', 'a1', [
        {
          type: 'tool_result',
          tool_use_id: 'tool-native',
          content: [{ type: 'text', text: 'File content' }],
        },
      ]),
      { type: 'last-prompt', sessionId: 'claude-native', leafUuid: 'u2' },
    ]);
    const messages = scanHistories().sessions[0]!.read();
    assert.deepEqual(
      messages.map((message) => message.role),
      ['user', 'assistant', 'tool'],
    );
    assert.deepEqual(
      messages.map((message) => message.id),
      ['u1', 'a1', 'tool-native'],
    );
    assert.deepEqual(preview(messages[2]!), {
      id   : 'tool-native',
      role : 'tool',
      text : 'File content',
      tool : { name: 'Read', summary: 'handler.ts', status: 'ok', ms: 0 },
    });
    assert.equal(
      messages.some((message) => message.text === 'Abandoned branch'),
      false,
    );
  }));

// =============================================================================
// Concurrent native writes
// =============================================================================

test('incremental JSONL reads tolerate incomplete UTF-8 and JSON, invalid records, truncation, and replacement', () =>
  fixture((root, cwd) => {
    const path = join(root, 'codex/sessions/rollout.jsonl');
    lines(path, [
      { type: 'session_meta', payload: { id: 'native', cwd } },
      codexRow(1, {
        type: 'message',
        id: 'u1',
        role: 'user',
        content: [{ type: 'input_text', text: 'First' }],
      }),
    ]);
    const session = scanHistories().sessions[0]!;
    assert.deepEqual(
      session.read().map((message) => message.text),
      ['First'],
    );
    const append = Buffer.from(
      JSON.stringify(
        codexRow(2, {
          type: 'message',
          id: 'a1',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Reply 🦊' }],
        }),
      ) + '\n',
    );
    const split = append.indexOf(Buffer.from('🦊')) + 2;
    appendFileSync(path, append.subarray(0, split));
    assert.deepEqual(
      session.read().map((message) => message.text),
      ['First'],
    );
    appendFileSync(path, append.subarray(split));
    appendFileSync(path, '{bad completed line}\n');
    const expected = ['First', 'Reply 🦊'];
    assert.deepEqual(
      session.read().map((message) => message.text),
      expected,
    );
    assert.deepEqual(
      session.read().map((message) => message.text),
      expected,
    );
    const next = codexRow(3, {
      type: 'message',
      id: 'u2',
      role: 'user',
      content: [{ type: 'input_text', text: 'No final newline' }],
    });
    appendFileSync(path, JSON.stringify(next));
    assert.equal(session.read().at(-1)?.text, 'No final newline');
    appendFileSync(path, '\n');
    assert.equal(session.read().filter((message) => message.id === 'u2').length, 1);
    lines(path, [
      { type: 'session_meta', payload: { id: 'native', cwd } },
      codexRow(1, { type: 'message', id: 'new', role: 'user', content: 'Replaced' }),
    ]);
    assert.deepEqual(
      session.read().map((message) => message.text),
      ['Replaced'],
    );
    lines(`${path}.replacement`, [
      { type: 'session_meta', payload: { id: 'native', cwd } },
      codexRow(1, {
        type: 'message',
        id: 'newer',
        role: 'assistant',
        content: 'Atomic replacement',
      }),
    ]);
    renameSync(`${path}.replacement`, path);
    assert.deepEqual(
      session.read().map((message) => message.text),
      ['Atomic replacement'],
    );
  }));

test('handles large first metadata records without mistaking a partial prefix for corruption', () =>
  fixture((root, cwd) => {
    lines(join(root, 'codex/sessions/large.jsonl'), [
      {
        type: 'session_meta',
        payload: { id: 'large-native', base_instructions: 'x'.repeat(200_000), cwd },
      },
      codexRow(1, { type: 'message', role: 'user', content: 'Large metadata prompt' }),
    ]);
    const scan = scanHistories();
    assert.deepEqual(scan.warnings, []);
    assert.equal(scan.sessions[0]?.id, 'large-native');
  }));

test('a transcript of many megabytes is read from its end', () =>
  fixture((root, cwd) => {
    const filler = 'x'.repeat(1_000);
    lines(
      join(root, 'claude/projects/project/claude-native.jsonl'),
      Array.from({ length: 12_000 }, (_, index) =>
        claudeRow(
          cwd,
          index % 2 ? 'assistant' : 'user',
          `m${index}`,
          index ? `m${index - 1}` : null,
          `message ${index} ${filler}`,
        )),
    );
    const read = scanHistories().sessions[0]!.read();
    assert.ok(read.length > 1_000 && read.length < 12_000);
    assert.match(read.at(-1)!.text, /^message 11999 /);
    assert.ok(!read.some((message) => /^message 0 /.test(message.text)));
  }));

test('a Codex thread is titled and read from what the person typed, not injected context', () =>
  fixture((root, cwd) => {
    lines(join(root, 'codex/sessions/injected.jsonl'), [
      { type: 'session_meta', payload: { id: 'injected', cwd } },
      codexRow(1, {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `# AGENTS.md instructions for ${cwd}\n\nUse pnpm.` }],
      }),
      codexRow(2, {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '<environment_context>\n  <cwd>/p</cwd>\n</environment_context>',
          },
        ],
      }),
      codexRow(3, { type: 'message', role: 'user', content: 'Fix the flaky checkout test' }),
    ]);
    const [session] = scanHistories().sessions;
    assert.equal(session?.title, 'Fix the flaky checkout test');
    assert.deepEqual(
      session?.read().map((message) => message.text),
      ['Fix the flaky checkout test'],
    );
  }));

test('reads current OpenCode WAL snapshots without modifying native data and observes later commits', () =>
  fixture((root, cwd) => {
    const path = join(root, 'separate-native.db');
    process.env.OPENCODE_DB = path;
    const db = database(path, cwd);
    try {
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(
        'msg_1',
        'ses_native',
        1,
        JSON.stringify({ role: 'assistant' }),
      );
      db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(
        'part_1',
        'msg_1',
        'ses_native',
        1,
        JSON.stringify({
          type: 'tool',
          tool: 'bash',
          state: {
            status: 'completed',
            input: { command: 'git status' },
            output: 'Clean worktree',
          },
        }),
      );
      db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(
        'corrupt-part',
        'msg_1',
        'ses_native',
        2,
        '{unfinished',
      );
      const before = readFileSync(path);
      const session = scanHistories().sessions[0]!;
      assert.match(session.read()[0]!.text, /Clean worktree/);
      assert.deepEqual(readFileSync(path), before);
      db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(
        'part_2',
        'msg_1',
        'ses_native',
        3,
        JSON.stringify({ type: 'text', text: 'Committed while Dashup is open' }),
      );
      assert.equal(session.read().at(-1)?.text, 'Committed while Dashup is open');
      assert.equal(existsSync(`${path}-journal`), false);
    } finally {
      db.close();
    }
  }));

// =============================================================================
// Version and file isolation
// =============================================================================

test('reads legacy OpenCode JSON stores and isolates unrelated corrupt or unknown stores', () =>
  fixture((root, cwd) => {
    const storage = join(root, 'data/opencode/storage');
    write(join(storage, 'session/project/ses_old.json'), {
      id: 'ses_old',
      directory: cwd,
      title: 'Old native session',
      time: { updated: Date.parse(TIME) },
    });
    write(join(storage, 'message/ses_old/msg_old.json'), {
      id: 'msg_old',
      role: 'user',
      time: { created: 1 },
    });
    write(join(storage, 'part/msg_old/prt_old.json'), {
      id: 'prt_old',
      type: 'text',
      text: 'Legacy native content',
    });
    lines(join(root, 'claude/projects/project/corrupt.jsonl'), [
      { type: 'unknown-version-record' },
    ]);
    lines(join(root, 'codex/sessions/bad.jsonl'), [
      { type: 'session_meta', payload: { id: 'bad', cwd: 'relative-path' } },
    ]);
    const path = join(root, 'data/opencode/opencode.db');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE incompatible_native_schema (id TEXT)');
    db.close();
    const scan = scanHistories();
    assert.equal(scan.sessions.length, 1);
    assert.equal(scan.sessions[0]!.id, 'ses_old');
    assert.deepEqual(
      scan.sessions[0]!.read().map((message) => message.text),
      ['Legacy native content'],
    );
    assert.equal(scan.warnings.length, 3);
    assert.ok(scan.paths.includes(join(storage, 'part/msg_old')));
  }));

// =============================================================================
// Existing editor relationships
// =============================================================================

test('native history and live observations reuse the existing Zed thread', () =>
  fixture((root, cwd) => {
    zed(root, cwd, [{ agent: 'claude-code', session: 'claude-native' }]);
    lines(join(root, 'claude/projects/project/claude-native.jsonl'), [
      claudeRow(cwd, 'user', 'native-message', null, 'Existing CLI history behind Zed'),
    ]);
    const discovery = discover();
    const projects = discovery.scan();
    assert.deepEqual(discovery.warnings, []);
    assert.equal(projects.length, 1);
    const project = projects[0]!;
    assert.equal(project.threads.length, 1);
    const thread = project.threads[0]!;
    assert.equal(thread.editor, 'zed');
    assert.deepEqual(thread.agent, { harness: 'claude', sessionId: 'claude-native' });
    assert.equal(thread.capabilities.send, false);
    assert.equal(thread.capabilities.approve, false);
    assert.deepEqual(
      discovery.read(thread).map((message) => message.text),
      ['Existing CLI history behind Zed'],
    );
    const live: LiveSession = {
      id: 'claude-native',
      cwd,
      harness: 'claude',
      title: 'Same running native session',
      updatedAt: TIME,
      status: 'attention',
      messages: [
        { id: 'native-live-message', role: 'assistant', text: 'Awaiting native approval' },
      ],
      approvals: [
        {
          id: 'native-permission',
          title: 'Edit file',
          detail: 'Original native request',
          choices: [{ id: 'allow_once', label: 'Allow once' }],
        },
      ],
      send: async () => {},
      approve: async () => {},
    };
    const observed = discovery.observe(live);
    assert.equal(observed.project, project);
    assert.equal(observed.thread, thread);
    assert.equal(project.threads.length, 1);
    assert.equal(thread.status, 'attention');
    assert.equal(thread.capabilities.send, true);
    assert.equal(thread.capabilities.approve, true);
    assert.deepEqual(
      discovery.read(thread, live.messages).map((message) => message.text),
      ['Existing CLI history behind Zed'],
    );
    discovery.observe({ ...live, send: undefined, approve: undefined });
    assert.equal(thread.capabilities.send, false);
    assert.equal(thread.capabilities.approve, false);
  }));

test('a matching path alone never merges local native history into an unrelated SSH editor thread', () =>
  fixture((root, cwd) => {
    zed(root, cwd, [{ agent: 'zed', session: 'unrelated-zed-session' }], true);
    lines(join(root, 'claude/projects/project/claude-native.jsonl'), [
      claudeRow(cwd, 'user', 'native-message', null, 'Local native history'),
    ]);
    const discovery = discover();
    const projects = discovery.scan();
    assert.deepEqual(discovery.warnings, []);
    assert.equal(projects.length, 2);
    const remote = projects.find((project) => project.remote)!;
    const local = projects.find((project) => !project.remote)!;
    assert.equal(remote.path, local.path);
    assert.notEqual(remote.id, local.id);
    assert.equal(remote.threads[0]!.agent, undefined);
    assert.deepEqual(local.threads[0]!.agent, { harness: 'claude', sessionId: 'claude-native' });
    assert.deepEqual(
      discovery.read(local.threads[0]!).map((message) => message.text),
      ['Local native history'],
    );
  }));

// =============================================================================
// Conversation times
// =============================================================================

test('a session is as recent as its newest message, never its bookkeeping', () =>
  fixture((root, cwd) => {
    const restamp = '2026-10-26T03:07:25.028Z';
    // The answer sits behind the tail sample: the head ends before it and bookkeeping follows it.
    lines(join(root, 'claude/projects/project/claude-native.jsonl'), [
      { ...claudeRow(cwd, 'user', 'u1', null, 'x'.repeat(150_000)), timestamp: at(0) },
      {
        ...claudeRow(cwd, 'assistant', 'a1', 'u1', [{ type: 'text', text: 'y'.repeat(300_000) }]),
        timestamp: at(5),
      },
      { type: 'system', subtype: 'away_summary', uuid: 's1', parentUuid: 'a1', timestamp: restamp },
      { type: 'attachment', uuid: 's2', parentUuid: 's1', timestamp: restamp },
      { type: 'ai-title', sessionId: 'claude-native', aiTitle: 'Native Claude title' },
    ]);
    lines(join(root, 'codex/sessions/2026/10/20/rollout-native.jsonl'), [
      { type: 'session_meta', timestamp: at(0), payload: { id: 'codex-thread', cwd } },
      { ...codexRow(1, { type: 'message', role: 'user', content: 'Prompt' }), timestamp: at(0) },
      {
        ...codexRow(2, { type: 'message', role: 'assistant', content: 'Answer' }),
        timestamp: at(5),
      },
      { type: 'event_msg', timestamp: at(5), payload: { type: 'task_complete' } },
      { type: 'event_msg', timestamp: restamp, payload: { type: 'thread_settings_applied' } },
    ]);
    lines(join(root, 'codex/session_index.jsonl'), [
      { id: 'codex-thread', thread_name: 'Native Codex title', updated_at: restamp },
    ]);
    const db = database(join(root, 'data/opencode/opencode.db'), cwd);
    try {
      // OpenCode restamps sessions in bulk.
      db.prepare('UPDATE session SET time_updated = ?').run(Date.parse(restamp));
      for (const [id, role, seconds] of [
        ['msg_1', 'user', 0],
        ['msg_2', 'assistant', 5],
      ] as const)
        db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(
          id,
          'ses_native',
          Date.parse(at(seconds)),
          JSON.stringify({ role, time: { created: Date.parse(at(seconds)) } }),
        );
      const scan = scanHistories();
      assert.deepEqual(scan.warnings, []);
      assert.deepEqual(
        scan.sessions.map(({ harness, title, updatedAt }) => ({ harness, title, updatedAt })),
        [
          { harness: 'claude', title: 'Native Claude title', updatedAt: at(5) },
          { harness: 'codex', title: 'Native Codex title', updatedAt: at(5) },
          { harness: 'opencode', title: 'OpenCode native title', updatedAt: at(5) },
        ],
      );
    } finally {
      db.close();
    }
  }));

test('editor threads take their conversation time, so a Zed sidebar restamp publishes nothing new', () =>
  fixture((root, cwd) => {
    zed(root, cwd, [
      { agent: 'claude-acp', session: 'claude-native' },
      { agent: 'kimi', session: 'kimi-session', interacted: '2026-10-18T09:30:00.123456789+00:00' },
      { agent: null, session: 'zed-native' },
    ]);
    mkdirSync(join(root, 'zed/threads'));
    const store = new DatabaseSync(join(root, 'zed/threads/threads.db'));
    store.exec(
      'CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT, updated_at TEXT, data_type TEXT, data BLOB, parent_id TEXT)',
    );
    store
      .prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, NULL)')
      .run('zed-native', 'Zed thread', '2026-10-17T07:00:00.5+00:00', 'json', '{"messages":[]}');
    store.close();
    // The native conversation is older than the sidebar's stamp.
    lines(join(root, 'claude/projects/project/claude-native.jsonl'), [
      {
        ...claudeRow(cwd, 'user', 'u1', null, 'Older native conversation'),
        timestamp: at(-86_400),
      },
    ]);
    const discovery = discover();
    const projects = discovery.scan();
    assert.deepEqual(discovery.warnings, []);
    assert.deepEqual(
      projects[0]!.threads.map((thread) => thread.updatedAt),
      [at(-86_400), '2026-10-18T09:30:00.123Z', '2026-10-17T07:00:00.500Z'],
    );
    const published = JSON.stringify(projects);
    const sidebar = new DatabaseSync(join(root, 'zed/db/0-stable/db.sqlite'));
    sidebar.exec(
      "UPDATE sidebar_threads SET updated_at = CASE agent_id WHEN 'kimi' THEN '2026-10-26T03:07:25.028712345+00:00' ELSE '2026-10-26T03:07:25.028701234+00:00' END",
    );
    sidebar.close();
    assert.equal(JSON.stringify(discovery.scan()), published);
    const live = discovery.observe({
      id        : 'claude-native',
      cwd,
      title     : 'Existing Zed conversation',
      harness   : 'claude',
      updatedAt : '2026-10-26T03:07:25.028Z',
      status    : 'idle',
      messages  : [],
      approvals : [],
    });
    assert.equal(live.thread.updatedAt, at(-86_400));
  }));

// =============================================================================
// Subagents
// =============================================================================

test('OpenCode child sessions and Codex spawned agents name their parent thread', () =>
  fixture((root, cwd) => {
    const db = database(join(root, 'data/opencode/opencode.db'), cwd);
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, NULL)').run(
      'ses_child',
      'ses_native',
      cwd,
      'Explore the handler (@explore subagent)',
      Date.parse(TIME),
      Date.parse(TIME),
    );
    db.close();
    lines(join(root, 'codex/sessions/2026/10/20/rollout-parent.jsonl'), [
      {
        type      : 'session_meta',
        timestamp : TIME,
        payload   : { id: 'codex-parent', cwd, source: 'vscode' },
      },
    ]);
    lines(join(root, 'codex/sessions/2026/10/20/rollout-child.jsonl'), [
      {
        type      : 'session_meta',
        timestamp : TIME,
        payload   : {
          id               : 'codex-child',
          session_id       : 'codex-parent',
          forked_from_id   : 'codex-parent',
          parent_thread_id : 'codex-parent',
          thread_source    : 'subagent',
          cwd,
          source           : {
            subagent: { thread_spawn: { parent_thread_id: 'codex-parent', depth: 1 } },
          },
        },
      },
    ]);
    // A Claude subagent transcript lives beside its session and is not a thread of its own.
    lines(join(root, 'claude/projects/project/claude-native.jsonl'), [
      claudeRow(cwd, 'user', 'u1', null, 'Delegate the review'),
    ]);
    lines(join(root, 'claude/projects/project/claude-native/subagents/agent-a1.jsonl'), [
      {
        ...claudeRow(cwd, 'user', 's1', null, 'Review the handler'),
        isSidechain : true,
        agentId     : 'a1',
      },
    ]);
    const discovery = discover();
    const threads = discovery.scan().flatMap((project) => project.threads);
    assert.deepEqual(discovery.warnings, []);
    const thread = (harness: string, session: string) =>
      threads.find((item) => item.agent?.harness === harness && item.agent.sessionId === session)!;
    assert.equal(thread('opencode', 'ses_child').parent, thread('opencode', 'ses_native').id);
    assert.equal(thread('codex', 'codex-child').parent, thread('codex', 'codex-parent').id);
    assert.equal(threads.filter((item) => item.parent).length, 2);
    assert.deepEqual(
      discovery.read(thread('claude', 'claude-native')).map((message) => message.text),
      ['Delegate the review'],
    );
  }));

// =============================================================================
// Tool steps
// =============================================================================

test('a running Claude session shows the model its newest reply ran on, its speed and its ultracode', () =>
  fixture((root, cwd) => {
    const path  = join(root, 'claude/projects/project/claude-native.jsonl');
    const reply = (uuid: string, parent: string, model: string, speed: string, extra = {}) => {
      const content = [{ type: 'text', text: 'Done' }];
      const message = { role: 'assistant', model, usage: { speed }, content };
      return { ...claudeRow(cwd, 'assistant', uuid, parent, content), message, ...extra };
    };
    const marker = (uuid: string, parentUuid: string, type: string) => ({
      type       : 'attachment',
      uuid,
      parentUuid,
      attachment : { type },
    });
    lines(path, [
      claudeRow(cwd, 'user', 'u1', null, 'Fix the build'),
      marker('t1', 'u1', 'ultra_effort_enter'),
      reply('a1', 't1', 'claude-opus-5-5', 'fast'),
      // A subagent's replies and Claude Code's own command output are not the session's model.
      reply('a2', 'a1', 'claude-haiku-5-5', 'standard', { isSidechain: true }),
      claudeRow(cwd, 'user', 'u2', 'a1', '<command-name>/model</command-name>'),
      reply('a3', 'u2', '<synthetic>', 'standard'),
    ]);
    const discovery = discover();
    discovery.scan();
    const [history] = scanHistories().sessions;
    const settings  = () => history!.settings!();
    assert.deepEqual(settings(), { model: 'claude-opus-5-5', fast: true, ultracode: true });

    const later = [
      marker('t2', 'a3', 'ultra_effort_exit'),
      reply('a4', 't2', 'claude-sonnet-5-5', 'standard'),
    ];
    appendFileSync(path, later.map((row) => JSON.stringify(row) + '\n').join(''));
    assert.deepEqual(settings(), { model: 'claude-sonnet-5-5', fast: false, ultracode: false });

    // The live session says what it runs with from that record, and only it can change it.
    const live: LiveSession = {
      id        : 'claude-native',
      cwd,
      harness   : 'claude',
      updatedAt : TIME,
      status    : 'idle',
      messages  : [],
      approvals : [],
      options   : (recorded) => [{ id: 'model', name: 'Model', value: String(recorded().model) }],
      configure : async () => {},
    };
    const { thread } = discovery.observe(live);
    assert.deepEqual(thread.options, [{ id: 'model', name: 'Model', value: 'claude-sonnet-5-5' }]);
    assert.equal(thread.capabilities.configure, true);
  }));

test('a Claude slash command reads as the person typed it, with its output, and meta rows stay out', () =>
  fixture((root, cwd) => {
    const meta    = (uuid: string, parent: string, content: string) => ({
      ...claudeRow(cwd, 'user', uuid, parent, content),
      isMeta : true,
    });
    const command = '<command-name>/model</command-name>\n<command-args>sonnet</command-args>';
    const output  = '<local-command-stdout>Set model to `Sonnet 5.5`</local-command-stdout>';
    lines(join(root, 'claude/projects/project/claude-native.jsonl'), [
      claudeRow(cwd, 'user', 'u1', null, 'Fix the build'),
      meta('m1', 'u1', '<command-name>reviewing</command-name>'),
      meta('m2', 'm1', '# Reviewing skill'),
      claudeRow(cwd, 'assistant', 'a1', 'm2', [{ type: 'text', text: 'Fixed' }]),
      meta('m3', 'a1', '<local-command-caveat>Run directly</local-command-caveat>'),
      claudeRow(cwd, 'user', 'u2', 'm3', command),
      { type: 'system', subtype: 'local_command', uuid: 's1', parentUuid: 'u2', content: output },
    ]);
    const [session] = scanHistories().sessions;
    assert.deepEqual(
      session!.read().map(({ role, text }) => [role, text]),
      [
        ['user', 'Fix the build'],
        ['assistant', 'Fixed'],
        ['user', '/model sonnet'],
        ['system', 'Set model to `Sonnet 5.5`'],
      ],
    );
  }));

test('a working session names the step it took last, and an idle one names none', () =>
  fixture((root, cwd) => {
    lines(join(root, 'claude/projects/project/claude-native.jsonl'), [
      claudeRow(cwd, 'user', 'u1', null, 'Fix the tests'),
      claudeRow(cwd, 'assistant', 'a1', 'u1', [
        { type: 'tool_use', id: 'toolu_test', name: 'Bash', input: { command: 'pnpm test' } },
      ]),
      claudeRow(cwd, 'user', 'u2', 'a1', [
        { type: 'tool_result', tool_use_id: 'toolu_test', content: 'ok' },
      ]),
      claudeRow(cwd, 'assistant', 'a2', 'u2', [
        { type: 'text', text: 'Now the handler.' },
        {
          type: 'tool_use',
          id: 'toolu_read',
          name: 'Read',
          input: { file_path: '/work/handler.ts' },
        },
      ]),
    ]);
    lines(join(root, 'codex/sessions/2026/10/20/rollout-steps.jsonl'), [
      { type: 'session_meta', timestamp: TIME, payload: { id: 'codex-thread', cwd } },
      codexRow(1, { type: 'message', role: 'user', content: 'Lint it' }),
      codexRow(2, {
        type      : 'function_call',
        name      : 'exec_command',
        arguments : JSON.stringify({ cmd: 'npm run lint' }),
        call_id   : 'call_lint',
      }),
      codexRow(3, {
        type    : 'function_call_output',
        call_id : 'call_lint',
        output  : 'Process exited with code 0\nOutput:\nclean\n',
      }),
    ]);
    const discovery = discover();
    discovery.scan();
    const step = (harness: 'claude' | 'codex', id: string, status: LiveSession['status']) =>
      discovery.observe({ id, cwd, harness, status, updatedAt: TIME, messages: [], approvals: [] })
        .thread.step;
    assert.deepEqual(step('claude', 'claude-native', 'working'), {
      name    : 'Read',
      summary : '/work/handler.ts',
      at      : TIME,
    });
    assert.deepEqual(step('codex', 'codex-thread', 'working'), {
      name    : 'exec_command',
      summary : 'npm run lint',
      status  : 'ok',
      ms      : 0,
    });
    assert.equal(step('claude', 'claude-native', 'idle'), undefined);
  }));

test('Codex lifecycle markers track working, completed and aborted turns without granting live status', () =>
  fixture((root, cwd) => {
    const path = join(root, 'codex/sessions/rollout-lifecycle.jsonl');
    lines(path, [
      { type: 'session_meta', timestamp: TIME, payload: { id: 'codex-thread', cwd } },
      codexRow(1, { type: 'message', role: 'user', content: 'Check the build' }),
    ]);
    const [session] = scanHistories().sessions;
    const status = () => session!.status!();
    const event = (type: string, turn_id: string) =>
      JSON.stringify({ type: 'event_msg', timestamp: TIME, payload: { type, turn_id } });
    assert.equal(status(), undefined);
    appendFileSync(path, event('task_started', 'turn-1') + '\n');
    assert.equal(status(), 'working');
    appendFileSync(
      path,
      JSON.stringify(codexRow(2, { type: 'message', role: 'assistant', content: 'Checking.' })) +
        '\n',
    );
    assert.equal(status(), 'working');
    appendFileSync(path, event('task_complete', 'turn-1') + '\n');
    assert.equal(status(), 'idle');
    appendFileSync(path, event('task_started', 'turn-2') + '\n');
    assert.equal(status(), 'working');
    const aborted = event('turn_aborted', 'turn-2');
    appendFileSync(path, aborted.slice(0, -1));
    assert.equal(status(), 'working');
    appendFileSync(path, '}\n');
    assert.equal(status(), 'idle');
    appendFileSync(path, event('task_started', 'turn-3') + '\n');
    assert.equal(status(), 'working');
    const discovery = discover();
    const [project] = discovery.scan();
    assert.equal(project!.threads[0]!.status, 'unknown');
    assert.equal(project!.threads[0]!.capabilities.send, false);
  }));

test('Codex activity reaches beyond the history tail and ignores lifecycle-shaped tool data', () =>
  fixture((root, cwd) => {
    const path = join(root, 'codex/sessions/rollout-long-turn.jsonl');
    lines(path, [
      { type: 'session_meta', timestamp: TIME, payload: { id: 'codex-thread', cwd } },
      { type: 'event_msg', timestamp: TIME, payload: { type: 'task_started', turn_id: 'turn-1' } },
      codexRow(1, { type: 'function_call_output', call_id: 'call-1', output: 'a'.repeat(600_000) }),
      codexRow(2, { type: 'function_call_output', call_id: 'call-2', output: 'b'.repeat(600_000) }),
      codexRow(3, { type: 'function_call_output', output: { type: 'task_complete' } }),
    ]);
    const [session] = scanHistories().sessions;
    assert.equal(session!.status!(), 'working');
    appendFileSync(
      path,
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }) + '\n',
    );
    assert.equal(session!.status!(), 'idle');
    lines(path, [
      { type: 'session_meta', timestamp: TIME, payload: { id: 'codex-thread', cwd } },
      codexRow(1, { type: 'message', role: 'user', content: 'Replaced history' }),
    ]);
    assert.equal(session!.status!(), undefined);
  }));

test('Codex context uses the latest report, clears after compaction and ignores session totals', () =>
  fixture((root, cwd) => {
    const path = join(root, 'codex/sessions/rollout-context.jsonl');
    const report = (used: unknown, size: unknown) => ({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          last_token_usage: { total_tokens: used },
          total_token_usage: { total_tokens: 2_000_000 },
          model_context_window: size,
        },
      },
    });
    const append = (row: object) => appendFileSync(path, JSON.stringify(row) + '\n');
    lines(path, [
      { type: 'session_meta', timestamp: TIME, payload: { id: 'context-thread', cwd } },
      codexRow(1, { type: 'message', role: 'user', content: 'Work on this' }),
      report(50_000, 200_000),
    ]);
    const context = scanHistories().sessions[0]!.context!;
    assert.deepEqual(context(), { used: 50_000, size: 200_000 });
    append({ type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: {} } });
    append(codexRow(2, { type: 'token_count', info: { last_token_usage: { total_tokens: 9 } } }));
    assert.deepEqual(context(), { used: 50_000, size: 200_000 });
    append(report(90_000, 200_000));
    assert.deepEqual(context(), { used: 90_000, size: 200_000 });
    append({ type: 'compacted', payload: { message: 'Native summary' } });
    assert.equal(context(), undefined);
    append(report(0, 100_000));
    assert.deepEqual(context(), { used: 0, size: 100_000 });
    for (const [used, size] of [
      [-1, 100_000],
      [50, 0],
      [null, 100_000],
      [50, null],
    ]) {
      append(report(used, size));
      assert.equal(context(), undefined);
    }
    append(report(5_000, 100_000));
    assert.deepEqual(context(), { used: 5_000, size: 100_000 });
    lines(path, [
      { type: 'session_meta', timestamp: TIME, payload: { id: 'context-thread', cwd } },
    ]);
    assert.equal(context(), undefined);
  }));

test('a Codex thread runs on the model, effort and speed its newest turn and settings record', () =>
  fixture((root, cwd) => {
    write(join(root, 'codex/models_cache.json'), {
      models: [
        {
          slug                       : 'gpt-6.1-sol',
          visibility                 : 'list',
          display_name               : 'GPT-6.1-Sol',
          service_tiers              : [{ id: 'priority', name: 'Fast' }],
          supported_reasoning_levels : [{ effort: 'low' }, { effort: 'ultra' }],
        },
        { slug: 'gpt-6-luna', visibility: 'list', display_name: 'GPT-6-Luna' },
        { slug: 'codex-auto-review', visibility: 'hide', display_name: 'Codex Auto Review' },
      ],
    });
    const applied = { model: 'gpt-6-luna', reasoning_effort: 'medium', service_tier: 'priority' };
    lines(join(root, 'codex/sessions/2026/10/20/rollout-native.jsonl'), [
      { type: 'session_meta', timestamp: at(0), payload: { id: 'codex-thread', cwd } },
      { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: applied } },
      { type: 'turn_context', payload: { model: 'gpt-6.1-sol', effort: 'ultra' } },
      { ...codexRow(2, { type: 'message', role: 'user', content: 'Prompt' }), timestamp: at(2) },
    ]);
    const settings = scanHistories().sessions[0]!.settings!();
    assert.deepEqual(settings, { model: 'gpt-6.1-sol', effort: 'ultra', fast: true });
    // Hidden models are not offered, and the effort choices are the model's own.
    assert.deepEqual(codexOptions(settings), [
      {
        id      : 'model',
        name    : 'Model',
        value   : 'gpt-6.1-sol',
        choices : [
          { value: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' },
          { value: 'gpt-6-luna', name: 'GPT-6-Luna' },
        ],
      },
      {
        id      : 'effort',
        name    : 'Effort',
        value   : 'ultra',
        choices : [
          { value: 'low', name: 'low effort' },
          { value: 'ultra', name: 'ultra effort' },
        ],
      },
      { id: 'fast', name: 'Fast', value: true },
    ]);
  }));

test('a setting recorded only when it changes is found however far back it is', () =>
  fixture((root, cwd) => {
    const path    = join(root, 'claude/projects/project/claude-native.jsonl');
    const content = [{ type: 'text', text: 'Done' }];
    const reply   = (uuid: string, parent: string) => ({
      ...claudeRow(cwd, 'assistant', uuid, parent, content),
      message : { role: 'assistant', model: 'claude-opus-5-5', usage: { speed: 'fast' }, content },
    });
    const marker  = (uuid: string, parentUuid: string | null, type: string) => ({
      type       : 'attachment',
      uuid,
      parentUuid,
      attachment : { type },
    });
    // Rows of 700 KB put the turn the marker opens past the last 8 MB, and cut the 1 MB reads.
    const rows    = Array.from({ length: 14 }, (_, index) =>
      claudeRow(cwd, 'user', `f${index}`, index ? `f${index - 1}` : 't0', 'x'.repeat(700_000)));
    lines(path, [marker('t0', null, 'ultra_effort_enter'), ...rows, reply('a1', 'f13')]);
    const [history] = scanHistories().sessions;
    assert.equal(history!.settings!().ultracode, true);
    appendFileSync(
      path,
      [marker('t1', 'a1', 'ultra_effort_exit'), reply('a2', 't1')]
        .map((row) => JSON.stringify(row) + '\n')
        .join(''),
    );
    assert.equal(history!.settings!().ultracode, false);
  }));

test('a Kimi session reads from its context, titled and timed by Kimi, with its plan mode', () =>
  fixture((root, cwd) => {
    const folder = join(
      root,
      'kimi/sessions',
      createHash('md5').update(cwd).digest('hex'),
      'kimi-1',
    );
    write(join(root, 'kimi/kimi.json'), { work_dirs: [{ path: cwd, kaos: 'local' }] });
    write(join(folder, 'state.json'), { custom_title: 'Tidy the renderer', plan_mode: true });
    write(join(folder, 'context_1.jsonl'), {});
    const call = {
      type: 'function',
      id: 'tool_1',
      function: { name: 'Shell', arguments: '{"command":"cargo test"}' },
    };
    lines(join(folder, 'context.jsonl'), [
      { role: '_system_prompt', content: 'You are Kimi Code CLI' },
      { role: '_checkpoint', id: 0 },
      // Compaction opens the context with its summary, which the person never typed.
      {
        role: 'user',
        content: [{ type: 'text', text: '<system>Previous context has been compacted.</system>' }],
      },
      { role: 'user', content: 'Run the renderer tests' },
      {
        role       : 'assistant',
        content    : [
          { type: 'think', think: 'Run them' },
          { type: 'text', text: 'Running them' },
        ],
        tool_calls : [call],
      },
      {
        role: 'tool',
        tool_call_id: 'tool_1',
        content: '<system>ERROR: Command failed with exit code 1</system>',
      },
      { role: '_usage', token_count: 3395 },
    ]);
    lines(join(folder, 'wire.jsonl'), [
      { type: 'metadata', protocol_version: '1.10' },
      { timestamp: Date.parse(at(9)) / 1000, message: { type: 'TurnEnd', payload: {} } },
    ]);
    const [session] = scanHistories().sessions;
    assert.deepEqual(
      { ...session, files: undefined, read: undefined, settings: undefined },
      {
        id        : 'kimi-1',
        cwd,
        harness   : 'kimi',
        title     : 'Tidy the renderer',
        updatedAt : at(9),
        files     : undefined,
        read      : undefined,
        settings  : undefined,
      },
    );
    assert.deepEqual(
      session!.read().map(({ role, text, tool }) => [role, tool?.name ?? text, tool?.status]),
      [
        ['system', 'Earlier messages stay on your computer.', undefined],
        ['user', 'Run the renderer tests', undefined],
        ['assistant', 'Running them', undefined],
        ['tool', 'Shell', 'error'],
      ],
    );
    assert.deepEqual(session!.settings!(), { plan: true });
  }));

test('OpenCode 2 sessions read from its own tables, and both kinds name their model and agent', () =>
  fixture((root, cwd) => {
    const db = database(join(root, 'data/opencode/opencode.db'), cwd);
    try {
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(
        'msg_v1',
        'ses_native',
        Date.parse(at(1)),
        JSON.stringify({
          role: 'user',
          agent: 'plan',
          model: { providerID: 'opencode', modelID: 'big-pickle' },
        }),
      );
      db.exec(
        'CREATE TABLE session_v2 (id TEXT, parent_id TEXT, directory TEXT, title TEXT, agent TEXT, model TEXT, time_created INTEGER, time_archived INTEGER); CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, data TEXT);',
      );
      db.prepare('INSERT INTO session_v2 VALUES (?, NULL, ?, ?, ?, ?, ?, NULL)').run(
        'ses_v2',
        cwd,
        'Service work',
        'build',
        JSON.stringify({ providerID: 'kimi-for-coding', id: 'k3' }),
        Date.parse(at(0)),
      );
      const rows = [
        ['msg_1', 'user', { text: 'Fix the build' }],
        ['msg_2', 'idle', { outcome: 'succeeded' }],
        [
          'msg_3',
          'assistant',
          {
            time    : { created: Date.parse(at(4)) },
            content : [
              { type: 'reasoning', text: 'Look first' },
              { type: 'text', text: 'Fixed it' },
              {
                type  : 'tool',
                id    : 'call_1',
                name  : 'shell',
                state : {
                  status: 'completed',
                  input: { command: 'pnpm build' },
                  content: [{ type: 'text', text: 'ok' }],
                },
              },
            ],
          },
        ],
      ] as const;
      rows.forEach(([id, type, data], index) =>
        db
          .prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, 'ses_v2', type, index, Date.parse(at(index + 3)), JSON.stringify(data)));
      const sessions = scanHistories().sessions;
      const v1 = sessions.find((session) => session.id === 'ses_native')!;
      const v2 = sessions.find((session) => session.id === 'ses_v2')!;
      assert.deepEqual(v1.settings!(), { model: 'opencode/big-pickle', agent: 'plan' });
      assert.deepEqual(v2.settings!(), { model: 'kimi-for-coding/k3', agent: 'build' });
      assert.deepEqual([v2.title, v2.updatedAt], ['Service work', at(5)]);
      assert.deepEqual(
        v2.read().map(({ role, text, tool }) => [role, tool?.name ?? text, tool?.status]),
        [
          ['user', 'Fix the build', undefined],
          ['assistant', 'Fixed it', undefined],
          ['tool', 'shell', 'ok'],
        ],
      );
    } finally {
      db.close();
    }
  }));

test('Claude calls join their results, parallel side branches included, and edits show their change', () =>
  fixture((root, cwd) => {
    const row = (type: string, uuid: string, parent: string, when: number, content: unknown) => ({
      ...claudeRow(cwd, type, uuid, parent, content),
      timestamp: at(when),
    });
    const use = (id: string, name: string, input: object) => [
      { type: 'tool_use', id, name, input },
    ];
    const result = (id: string, content: string, extra = {}) => [
      { type: 'tool_result', tool_use_id: id, content, ...extra },
    ];
    const edit = {
      filePath        : '/work/a.ts',
      structuredPatch : [
        {
          oldStart : 2,
          oldLines : 2,
          newStart : 2,
          newLines : 2,
          lines    : [' a;', '-b = 1;', '+b = 3;'],
        },
      ],
    };
    const created = {
      type            : 'create',
      filePath        : '/work/notes.md',
      content         : 'Retry.\n',
      structuredPatch : [],
    };
    const asked = {
      question    : 'How should login attempts be limited?',
      header      : 'Rate limit',
      options     : [{ label: 'Per account', description: '5 tries per 15 minutes' }],
      multiSelect : false,
    };
    lines(join(root, 'claude/projects/project/claude-native.jsonl'), [
      claudeRow(cwd, 'user', 'u1', null, 'Fix the handler'),
      // Parallel calls: the first result hangs off its call, beside the chain.
      row('assistant', 'a1', 'u1', 1, use('t1', 'Bash', { command: 'npm test\nnpm ls' })),
      row('assistant', 'a2', 'a1', 1, use('t2', 'Grep', { pattern: 'retry', path: '/work' })),
      row('user', 'r1', 'a1', 4.5, result('t1', 'Exit code 1', { is_error: true })),
      row('user', 'r2', 'a2', 2, result('t2', 'a.ts:3')),
      row('assistant', 'a3', 'r2', 5, use('t3', 'Edit', { file_path: '/work/a.ts' })),
      { ...row('user', 'r3', 'a3', 5.25, result('t3', 'Updated.')), toolUseResult: edit },
      row('assistant', 'a4', 'r3', 6, use('t4', 'Write', { file_path: '/work/notes.md' })),
      { ...row('user', 'r4', 'a4', 6, result('t4', 'Created.')), toolUseResult: created },
      row('assistant', 'a5', 'r4', 7, use('t5', 'TodoWrite', { todos: [{ content: 'Verify' }] })),
      row('assistant', 'a6', 'a5', 8, use('t6', 'AskUserQuestion', { questions: [asked] })),
      // Request records repeat earlier content and never answer a call.
      { type: 'api-request-blob', message: { role: 'user', content: result('t5', 'Copied') } },
    ]);
    assert.deepEqual(scanHistories().sessions[0]!.read().map(preview), [
      { id: 'u1', role: 'user', text: 'Fix the handler' },
      {
        id   : 't1',
        role : 'tool',
        text : 'Exit code 1',
        tool : { name: 'Bash', summary: 'npm test\nnpm ls', status: 'error', ms: 3500 },
      },
      {
        id   : 't2',
        role : 'tool',
        text : 'a.ts:3',
        tool : { name: 'Grep', summary: 'retry', status: 'ok', ms: 1000 },
      },
      {
        id   : 't3',
        role : 'tool',
        text : '--- /work/a.ts\n+++ /work/a.ts\n@@ -2,2 +2,2 @@\n a;\n-b = 1;\n+b = 3;',
        tool : { name: 'Edit', summary: '/work/a.ts', status: 'ok', ms: 250, diff: true },
      },
      {
        id   : 't4',
        role : 'tool',
        text : '--- /dev/null\n+++ /work/notes.md\n@@ -0,0 +1,1 @@\n+Retry.',
        tool : { name: 'Write', summary: '/work/notes.md', status: 'ok', ms: 0, diff: true },
      },
      {
        id   : 't5',
        role : 'tool',
        text : '',
        tool : {
          name    : 'TodoWrite',
          summary : '{"todos":[{"content":"Verify"}]}',
          at      : '2026-10-20T12:00:07.000Z',
        },
      },
      {
        id   : 't6',
        role : 'tool',
        text : '',
        tool : {
          name    : 'AskUserQuestion',
          summary : 'How should login attempts be limited?',
          at      : '2026-10-20T12:00:08.000Z',
        },
      },
    ]);
  }));

test('Codex calls join their outputs by call id and take their status from the output head', () =>
  fixture((root, cwd) => {
    const item = (seconds: number, payload: object) => ({
      type      : 'response_item',
      timestamp : at(seconds),
      payload,
    });
    const patch =
      '*** Begin Patch\n*** Update File: /work/handler.ts\n@@\n-retries = 1\n+retries = 3\n*** Add File: /work/notes.md\n+Retry.\n*** End Patch';
    lines(join(root, 'codex/sessions/2026/10/20/rollout-tools.jsonl'), [
      { type: 'session_meta', timestamp: at(0), payload: { id: 'codex-thread', cwd } },
      item(0, { type: 'message', role: 'user', content: 'Fix the handler' }),
      item(1, {
        type      : 'function_call',
        name      : 'exec_command',
        arguments : JSON.stringify({ cmd: 'npm test', workdir: '/work' }),
        call_id   : 'call_test',
      }),
      item(1, {
        type      : 'function_call',
        name      : 'exec_command',
        arguments : JSON.stringify({ cmd: 'npm run lint' }),
        call_id   : 'call_lint',
      }),
      item(3, {
        type    : 'function_call_output',
        call_id : 'call_test',
        output  :
          'Chunk ID: 1f2e3d\nWall time: 2.0 seconds\nProcess exited with code 1\nOriginal token count: 4\nOutput:\n1 failing\n',
      }),
      item(31, {
        type    : 'function_call_output',
        call_id : 'call_lint',
        output  :
          'Chunk ID: 4c5b6a\nWall time: 30.0 seconds\nProcess running with session ID 7\nOriginal token count: 2\nOutput:\nlinting\n',
      }),
      item(32, {
        type    : 'custom_tool_call',
        call_id : 'call_patch',
        name    : 'apply_patch',
        input   : patch,
      }),
      item(32.5, {
        type    : 'custom_tool_call_output',
        call_id : 'call_patch',
        output  :
          'Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\n',
      }),
      item(33, {
        type    : 'custom_tool_call',
        call_id : 'call_script',
        name    : 'exec',
        input   : 'const result = await tools.exec_command({ cmd: "false" });\ntext(result);',
      }),
      item(33.1, {
        type    : 'custom_tool_call_output',
        call_id : 'call_script',
        output  : [
          { type: 'input_text', text: 'Script failed\nWall time 0.1 seconds\nOutput:\n' },
          { type: 'input_text', text: 'Script error: exit 1' },
        ],
      }),
      { type: 'event_msg', timestamp: at(34), payload: { type: 'task_complete' } },
    ]);
    const session = scanHistories().sessions[0]!;
    assert.equal(session.updatedAt, at(33.1));
    assert.deepEqual(session.read().map(preview), [
      { id: '1', role: 'user', text: 'Fix the handler' },
      {
        id   : 'call_test',
        role : 'tool',
        text : '1 failing\n',
        tool : { name: 'exec_command', summary: 'npm test', status: 'error', ms: 2000 },
      },
      {
        id   : 'call_lint',
        role : 'tool',
        text : 'linting\n',
        tool : { name: 'exec_command', summary: 'npm run lint', at: '2026-10-20T12:00:01.000Z' },
      },
      {
        id   : 'call_patch',
        role : 'tool',
        text :
          '--- /work/handler.ts\n+++ /work/handler.ts\n@@\n-retries = 1\n+retries = 3\n--- /dev/null\n+++ /work/notes.md\n+Retry.\n',
        tool : {
          name    : 'apply_patch',
          summary : '/work/handler.ts, /work/notes.md',
          status  : 'ok',
          ms      : 500,
          diff    : true,
        },
      },
      {
        id   : 'call_script',
        role : 'tool',
        text : 'Script error: exit 1',
        tool : {
          name    : 'exec',
          summary : 'const result = await tools.exec_command({ cmd: "false" });\ntext(result);',
          status  : 'error',
          ms      : 100,
        },
      },
    ]);
  }));

test('OpenCode tool parts keep their recorded diff, failure and duration', () =>
  fixture((root, cwd) => {
    const db = database(join(root, 'data/opencode/opencode.db'), cwd);
    try {
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(
        'msg_1',
        'ses_native',
        Date.parse(TIME),
        JSON.stringify({ role: 'assistant' }),
      );
      const time = { start: Date.parse(TIME), end: Date.parse(TIME) + 42 };
      const part = (id: string, tool: string, state: object) =>
        db
          .prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)')
          .run(
            id,
            'msg_1',
            'ses_native',
            Date.parse(TIME),
            JSON.stringify({ type: 'tool', callID: 'functions.tool:0', tool, state }),
          );
      part('prt_1', 'edit', {
        status   : 'completed',
        input    : {
          filePath  : '/work/handler.ts',
          oldString : 'retries = 1',
          newString : 'retries = 3',
        },
        output   : 'Edit applied successfully.',
        metadata : {
          diff: 'Index: /work/handler.ts\n===================================================================\n--- /work/handler.ts\n+++ /work/handler.ts\n@@ -1,1 +1,1 @@\n-retries = 1\n+retries = 3\n',
        },
        time,
      });
      part('prt_2', 'bash', {
        status : 'error',
        input  : { command: 'npm test', description: 'Run tests' },
        error  : 'Tool execution aborted',
        time,
      });
      part('prt_3', 'write', {
        status   : 'completed',
        input    : { filePath: '/work/notes.md', content: 'Retry.\n' },
        output   : 'Wrote file successfully.',
        metadata : { filepath: '/work/notes.md', exists: false },
        time,
      });
      part('prt_4', 'grep', {
        status : 'running',
        input  : { pattern: 'retry', path: '/work' },
        time   : { start: Date.parse(TIME) },
      });
      assert.deepEqual(scanHistories().sessions[0]!.read().map(preview), [
        {
          id   : 'prt_1',
          role : 'tool',
          text :
            '--- /work/handler.ts\n+++ /work/handler.ts\n@@ -1,1 +1,1 @@\n-retries = 1\n+retries = 3\n',
          tool : { name: 'edit', summary: '/work/handler.ts', status: 'ok', ms: 42, diff: true },
        },
        {
          id   : 'prt_2',
          role : 'tool',
          text : 'Tool execution aborted',
          tool : { name: 'bash', label: 'Run tests', summary: 'npm test', status: 'error', ms: 42 },
        },
        {
          id   : 'prt_3',
          role : 'tool',
          text : '--- /dev/null\n+++ /work/notes.md\n@@ -0,0 +1,1 @@\n+Retry.',
          tool : { name: 'write', summary: '/work/notes.md', status: 'ok', ms: 42, diff: true },
        },
        {
          id   : 'prt_4',
          role : 'tool',
          text : '',
          tool : { name: 'grep', summary: 'retry', at: '2026-10-20T12:00:00.000Z' },
        },
      ]);
    } finally {
      db.close();
    }
  }));

// =============================================================================
// Attachments
// =============================================================================

test('complete Claude, Codex and OpenCode tool inputs retain fields and source text beyond their summaries', () =>
  fixture((root, cwd) => {
    const input = {
      file_path: '/work/private.ts',
      content: 'complete source\n'.repeat(1000),
      options: { mode: 'replace' },
    };
    const script = 'const hidden = "native input";\n'.repeat(1000);
    lines(join(root, 'claude/projects/project/claude-native.jsonl'), [
      claudeRow(cwd, 'user', 'user', null, 'Update the file'),
      claudeRow(cwd, 'assistant', 'assistant', 'user', [
        { type: 'tool_use', id: 'call', name: 'Write', input },
      ]),
    ]);
    lines(join(root, 'codex/sessions/rollout-input.jsonl'), [
      { type: 'session_meta', timestamp: TIME, payload: { id: 'codex-thread', cwd } },
      codexRow(1, { type: 'custom_tool_call', call_id: 'script', name: 'exec', input: script }),
    ]);
    const db = database(join(root, 'data/opencode/opencode.db'), cwd);
    try {
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(
        'msg',
        'ses_native',
        Date.parse(TIME),
        JSON.stringify({ role: 'assistant' }),
      );
      db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run(
        'part',
        'msg',
        'ses_native',
        Date.parse(TIME),
        JSON.stringify({ type: 'tool', tool: 'write', state: { input, status: 'running' } }),
      );
      const sessions = scanHistories().sessions;
      for (const harness of ['claude', 'codex', 'opencode']) {
        const message = sessions
          .find((session) => session.harness === harness)!
          .read()
          .find((message) => message.role === 'tool')!;
        const file = message.tool!.input as NativeAttachment;
        assert.ok(message.tool!.summary!.length <= 500);
        assert.ok(file.bytes > 500);
        const value = file.read().toString();
        assert.equal(Buffer.byteLength(value), file.bytes);
        if (harness === 'codex') assert.equal(value, script);
        else assert.deepEqual(JSON.parse(value), input);
      }
    } finally {
      db.close();
    }
  }));

// Attachments as plain values, each with the bytes it reads.
const opened = (messages: Message[]) =>
  messages.map(preview).map(({ attachments, ...message }) => ({
    ...message,
    ...(attachments
      ? {
          attachments: (attachments as NativeAttachment[]).map(({ read, ...file }) => ({
            ...file,
            data: read().toString(),
          })),
        }
      : {}),
  }));

test('Claude images and documents become attachments read on demand, and binary changes drop', () =>
  fixture((root, cwd) => {
    const png   = Buffer.from('screenshot').toString('base64');
    const pdf   = Buffer.from('%PDF-1.7').toString('base64');
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } };
    lines(join(root, 'claude/projects/project/claude-native.jsonl'), [
      claudeRow(cwd, 'user', 'u1', null, [
        image,
        { type: 'text', text: 'Why is this broken?' },
        {
          type   : 'document',
          title  : 'spec.pdf',
          source : { type: 'base64', media_type: 'application/pdf', data: pdf },
        },
      ]),
      claudeRow(cwd, 'assistant', 'a1', 'u1', [
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/work/shot.png' } },
      ]),
      claudeRow(cwd, 'user', 'r1', 'a1', [
        { type: 'tool_result', tool_use_id: 't1', content: [image] },
      ]),
      claudeRow(cwd, 'assistant', 'a2', 'r1', [
        { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/work/logo.png' } },
      ]),
      {
        ...claudeRow(cwd, 'user', 'r2', 'a2', [
          { type: 'tool_result', tool_use_id: 't2', content: 'Created.' },
        ]),
        toolUseResult: {
          type            : 'create',
          filePath        : '/work/logo.png',
          content         : '\u0089PNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR',
          structuredPatch : [],
        },
      },
    ]);
    assert.deepEqual(opened(scanHistories().sessions[0]!.read()), [
      {
        id          : 'u1',
        role        : 'user',
        text        : 'Why is this broken?',
        attachments : [
          { id: 'u1:0', mime: 'image/png', bytes: 10, data: 'screenshot' },
          { id: 'u1:2', mime: 'application/pdf', bytes: 8, name: 'spec.pdf', data: '%PDF-1.7' },
        ],
      },
      {
        id          : 't1',
        role        : 'tool',
        text        : '',
        tool        : { name: 'Read', summary: '/work/shot.png', status: 'ok', ms: 0 },
        attachments : [{ id: 't1:0', mime: 'image/png', bytes: 10, data: 'screenshot' }],
      },
      {
        id   : 't2',
        role : 'tool',
        text : 'Created.',
        tool : { name: 'Write', summary: '/work/logo.png', status: 'ok', ms: 0 },
      },
    ]);
  }));

test('Codex images in messages and tool output become attachments', () =>
  fixture((root, cwd) => {
    const png = Buffer.from('pasted').toString('base64');
    const jpg = Buffer.from('rendered').toString('base64');
    lines(join(root, 'codex/sessions/2026/10/20/rollout-images.jsonl'), [
      { type: 'session_meta', timestamp: TIME, payload: { id: 'codex-images', cwd } },
      codexRow(1, {
        type    : 'message',
        id      : 'm1',
        role    : 'user',
        content : [
          { type: 'input_image', image_url: `data:image/png;base64,${png}` },
          { type: 'input_text', text: 'Match this' },
        ],
      }),
      codexRow(2, { type: 'custom_tool_call', call_id: 'c1', name: 'js', input: 'shot()' }),
      codexRow(3, {
        type    : 'custom_tool_call_output',
        call_id : 'c1',
        output  : [
          { type: 'input_text', text: 'Script completed\nOutput:\n' },
          { type: 'input_image', image_url: `data:image/jpeg;base64,${jpg}` },
        ],
      }),
    ]);
    assert.deepEqual(opened(scanHistories().sessions[0]!.read()), [
      {
        id          : 'm1',
        role        : 'user',
        text        : 'Match this',
        attachments : [{ id: 'm1:0', mime: 'image/png', bytes: 6, data: 'pasted' }],
      },
      {
        id          : 'c1',
        role        : 'tool',
        text        : '',
        tool        : { name: 'js', summary: 'shot()', status: 'ok', ms: 0 },
        attachments : [{ id: 'c1:1', mime: 'image/jpeg', bytes: 8, data: 'rendered' }],
      },
    ]);
  }));

test('OpenCode file parts and tool attachments become attachments', () =>
  fixture((root, cwd) => {
    const png = Buffer.from('clip').toString('base64');
    const url = `data:image/png;base64,${png}`;
    const db  = database(join(root, 'data/opencode/opencode.db'), cwd);
    try {
      const message = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)');
      const part    = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)');
      const time    = Date.parse(TIME);
      message.run('msg_1', 'ses_native', time, JSON.stringify({ role: 'user' }));
      message.run('msg_2', 'ses_native', time + 1, JSON.stringify({ role: 'assistant' }));
      part.run(
        'prt_1',
        'msg_1',
        'ses_native',
        time,
        JSON.stringify({ type: 'text', text: 'Look' }),
      );
      part.run(
        'prt_2',
        'msg_1',
        'ses_native',
        time,
        JSON.stringify({ type: 'file', mime: 'image/png', filename: 'clipboard', url }),
      );
      part.run(
        'prt_3',
        'msg_2',
        'ses_native',
        time + 1,
        JSON.stringify({
          type  : 'tool',
          tool  : 'read',
          state : {
            status      : 'completed',
            input       : { filePath: '/work/shot.png' },
            output      : 'Image read successfully',
            attachments : [{ id: 'prt_a', type: 'file', mime: 'image/png', url }],
            time        : { start: time, end: time },
          },
        }),
      );
      part.run(
        'prt_4',
        'msg_2',
        'ses_native',
        time + 2,
        JSON.stringify({ type: 'file', mime: 'application/x-directory', url: 'file:///work' }),
      );
      assert.deepEqual(opened(scanHistories().sessions[0]!.read()), [
        { id: 'prt_1', role: 'user', text: 'Look' },
        {
          id          : 'prt_2',
          role        : 'user',
          text        : '',
          attachments : [
            { id: 'prt_2:0', mime: 'image/png', bytes: 4, name: 'clipboard', data: 'clip' },
          ],
        },
        {
          id          : 'prt_3',
          role        : 'tool',
          text        : 'Image read successfully',
          tool        : { name: 'read', summary: '/work/shot.png', status: 'ok', ms: 0 },
          attachments : [{ id: 'prt_3:0', mime: 'image/png', bytes: 4, data: 'clip' }],
        },
      ]);
    } finally {
      db.close();
    }
  }));

// =============================================================================
// Plan usage
// =============================================================================

test(
  'plan usage is each agent login with its account, plan and windows',
  { skip: process.platform === 'darwin' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'dashup-usage-'));
    const prior = HOMES.map((name) => process.env[name]);
    const fetched = globalThis.fetch;
    try {
      process.env.CODEX_HOME = join(root, 'codex');
      process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
      const claims = Buffer.from(
        JSON.stringify({
          email                         : 'person@example.com',
          'https://api.openai.com/auth' : {
            chatgpt_plan_type  : 'pro',
            chatgpt_account_id : 'codex-workspace',
            chatgpt_user_id    : 'codex-user',
          },
        }),
      ).toString('base64url');
      write(join(root, 'codex/auth.json'), { tokens: { id_token: `header.${claims}.signature` } });
      const rollout = join(root, 'codex/sessions/2026/10/20/rollout-usage.jsonl');
      // Usage reads only the sessions it is given, so no other native home is scanned.
      const histories: HistorySession[] = [
        {
          id        : 'codex-thread',
          cwd       : root,
          title     : 'Lint it',
          harness   : 'codex',
          updatedAt : TIME,
          files     : [rollout],
          read      : () => [],
        },
      ];
      lines(rollout, [
        {
          type      : 'event_msg',
          timestamp : at(9),
          payload   : {
            type        : 'token_count',
            rate_limits : {
              primary   : { used_percent: 2.4, window_minutes: 10_080, resets_at: 1_793_774_205 },
              secondary : null,
            },
          },
        },
      ]);
      write(join(root, 'claude/.claude.json'), {
        oauthAccount: { emailAddress: 'person@example.com', accountUuid: 'claude-account' },
      });
      write(join(root, 'claude/.credentials.json'), {
        claudeAiOauth: {
          accessToken      : 'claude-token',
          expiresAt        : Date.now() + 60_000,
          subscriptionType : 'max',
        },
      });
      const asked: [string, unknown][] = [];
      globalThis.fetch = async (url, init) => {
        asked.push([String(url), init?.headers]);
        return Response.json({
          five_hour      : { utilization: 12.4, resets_at: '2026-10-29T02:59:59.525511+00:00' },
          seven_day      : { utilization: 71.0, resets_at: '2026-11-01T19:59:59.525533+00:00' },
          seven_day_opus : null,
        });
      };
      // Claude's meter answers as it is asked; Codex's limits are the ones it last wrote.
      const usage = await planUsage(histories);
      assert.deepEqual(asked, [
        [
          'https://api.anthropic.com/api/oauth/usage',
          { Authorization: 'Bearer claude-token', 'anthropic-beta': 'oauth-2025-04-20' },
        ],
      ]);
      assert.deepEqual(usage, [
        {
          harness  : 'claude',
          account  : 'person@example.com',
          identity : 'claude-account',
          plan     : 'max',
          windows  : [
            { minutes: 300, used: 12, resets: '2026-10-29T02:59:59.525Z' },
            { minutes: 10_080, used: 71, resets: '2026-11-01T19:59:59.525Z' },
          ],
        },
        {
          harness  : 'codex',
          account  : 'person@example.com',
          identity : JSON.stringify(['codex-workspace', 'codex-user']),
          plan     : 'pro',
          windows  : [
            { minutes: 10_080, used: 2, resets: new Date(1_793_774_205_000).toISOString() },
          ],
        },
      ]);
      // An expired login waits for Claude Code to renew it, and still names its account.
      write(join(root, 'claude/.credentials.json'), {
        claudeAiOauth: { accessToken: 'claude-token', expiresAt: Date.now() - 1 },
      });
      assert.deepEqual(
        (await planUsage(histories)).map((item) => [
          item.harness,
          item.account,
          item.windows.length,
        ]),
        [
          ['claude', 'person@example.com', 0],
          ['codex', 'person@example.com', 1],
        ],
      );
      assert.equal(asked.length, 1);
      // A computer without an agent's login reports none for it.
      rmSync(join(root, 'codex/auth.json'));
      assert.deepEqual(
        (await planUsage(histories)).map((item) => item.harness),
        ['claude'],
      );
    } finally {
      globalThis.fetch = fetched;
      HOMES.forEach((name, index) => {
        if (prior[index] === undefined) delete process.env[name];
        else process.env[name] = prior[index];
      });
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('native permission settings report auto mode without assuming it from a model', () =>
  fixture((root, cwd) => {
    const claudePath = join(root, 'claude/projects/project/mode.jsonl');
    lines(claudePath, [
      {
        type: 'user',
        sessionId: 'claude-mode',
        cwd,
        timestamp: TIME,
        permissionMode: 'auto',
        message: { role: 'user', content: 'hello' },
      },
    ]);
    const codexPath = join(root, 'codex/sessions/2026/10/20/rollout-mode.jsonl');
    lines(codexPath, [
      { type: 'session_meta', timestamp: TIME, payload: { id: 'codex-mode', cwd } },
      {
        type: 'event_msg',
        payload: {
          type: 'thread_settings_applied',
          thread_settings: { model: 'test-model', approvals_reviewer: 'auto_review' },
        },
      },
      { type: 'turn_context', payload: { model: 'test-model', approvals_reviewer: 'user' } },
    ]);
    const sessions = scanHistories().sessions;
    assert.equal(sessions.find((session) => session.id === 'claude-mode')?.settings?.().auto, true);
    assert.equal(sessions.find((session) => session.id === 'codex-mode')?.settings?.().auto, false);
  }));

test('Codex image wrappers leave the original prompt matchable and preserve attachment identity', () =>
  fixture((root, cwd) => {
    const opening = {
      type: 'input_text',
      text: '<image name=[Image #1] path="/private/phone.jpg">',
    };
    const closing = { type: 'input_text', text: '</image>' };
    const image = { type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' };
    lines(join(root, 'codex/sessions/wrapped.jsonl'), [
      { type: 'session_meta', timestamp: TIME, payload: { id: 'wrapped', cwd } },
      codexRow(1, {
        type: 'message',
        id: 'native',
        role: 'user',
        content: [{ type: 'input_text', text: 'My exact phone prompt' }, opening, image, closing],
      }),
      codexRow(2, {
        type: 'message',
        id: 'literal',
        role: 'user',
        content: [{ type: 'input_text', text: 'Explain these literal tags' }, opening, closing],
      }),
    ]);
    const messages = scanHistories()
      .sessions.find((session) => session.id === 'wrapped')!
      .read();
    assert.equal(messages[0]!.text, 'My exact phone prompt');
    assert.equal(messages[0]!.attachments?.[0]?.id, 'native:2');
    assert.match(messages[1]!.text, /<image name=/);
  }));
