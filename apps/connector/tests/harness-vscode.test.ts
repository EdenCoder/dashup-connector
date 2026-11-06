import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { test } from 'node:test';
import { PROTOCOL_VERSION } from '@microsoft/agent-host-protocol';
import { VSCode } from '../src/harness/vscode';
import { agentHarness } from '../src/harness/session';

// =============================================================================
// Existing Agent Host registry and official AHP client interoperability
// =============================================================================

test('editor provider ids preserve Kimi’s agent identity', () => {
  assert.equal(agentHarness('moonshot.kimi-code'), 'kimi');
});

test(
  'VS Code attaches to a private existing native AHP endpoint, observes snapshots/events, and sends acknowledged native actions',
  { skip: process.platform === 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'dashup-ahp-'));
    const registry = join(root, 'agent-host/local-endpoint/entries');
    await mkdir(registry, { recursive: true, mode: 0o700 });
    const path = join(root, 'existing.sock');
    const token = 'local-only-native-connection-token';
    const instanceId = 'original-native-host';
    const identity = createHash('sha256')
      .update(`editor\0${process.pid}\0${instanceId}`)
      .digest('hex');
    const metadata = join(registry, `${identity}.json`);
    await writeFile(
      metadata,
      JSON.stringify({
        schemaVersion: 2,
        type: 'editor',
        pid: process.pid,
        instanceId,
        protocolVersion: PROTOCOL_VERSION,
        connectionToken: token,
        endpoint: { type: 'socket', path },
      }),
      { mode: 0o600 },
    );
    const sessionUri = 'ahp-session:/existing-session';
    const chatUri = 'ahp-chat:/existing-chat';
    const date = '2026-10-20T00:00:00.000Z';
    let sequence = 0;
    let clientId = '';
    let peer: WebSocket | undefined;
    const calls: any[] = [];
    const confirmation = {
      id: 'native-request',
      kind: 'toolConfirmation',
      chat: chatUri,
      turnId: 'original-turn',
      toolCall: {
        toolCallId: 'original-tool',
        toolName: 'terminal',
        displayName: 'Run tests',
        status: 'pending-confirmation',
        confirmationTitle: 'Allow tests?',
        invocationMessage: { markdown: 'Run the connector test suite.' },
        toolInput: 'pnpm test --filter @dashup/connector',
        options: [
          { id: 'native-once', label: 'Allow once', kind: 'approve' },
          { id: 'native-reject', label: 'Reject', kind: 'deny' },
        ],
      },
    };
    const session = {
      provider: 'codex',
      title: 'Existing native work',
      status: 1,
      lifecycle: 'ready',
      activeClients: [],
      workingDirectories: ['file:///original/project'],
      defaultChat: chatUri,
      chats: [{ resource: chatUri, title: 'Existing conversation', status: 1, modifiedAt: date }],
      inputNeeded: [] as any[],
    };
    const chat = {
      resource: chatUri,
      title: 'Existing conversation',
      status: 1,
      modifiedAt: date,
      turns: [
        {
          id: 'original-turn',
          message: { text: 'Existing question', origin: { kind: 'user' } },
          responseParts: [{ kind: 'markdown', id: 'existing-answer', content: 'Existing answer' }],
          state: 'complete',
        },
      ],
    };
    const server = createServer();
    const websocket = new WebSocketServer({
      server,
      verifyClient: ({ req }: { req: IncomingMessage }) =>
        new URL(req.url!, 'http://localhost').searchParams.get('tkn') === token,
    });
    websocket.on('connection', (socket) => {
      peer = socket;
      socket.on('message', (bytes) => {
        const request = JSON.parse(bytes.toString());
        calls.push(request);
        const send = (result: unknown) =>
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
        if (request.method === 'initialize') {
          clientId = request.params.clientId;
          send({
            protocolVersion: PROTOCOL_VERSION,
            serverSeq: sequence,
            snapshots: [{ resource: 'ahp-root://', fromSeq: sequence, state: { agents: [] } }],
          });
        } else if (request.method === 'listSessions')
          send({
            items: [{ ...session, resource: sessionUri, createdAt: date, modifiedAt: date }],
          });
        else if (request.method === 'subscribe')
          send({
            snapshot: {
              resource: request.params.channel,
              fromSeq: sequence,
              state: request.params.channel === sessionUri ? session : chat,
            },
          });
        else if (request.method === 'dispatchAction') {
          socket.send(
            JSON.stringify({
              jsonrpc: '2.0',
              method: 'action',
              params: {
                channel: request.params.channel,
                serverSeq: ++sequence,
                origin: { clientId, clientSeq: request.params.clientSeq },
                action: request.params.action,
              },
            }),
          );
        } else send({});
      });
    });
    server.listen(path);
    await once(server, 'listening');
    const prior = process.env.DASHUP_AHP_DATA;
    process.env.DASHUP_AHP_DATA = root;
    const vscode = new VSCode(() => {
      changes++;
    });
    let changes = 0;
    async function pending(overrides: Record<string, unknown> = {}) {
      const previous = changes;
      const request = {
        ...confirmation,
        toolCall: { ...confirmation.toolCall, ...overrides },
      };
      session.inputNeeded = [request];
      peer!.send(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'action',
          params: {
            channel: sessionUri,
            serverSeq: ++sequence,
            action: { type: 'session/inputNeededSet', request },
          },
        }),
      );
      const end = Date.now() + 2000;
      while (changes <= previous && Date.now() < end)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(changes > previous, 'native approval updates are observed');
      return (await vscode.refresh())[0]!;
    }
    const approvalResponses = () =>
      calls.filter(
        (call) =>
          call.method === 'dispatchAction' && call.params.action.type === 'chat/toolCallConfirmed',
      );
    try {
      let [native] = await vscode.refresh();
      assert.equal(native?.editor, 'vscode');
      assert.equal(native?.harness, 'codex');
      assert.equal(native?.cwd, '/original/project');
      assert.deepEqual(
        native?.messages.map((message) => message.text),
        ['Existing question', 'Existing answer'],
      );
      assert.equal(native?.status, 'idle');
      assert.ok(native?.send);
      await assert.rejects(native!.stop!('dashup-stop-idle'), /Nothing is running/);
      const initialSend = native!.send!;
      await native!.send!('dashup-original-reply', 'Continue the existing work');
      await native!.send!('dashup-original-reply', 'Continue the existing work');
      const sends = calls.filter(
        (call) =>
          call.method === 'dispatchAction' && call.params.action.type === 'chat/turnStarted',
      );
      assert.equal(sends.length, 1);
      assert.equal(sends[0].params.channel, chatUri);
      assert.equal(sends[0].params.action.message.text, 'Continue the existing work');
      assert.equal(sends[0].params.action.turnId, 'dashup-original-reply');
      await native!.stop!('dashup-stop');
      await native!.stop!('dashup-stop');
      const cancels = calls.filter(
        (call) =>
          call.method === 'dispatchAction' && call.params.action.type === 'chat/turnCancelled',
      );
      assert.equal(cancels.length, 1);
      assert.equal(cancels[0].params.channel, chatUri);
      assert.equal(cancels[0].params.action.turnId, 'dashup-original-reply');
      assert.ok(cancels[0].params.action.duration >= 0);
      await assert.rejects(native!.stop!('dashup-stop-ended'), /Nothing is running/);
      native = await pending();
      assert.deepEqual(
        native?.approvals[0]?.choices.map((choice) => choice.id),
        ['native-once', 'native-reject'],
      );
      assert.match(native.approvals[0]!.detail, /Run the connector test suite/);
      assert.match(native.approvals[0]!.detail, /pnpm test --filter @dashup\/connector/);
      await native!.approve!('dashup-native-approval', 'native-request', { choice: 'native-once' });
      const response = approvalResponses().at(-1);
      assert.equal(response.params.action.toolCallId, 'original-tool');
      assert.equal(response.params.action.selectedOptionId, 'native-once');
      assert.equal(response.params.action.approved, true);
      assert.equal(response.params.action.confirmed, 'user-action');

      native = await pending({ options: undefined });
      assert.deepEqual(
        native.approvals[0]!.choices.map((choice) => choice.id),
        ['approve', 'deny'],
      );
      const defaultApprove = native.approve!;
      await defaultApprove('dashup-default-approval', 'native-request', { choice: 'approve' });
      const approved = approvalResponses().at(-1).params.action;
      assert.equal(approved.approved, true);
      assert.equal(approved.confirmed, 'user-action');
      assert.equal(Object.hasOwn(approved, 'selectedOptionId'), false);

      native = await pending({ options: undefined });
      await native.approve!('dashup-default-denial', 'native-request', { choice: 'deny' });
      const denied = approvalResponses().at(-1).params.action;
      assert.equal(denied.approved, false);
      assert.equal(denied.reason, 'denied');
      assert.equal(Object.hasOwn(denied, 'selectedOptionId'), false);

      native = await pending({ toolInput: { uri: 'ahp-resource:/command', sizeHint: 2048 } });
      assert.deepEqual(
        native.approvals[0]!.choices.map((choice) => choice.id),
        ['native-reject'],
      );
      assert.match(native.approvals[0]!.detail, /on your computer/);
      const beforeRejectedChoice = approvalResponses().length;
      await assert.rejects(
        native.approve!('unpreviewed-command', 'native-request', { choice: 'native-once' }),
        /no longer pending/,
      );
      await assert.rejects(
        defaultApprove('stale-preview', 'native-request', { choice: 'approve' }),
        /no longer pending/,
      );
      assert.equal(approvalResponses().length, beforeRejectedChoice);
      await native.approve!('dashup-reference-denial', 'native-request', {
        choice: 'native-reject',
      });
      assert.equal(approvalResponses().at(-1).params.action.selectedOptionId, 'native-reject');
      assert.equal(approvalResponses().at(-1).params.action.approved, false);

      native = await pending({
        invocationMessage: 'Update the handler.',
        toolInput: undefined,
        edits: {
          items: [
            {
              before: {
                uri: 'file:///original/project/handler.ts',
                content: { uri: 'ahp-resource:/before' },
              },
              after: {
                uri: 'file:///original/project/handler.ts',
                content: { uri: 'ahp-resource:/after' },
              },
              diff: { added: 3, removed: 1 },
            },
          ],
        },
      });
      assert.match(native.approvals[0]!.detail, /\/original\/project\/handler\.ts \+3 -1/);
      assert.match(native.approvals[0]!.detail, /on your computer/);
      assert.deepEqual(
        native.approvals[0]!.choices.map((choice) => choice.id),
        ['native-reject'],
      );

      native = await pending({
        options: [{ id: 'unknown', label: 'Unknown native choice', kind: 'unsupported' }],
      });
      assert.equal(native.approvals[0]!.choices.length, 0);
      assert.equal(native.approve, undefined);
      assert.match(native.approvals[0]!.detail, /on your computer/);

      native = await pending({ toolInput: 'x'.repeat(128 * 1024) });
      assert.deepEqual(
        native.approvals[0]!.choices.map((choice) => choice.id),
        ['native-reject'],
      );
      assert.ok(Buffer.byteLength(native.approvals[0]!.detail) < 65 * 1024);
      assert.match(native.approvals[0]!.detail, /on your computer/);
      assert.ok(
        !calls.some((call) =>
          ['createSession', 'createChat', 'authenticate', 'resourceRead', 'resourceWrite'].includes(
            call.method,
          )),
      );
      await chmod(metadata, 0o644);
      assert.deepEqual(await vscode.refresh(), []);
      await assert.rejects(
        initialSend('after-host-disappeared', 'Must not send'),
        /disconnected|unavailable/,
      );
    } finally {
      vscode.stop();
      if (prior === undefined) delete process.env.DASHUP_AHP_DATA;
      else process.env.DASHUP_AHP_DATA = prior;
      for (const socket of websocket.clients) socket.terminate();
      await new Promise<void>((resolve) => websocket.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
