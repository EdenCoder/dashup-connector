import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { cp, rm, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';

import { service } from '../src/install';

const node   = '/opt/node "24"/bin/node';
const entry  = '/home/a b/.dashup/app/node_modules/@dashup/connector/dist/index.js';
const config = '/home/a b/.dashup/100%/connector.json';

test('each platform starts watch with the paired state file and restarts only after a crash', () => {
  const unit = service('linux', node, entry, config);
  assert.match(
    unit,
    /^Environment="DASHUP_CONFIG=\/home\/a b\/\.dashup\/100%%\/connector\.json"$/m,
  );
  assert.match(
    unit,
    /^ExecStart="\/opt\/node \\"24\\"\/bin\/node" "--disable-warning=ExperimentalWarning" "\/home\/a b\/\.dashup\/app\/node_modules\/@dashup\/connector\/dist\/index\.js" watch$/m,
  );
  assert.match(unit, /^Restart=on-failure$/m);

  const plist = service('darwin', node, entry, '/Users/a&b/connector.json');
  assert.ok(
    plist.includes('<key>DASHUP_CONFIG</key><string>/Users/a&amp;b/connector.json</string>'),
  );
  assert.ok(
    plist.includes(
      `<string>${node}</string><string>--disable-warning=ExperimentalWarning</string><string>${entry}</string><string>watch</string>`,
    ),
  );
  assert.ok(plist.includes('<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>'));

  const script = service(
    'win32',
    'C:\\node\\node.exe',
    'C:\\app\\dist\\index.js',
    'C:\\Users\\a "b"\\connector.json',
  );
  assert.ok(
    script.includes(
      'shell.Environment("Process")("DASHUP_CONFIG") = "C:\\Users\\a ""b""\\connector.json"',
    ),
  );
  assert.ok(
    script.includes(
      'shell.Run """C:\\node\\node.exe"" ""--disable-warning=ExperimentalWarning"" ""C:\\app\\dist\\index.js"" watch", 0, False',
    ),
  );
});

test(
  'installed Pi installs and removes the same durable local package while preserving existing settings',
  {
    skip: !process.env.DASHUP_PI_CLI,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'dashup-pi-install-'));
    const agent = join(root, 'agent');
    const plugin = join(root, 'durable package with spaces');
    const unrelated = join(root, 'other-package');
    await mkdir(agent);
    await mkdir(unrelated);
    await cp(fileURLToPath(new URL('../pi/', import.meta.url)), plugin, { recursive: true });
    await writeFile(
      join(unrelated, 'package.json'),
      JSON.stringify({ name: 'other-local-package', pi: { extensions: [] } }),
    );
    const settings = join(agent, 'settings.json');
    await writeFile(settings, JSON.stringify({ packages: [unrelated], quietStartup: true }));
    const run = (command: string) =>
      promisify(execFile)(process.execPath, [process.env.DASHUP_PI_CLI!, command, plugin], {
        cwd: root,
        env: { ...process.env, PI_OFFLINE: '1', PI_CODING_AGENT_DIR: agent },
        timeout: 10_000,
      });
    try {
      await run('install');
      const installed = JSON.parse(await readFile(settings, 'utf8'));
      assert.ok(installed.packages.some((source: string) => resolve(agent, source) === plugin));
      assert.ok(installed.packages.includes(unrelated));
      assert.equal(installed.quietStartup, true);
      await run('remove');
      const removed = JSON.parse(await readFile(settings, 'utf8'));
      assert.deepEqual(removed.packages, [unrelated]);
      assert.equal(removed.quietStartup, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('startup preserves the installer command environment and includes the node toolchain', () => {
  const path = '/home/user/.local/bin:/usr/bin';
  const unit = service('linux', '/opt/node/bin/node', entry, config, path);
  assert.match(unit, /^Environment="PATH=\/opt\/node\/bin:\/home\/user\/.local\/bin:\/usr\/bin"$/m);
  const plist = service('darwin', '/opt/node/bin/node', entry, config, path);
  assert.ok(
    plist.includes('<key>PATH</key><string>/opt/node/bin:/home/user/.local/bin:/usr/bin</string>'),
  );
});
