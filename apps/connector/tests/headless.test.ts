import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { Kimi } from '../src/harness/kimi';
import { Headless } from '../src/harness/headless';
import type { Settings, LiveSession } from '../src/harness/session';
import { change, claudeModels, claudeOptions } from '../src/harness/claude';

test('a Claude Code edit or write is reviewed as the diff it would make', () => {
  const root = mkdtempSync(join(tmpdir(), 'dashup-headless-'));
  try {
    const path = join(root, 'handler.ts');
    writeFileSync(path, 'one\ntwo\nconst key = randomUUID();\nthree\n');
    const edit = change('Edit', {
      file_path: path,
      old_string: 'const key = randomUUID();',
      new_string: 'const key = event.retryKey ?? randomUUID();\nawait saveRetryKey(event.id, key);',
    });
    assert.deepEqual(
      { ...edit, diff: edit?.diff.split('\n') },
      {
        path,
        added: 2,
        deleted: 1,
        diff: [
          `--- ${path}`,
          `+++ ${path}`,
          '@@ -3,1 +3,2 @@',
          '-const key = randomUUID();',
          '+const key = event.retryKey ?? randomUUID();',
          '+await saveRetryKey(event.id, key);',
        ],
      },
    );
    const created = change('Write', { file_path: join(root, 'new.txt'), content: 'hi\n' });
    assert.equal(created?.diff.split('\n').slice(2).join('\n'), '@@ -1,0 +1,1 @@\n+hi');
    const replaced = change('Write', {
      file_path: path,
      content: 'one\ntwo\nconst key = 1;\nthree\n',
    });
    assert.deepEqual([replaced?.added, replaced?.deleted], [1, 1]);
    assert.equal(change('Bash', { command: 'ls' }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a hosted reply streams its text as Claude Code writes it, without its subagents', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashup-headless-stream-'));
  const path = process.env.PATH;
  // Claude Code as far as a turn goes: it streams a reply in pieces, then sends the whole of it.
  writeFileSync(
    join(root, 'claude'),
    `#!/usr/bin/env node
if (!process.argv.includes('--include-partial-messages')) process.exit(2);
const say = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const event = (value, parent = null) => say({ type: 'stream_event', event: value, parent_tool_use_id: parent });
process.stdin.once('data', () => {
  say({ type: 'system', subtype: 'init' });
  event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Fixing ' } });
  event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'it' } }, 'tool-1');
  say({ type: 'assistant', parent_tool_use_id: 'tool-1', uuid: 'child', message: { content: [{ type: 'text', text: 'Subagent result' }] } });
  event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'the build' } });
  setTimeout(() => {
    say({ type: 'assistant', uuid: 'reply', message: { content: [{ type: 'text', text: 'Fixing the build' }] } });
    say({ type: 'result' });
  }, 300);
});

process.stdin.resume();
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${root}:${path}`;
  const headless = new Headless(() => {});
  try {
    await headless.start(root, 'Fix the build');
    const until = async (done: (session: LiveSession) => boolean) => {
      for (let wait = 0; wait < 100 && !done((await headless.refresh())[0]!); wait++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      return (await headless.refresh())[0]!;
    };
    const writing = await until((session) => !!session.typing?.endsWith('build'));
    assert.equal(writing.typing, 'Fixing the build');
    const done = await until((session) => session.messages.length > 1);
    assert.equal(done.typing, '');
    assert.deepEqual(
      done.messages.map((message) => message.text),
      ['Fix the build', 'Fixing the build'],
    );
  } finally {
    process.env.PATH = path;
    headless.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a phone-started Claude session receives uploaded images as native image blocks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashup-headless-images-'));
  const path = process.env.PATH;
  const heard = join(root, 'heard.json');
  const image = join(root, 'phone.png');
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    'base64',
  );
  writeFileSync(image, bytes);
  writeFileSync(
    join(root, 'claude'),
    `#!/usr/bin/env node
const { writeFileSync } = require('node:fs');
const say = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.type !== 'user') return;
  writeFileSync(${JSON.stringify(heard)}, JSON.stringify(message.message.content));
  say({ type: 'system', subtype: 'init' });
  say({ type: 'result' });
});
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${root}:${path}`;
  const headless = new Headless(() => {});
  try {
    await headless.start(root, 'Inspect this screenshot', [{ path: image, mime: 'image/png' }]);
    assert.deepEqual(JSON.parse(readFileSync(heard, 'utf8')), [
      { type: 'text', text: 'Inspect this screenshot' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') },
      },
    ]);
    const history = (await headless.refresh())[0]!.messages;
    assert.equal(history[0]!.attachments?.[0]?.mime, 'image/png');
    assert.equal(history[0]!.attachments?.[0]?.name, 'phone.png');
  } finally {
    process.env.PATH = path;
    headless.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a hosted session runs each turn on the model and switches the person chose', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashup-headless-options-'));
  const path = process.env.PATH;
  const heard = join(root, 'heard.jsonl');
  // Claude Code as its initialize answer and its turns go: it lists its models, and keeps what each
  // turn is sent; a turn holds until the test writes \`go\`.
  writeFileSync(
    join(root, 'claude'),
    `#!/usr/bin/env node
const { appendFileSync, existsSync, writeFileSync } = require('node:fs');
writeFileSync(${JSON.stringify(join(root, 'arguments.json'))}, JSON.stringify(process.argv.slice(2)));
const say = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.request?.subtype === 'initialize')
    return say({ type: 'control_response', response: { request_id: message.request_id, subtype: 'success', response: { models: [
      { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-sonnet-5-5' },
      { value: 'opus', displayName: 'Opus 5.5', resolvedModel: 'claude-opus-5-5', supportsFastMode: true, supportedEffortLevels: ['high', 'xhigh'] },
      { value: 'sonnet', displayName: 'Sonnet 5.5', resolvedModel: 'claude-sonnet-5-5', supportedEffortLevels: ['high', 'xhigh'] },
      { value: 'claude-opus-4-6', displayName: 'Opus 4.6', supportsFastMode: true, supportedEffortLevels: ['high'] },
    ] } } });
  appendFileSync(${JSON.stringify(heard)}, line + '\\n');
  if (message.request?.subtype === 'set_permission_mode')
    return say({ type: 'control_response', response: { request_id: message.request_id, subtype: message.request.mode === 'auto' ? 'success' : 'error', error: 'Mode disabled by policy' } });
  if (message.type !== 'user') return;
  say({ type: 'system', subtype: 'init', permissionMode: 'default' });
  const end = () => (existsSync(${JSON.stringify(join(root, 'go'))}) ? say({ type: 'result' }) : setTimeout(end, 20));
  end();
});
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${root}:${path}`;
  const headless = new Headless(() => {});
  const requests = () =>
    readFileSync(heard, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .map((message) => message.request ?? message.message.content);
  try {
    // Claude Code offers no models until it has answered.
    let models = claudeModels(() => {});
    for (let wait = 0; wait < 300 && !models.length; wait++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      models = claudeModels(() => {});
    }
    const options = (recorded: Settings) => claudeOptions(models, recorded);
    const sonnet  = options({ model: 'claude-sonnet-5-5', fast: true, ultracode: true });
    assert.deepEqual(sonnet, [
      {
        id      : 'model',
        name    : 'Model',
        value   : 'sonnet',
        choices : [
          { value: 'default', name: 'Default (recommended)' },
          { value: 'opus', name: 'Opus 5.5' },
          { value: 'sonnet', name: 'Sonnet 5.5' },
          { value: 'claude-opus-4-6', name: 'Opus 4.6' },
        ],
      },
      { id: 'ultracode', name: 'Ultracode', value: true },
    ]);
    // Fast mode shows where the model takes it, ultracode where it takes xhigh effort.
    const older = options({ model: 'claude-opus-4-6', fast: false, ultracode: false });
    assert.deepEqual(
      older.map((option) => `${option.id}=${option.value}`),
      ['model=claude-opus-4-6', 'fast=false'],
    );
    assert.equal(options({ model: 'claude-next' })[0]!.choices!.at(-1)!.name, 'claude-next');

    writeFileSync(join(root, 'go'), '');
    const id = await headless.start(root, 'Fix the build', undefined, 'sonnet');
    const argumentsForFirstTurn = JSON.parse(readFileSync(join(root, 'arguments.json'), 'utf8'));
    assert.equal(argumentsForFirstTurn[argumentsForFirstTurn.indexOf('--model') + 1], 'sonnet');
    const until = async (done: (session: LiveSession) => boolean) => {
      for (let wait = 0; wait < 100 && !done((await headless.refresh())[0]!); wait++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      return (await headless.refresh())[0]!;
    };
    let session = await until((session) => session.status === 'idle');
    await session.configure!('choose-model', 'model', 'opus');
    await session.configure!('choose-fast', 'fast', true);
    rmSync(join(root, 'go'));
    await headless.resume(id, root, 'Now the tests');
    session = await until((session) => session.status === 'working');
    // A switch made while a turn runs applies to it at once.
    await session.configure!('choose-ultracode', 'ultracode', true);
    await until(() => requests().length === 4);
    assert.deepEqual(requests(), [
      'Fix the build',
      { subtype: 'apply_flag_settings', settings: { fastMode: true } },
      'Now the tests',
      { subtype: 'apply_flag_settings', settings: { ultracode: true } },
    ]);
    assert.equal(session.options!(() => ({})).find((option) => option.id === 'auto')?.value, false);
    await session.configure!('auto-on', 'auto', true);
    assert.equal(session.options!(() => ({})).find((option) => option.id === 'auto')?.value, true);
    await assert.rejects(session.configure!('auto-off', 'auto', false), /disabled by policy/);
    assert.equal(session.options!(() => ({})).find((option) => option.id === 'auto')?.value, true);
  } finally {
    writeFileSync(join(root, 'go'), '');
    process.env.PATH = path;
    headless.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the phone answers a hosted session’s permissions, questions and plans as its host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dashup-headless-asks-'));
  const path = process.env.PATH;
  const heard = join(root, 'heard.jsonl');
  // Claude Code asks four things at once and takes back the last, as when a hook answers it.
  writeFileSync(
    join(root, 'claude'),
    `#!/usr/bin/env node
const fs = require('node:fs');
const say = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
const ask = (id, tool_name, input, more = {}) =>
  say({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name, input, ...more } });
let answers = 0;
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  fs.appendFileSync(${JSON.stringify(heard)}, line + '\\n');
  const message = JSON.parse(line);
  if (message.type === 'user') {
    say({ type: 'system', subtype: 'init' });
    ask('run', 'Bash', { command: 'pnpm test', description: 'Run the tests' }, {
      description: 'Run the tests',
      permission_suggestions: [
        { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'pnpm test:*' }], behavior: 'allow', destination: 'localSettings' },
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      ],
    });
    ask('ask', 'AskUserQuestion', { questions: [
      { question: 'Which color?', header: 'Color', options: [{ label: 'Red', description: 'Warm' }, { label: 'Blue', description: 'Cool' }], multiSelect: false },
      { question: 'Which checks?', header: 'Checks', options: [{ label: 'Lint', description: '' }, { label: 'Tests', description: '' }], multiSelect: true },
    ] });
    ask('plan', 'ExitPlanMode', { plan: '## Plan\\n1. Fix it' });
    ask('taken', 'Bash', { command: 'ls' });
    setTimeout(() => say({ type: 'control_cancel_request', request_id: 'taken' }), 50);
  } else if (message.type === 'control_response' && ++answers === 3) say({ type: 'result' });
});
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${root}:${path}`;
  const headless = new Headless(() => {});
  try {
    await headless.start(root, 'Fix it');
    const until = async (done: (session: LiveSession) => boolean) => {
      for (let wait = 0; wait < 100 && !done((await headless.refresh())[0]!); wait++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      return (await headless.refresh())[0]!;
    };
    const asked = await until((session) => session.approvals.length === 3);
    const [run, ask, plan] = asked.approvals;
    assert.deepEqual(
      [run!.title, run!.detail, run!.choices.map((choice) => choice.label)],
      [
        'Allow command?',
        'Run the tests\n\npnpm test',
        ['Allow once', 'Always allow pnpm test:*', 'Reject'],
      ],
    );
    assert.deepEqual(ask!.questions, [
      {
        header: 'Color',
        question: 'Which color?',
        options: [
          { label: 'Red', description: 'Warm' },
          { label: 'Blue', description: 'Cool' },
        ],
      },
      {
        header: 'Checks',
        question: 'Which checks?',
        options: [
          { label: 'Lint', description: '' },
          { label: 'Tests', description: '' },
        ],
        multiple: true,
      },
    ]);
    assert.deepEqual(
      [plan!.plan, plan!.choices],
      [
        '## Plan\n1. Fix it',
        [
          { id: 'accept', label: 'Approve' },
          { id: 'revise', label: 'Keep planning', text: true },
        ],
      ],
    );
    await asked.approve!('always', run!.id, { choice: 'always' });
    await asked.approve!('answers', ask!.id, { answers: [['Red'], ['Lint', 'Tests']] });
    await asked.approve!('revise', plan!.id, { choice: 'revise', text: 'Use echo' });
    await until((session) => session.status === 'idle');
    const responses = Object.fromEntries(
      readFileSync(heard, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((message) => message.type === 'control_response')
        .map((message) => [message.response.request_id, message.response.response]),
    );
    assert.deepEqual(responses.run, {
      behavior: 'allow',
      updatedInput: { command: 'pnpm test', description: 'Run the tests' },
      updatedPermissions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'pnpm test:*' }],
          behavior: 'allow',
          destination: 'localSettings',
        },
      ],
    });
    assert.deepEqual(
      [
        responses.ask.behavior,
        responses.ask.updatedInput.questions.length,
        responses.ask.updatedInput.answers,
      ],
      ['allow', 2, { 'Which color?': 'Red', 'Which checks?': 'Lint, Tests' }],
    );
    assert.deepEqual(responses.plan, { behavior: 'deny', message: 'Use echo' });
    assert.equal(responses.taken, undefined);
  } finally {
    process.env.PATH = path;
    headless.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a Kimi session the phone starts runs over wire mode, asks the phone, and takes its choices', async () => {
  const root  = mkdtempSync(join(tmpdir(), 'dashup-kimi-'));
  const path  = process.env.PATH;
  const home  = process.env.DASHUP_KIMI_HOME;
  const heard = join(root, 'heard.jsonl');
  writeFileSync(
    join(root, 'config.toml'),
    [
      'default_model = "kimi-code/k3"',
      'default_thinking = true',
      '[models."kimi-code/k3"]',
      'display_name = "K3"',
      'capabilities = ["thinking", "image_in"]',
      '[models."kimi-code/k2"]',
      'display_name = "K2.7 Coding"',
      'capabilities = ["thinking"]',
      '[loop_control]',
      'max_steps_per_turn = 1000',
    ].join('\n'),
  );
  // Kimi as its wire mode goes: a turn streams, asks to run a command, and ends once answered.
  writeFileSync(
    join(root, 'kimi'),
    `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
if (process.argv.includes('--version')) return console.log('kimi, version 1.52.0');
const keep = (value) => appendFileSync(${JSON.stringify(heard)}, JSON.stringify(value) + '\\n');
const say = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
const event = (type, payload = {}) => say({ method: 'event', params: { type, payload } });
keep({ argv: process.argv.slice(2) });
let prompt;
// Keep the ended process alive briefly so next-turn settings cannot race its closing stdin.
process.stdin.on('end', () => setTimeout(() => {}, 50));
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  keep(message.method ? { method: message.method, params: message.params } : { result: message.result });
  if (message.method === 'initialize') say({ id: message.id, result: { protocol_version: '1.10' } });
  if (message.method === 'set_plan_mode') say({ id: message.id, result: { status: 'ok', plan_mode: message.params.enabled } });
  if (message.method === 'prompt') {
    prompt = message.id;
    event('TurnBegin', { user_input: message.params.user_input });
    event('ContentPart', { type: 'think', think: 'Plan' });
    event('ContentPart', { type: 'text', text: 'Running' });
    say({ id: 'srv-1', method: 'request', params: { type: 'ApprovalRequest', payload: { id: 'apr_1', action: 'run shell command', description: 'cargo test', sender: 'Shell' } } });
  }
  if (message.id === 'srv-1') {
    event('ContentPart', { type: 'text', text: ' done' });
    event('TurnEnd');
    say({ id: prompt, result: { status: 'finished' } });
  }
});
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${root}:${path}`;
  process.env.DASHUP_KIMI_HOME = root;
  const kimi = new Kimi(() => {});
  const rows = () =>
    readFileSync(heard, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  const until = async (done: (session: LiveSession) => boolean) => {
    for (let wait = 0; wait < 200 && !done((await kimi.refresh())[0]!); wait++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    return (await kimi.refresh())[0]!;
  };
  try {
    const id = await kimi.start(root, 'Run the tests');
    let session = await until((session) => session.approvals.length === 1);
    const [approval] = session.approvals;
    assert.equal(approval!.title, 'Allow run shell command?');
    assert.deepEqual(
      approval!.choices.map((choice) => choice.id),
      ['approve', 'approve_for_session', 'reject'],
    );
    // A session starts on Kimi's default model and thinking, among the models its config names.
    const unrecorded = () => ({});
    assert.deepEqual(session.options!(unrecorded), [
      {
        id      : 'model',
        name    : 'Model',
        value   : 'kimi-code/k3',
        choices : [
          { value: 'kimi-code/k3', name: 'K3' },
          { value: 'kimi-code/k2', name: 'K2.7 Coding' },
        ],
      },
      { id: 'thinking', name: 'Thinking', value: true },
    ]);
    await session.approve!('dashup-approve', approval!.id, { choice: 'approve' });
    session = await until((session) => session.status === 'idle');
    assert.deepEqual(
      session.messages.map((message) => [message.role, message.text]),
      [
        ['user', 'Run the tests'],
        ['assistant', 'Running done'],
      ],
    );
    assert.deepEqual(rows().find((row) => row.result?.request_id)?.result, {
      request_id : 'apr_1',
      response   : 'approve',
    });
    // The model and thinking apply as the next turn starts, plan mode once it has.
    await session.configure!('dashup-model', 'model', 'kimi-code/k2');
    await session.configure!('dashup-thinking', 'thinking', false);
    await session.configure!('dashup-plan', 'plan', true);
    await kimi.resume(id, root, 'Again');
    await until((session) => session.approvals.length === 1);
    const heard2   = rows();
    const launches = heard2.filter((row) => row.argv).map((row) => row.argv);
    assert.deepEqual(launches, [
      ['--wire', '--work-dir', root, '--session', id, '--model', 'kimi-code/k3', '--thinking'],
      ['--wire', '--work-dir', root, '--session', id, '--model', 'kimi-code/k2', '--no-thinking'],
    ]);
    const second = heard2.map((row) => !!row.argv).lastIndexOf(true);
    assert.deepEqual(
      heard2.slice(second + 1, second + 4).map((row) => [row.method, row.params?.enabled]),
      [
        ['initialize', undefined],
        ['set_plan_mode', true],
        ['prompt', undefined],
      ],
    );
  } finally {
    process.env.PATH = path;
    if (home === undefined) delete process.env.DASHUP_KIMI_HOME;
    else process.env.DASHUP_KIMI_HOME = home;
    kimi.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
