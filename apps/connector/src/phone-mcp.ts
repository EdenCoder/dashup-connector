import type { Readable, Writable } from 'node:stream';
import { PHONE_KINDS, PHONE_PENDING, PHONE_PROMPT, PHONE_CHOICES, PHONE_MAX_WAIT_MS, parsePhoneInput } from '@dashup/protocol/phone';

// =============================================================================
// MCP stdio exposes deliberate phone input through the connector's loopback API
// =============================================================================

const LINE_BYTES = 64 * 1024;
const PROTOCOL = '2025-06-18';
export const PHONE_TOOLS = [
  {
    name: 'phone_list',
    description:
      'List paired phones with Dashup open in the foreground. A phone must be open before requesting input.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'phone_request',
    description:
      'Ask the person on a paired phone for a photo, selected screenshot, file, sketch, choice, or text. The person explicitly captures/selects and sends it. Files are encrypted in transit and returned as private local paths on this computer. There is no silent camera or screen access. Requests expire and are never queued offline.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: PHONE_KINDS },
        prompt: {
          type: 'string',
          minLength: 1,
          maxLength: PHONE_PROMPT,
          description: 'Explain what you need and why; displayed on the phone.',
        },
        pairing: {
          type: 'string',
          maxLength: 128,
          description: 'Pairing from phone_list; required if several phones are open.',
        },
        projectId: { type: 'string', maxLength: 128 },
        threadId: { type: 'string', maxLength: 128 },
        choices: {
          type: 'array',
          minItems: 2,
          maxItems: PHONE_CHOICES,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 200 },
        },
        timeoutMs: { type: 'integer', minimum: 10000, maximum: PHONE_MAX_WAIT_MS },
      },
      required: ['kind', 'prompt'],
      additionalProperties: false,
    },
  },
] as const;

type RpcId = string | number | null;
type Call = (path: string, value: unknown, signal: AbortSignal) => Promise<unknown>;
export function runPhoneMcp(options: {
  call: Call;
  input?: Readable;
  output?: Writable;
}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const pending = new Map<string, AbortController>();
  let buffered = '';
  let initialized = false;
  let closed = false;
  let blocked = false;
  const write = (value: unknown) => {
    if (!closed && !output.write(JSON.stringify(value) + '\n')) {
      blocked = true;
      input.pause();
    }
  };
  const fail = (id: RpcId, code: number, message: string) =>
    write({ jsonrpc: '2.0', id, error: { code, message } });
  const finish = (id: RpcId, result: unknown) => write({ jsonrpc: '2.0', id, result });
  async function message(line: string): Promise<void> {
    let value: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        return fail(null, -32600, 'Invalid JSON-RPC request.');
      value = parsed as Record<string, unknown>;
    } catch {
      return fail(null, -32700, 'Invalid JSON.');
    }
    const id = value.id as RpcId;
    if (
      value.jsonrpc !== '2.0' ||
      typeof value.method !== 'string' ||
      (value.id !== undefined &&
        !(
          id === null ||
          (typeof id === 'number' && Number.isFinite(id)) ||
          (typeof id === 'string' && id.length <= 128)
        ))
    )
      return fail(null, -32600, 'Invalid JSON-RPC request.');
    const params =
      value.params && typeof value.params === 'object' && !Array.isArray(value.params)
        ? (value.params as Record<string, unknown>)
        : {};
    if (value.method === 'notifications/cancelled') {
      pending.get(JSON.stringify(params.requestId))?.abort();
      return;
    }
    if (value.id === undefined) return;
    if (value.method === 'initialize') {
      initialized = true;
      const protocolVersion = ['2024-11-05', '2025-03-26', PROTOCOL].includes(
        String(params.protocolVersion),
      )
        ? params.protocolVersion
        : PROTOCOL;
      return finish(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'dashup-phone', version: '1.0.0' },
        instructions:
          'Use phone_list first. Phone input is always deliberate and expires if the person leaves Dashup.',
      });
    }
    if (!initialized) return fail(id, -32002, 'Initialize the MCP connection first.');
    if (value.method === 'ping') return finish(id, {});
    if (value.method === 'tools/list') return finish(id, { tools: PHONE_TOOLS });
    if (value.method !== 'tools/call') return fail(id, -32601, 'Method not found.');
    if (!['phone_list', 'phone_request'].includes(String(params.name)))
      return fail(id, -32602, 'Unknown phone tool.');
    const key = JSON.stringify(id);
    if (pending.has(key)) return fail(id, -32600, 'A request with this ID is already pending.');
    if (pending.size >= PHONE_PENDING) return fail(id, -32000, 'Too many pending phone requests.');
    const controller = new AbortController();
    pending.set(key, controller);
    try {
      const args = params.arguments ?? {};
      if (
        params.name === 'phone_list' &&
        (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length)
      )
        throw new Error('phone_list takes no arguments.');
      const payload = params.name === 'phone_request' ? parsePhoneInput(args) : {};
      const timeout = setTimeout(
        () => controller.abort(),
        params.name === 'phone_request'
          ? ((payload as { timeoutMs?: number }).timeoutMs ?? PHONE_MAX_WAIT_MS)
          : 10000,
      );
      try {
        const result = await options.call(
          params.name === 'phone_list' ? '/phone/list' : '/phone/request',
          payload,
          controller.signal,
        );
        finish(id, { content: [{ type: 'text', text: JSON.stringify(result) }] });
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      if (controller.signal.aborted) fail(id, -32800, 'Phone request cancelled or expired.');
      else
        finish(id, {
          isError: true,
          content: [
            {
              type: 'text',
              text: error instanceof Error ? error.message : 'Phone input is unavailable.',
            },
          ],
        });
    } finally {
      pending.delete(key);
    }
  }
  return new Promise<void>((resolve) => {
    const stop = () => {
      closed = true;
      for (const controller of pending.values()) controller.abort();
      pending.clear();
      input.off('data', data);
      input.off('end', stop);
      input.off('error', stop);
      output.off('drain', drain);
      output.off('error', stop);
      input.pause();
      resolve();
    };
    const data = (chunk: string) => {
      buffered += chunk;
      let at;
      while (!blocked && (at = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        if (Buffer.byteLength(line) > LINE_BYTES) {
          fail(null, -32600, 'MCP request exceeds its size limit.');
          stop();
          return;
        }
        if (line.trim()) void message(line);
      }
      if (Buffer.byteLength(buffered) > LINE_BYTES) {
        fail(null, -32600, 'MCP request exceeds its size limit.');
        stop();
      }
    };
    const drain = () => {
      blocked = false;
      data('');
      if (!closed && !blocked) input.resume();
    };
    input.setEncoding('utf8');
    input.on('data', data);
    input.once('end', stop);
    input.once('error', stop);
    output.on('drain', drain);
    output.once('error', stop);
  });
}
