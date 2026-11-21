import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { mkdtemp, rm, chmod, symlink, writeFile } from 'node:fs/promises';

import { readRecord, ownProcess, MAX_RECORD } from '../src/harness/local-file';

// =============================================================================
// Discovery records are read only from this user's own files
// =============================================================================

test(
  'a discovery record is read only from a private regular file, or a readable one that holds no credential',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'dashup-read-record-'));
    const path = join(root, 'owner.json');
    const link = join(root, 'linked.json');
    try {
      await writeFile(path, '{"pid":1}', { mode: 0o600 });
      await symlink(path, link);
      assert.deepEqual(await readRecord(path), { pid: 1 });
      assert.deepEqual(await readRecord(path, true), { pid: 1 });
      assert.equal(await readRecord(link), undefined);
      assert.equal(await readRecord(link, true), undefined);
      assert.equal(await readRecord(root), undefined);
      assert.equal(await readRecord(join(root, 'missing')), undefined);
      await chmod(path, 0o644);
      assert.equal(await readRecord(path), undefined);
      assert.deepEqual(await readRecord(path, true), { pid: 1 });
      await chmod(path, 0o664);
      assert.equal(await readRecord(path, true), undefined);
      await chmod(path, 0o600);
      await writeFile(path, 'not a record');
      await assert.rejects(readRecord(path), SyntaxError);
      await writeFile(path, JSON.stringify('x'.repeat(MAX_RECORD)));
      assert.equal(await readRecord(path), undefined);
      assert.equal(await readRecord(path, true), undefined);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('a record names a process only while it runs as this user', async () => {
  assert.equal(await ownProcess(process.pid), true);
  await assert.rejects(ownProcess(2_147_483_647));
});
