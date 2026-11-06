import type { EngineInterface, Register } from 'claude-code';

// =============================================================================
// Replies from the Dashup app
// =============================================================================

// Claude Code reads what other processes post to a session's inbox as another session's request,
// never the person's. Dashup's connector instead streams what the person sends this session from
// their phone, one delivery per line, and the session takes each message as their own. `now`
// first ends the running turn, so a delivery without text only stops it. The empty `hooks` in
// hooks.json lets Claude Code from before function hooks load the plugin, which then does nothing.
type Delivery = { text?: string; now?: true };

const RETRY_MS = 10_000;

// =============================================================================
// Permission requests
// =============================================================================

// The connector holds each request this session waits on open until the phone answers it. The
// dialog here, the editor hosting the session or the person's own hooks may answer first. No hook
// hears the dialog's answer, so the call it settles closes the request: both hooks see the call,
// with its fields in different orders.
function call(agent: string | undefined, tool: string, input: unknown): string {
  const sorted = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(sorted)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, sorted((value as Record<string, unknown>)[key])]),
          )
        : value;
  return JSON.stringify([agent ?? '', tool, sorted(input)]);
}

export const register: Register = (on) => {
  let turnId: string | undefined;
  let stream: AsyncGenerator<unknown, unknown> | undefined;
  // The requests the phone is asked, by the call each waits on.
  const asks = new Map<string, AsyncGenerator<unknown, unknown>>();
  on('classic.PermissionRequest', async ($, e, next) => {
    const key = call(e.agent_id, e.tool_name, e.tool_input);
    const ask = $.process.spawn({
      argv: [
        'curl',
        '-sfN',
        '--unix-socket',
        `${await $.env.get('HOME')}/.dashup/claude.sock`,
        '--data-binary',
        '@-',
        `http://dashup/sessions/${await $.session.id()}/prompts`,
      ],
      input: JSON.stringify({
        tool        : e.tool_name,
        input       : e.tool_input,
        suggestions : e.permission_suggestions,
      }),
    });
    const open: AsyncGenerator<unknown, unknown> = ask;
    asks.set(key, open);
    const beneath = next(e).then((result) => {
      if (result.decision) void open.return(undefined);
      return result;
    });
    let answer = '';
    try {
      for await (const { stream: name, text } of ask) if (name === 'stdout') answer += text;
    } catch {
      // curl is missing.
    } finally {
      if (asks.get(key) === open) asks.delete(key);
    }
    try {
      return answer ? { decision: JSON.parse(answer) } : beneath;
    } catch {
      // The connector stopped mid-answer.
      return beneath;
    }
  });
  on('tool.call', async ($, e, next) => {
    try {
      return await next(e);
    } finally {
      if (asks.size) {
        const { tool, tool_use_id, consent, agentId, requestMeta, ...input } = e as Record<
          string,
          unknown
        >;
        void asks.get(call(agentId as string | undefined, String(tool), input))?.return(undefined);
      }
    }
  });
  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) turnId = e.turnId;
    return next(e);
  });
  // `/clear` starts another conversation in this process, which streams under its own id.
  on('session.end', ($, e, next) => {
    void stream?.return(undefined);
    for (const ask of asks.values()) void ask.return(undefined);
    return next(e);
  });
  on('session.start', async ($, e, next) => {
    const started = await next(e);
    void (async () => {
      const socketPath = `${await $.env.get('HOME')}/.dashup/claude.sock`;
      for (;;) {
        // A request held open here would hold the session's queue; a child's stream does not.
        const lines = (stream = $.process.spawn({
          argv: [
            'curl',
            '-sfN',
            '--unix-socket',
            socketPath,
            `http://dashup/sessions/${await $.session.id()}`,
          ],
        }));
        let buffer = '';
        try {
          for await (const { stream: name, text } of lines) {
            if (name !== 'stdout') continue;
            buffer += text;
            for (let end = buffer.indexOf('\n'); end !== -1; end = buffer.indexOf('\n')) {
              await take($, JSON.parse(buffer.slice(0, end)) as Delivery, turnId);
              buffer = buffer.slice(end + 1);
            }
          }
        } catch {
          // curl is missing, or the stream broke off mid-line.
        }
        // Dashup is not running on this computer, or is restarting.
        await $.clock.sleep(RETRY_MS);
      }
    })();
    return started;
  });
};

// A message runs once the session is idle; the stream must not wait for that.
async function take($: EngineInterface, { text, now }: Delivery, turnId?: string): Promise<void> {
  if (now && turnId) await $.turn.abort({ turnId }).catch(() => {});
  const command = text?.match(/^\/(\S+)\s*([\s\S]*)$/);
  if (command) void $.command.run({ command: command[1]!, args: command[2] }).catch(() => {});
  else if (text) void $.prompt.submit({ text, asUser: true }).catch(() => {});
}
