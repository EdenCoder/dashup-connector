import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rmSync, statSync, mkdtempSync, writeFileSync } from 'node:fs';

import type { QueueReceipt } from '@dashup/protocol';
import { nativeProcesses } from '../src/harness/processes';

import {
  NativeQueue,
  sameOwner,
  writerOwner,
  queueOwner,
  codexVersion,
  nativeReceipt,
  reconcileReceipt,
  type QueueOwner,
  type QueueRequest,
} from '../src/harness/queue';

// =============================================================================
// Native metadata fixtures do not launch an agent or submit input
// =============================================================================

test(
  'process discovery filters to Codex before bounding candidates on busy hosts',
  {
    skip: process.platform !== 'linux',
  },
  () => {
    const home = mkdtempSync(join(tmpdir(), 'dashup-codex-processes-'));
    const path = process.env.PATH;
    try {
      writeFileSync(
        join(home, 'ps'),
        '#!/bin/sh\n' +
          '[ "$*" = "-C codex -o pid=" ] || exit 1\n' +
          'printf " 166613\\n1792623\\nnot-a-pid\\n"\n',
        { mode: 0o700 },
      );
      process.env.PATH = home;
      assert.deepEqual(nativeProcesses('codex'), [166613, 1792623]);
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
      rmSync(home, { recursive: true, force: true });
    }
  },
);

function owner(home: string): QueueOwner {
  const file = (path: string) => {
    writeFileSync(path, '');
    const value = statSync(path);
    return { path, device: value.dev, inode: value.ino };
  };
  return {
    pid: -1,
    start: '123',
    executable: '/fixture/codex',
    version: '0.160.1',
    home,
    cwd: home,
    thread: 'original-thread',
    queue: file(join(home, 'queue_1.sqlite')),
    rollout: file(join(home, 'original-rollout.jsonl')),
  };
}

test('queue identity requires the actual native history file and unchanged process incarnation', () => {
  const home = mkdtempSync(join(tmpdir(), 'dashup-queue-owner-'));
  try {
    const current = owner(home);
    const copy = join(home, 'copy.jsonl');
    writeFileSync(copy, '');
    const history = {
      id: current.thread,
      harness: 'codex' as const,
      cwd: home,
      title: 'Native thread',
      updatedAt: '2026-10-26T00:00:00Z',
      files: [current.rollout.path],
      read: () => [],
    };
    assert.equal(queueOwner([current], history), current);
    assert.equal(queueOwner([current], { ...history, files: [copy] }), undefined);
    assert.equal(queueOwner([current], { ...history, id: 'other-thread' }), undefined);
    assert.equal(queueOwner([current, current], history), undefined);
    const { queue, version, ...writer } = current;
    assert.equal(writerOwner([writer], history), writer);
    assert.equal(writerOwner([writer], { ...history, files: [copy] }), undefined);
    assert.equal(writerOwner([writer, writer], history), undefined);
    assert.equal(sameOwner(current, { ...current, start: '124' }), false);
    assert.equal(sameOwner(current, { ...current, queue: { ...current.queue, inode: 0 } }), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test(
  'desktop and npm Codex versions come from the executable and refresh when it changes',
  {
    skip: process.platform === 'win32',
  },
  () => {
    const home = mkdtempSync(join(tmpdir(), 'dashup-codex-version-'));
    const executable = join(home, 'codex');
    try {
      writeFileSync(
        join(home, 'package.json'),
        JSON.stringify({
          name: '@openai/codex',
          version: '0.165.0-linux-x64',
        }),
      );
      writeFileSync(executable, '#!/bin/sh\nprintf "codex-cli 0.153.4\\n"\n', { mode: 0o700 });
      assert.equal(codexVersion(executable), '0.153.4');
      writeFileSync(executable, '#!/bin/sh\nprintf "codex-cli 0.165.0\\n"\n# replaced binary\n');
      assert.equal(codexVersion(executable), '0.165.0');
      writeFileSync(executable, '#!/bin/sh\nprintf "not a Codex version\\n"\n');
      assert.equal(codexVersion(executable), undefined);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);

test('native delivery requires typed client identity in the exact thread, followed by a same-turn assistant item', () => {
  const home = mkdtempSync(join(tmpdir(), 'dashup-queue-receipt-'));
  let queue: DatabaseSync | undefined;
  let history: DatabaseSync | undefined;
  try {
    const current = owner(home);
    queue = new DatabaseSync(current.queue.path);
    queue.exec('CREATE TABLE queued_items (id TEXT, thread_id TEXT, payload_json TEXT)');
    history = new DatabaseSync(join(home, 'thread_history_1.sqlite'));
    history.exec(`CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT,
      rollout_ordinal INTEGER, item_type TEXT, item_json TEXT)`);
    const item = (
      thread: string,
      turn: string,
      id: string,
      ordinal: number,
      type: string,
      clientId?: string,
    ) =>
      history!
        .prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?)')
        .run(thread, turn, id, ordinal, type, JSON.stringify({ type, clientId }));
    queue
      .prepare('INSERT INTO queued_items VALUES (?, ?, ?)')
      .run('queue-id', current.thread, JSON.stringify({ UserInput: { client_id: 'client-id' } }));
    assert.deepEqual(nativeReceipt(current, 'client-id'), { queueId: 'queue-id' });
    queue.exec('DELETE FROM queued_items');
    item('another-thread', 'turn', 'wrong-thread', 1, 'userMessage', 'client-id');
    item(current.thread, 'turn', 'tool-record', 2, 'commandExecution', 'client-id');
    item(current.thread, 'turn', 'earlier-assistant', 3, 'agentMessage');
    assert.deepEqual(nativeReceipt(current, 'client-id'), { queueId: undefined });
    item(current.thread, 'turn', 'native-user', 4, 'userMessage', 'client-id');
    item(current.thread, 'different-turn', 'wrong-response', 5, 'agentMessage');
    assert.deepEqual(nativeReceipt(current, 'client-id'), { queueId: undefined, turnId: 'turn' });
    item(current.thread, 'turn', 'native-response', 6, 'agentMessage');
    assert.deepEqual(nativeReceipt(current, 'client-id'), {
      queueId: undefined,
      turnId: 'turn',
      responseId: 'native-response',
    });
    item(current.thread, 'turn', 'duplicate-input', 7, 'userMessage', 'client-id');
    assert.throws(() => nativeReceipt(current, 'client-id'), /ambiguous/);
  } finally {
    history?.close();
    queue?.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('queue receipts preserve accepted evidence and recover a lost ACK through client identity without text matching', () => {
  const unknown: QueueReceipt = { state: 'unknown', clientUserMessageId: 'client' };
  assert.deepEqual(reconcileReceipt(unknown, {}), unknown);
  const accepted = reconcileReceipt(unknown, { queueId: 'queue' });
  assert.equal(accepted.state, 'accepted');
  assert.deepEqual(reconcileReceipt(accepted, {}), accepted);
  assert.throws(() => reconcileReceipt(accepted, { queueId: 'different' }), /identity changed/);
  const delivered = reconcileReceipt(unknown, { turnId: 'turn' });
  assert.deepEqual(delivered, {
    state: 'delivered',
    queueId: undefined,
    clientUserMessageId: 'client',
    turnId: 'turn',
  });
  assert.deepEqual(reconcileReceipt(delivered, {}), delivered);
  assert.throws(() => reconcileReceipt(delivered, { turnId: 'other-turn' }), /identity changed/);
  const responded = reconcileReceipt(delivered, { turnId: 'turn', responseId: 'response' });
  assert.equal(responded.state, 'responded');
  assert.deepEqual(reconcileReceipt(responded, { turnId: 'turn', responseId: 'later' }), responded);
});

test('a restored request cannot resubmit and can correlate persisted history after its owner exits', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dashup-queue-restart-'));
  try {
    const native = owner(home);
    const request: QueueRequest = {
      pairing: 'pair',
      project: 'project',
      thread: 'opaque-thread',
      owner: native,
      receipt: { state: 'unknown', clientUserMessageId: 'persisted-client-id' },
    };
    const requests = { request };
    let writes = 0;
    const restored = new NativeQueue(
      requests,
      () => {
        writes++;
      },
      () => false,
    );
    assert.deepEqual(
      await restored.submit('request', request, 'never dispatched'),
      request.receipt,
    );
    assert.equal(writes, 0);
    const queue = new DatabaseSync(native.queue.path);
    queue.exec('CREATE TABLE queued_items (id TEXT, thread_id TEXT, payload_json TEXT)');
    queue.close();
    const history = new DatabaseSync(join(home, 'thread_history_1.sqlite'));
    history.exec(`CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT,
      rollout_ordinal INTEGER, item_type TEXT, item_json TEXT)`);
    history
      .prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?)')
      .run(
        native.thread,
        'original-turn',
        'native-input',
        1,
        'userMessage',
        JSON.stringify({ type: 'userMessage', clientId: 'persisted-client-id' }),
      );
    history.close();
    assert.equal(restored.reconcile('request').state, 'delivered');
    assert.equal(writes, 1);
    await assert.rejects(
      restored.submit('request', { ...request, thread: 'another-thread' }, 'different'),
      /identity changed/,
    );
    restored.stop();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
