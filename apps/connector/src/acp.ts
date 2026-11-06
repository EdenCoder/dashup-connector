import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import { methods } from '@agentclientprotocol/sdk';
import type { PromptRequest, CancelNotification, SessionNotification, RequestPermissionResponse } from '@agentclientprotocol/sdk';

import type { Approval, Message, AgentOption } from '@dashup/protocol';
import { contextUsage, type ContextUsage } from '@dashup/protocol/context';

import { connectorPort, type ConnectorConfig } from './config';

// boundary: the proxy forwards editor-owned ACP JSON-RPC without changing its schema.
export type AcpMessage = Record<string, any>;
interface AcpEvent {
  direction : 'editor' | 'agent';
  message   : AcpMessage;
}

function decode(line: string): AcpMessage | null {
  try {
    const value: unknown = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as AcpMessage)
      : null;
  } catch {
    return null;
  }
}

export interface AcpSession {
  id        : string;
  cwd       : string;
  updatedAt : string;
  messages  : Message[];
  context?  : ContextUsage | null;
  options   : AgentOption[];
  // Keyed by the agent's request id; agents renumber on restart, so each ask has its own id.
  approvals : Map<string, Approval>;
  status    : 'working' | 'attention' | 'idle';
  socket    : Duplex;
  pending   : Map<string, { resolve(): void; reject(error: Error): void }>;
}

// Configuration and legacy modes are agent-owned. Namespaced IDs retain which ACP method owns
// each option; the phone only sends back values the agent has offered.
function options(value: AcpMessage): AgentOption[] {
  if (Array.isArray(value.configOptions))
    return value.configOptions.slice(0, 32).flatMap((option: AcpMessage): AgentOption[] => {
      if (typeof option.id !== 'string' || typeof option.name !== 'string') return [];
      const base = { id: `config:${option.id}`, name: option.name, category: option.category };
      if (option.type === 'boolean' && typeof option.currentValue === 'boolean')
        return [{ ...base, value: option.currentValue }];
      if (
        option.type !== 'select' ||
        typeof option.currentValue !== 'string' ||
        !Array.isArray(option.options)
      )
        return [];
      const choices = option.options
        .flatMap((item: AcpMessage) => (Array.isArray(item.options) ? item.options : [item]))
        .filter(
          (item: AcpMessage) => typeof item.value === 'string' && typeof item.name === 'string',
        )
        .slice(0, 100)
        .map((item: AcpMessage) => ({ value: item.value, name: item.name }));
      return [{ ...base, value: option.currentValue, choices }];
    });
  if (!Array.isArray(value.modes?.availableModes) || typeof value.modes.currentModeId !== 'string')
    return [];
  return [
    {
      id: 'mode',
      category: 'mode',
      name: 'Mode',
      value: value.modes.currentModeId,
      choices: value.modes.availableModes
        .slice(0, 32)
        .map((mode: AcpMessage) => ({ value: mode.id, name: mode.name })),
    },
  ];
}

export function commandAcp(session: AcpSession, id: string, value: object): Promise<void> {
  if (session.socket.destroyed) return Promise.reject(new Error('ACP connection closed'));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      session.pending.delete(id);
      reject(new Error('ACP command timed out'));
    }, 10000);
    session.pending.set(id, {
      resolve: () => {
        clearTimeout(timeout);
        resolve();
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
    session.socket.write(JSON.stringify({ ...value, requestId: id, session: session.id }) + '\n');
  });
}

export function bridgeAcp(
  socket: Duplex,
  onUpdate: (session: AcpSession, attention?: Approval) => void,
): Map<string, AcpSession> {
  const sessions = new Map<string, AcpSession>();
  const calls = new Map<string, AcpMessage>();
  const permissions = new Map<string, AcpSession>();
  const create = (id: string, cwd: string): AcpSession => ({
    id,
    cwd,
    updatedAt: new Date().toISOString(),
    messages: [],
    options: [],
    approvals: new Map(),
    status: 'idle',
    socket,
    pending: new Map(),
  });
  const publish = (session: AcpSession, attention?: Approval) => {
    session.updatedAt = new Date().toISOString();
    onUpdate(session, attention);
  };
  attachAcp(socket, ({ direction, message }) => {
    if (message.method === 'dashup/command_result') {
      const session = sessions.get(String(message.params.session));
      const pending = session?.pending.get(message.params.requestId);
      session?.pending.delete(message.params.requestId);
      if (message.params.ok) pending?.resolve();
      else pending?.reject(new Error(String(message.params.error)));
      return;
    }
    if (direction === 'editor' && message.method && message.id !== undefined)
      calls.set(String(message.id), message);
    if (
      direction === 'editor' &&
      (message.method === methods.agent.session.load ||
        (message.method === methods.agent.session.resume &&
          !sessions.has(message.params.sessionId)))
    ) {
      const session = create(String(message.params.sessionId), String(message.params.cwd));
      sessions.set(session.id, session);
      publish(session);
    }
    const call =
      direction === 'agent' && !message.method ? calls.get(String(message.id)) : undefined;
    if (call) calls.delete(String(message.id));
    if (
      call &&
      [
        methods.agent.session.new,
        methods.agent.session.load,
        methods.agent.session.resume,
      ].includes(call.method) &&
      !message.error
    ) {
      const id = String(message.result?.sessionId ?? call.params.sessionId);
      const session = sessions.get(id) ?? create(id, String(call.params.cwd));
      session.options = options(message.result ?? {});
      sessions.set(id, session);
      publish(session);
    }
    if (
      call &&
      !message.error &&
      [methods.agent.session.setConfigOption, methods.agent.session.setMode].includes(call.method)
    ) {
      const configured = sessions.get(String(call.params.sessionId));
      if (configured) {
        if (Array.isArray(message.result?.configOptions))
          configured.options = options(message.result);
        else if (call.method === methods.agent.session.setMode)
          configured.options = configured.options.map((option) =>
            option.id === 'mode' ? { ...option, value: call.params.modeId } : option);
        publish(configured);
      }
    }
    const session = sessions.get(String(message.params?.sessionId));
    if (session && direction === 'editor' && message.method === methods.agent.session.prompt) {
      session.messages.push({
        id: String(message.id),
        role: 'user',
        text: (message.params.prompt ?? [])
          .filter((part: AcpMessage) => part.type === 'text')
          .map((part: AcpMessage) => part.text)
          .join('\n'),
      });
      session.status = 'working';
      publish(session);
    }
    if (session && direction === 'agent' && message.method === methods.client.session.update) {
      const update = message.params.update;
      if (update.sessionUpdate === 'config_option_update') session.options = options(update);
      if (update.sessionUpdate === 'current_mode_update')
        session.options = session.options.map((option) =>
          option.id === 'mode' ? { ...option, value: update.currentModeId } : option);
      if (update.sessionUpdate === 'usage_update')
        session.context = contextUsage(update.used, update.size) ?? null;
      if (
        ['user_message_chunk', 'agent_message_chunk'].includes(update.sessionUpdate) &&
        update.content?.type === 'text'
      ) {
        const role = update.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant';
        const last = session.messages.at(-1);
        const existing = update.messageId
          ? session.messages.find((item) => item.id === update.messageId)
          : last?.role === role
            ? last
            : undefined;
        if (existing) existing.text += update.content.text;
        else
          session.messages.push({
            id: update.messageId ?? randomUUID(),
            role,
            text: update.content.text,
          });
      }
      if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
        const id = `tool:${update.toolCallId}`;
        const existing = session.messages.find((item) => item.id === id);
        const text = [
          update.title ?? existing?.text.split('\n')[0] ?? 'Tool',
          update.status,
          ...(update.content ?? []).flatMap((part: AcpMessage) =>
            part.type === 'content' && part.content?.type === 'text' ? [part.content.text] : []),
        ]
          .filter(Boolean)
          .join('\n');
        if (existing) existing.text = text;
        else session.messages.push({ id, role: 'tool', text });
      }
      publish(session);
    }
    if (
      session &&
      direction === 'agent' &&
      message.method === methods.client.session.requestPermission
    ) {
      const tool = message.params.toolCall ?? {};
      const diff = (tool.content ?? []).find((part: AcpMessage) => part.type === 'diff');
      const approval: Approval = {
        id: randomUUID(),
        title: String(message.params.title ?? tool.title ?? 'Agent needs approval'),
        detail: String(message.params.description ?? ''),
        choices: message.params.options.map((option: AcpMessage) => ({
          id: String(option.optionId),
          label: String(option.name),
          ...(String(option.kind).startsWith('allow')
            ? { intent: 'approve' as const }
            : String(option.kind).startsWith('reject')
              ? { intent: 'reject' as const }
              : {}),
        })),
        ...(diff
          ? {
              change: {
                path: String(diff.path),
                diff: `--- ${diff.path}\n+++ ${diff.path}\n${String(diff.oldText ?? '')
                  .split('\n')
                  .map((line) => '-' + line)
                  .join('\n')}\n${String(diff.newText)
                  .split('\n')
                  .map((line) => '+' + line)
                  .join('\n')}`,
              },
            }
          : {}),
      };
      session.approvals.set(String(message.id), approval);
      permissions.set(String(message.id), session);
      session.status = 'attention';
      publish(session, approval);
    }
    if (direction === 'editor' && !message.method) {
      const pending = permissions.get(String(message.id));
      if (pending) {
        pending.approvals.delete(String(message.id));
        permissions.delete(String(message.id));
        pending.status = pending.approvals.size ? 'attention' : 'working';
        publish(pending);
      }
    }
    if (call?.method === methods.agent.session.prompt) {
      const pending = sessions.get(String(call.params.sessionId));
      if (pending) {
        pending.status = pending.approvals.size ? 'attention' : 'idle';
        if (message.error)
          pending.messages.push({
            id: randomUUID(),
            role: 'system',
            text: String(message.error.message ?? 'The native agent rejected this turn.'),
          });
        publish(pending);
      }
    }
  });
  socket.once('close', () => {
    for (const session of sessions.values())
      for (const pending of session.pending.values())
        pending.reject(new Error('ACP connection closed'));
  });
  return sessions;
}

function attachAcp(socket: Duplex, onEvent: (event: AcpEvent) => void): void {
  socket.on('error', () => socket.destroy());
  createInterface({ input: socket })
    .on('error', () => socket.destroy())
    .on('line', (line) => {
      try {
        const event = JSON.parse(line) as AcpEvent;
        if (
          !['editor', 'agent'].includes(event.direction) ||
          !event.message ||
          typeof event.message !== 'object'
        )
          return;
        onEvent(event);
      } catch {
        socket.destroy();
      }
    });
}

export async function proxyAcp(
  config: ConnectorConfig,
  executable: string,
  args: string[],
): Promise<void> {
  if (!config.localSecret) throw new Error('Start dashup watch before using the ACP proxy');
  const socket = await new Promise<Duplex>((resolve, reject) => {
    const connect = request({
      hostname: '127.0.0.1',
      port: connectorPort(),
      method: 'CONNECT',
      path: '/acp',
      headers: { Authorization: `Bearer ${config.localSecret}` },
    });
    connect.on('connect', (response, stream) =>
      response.statusCode === 200
        ? resolve(stream)
        : reject(new Error('Dashup ACP connection was rejected')));
    connect.on('error', reject);
    connect.end();
  });
  const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const local = new Set<string>();
  const configurations = new Map<string, AcpMessage>();
  const stops = new Map<string, AcpMessage>();
  const prompts = new Map<string, string>();
  const resolved = new Set<string>();
  const permissions = new Map<string, AcpMessage>();
  const observe = (direction: AcpEvent['direction'], message: AcpMessage) => {
    if (!socket.destroyed) socket.write(JSON.stringify({ direction, message }) + '\n');
  };
  const reply = (command: AcpMessage, error?: string) =>
    observe('agent', {
      method: 'dashup/command_result',
      params: { session: command.session, requestId: command.requestId, ok: !error, error },
    });
  // Cancel is a notification; the agent acknowledges it by answering the session's open prompts.
  const settle = (id: string) => {
    const session = prompts.get(id);
    if (session === undefined || !prompts.delete(id) || [...prompts.values()].includes(session))
      return;
    for (const [requestId, command] of stops)
      if (command.session === session) {
        stops.delete(requestId);
        reply(command);
      }
  };

  const editor = createInterface({ input: process.stdin }).on('line', (line) => {
    const message = decode(line);
    if (!message) {
      child.stdin.write(line + '\n');
      return;
    }
    // Editor and agent request ids are separate spaces; only the editor's late answer is withheld.
    if (!message.method && resolved.delete(String(message.id))) return;
    if (!message.method && message.id !== undefined) permissions.delete(String(message.id));
    if (message.method === methods.agent.session.prompt && message.id !== undefined)
      prompts.set(String(message.id), String(message.params?.sessionId));
    observe('editor', message);
    child.stdin.write(line + '\n');
  });
  const agent = createInterface({ input: child.stdout }).on('line', (line) => {
    const message = decode(line);
    if (!message) {
      process.stdout.write(line + '\n');
      return;
    }
    observe('agent', message);
    if (message.method === methods.client.session.requestPermission)
      permissions.set(String(message.id), message);
    if (!message.method) {
      settle(String(message.id));
      const command = configurations.get(String(message.id));
      if (command) {
        configurations.delete(String(message.id));
        if (!message.error) {
          const update =
            command.option === 'mode'
              ? { sessionUpdate: 'current_mode_update', currentModeId: command.value }
              : {
                  sessionUpdate: 'config_option_update',
                  configOptions: message.result?.configOptions ?? [],
                };
          process.stdout.write(
            JSON.stringify({
              jsonrpc: '2.0',
              method: methods.client.session.update,
              params: { sessionId: command.session, update },
            }) + '\n',
          );
        }
        reply(
          command,
          message.error
            ? String(message.error.message || 'The agent rejected the setting')
            : undefined,
        );
      }
    }
    if (!message.method && local.delete(String(message.id))) return;
    process.stdout.write(line + '\n');
  });
  const link = createInterface({ input: socket })
    .on('error', () => socket.destroy())
    .on('line', (line) => {
      const command = decode(line);
      if (!command) {
        socket.destroy();
        return;
      }
      if (
        command.kind === 'configure' &&
        typeof command.session === 'string' &&
        typeof command.option === 'string' &&
        (typeof command.value === 'string' || typeof command.value === 'boolean')
      ) {
        if (command.option !== 'mode' && !command.option.startsWith('config:')) {
          reply(command, 'Unknown session option');
          return;
        }
        const id = `dashup:${randomUUID()}`;
        local.add(id);
        configurations.set(id, command);
        const message = {
          jsonrpc: '2.0',
          id,
          method:
            command.option === 'mode'
              ? methods.agent.session.setMode
              : methods.agent.session.setConfigOption,
          params: {
            sessionId: command.session,
            ...(command.option === 'mode'
              ? { modeId: command.value }
              : { configId: command.option.slice('config:'.length), value: command.value }),
          },
        };
        observe('editor', message);
        child.stdin.write(JSON.stringify(message) + '\n');
      } else if (command.kind === 'approval') {
        const permission = permissions.get(command.id);
        if (
          !permission ||
          permission.params.sessionId !== command.session ||
          !permission.params.options.some(
            (option: AcpMessage) => option.optionId === command.choice,
          )
        ) {
          reply(command, 'Approval is no longer available');
          return;
        }
        const message = {
          jsonrpc: '2.0',
          id: permission.id,
          result: { outcome: { outcome: 'selected', optionId: command.choice } },
        };
        permissions.delete(command.id);
        resolved.add(command.id);
        observe('editor', message);
        child.stdin.write(JSON.stringify(message) + '\n');
        reply(command);
      } else if (
        command.kind === 'prompt' &&
        typeof command.session === 'string' &&
        typeof command.text === 'string'
      ) {
        const id = `dashup:${randomUUID()}`;
        local.add(id);
        prompts.set(id, command.session);
        const message = {
          jsonrpc: '2.0',
          id,
          method: methods.agent.session.prompt,
          params: {
            sessionId: command.session,
            prompt: [{ type: 'text', text: command.text }],
          } satisfies PromptRequest,
        };
        const notification = {
          jsonrpc: '2.0',
          method: methods.client.session.update,
          params: {
            sessionId: command.session,
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: command.text },
            },
          } satisfies SessionNotification,
        };
        observe('editor', message);
        process.stdout.write(JSON.stringify(notification) + '\n');
        child.stdin.write(JSON.stringify(message) + '\n');
        reply(command);
      } else if (command.kind === 'cancel' && typeof command.session === 'string') {
        if (![...prompts.values()].includes(command.session)) {
          reply(command, 'Nothing is running in this ACP session');
          return;
        }
        // The client that cancels a turn must answer its pending permissions as cancelled.
        const messages: AcpMessage[] = [
          {
            jsonrpc: '2.0',
            method: methods.agent.session.cancel,
            params: { sessionId: command.session } satisfies CancelNotification,
          },
        ];
        for (const [id, permission] of permissions)
          if (permission.params.sessionId === command.session) {
            permissions.delete(id);
            resolved.add(id);
            messages.push({
              jsonrpc: '2.0',
              id: permission.id,
              result: { outcome: { outcome: 'cancelled' } } satisfies RequestPermissionResponse,
            });
          }
        stops.set(command.requestId, command);
        for (const message of messages) {
          observe('editor', message);
          child.stdin.write(JSON.stringify(message) + '\n');
        }
      }
    });
  socket.on('error', () => {});
  socket.on('close', () => {
    if (child.exitCode === null && child.signalCode === null)
      process.stderr.write('Dashup link closed; the editor agent remains running.\n');
  });
  child.stdin.on('error', () => editor.close());
  process.stdin.on('end', () => child.stdin.end());
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        process.exitCode = code ?? 1;
        resolve();
      });
    });
  } finally {
    editor.close();
    agent.close();
    link.close();
    process.stdin.pause();
    socket.destroy();
  }
}
