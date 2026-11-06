import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Terminals } from '../src/terminal';
import type { SessionContent as TerminalContent } from '@dashup/protocol/session';
test('paired PTY streams raw ANSI and retains only instance metadata', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dashup-terminal-'));
  const outputs: Array<Extract<TerminalContent, { type: 'output' }>> = [];
  const terminals = new Terminals(
    () => true,
    () => {},
    (error) => {
      throw error;
    },
    join(cwd, 'instances'),
    (_pair, _project, content) => {
      if (content.type === 'output') outputs.push(content);
    },
  );
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(predicate());
  };
  try {
    const id = await terminals.open('phone', 'project', cwd, 80, 24);
    await terminals.follow('phone', 'project', id);
    assert.equal(outputs[0]?.reset, true);
    assert.throws(() => terminals.input('other-phone', 'project', id, 'exit\r'), /no longer/);
    assert.throws(() => terminals.input('phone', 'other-project', id, 'exit\r'), /no longer/);
    terminals.input('phone', 'project', id, "printf '\\033[2J\\033[Hterminal-proof\\n'\r");
    await waitFor(() =>
      outputs.some((output) => output.data.includes('\x1b[2J\x1b[Hterminal-proof')));
    assert.deepEqual(terminals.session(id)?.messages, []);
    terminals.resize('phone', 'project', id, 100, 30);
    terminals.unfollow('phone', 'project', id);
    await terminals.follow('phone', 'project', id);
    assert.equal(outputs.at(-1)?.cols, 100);
    assert.equal(outputs.at(-1)?.rows, 30);
    assert.equal(outputs.at(-1)?.reset, true);
    assert.ok(outputs.at(-1)?.data.includes('terminal-proof'));
    const saved = JSON.parse(await readFile(join(cwd, 'instances', `${id}.json`), 'utf8'));
    assert.equal(saved.messages, undefined);
    assert.ok(!JSON.stringify(saved).includes('terminal-proof'));
    await terminals.close('phone', 'project', id);
    assert.equal(terminals.session(id)?.status, 'idle');
    assert.throws(() => terminals.input('phone', 'project', id, 'echo no\r'), /exited/);
  } finally {
    terminals.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('terminal restart restores owned instance metadata without conversation messages', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dashup-terminal-instance-'));
  const directory = join(cwd, 'instances');
  const report = (error: unknown) => {
    throw error;
  };
  const terminals = new Terminals(
    () => true,
    () => {},
    report,
    directory,
  );
  let restored: Terminals | undefined;
  try {
    const id = await terminals.open('phone', 'project', cwd, 80, 24);
    terminals.input('phone', 'project', id, "printf 'private-input\\n'\r");
    terminals.stop();
    restored = new Terminals(
      () => true,
      () => {},
      report,
      directory,
    );
    const instance = restored.session(id)!;
    assert.equal(instance.status, 'idle');
    assert.equal(instance.send, undefined);
    assert.deepEqual(instance.messages, []);
    assert.equal(restored.owns(id, 'phone'), true);
    assert.equal(restored.owns(id, 'another-phone'), false);
    assert.ok(!(await readFile(join(directory, `${id}.json`), 'utf8')).includes('private-input'));
  } finally {
    terminals.stop();
    restored?.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test('leaving or switching terminals cancels an attach that is still waiting for the current screen', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dashup-terminal-attach-'));
  const output: TerminalContent[] = [];
  const terminals = new Terminals(
    () => true,
    () => {},
    (error) => {
      throw error;
    },
    join(cwd, 'instances'),
    (_pair, _project, content) => output.push(content),
  );
  try {
    const first = await terminals.open('phone', 'project', cwd, 80, 24);
    const second = await terminals.open('phone', 'project', cwd, 80, 24);
    const cancelled = terminals.follow('phone', 'project', first);
    terminals.unfollow('phone', 'project', first);
    await cancelled;
    assert.equal(terminals.following('phone', first), false);
    assert.equal(output.length, 0);
    const pending = terminals.follow('phone', 'project', first);
    const replacement = terminals.follow('phone', 'project', second);
    await Promise.all([pending, replacement]);
    assert.equal(terminals.following('phone', first), false);
    assert.equal(terminals.following('phone', second), true);
    assert.ok(output.length > 0);
    assert.ok(output.every((content) => 'terminalId' in content && content.terminalId === second));
  } finally {
    terminals.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});
