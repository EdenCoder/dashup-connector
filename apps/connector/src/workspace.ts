import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { join, dirname, basename, relative, isAbsolute } from 'node:path';
import { mkdir, lstat, realpath, readlink, open } from 'node:fs/promises';

import type { Workspace, WorkspaceCheck, WorkspaceTarget } from '@dashup/protocol/workspace';
import { SESSION_PACKET_BYTES } from '@dashup/protocol/session';

// =============================================================================
// Git: argument-only inspection, with bounded data for an encrypted result
// =============================================================================

const DIFF_BYTES   = 48 * 1024;
const OUTPUT_BYTES = 8 * 1024;
const INDEX_BYTES  = 1024 * 1024;
const FILES       = 200;
const BRANCHES    = 100;
const CHECKS      = 3;
const GIT_MS      = 30_000;
const CHECK_MS    = 120_000;
const WORKSPACE_BYTES = SESSION_PACKET_BYTES - 4096;

function preview(workspace: Workspace): Workspace {
  // The encoded result owns the budget: escaped text and file metadata also use packet bytes.
  while (Buffer.byteLength(JSON.stringify(workspace)) > WORKSPACE_BYTES) {
    workspace.truncated = true;
    if (workspace.diff) {
      let end = Math.floor(workspace.diff.length / 2);
      if (/[\uD800-\uDBFF]/.test(workspace.diff[end - 1] ?? '')) end--;
      workspace.diff = workspace.diff.slice(0, end);
    } else {
      const output = workspace.checks.find((check) => check.output.length > 256);
      if (output) output.output = output.output.slice(0, Math.floor(output.output.length / 2));
      else {
        const list = [
          workspace.files,
          workspace.branches,
          workspace.worktrees,
          workspace.checks,
        ].find((items) => items.length);
        if (!list) throw new Error('Workspace metadata exceeds its preview limit.');
        list.splice(Math.floor(list.length / 2));
      }
    }
  }
  return workspace;
}

type Output = { text: string; code: number | null; truncated: boolean; timedOut: boolean };
type RunOptions = {
  bytes?: number;
  timeout?: number;
  signal?: AbortSignal;
  data?: (chunk: Buffer) => void;
};

function run(cwd: string, file: string, args: string[], options: RunOptions = {}): Promise<Output> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('Check stopped.'));
      return;
    }
    const child = spawn(file, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    const limit = options.bytes ?? INDEX_BYTES;
    let received = 0;
    let timedOut = false;
    const kill = () => {
      if (process.platform === 'win32' && child.pid)
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on(
          'error',
          () => child.kill('SIGKILL'),
        );
      else {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeout ?? GIT_MS);
    timer.unref();
    options.signal?.addEventListener('abort', kill, { once: true });
    const collect = (chunk: Buffer) => {
      options.data?.(chunk);
      const remaining = limit - received;
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      received += chunk.length;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', kill);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', kill);
      resolve({
        text: Buffer.concat(chunks).toString('utf8'),
        code,
        truncated: received > limit,
        timedOut,
      });
    });
  });
}

async function git(cwd: string, args: string[], options: RunOptions = {}): Promise<Output> {
  const result = await run(
    cwd,
    'git',
    [
      '-c',
      'core.quotePath=false',
      '-c',
      'diff.mnemonicPrefix=false',
      '-c',
      'diff.noprefix=false',
      ...args,
    ],
    options,
  );
  if (result.code !== 0)
    throw new Error(
      result.timedOut
        ? 'Git inspection timed out.'
        : result.text.trim() || 'Git inspection failed.',
    );
  return result;
}

async function root(cwd: string): Promise<string> {
  return realpath((await git(cwd, ['rev-parse', '--show-toplevel'])).text.trim());
}

async function commit(cwd: string, reference: string): Promise<string> {
  if (!reference || reference.length > 255 || /[\x00-\x1f]/.test(reference))
    throw new Error('Choose a valid Git baseline.');
  return (
    await git(cwd, ['rev-parse', '--verify', '--end-of-options', `${reference}^{commit}`])
  ).text.trim();
}

async function worktrees(cwd: string): Promise<Workspace['worktrees']> {
  const result = await git(cwd, ['worktree', 'list', '--porcelain', '-z']);
  if (result.truncated) throw new Error('This repository has too many worktrees to list.');
  return result.text.split('\0\0').flatMap((record) => {
    const fields = record.split('\0');
    const path = fields.find((field) => field.startsWith('worktree '))?.slice(9);
    if (!path || fields.includes('bare') || fields.some((field) => field.startsWith('prunable')))
      return [];
    return [
      {
        path,
        branch: fields.find((field) => field.startsWith('branch refs/heads/'))?.slice(18) ?? null,
      },
    ];
  });
}

async function untracked(cwd: string): Promise<string[]> {
  const result = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (result.truncated) throw new Error('Too many untracked files to inspect reliably.');
  return result.text.split('\0').filter(Boolean);
}

// Include file contents, not just HEAD: a passing check becomes stale after an uncommitted edit.
async function fingerprint(cwd: string): Promise<string> {
  const hash = createHash('sha256').update(await commit(cwd, 'HEAD'));
  await git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--'], {
    bytes: 0,
    data: (chunk) => hash.update(chunk),
  });
  for (const path of await untracked(cwd)) {
    const absolute = join(cwd, path);
    const stat = await lstat(absolute);
    hash.update(`${path}\0${stat.mode}\0`);
    if (stat.isSymbolicLink()) hash.update(await readlink(absolute));
    else if (stat.isFile())
      for await (const chunk of createReadStream(absolute)) hash.update(chunk);
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function newFile(
  cwd: string,
  path: string,
): Promise<{ diff: string; added: number; binary: boolean; truncated: boolean }> {
  const absolute = join(cwd, path);
  const stat = await lstat(absolute);
  let bytes: Buffer;
  if (stat.isSymbolicLink()) bytes = Buffer.from(await readlink(absolute));
  else if (stat.isFile()) {
    const file = await open(absolute, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, DIFF_BYTES));
      const result = await file.read(buffer, 0, buffer.length, 0);
      bytes = buffer.subarray(0, result.bytesRead);
    } finally {
      await file.close();
    }
  } else return { diff: '', added: 0, binary: true, truncated: false };
  const binary = bytes.includes(0);
  const lines = bytes.toString('utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const quoted = JSON.stringify(path);
  return {
    diff: binary
      ? `\nBinary file ${quoted} added\n`
      : `\ndiff --git ${JSON.stringify(`a/${path}`)} ${JSON.stringify(`b/${path}`)}\n--- /dev/null\n+++ ${JSON.stringify(`b/${path}`)}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`,
    added: binary ? 0 : lines.length,
    binary,
    truncated: stat.size > DIFF_BYTES,
  };
}

// =============================================================================
// Workspace: project review, explicit checks, and isolated launch targets
// =============================================================================

export class Workspaces {
  private readonly checks = new Map<string, WorkspaceCheck[]>();
  private readonly running = new Map<string, AbortController>();
  private stopped = false;

  constructor(private readonly checkTimeout = CHECK_MS) {}

  stop(): void {
    this.stopped = true;
    for (const controller of this.running.values()) controller.abort();
  }

  async inspect(path: string, baseline = 'HEAD'): Promise<Workspace> {
    const cwd = await root(path);
    const base = await commit(cwd, baseline);
    const [branch, head, branches, trees, stats, patch, added, revision] = await Promise.all([
      git(cwd, ['branch', '--show-current']),
      commit(cwd, 'HEAD'),
      git(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']),
      worktrees(cwd),
      git(cwd, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--numstat',
        '-z',
        base,
        '--',
      ]),
      git(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--patch', base, '--'], {
        bytes: DIFF_BYTES,
      }),
      untracked(cwd),
      this.checks.get(cwd)?.length ? fingerprint(cwd) : Promise.resolve(''),
    ]);
    let truncated = stats.truncated || patch.truncated || branches.truncated;
    const files: Workspace['files'] = stats.text
      .split('\0')
      .filter(Boolean)
      .flatMap((record) => {
        const fields = record.split('\t');
        if (fields.length < 3) return [];
        return [
          {
            path: fields.slice(2).join('\t'),
            added: Number(fields[0]) || 0,
            deleted: Number(fields[1]) || 0,
            ...(fields[0] === '-' ? { binary: true } : {}),
          },
        ];
      });
    let diff = patch.text;
    for (const file of added) {
      if (files.length >= FILES) {
        truncated = true;
        break;
      }
      const item = await newFile(cwd, file);
      files.push({
        path: file,
        added: item.added,
        deleted: 0,
        ...(item.binary ? { binary: true } : {}),
      });
      diff += item.diff;
      truncated ||= item.truncated;
    }
    const bytes = Buffer.from(diff);
    const names = branches.text.trim().split('\n').filter(Boolean);
    truncated ||= bytes.length > DIFF_BYTES || files.length > FILES || names.length > BRANCHES;
    return preview({
      branch: branch.text.trim() || null,
      head,
      baseline,
      branches: names.slice(0, BRANCHES),
      worktrees: trees,
      files: files.slice(0, FILES),
      diff: bytes.subarray(0, DIFF_BYTES).toString('utf8'),
      truncated,
      checkedAt: new Date().toISOString(),
      checks: (this.checks.get(cwd) ?? []).map((check) => ({
        ...check,
        stale: check.revision !== revision,
      })),
    });
  }

  async check(path: string, command: string): Promise<Workspace> {
    if (!command.trim() || command.length > 2000 || command.includes('\0'))
      throw new Error('Enter a check command of at most 2,000 characters.');
    const cwd = await root(path);
    if (this.stopped) throw new Error('Checks stopped with the connector.');
    if (this.running.has(cwd)) throw new Error('A check is already running in this project.');
    const controller = new AbortController();
    this.running.set(cwd, controller);
    try {
      const revision = await fingerprint(cwd);
      const startedAt = new Date().toISOString();
      const result =
        process.platform === 'win32'
          ? await run(cwd, process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], {
              bytes: OUTPUT_BYTES,
              timeout: this.checkTimeout,
              signal: controller.signal,
            })
          : await run(cwd, '/bin/sh', ['-c', command], {
              bytes: OUTPUT_BYTES,
              timeout: this.checkTimeout,
              signal: controller.signal,
            });
      if (controller.signal.aborted) throw new Error('Check stopped.');
      const check: WorkspaceCheck = {
        command,
        exitCode: result.code,
        output: result.text + (result.truncated ? '\n[Output truncated]' : ''),
        startedAt,
        finishedAt: new Date().toISOString(),
        revision,
        stale: false,
        ...(result.timedOut ? { timedOut: true } : {}),
      };
      this.checks.set(cwd, [check, ...(this.checks.get(cwd) ?? [])].slice(0, CHECKS));
      return await this.inspect(cwd);
    } finally {
      this.running.delete(cwd);
    }
  }

  async target(path: string, choice: WorkspaceTarget): Promise<string> {
    const original = await realpath(path);
    const cwd = await root(original);
    const subdirectory = relative(cwd, original);
    const project = async (tree: string): Promise<string> => {
      const target = await realpath(join(tree, subdirectory)).catch(() => {
        throw new Error('The selected branch does not contain this project folder.');
      });
      const within = relative(await realpath(tree), target);
      if (
        isAbsolute(within) ||
        within === '..' ||
        within.startsWith('../') ||
        within.startsWith('..\\') ||
        !(await lstat(target)).isDirectory()
      )
        throw new Error('The project folder must stay inside the selected worktree.');
      return target;
    };
    if (choice.kind === 'existing') {
      const selected = await realpath(choice.path);
      const known = await worktrees(cwd);
      if (
        !(await Promise.all(known.map((tree) => realpath(tree.path).catch(() => '')))).includes(
          selected,
        )
      )
        throw new Error('Choose one of this repository’s existing worktrees.');
      return project(selected);
    }
    const branch = choice.branch.trim();
    if (!branch || branch.startsWith('-') || branch.length > 120)
      throw new Error('Choose a new branch name of at most 120 characters.');
    await git(cwd, ['check-ref-format', '--branch', branch]);
    const base = await commit(cwd, choice.base);
    const parent = join(dirname(cwd), `${basename(cwd)}.worktrees`);
    await mkdir(parent, { recursive: true });
    const name = `${branch.replace(/[^a-zA-Z0-9_-]/g, '-')}-${createHash('sha256').update(branch).digest('hex').slice(0, 8)}`;
    const target = join(parent, name);
    await git(cwd, ['worktree', 'add', '-b', branch, '--', target, base]);
    return project(target);
  }
}
