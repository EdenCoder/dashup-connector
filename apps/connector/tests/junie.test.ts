import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { mkdir, mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';

import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';

import { Junie, junieApproval } from '../src/harness/junie';
import { scanJunieHistories } from '../src/harness/junie-history';

// =============================================================================
// Native ACP lifecycle and controls
// =============================================================================

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 5_000;
  do {
    const value = await read();
    if (ready(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < end);
  assert.fail('Junie did not publish the expected native state');
}

// A protocol peer, not a model: asserts exactly what Dashup writes to the ACP agent's stdio.
async function fixture(load = true) {
  const directory = await mkdtemp(join(tmpdir(), 'dashup-junie-'));
  const home = join(directory, 'junie-home');
  await mkdir(home, { mode: 0o700 });
  const command = join(directory, 'junie.mjs');
  const log = join(directory, 'calls.jsonl');
  await writeFile(
    command,
    `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const log = ${JSON.stringify(log)};
const sessionId = 'native-session';
let prompt;
let permission;
function write(message) { process.stdout.write(JSON.stringify({jsonrpc:'2.0',...message})+'\\n'); }
function result(id, value) { write({id,result:value}); }
function update(value, id=sessionId) { write({method:'session/update',params:{sessionId:id,update:value}}); }
function finish(reason='end_turn') {
  if (!prompt) return;
  update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Native answer'}},prompt.params.sessionId);
  result(prompt.id,{stopReason:reason});
  prompt=undefined;
}
appendFileSync(log,JSON.stringify({argv:process.argv.slice(2)})+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const frame=JSON.parse(line);
 appendFileSync(log,JSON.stringify(frame)+'\\n');
 if(frame.method==='initialize') result(frame.id,{protocolVersion:1,agentCapabilities:{loadSession:${load}}});
 else if(frame.method==='session/new') result(frame.id,{sessionId});
 else if(frame.method==='session/load') {
   update({sessionUpdate:'user_message_chunk',content:{type:'text',text:'Saved question'}},frame.params.sessionId);
   update({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Saved answer'}},frame.params.sessionId);
   result(frame.id,{});
 }
 else if(frame.method==='session/prompt') {
   const value=frame.params.prompt[0].text;
   if(value==='reject') { write({id:frame.id,error:{code:-32000,message:'Authentication is required'}}); return; }
   prompt=frame;
   update({sessionUpdate:'tool_call',toolCallId:'native-tool',title:'Native shell',kind:'execute',status:'in_progress',rawInput:{command:'echo yes'}},frame.params.sessionId);
   if(value==='permission') {
     permission='native-permission-request';
     write({id:permission,method:'session/request_permission',params:{
       sessionId:frame.params.sessionId,
       toolCall:{toolCallId:'native-tool',title:'Run echo?',rawInput:{command:'echo yes'}},
       options:[{optionId:'native-once',name:'Run once',kind:'allow_once'},{optionId:'native-deny',name:'Do not run',kind:'reject_once'}]
     }});
   } else if(value==='exit') setTimeout(()=>process.exit(0),10);
   else if(value!=='wait') finish();
 }
 else if(frame.method==='session/cancel') finish('cancelled');
 else if(frame.id===permission) {
   update({sessionUpdate:'tool_call_update',toolCallId:'native-tool',status:'completed',rawOutput:frame.result.outcome.optionId??'cancelled'},prompt.params.sessionId);
   finish();
 }
});
`,
    { mode: 0o700 },
  );
  const previous = process.env.DASHUP_JUNIE_COMMAND;
  const previousHome = process.env.DASHUP_JUNIE_HOME;
  process.env.DASHUP_JUNIE_COMMAND = command;
  process.env.DASHUP_JUNIE_HOME = home;
  const junie = new Junie(() => {});
  return {
    junie,
    directory,
    calls: async (): Promise<any[]> =>
      (await readFile(log, 'utf8').catch(() => ''))
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    async close() {
      junie.stop();
      if (previous === undefined) delete process.env.DASHUP_JUNIE_COMMAND;
      else process.env.DASHUP_JUNIE_COMMAND = previous;
      if (previousHome === undefined) delete process.env.DASHUP_JUNIE_HOME;
      else process.env.DASHUP_JUNIE_HOME = previousHome;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('Junie discovery and availability never start an agent process', async () => {
  const native = await fixture();
  try {
    assert.equal(await native.junie.available(), true);
    assert.deepEqual(await native.junie.refresh(), []);
    assert.deepEqual(await native.junie.refresh(), []);
    assert.deepEqual(await native.calls(), []);
  } finally {
    await native.close();
  }
});

test('Junie uses real session IDs, native permission choices, command deduplication and cancel', async () => {
  const native = await fixture();
  try {
    const id = await native.junie.start(native.directory, 'permission');
    assert.equal(id, 'native-session');
    let [session] = await until(
      () => native.junie.refresh(),
      (sessions) => sessions[0]?.approvals.length === 1,
    );
    assert.equal(session!.status, 'attention');
    assert.deepEqual(session!.approvals[0]!.choices, [
      { id: 'native-once', label: 'Run once', intent: 'approve' },
      { id: 'native-deny', label: 'Do not run', intent: 'reject' },
    ]);
    assert.match(session!.approvals[0]!.detail, /echo yes/);
    assert.equal(session!.now, undefined);
    await assert.rejects(
      session!.approve!('bad-choice', session!.approvals[0]!.id, { choice: 'made-up' }),
      /native Junie permission/,
    );
    const approved = () =>
      session!.approve!('same-approval', session!.approvals[0]!.id, { choice: 'native-once' });
    await Promise.all([approved(), approved()]);
    [session] = await until(
      () => native.junie.refresh(),
      (sessions) => sessions[0]?.status === 'idle',
    );
    assert.ok(session!.messages.some((message) => message.text === 'Native answer'));
    const sent = () => session!.send!('same-message', 'wait');
    await Promise.all([sent(), sent()]);
    [session] = await native.junie.refresh();
    assert.equal(session!.status, 'working');
    assert.ok(session!.stop);
    await session!.stop!('cancel-request');
    [session] = await until(
      () => native.junie.refresh(),
      (sessions) => sessions[0]?.status === 'idle',
    );
    assert.equal(session!.stop, undefined);
    const calls = await native.calls();
    assert.deepEqual(calls[0].argv, ['--acp', 'true']);
    assert.equal(calls.filter((call) => call.method === 'session/new').length, 1);
    assert.equal(calls.filter((call) => call.method === 'session/prompt').length, 2);
    assert.equal(calls.filter((call) => call.method === 'session/cancel').length, 1);
    assert.deepEqual(calls.find((call) => call.id === 'native-permission-request')?.result, {
      outcome: { outcome: 'selected', optionId: 'native-once' },
    });
    assert.ok(
      calls
        .filter((call) => call.method?.startsWith('session/') && call.method !== 'session/new')
        .every((call) => call.params.sessionId === id),
    );
    native.junie.stop();
    assert.deepEqual(await native.junie.refresh(), []);
  } finally {
    await native.close();
  }
});

test('Junie loads saved history under the original ID and never substitutes a new session', async () => {
  const native = await fixture();
  try {
    await native.junie.resume('saved-native-id', native.directory, 'Follow up');
    const [session] = await until(
      () => native.junie.refresh(),
      (sessions) => sessions[0]?.status === 'idle',
    );
    assert.equal(session!.id, 'saved-native-id');
    assert.deepEqual(
      session!.messages.filter((message) => message.role !== 'tool').map((message) => message.text),
      ['Saved question', 'Saved answer', 'Follow up', 'Native answer'],
    );
    const calls = await native.calls();
    assert.equal(calls.filter((call) => call.method === 'session/load').length, 1);
    assert.equal(calls.filter((call) => call.method === 'session/new').length, 0);
  } finally {
    await native.close();
  }
});

test('Junie removes stale controls after disconnect and explicitly reloads the same session', async () => {
  const native = await fixture();
  try {
    const id = await native.junie.start(native.directory, 'exit');
    const [closed] = await until(
      () => native.junie.refresh(),
      (sessions) => !!sessions[0] && !sessions[0].send,
    );
    assert.equal(closed!.stop, undefined);
    await native.junie.resume(id, native.directory, 'Continue');
    const [resumed] = await until(
      () => native.junie.refresh(),
      (sessions) => sessions[0]?.status === 'idle',
    );
    assert.equal(resumed!.id, id);
    assert.ok(resumed!.send);
    const calls = await native.calls();
    assert.equal(calls.filter((call) => call.method === 'session/new').length, 1);
    assert.equal(calls.filter((call) => call.method === 'session/load').length, 1);
  } finally {
    await native.close();
  }
});

test('Junie refuses unsupported load and preserves a native prompt failure', async () => {
  const native = await fixture(false);
  try {
    await assert.rejects(
      native.junie.resume('saved-native-id', native.directory, 'Follow up'),
      /cannot load saved sessions/,
    );
    assert.equal((await native.calls()).filter((call) => call.method === 'session/load').length, 0);
    await assert.rejects(
      native.junie.start(native.directory, 'reject'),
      /Authentication is required/,
    );
    assert.deepEqual(await native.junie.refresh(), []);
  } finally {
    await native.close();
  }
});

test('Junie approval previews fail closed without changing native option IDs', () => {
  const request: RequestPermissionRequest = {
    sessionId : 'native',
    toolCall  : { toolCallId: 'tool', title: 'Shell' },
    options   : [
      { optionId: 'yes-from-agent', name: 'Yes', kind: 'allow_once' },
      { optionId: 'no-from-agent', name: 'No', kind: 'reject_once' },
    ],
  };
  assert.deepEqual(junieApproval('ask', request).choices, [
    { id: 'no-from-agent', label: 'No', intent: 'reject' },
  ]);
  for (const rawInput of [null, {}, '', []]) {
    request.toolCall.rawInput = rawInput;
    assert.deepEqual(junieApproval('ask', request).choices, [
      { id: 'no-from-agent', label: 'No', intent: 'reject' },
    ]);
  }
  request.toolCall.rawInput = { command: 'x'.repeat(65_536) };
  assert.deepEqual(junieApproval('ask', request).choices, [
    { id: 'no-from-agent', label: 'No', intent: 'reject' },
  ]);
  request.toolCall.rawInput = { command: 'echo yes' };
  assert.deepEqual(junieApproval('ask', request).choices, [
    { id: 'yes-from-agent', label: 'Yes', intent: 'approve' },
    { id: 'no-from-agent', label: 'No', intent: 'reject' },
  ]);
});

test('Junie discovers native saved sessions after restart and reads only user-visible output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dashup-junie-history-'));
  const previous = process.env.DASHUP_JUNIE_HOME;
  process.env.DASHUP_JUNIE_HOME = directory;
  const folder = join(directory, 'sessions', 'session-261029-153342-doy8');
  const timestampMs = 1793252022787;
  const visible = {
    kind: 'SessionA2uxEvent',
    event: {
      state: 'COMPLETED',
      agentEvent: {
        kind: 'ResultBlockUpdatedEvent',
        agent: { kind: 'MainAgent', id: 'main', name: 'main', type: 'LINEAR' },
        stepId: 'fca6542a-00e6-4368-b4d3-d05d07332ceb',
        result: 'hello',
        errorCode: 'Submit',
      },
    },
    timestampMs,
  };
  try {
    await mkdir(folder, { recursive: true });
    const index = join(directory, 'sessions', 'index.jsonl');
    await writeFile(
      index,
      JSON.stringify({
        sessionId: 'session-261029-153342-doy8',
        createdAt: timestampMs,
        updatedAt: timestampMs,
        projectDir: directory,
        taskName: 'A native task',
      }) +
        '\n' +
        JSON.stringify({
          sessionId: '../../private',
          projectDir: directory,
          updatedAt: timestampMs,
        }) +
        '\n',
    );
    const events = join(folder, 'events.jsonl');
    await writeFile(
      events,
      [
        {
          kind: 'UserPromptEvent',
          requestId: 'prompt-261029-153342-7r10',
          prompt: 'Internal prompt',
          presentablePrompt: 'Say hello',
          timestampMs,
        },
        {
          kind: 'SessionA2uxEvent',
          event: {
            agentEvent: {
              kind: 'AgentStateUpdatedEvent',
              blob: 'PRIVATE REASONING AND ENVIRONMENT',
            },
          },
        },
        visible,
        visible,
      ]
        .map((row) => JSON.stringify(row))
        .join('\n') + '\n{"kind":',
    );
    const scan = scanJunieHistories();
    assert.equal(scan.sessions.length, 1);
    const [session] = scan.sessions;
    assert.equal(session!.id, 'session-261029-153342-doy8');
    assert.equal(session!.cwd, directory);
    assert.equal(session!.title, 'A native task');
    assert.equal(session!.resumable, false);
    assert.equal(session!.updatedAt, new Date(timestampMs).toISOString());
    assert.ok(scan.paths.includes(index));
    assert.ok(scan.paths.includes(events));
    assert.deepEqual(
      session!.read().map(({ role, text }) => ({ role, text })),
      [
        { role: 'user', text: 'Say hello' },
        { role: 'assistant', text: 'hello' },
      ],
    );
    assert.ok(!JSON.stringify(session!.read()).includes('PRIVATE'));
    assert.deepEqual(scan.warnings, []);
  } finally {
    if (previous === undefined) delete process.env.DASHUP_JUNIE_HOME;
    else process.env.DASHUP_JUNIE_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test(
  'native Junie completes a local-provider turn, persists it and reloads the same ID',
  {
    skip: !process.env.DASHUP_JUNIE_CLI,
    timeout: 90_000,
  },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dashup-junie-native-'));
    const command = join(directory, 'junie.mjs');
    const home = join(directory, 'home');
    const previous = process.env.DASHUP_JUNIE_COMMAND;
    const previousHome = process.env.DASHUP_JUNIE_HOME;
    const requests: string[] = [];
    const server = createServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += String(chunk);
      const body = JSON.parse(raw);
      requests.push(body.model);
      const message = body.tools?.length
        ? {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'local-answer',
                type: 'function',
                function: {
                  name: 'answer',
                  arguments: JSON.stringify({ full_answer: 'Native local hello' }),
                },
              },
            ],
          }
        : { role: 'assistant', content: 'Local Junie test' };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'local',
          object: 'chat.completion',
          created: 0,
          model: 'local-test',
          choices: [
            { index: 0, message, finish_reason: body.tools?.length ? 'tool_calls' : 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    let junie = new Junie(() => {});
    try {
      await mkdir(join(directory, '.junie', 'models'), { recursive: true });
      await mkdir(home);
      await writeFile(
        join(directory, '.junie', 'models', 'dashup-test.json'),
        JSON.stringify({
          id: 'local-test',
          apiType: 'OpenAICompletion',
          baseUrl: `http://127.0.0.1:${address.port}/v1/chat/completions`,
        }),
      );
      await writeFile(
        command,
        `#!${process.execPath}
import {spawn} from 'node:child_process';
const child=spawn(${JSON.stringify(process.env.DASHUP_JUNIE_CLI)}, ['--skip-update-check','--share-anonymous-statistics','false','--model','custom:dashup-test',...process.argv.slice(2)], {stdio:'inherit',env:{...process.env,JAVA_TOOL_OPTIONS:${JSON.stringify(`-Duser.home=${home}`)}}});
process.on('SIGTERM',()=>child.kill());
child.on('exit',code=>process.exit(code??0));
`,
        { mode: 0o700 },
      );
      process.env.DASHUP_JUNIE_COMMAND = command;
      process.env.DASHUP_JUNIE_HOME = join(directory, 'junie-data');
      const id = await junie.start(directory, 'Say hello without reading or changing files.');
      const [session] = await until(
        () => junie.refresh(),
        (sessions) => sessions[0]?.status === 'idle',
      );
      assert.ok(session!.messages.some((message) => message.text.includes('Native local hello')));
      assert.ok(requests.length > 0 && requests.every((model) => model === 'local-test'));
      const [saved] = await until(
        async () => scanJunieHistories().sessions,
        (sessions) =>
          !!sessions
            .find((session) => session.id === id)
            ?.read()
            .some((message) => message.text === 'Native local hello'),
      );
      assert.equal(saved!.id, id);
      junie.stop();
      junie = new Junie(() => {});
      assert.deepEqual(await junie.refresh(), []);
      await junie.resume(id, directory, 'Say hello once more without reading or changing files.');
      const [resumed] = await until(
        () => junie.refresh(),
        (sessions) => sessions[0]?.status === 'idle',
      );
      assert.equal(resumed!.id, id);
      assert.ok(resumed!.messages.some((message) => message.text.includes('Native local hello')));
    } finally {
      junie.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previous === undefined) delete process.env.DASHUP_JUNIE_COMMAND;
      else process.env.DASHUP_JUNIE_COMMAND = previous;
      if (previousHome === undefined) delete process.env.DASHUP_JUNIE_HOME;
      else process.env.DASHUP_JUNIE_HOME = previousHome;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
