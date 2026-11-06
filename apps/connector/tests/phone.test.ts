import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectorPort } from '../src/config';
import { PhoneTools } from '../src/phone';
import { runPhoneMcp } from '../src/phone-mcp';
import { newSecret } from '@dashup/protocol/crypto';
import { sealSession, openSession, type SessionContent } from '@dashup/protocol/session';
import { parsePhoneInput, type PhoneContent } from '@dashup/protocol/phone';
import type { PairingRecord } from '@dashup/protocol';

const pair: PairingRecord = {
  id: 'pair',
  mobile: 'phone',
  device: 'computer',
  code: '',
  revokedAt: null,
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('phone tools require an open paired phone and return only that phone’s encrypted response', async () => {
  const key = newSecret(randomBytes);
  const sent: PhoneContent[] = [];
  const tools = new PhoneTools({
    pairs: () => [pair],
    send: (_, content) => {
      const packet = sealSession(
        key,
        {
          pairing: pair.id,
          sender: pair.device,
          recipient: pair.mobile,
          stream: '01'.repeat(16),
          sequence: sent.length + 1,
        },
        content,
        randomBytes,
      );
      assert.equal(JSON.stringify(packet).includes('Pick the deployment colour'), false);
      sent.push(openSession(key, packet) as PhoneContent);
    },
    receive: async () => [{ path: '/private/phone/photo.png', mime: 'image/png' }],
  });
  await assert.rejects(
    tools.request({
      kind: 'choice',
      prompt: 'Pick the deployment colour',
      choices: ['Blue', 'Green'],
    }),
    /Open Dashup/,
  );
  await tools.receive(pair.id, { type: 'phone.watch', active: true });
  const result = tools.request({
    kind: 'choice',
    prompt: 'Pick the deployment colour',
    choices: ['Blue', 'Green'],
  });
  const request = sent.find((value) => value.type === 'phone.request');
  assert.ok(request?.type === 'phone.request');
  let completed = false;
  void result.then(() => {
    completed = true;
  });
  await tools.receive('other-pair', {
    type: 'phone.response',
    requestId: request.request.id,
    status: 'completed',
    choice: 'Blue',
  });
  await tick();
  assert.equal(completed, false);
  const packet = sealSession(
    key,
    {
      pairing: pair.id,
      sender: pair.mobile,
      recipient: pair.device,
      stream: '02'.repeat(16),
      sequence: 1,
    },
    { type: 'phone.response', requestId: request.request.id, status: 'completed', choice: 'Green' },
    randomBytes,
  );
  await tools.receive(pair.id, openSession(key, packet) as PhoneContent);
  assert.equal((await result).choice, 'Green');
  tools.disconnect();
});

test('phone file responses are opened locally; cancel, disconnect and expiry retire requests', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const sent: PhoneContent[] = [];
  const tools = new PhoneTools({
    pairs: () => [pair],
    send: (_, value) => {
      sent.push(value);
    },
    receive: async (_, item) => {
      assert.equal(item.id, 'ab'.repeat(32));
      return [{ path: '/private/phone/photo.png', mime: item.mime }];
    },
  });
  await tools.receive(pair.id, { type: 'phone.watch', active: true });
  const photo = tools.request({ kind: 'photo', prompt: 'Show the device' });
  const request = sent.at(-1)!;
  assert.equal(request.type, 'phone.request');
  await tools.receive(pair.id, {
    type: 'phone.response',
    requestId: (request as Extract<SessionContent, { type: 'phone.request' }>).request.id,
    status: 'completed',
    attachment: { id: 'ab'.repeat(32), name: 'photo.png', mime: 'image/png', bytes: 100 },
  });
  assert.deepEqual((await photo).files, [{ path: '/private/phone/photo.png', mime: 'image/png' }]);
  const controller = new AbortController();
  const cancelled = tools.request({ kind: 'text', prompt: 'Answer' }, controller.signal);
  const rejection = assert.rejects(cancelled, /cancelled/);
  controller.abort();
  await rejection;
  const expires = tools.request({ kind: 'text', prompt: 'Answer', timeoutMs: 10000 });
  const expired = assert.rejects(expires, /expired/);
  t.mock.timers.tick(10001);
  await expired;
  const pending = tools.request({ kind: 'text', prompt: 'Answer' });
  const disconnected = assert.rejects(pending, /disconnected/);
  tools.disconnect(pair.id);
  await disconnected;
  assert.deepEqual(tools.list(), []);
});

test('phone request validation rejects hidden/oversized capability and arbitrary choice injection', () => {
  assert.throws(() => parsePhoneInput({ kind: 'camera.stream', prompt: 'Watch' }));
  assert.throws(() => parsePhoneInput({ kind: 'text', prompt: 'x'.repeat(4001) }));
  assert.throws(() => parsePhoneInput({ kind: 'choice', prompt: 'Pick', choices: ['A', 'A'] }));
  assert.throws(() => parsePhoneInput({ kind: 'text', prompt: 'Answer', timeoutMs: 999999 }));
  assert.throws(() => parsePhoneInput({ kind: 'text', prompt: 'Answer', background: true }));
});

test('cancelling while a phone attachment downloads aborts that work and returns no late files', async () => {
  let request!: Extract<PhoneContent, { type: 'phone.request' }>;
  let readingSignal!: AbortSignal;
  const tools = new PhoneTools({
    pairs: () => [pair],
    send: (_, content) => {
      if (content.type === 'phone.request') request = content;
    },
    receive: async (_, _item, signal) => {
      readingSignal = signal;
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('Read cancelled')), {
          once: true,
        }));
    },
  });
  await tools.receive(pair.id, { type: 'phone.watch', active: true });
  const controller = new AbortController();
  const result = tools.request({ kind: 'photo', prompt: 'Show the device' }, controller.signal);
  const rejected = assert.rejects(result, /cancelled/);
  const reading = tools.receive(pair.id, {
    type: 'phone.response',
    requestId: request.request.id,
    status: 'completed',
    attachment: { id: 'ab'.repeat(32), name: 'photo.png', mime: 'image/png', bytes: 100 },
  });
  controller.abort();
  await rejected;
  await reading;
  assert.equal(readingSignal.aborted, true);
  tools.disconnect();
});

test('MCP stdio initializes, advertises schemas, calls tools, and cancels live requests', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const replies: Array<Record<string, any>> = [];
  let buffered = '';
  output.setEncoding('utf8');
  output.on('data', (chunk: string) => {
    buffered += chunk;
    let end;
    while ((end = buffered.indexOf('\n')) >= 0) {
      replies.push(JSON.parse(buffered.slice(0, end)));
      buffered = buffered.slice(end + 1);
    }
  });
  const mcp = runPhoneMcp({
    input,
    output,
    call: async (path, value, signal) => {
      if (path === '/phone/list') return { phones: [{ pairing: pair.id }] };
      assert.equal((value as { kind: string }).kind, 'text');
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
    },
  });
  const send = (value: unknown) => input.write(JSON.stringify(value) + '\n');
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    },
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'phone_list', arguments: {} },
  });
  send({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'phone_request', arguments: { kind: 'text', prompt: 'Answer' } },
  });
  await tick();
  send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 4 } });
  await tick();
  assert.equal(replies.find((reply) => reply.id === 1)?.result.protocolVersion, '2025-06-18');
  const tools = replies.find((reply) => reply.id === 2)?.result.tools;
  assert.equal(tools[1].inputSchema.additionalProperties, false);
  assert.ok(tools[1].inputSchema.properties.kind.enum.includes('sketch'));
  assert.equal(
    JSON.parse(replies.find((reply) => reply.id === 3)?.result.content[0].text).phones[0].pairing,
    pair.id,
  );
  assert.equal(replies.find((reply) => reply.id === 4)?.error.code, -32800);
  input.end();
  await mcp;
});

test('MCP rejects a line above its bounded input size', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let result = '';
  output.on('data', (chunk) => {
    result += chunk.toString();
  });
  const mcp = runPhoneMcp({ input, output, call: async () => ({}) });
  input.write('x'.repeat(65537));
  await mcp;
  assert.equal(JSON.parse(result).error.code, -32600);
});

test('the actual phone-tools CLI speaks MCP through the authenticated loopback connector', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dashup-phone-mcp-'));
  const path = join(directory, 'connector.json');
  const localSecret = newSecret(randomBytes);
  await writeFile(
    path,
    JSON.stringify({ api: 'http://127.0.0.1:1', localSecret, secret: '', pairs: {} }),
    { mode: 0o600 },
  );
  const previous = process.env.DASHUP_CONFIG;
  process.env.DASHUP_CONFIG = path;
  const port = connectorPort();
  if (previous === undefined) delete process.env.DASHUP_CONFIG;
  else process.env.DASHUP_CONFIG = previous;
  const key = newSecret(randomBytes);
  let sequence = 0;
  const tools = new PhoneTools({
    pairs: () => [pair],
    receive: async () => [],
    send: (_, content) => {
      const wire = sealSession(
        key,
        {
          pairing: pair.id,
          sender: pair.device,
          recipient: pair.mobile,
          stream: '01'.repeat(16),
          sequence: ++sequence,
        },
        content,
        randomBytes,
      );
      const opened = openSession(key, wire);
      if (opened.type !== 'phone.request') return;
      assert.equal(JSON.stringify(wire).includes('Use the phone'), false);
      queueMicrotask(() => {
        const response = sealSession(
          key,
          {
            pairing: pair.id,
            sender: pair.mobile,
            recipient: pair.device,
            stream: '02'.repeat(16),
            sequence: ++sequence,
          },
          {
            type: 'phone.response',
            requestId: opened.request.id,
            status: 'completed',
            text: 'Selected on the phone',
          },
          randomBytes,
        );
        void tools.receive(pair.id, openSession(key, response) as PhoneContent);
      });
    },
  });
  await tools.receive(pair.id, { type: 'phone.watch', active: true });
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${localSecret}`) {
      response.writeHead(403).end();
      return;
    }
    let body = '';
    for await (const chunk of request) body += String(chunk);
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/phone/list') response.end(JSON.stringify({ phones: tools.list() }));
    else response.end(JSON.stringify(await tools.request(JSON.parse(body))));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', resolve(import.meta.dirname, '../src/index.ts'), 'phone-tools'],
    {
      cwd: resolve(import.meta.dirname, '../../..'),
      env: { ...process.env, DASHUP_CONFIG: path },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const replies: Array<Record<string, any>> = [];
  let buffered = '';
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  child.stdout.on('data', (chunk) => {
    buffered += String(chunk);
    let at;
    while ((at = buffered.indexOf('\n')) >= 0) {
      replies.push(JSON.parse(buffered.slice(0, at)));
      buffered = buffered.slice(at + 1);
    }
  });
  try {
    const send = (id: number, method: string, params: unknown) =>
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    send(1, 'initialize', { protocolVersion: '2025-06-18' });
    send(2, 'tools/list', {});
    send(3, 'tools/call', {
      name: 'phone_request',
      arguments: { kind: 'text', prompt: 'Use the phone' },
    });
    const deadline = Date.now() + 15000;
    while (!replies.some((reply) => reply.id === 3) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      replies.find((reply) => reply.id === 1)?.result.serverInfo.name,
      'dashup-phone',
      stderr,
    );
    assert.equal(
      JSON.parse(replies.find((reply) => reply.id === 3)?.result.content[0].text).text,
      'Selected on the phone',
    );
    child.stdin.end();
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    assert.equal(child.exitCode, 0, stderr);
  } finally {
    child.kill();
    tools.disconnect();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
