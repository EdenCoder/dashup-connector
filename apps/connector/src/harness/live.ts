import { isStartHarness } from '@dashup/protocol';
import type { Harness, AgentOption, StartHarness } from '@dashup/protocol';

import { Pi } from './pi';
import { T3 } from './t3';
import { Kimi } from './kimi';
import { Kilo } from './kilo';
import { Orca } from './orca';
import { Codex } from './codex';
import { Cline } from './cline';
import { Junie } from './junie';
import { Claude } from './claude';
import { VSCode } from './vscode';
import { Headless } from './headless';
import { OpenCode } from './opencode';
import { OpenCodeService } from './opencode-service';
import { sessionKey, singleFlight, liveDiscovery, type Settings, type InputFile, type LiveSession } from './session';

// =============================================================================
// Existing harness connections
// =============================================================================

const DISCOVERY_MS = 10_000;

// What every integration is to the connector: it lists the live sessions it finds, and lets go of
// what it holds. One that names a harness lists that agent's sessions only; VS Code names none,
// because it hosts any agent's chats.
type Lists<H extends Harness> = { refresh(): Promise<LiveSession<H>[]>; stop(): void };
type Integration =

    | { [H in Harness]: Lists<H> & { readonly harness: H } }[Harness]
    | (Lists<Harness> & { readonly harness?: undefined });

// An integration that starts and continues its agent's sessions.
type Host = {
  // Whether it can start a session on this computer.
  available() : Promise<boolean>;
  // Starts a session in `cwd` with its first message, and resolves with the session's native id.
  start(cwd: string, text: string, files?: InputFile[], model?: string) : Promise<string>;
  // Continues a saved session with a message, and resolves once its agent takes it.
  resume(id: string, cwd: string, text: string, files?: InputFile[]) : Promise<void>;
  // The models a session may start with.
  models?() : NonNullable<AgentOption['choices']>;
  // What a saved session last ran with, as its agent names its options.
  recorded?(settings: Settings) : AgentOption[];
};

// The order is precedence: the first integration to list a session owns it, so the sessions Dashup
// runs come first and their controls win over any other view of them.
const integrations = (changed: () => void) =>
  ({
    headless : new Headless(changed),
    kimi     : new Kimi(changed),
    service  : new OpenCodeService(changed),
    opencode : new OpenCode(changed),
    junie    : new Junie(changed),
    kilo     : new Kilo(changed),
    cline    : new Cline(changed),
    pi       : new Pi(changed),
    codex    : new Codex(changed),
    claude   : new Claude(changed),
    vscode   : new VSCode(changed),
    t3       : new T3(changed),
    orca     : new Orca(changed),
  }) satisfies Record<string, Integration>;

// The agents a phone starts, in the order it offers them, and the integration that hosts each.
const HOSTS = {
  claude   : 'headless',
  codex    : 'codex',
  opencode : 'opencode',
  kimi     : 'kimi',
  kilo     : 'kilo',
  junie    : 'junie',
} as const satisfies Record<StartHarness, keyof ReturnType<typeof integrations>>;

const OFFERED = Object.keys(HOSTS) as StartHarness[];

// OpenCode servers share history, but only the executing server reports its work; its listing
// replaces an idle one, so stop and replies reach the actual owner.
function merged(results: PromiseSettledResult<LiveSession[]>[]): LiveSession[] {
  const sessions = new Map<string, LiveSession>();
  for (const result of results)
    if (result.status === 'fulfilled')
      for (const session of result.value) {
        const key = sessionKey(session);
        const known = sessions.get(key);
        if (
          !known ||
          (session.harness === 'opencode' &&
            ['working', 'attention'].includes(session.status) &&
            !['working', 'attention'].includes(known.status))
        )
          sessions.set(key, session);
      }
  return [...sessions.values()];
}

export class LiveHarnesses {
  private readonly listeners = new Set<() => void>();
  private readonly integrations = integrations(() => this.changed());
  private readonly all: Integration[] = Object.values(this.integrations);
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private readonly reading = singleFlight(async () => {
    const sessions = merged(
      await Promise.allSettled(this.all.map((integration) => integration.refresh())),
    );
    return this.stopped ? [] : sessions;
  });

  private changed(): void {
    if (!this.stopped) for (const listener of this.listeners) listener();
  }

  refresh(): Promise<LiveSession[]> {
    return this.stopped ? Promise.resolve([]) : this.reading();
  }

  // Every live session of one harness, from each integration that lists it. A session counts only
  // under the harness it carries.
  async sessionsFor(harness: Harness): Promise<LiveSession[]> {
    const found = await Promise.allSettled(
      this.all
        .filter((integration) => !integration.harness || integration.harness === harness)
        .map((integration) => integration.refresh()),
    );
    return merged(found).filter((session) => session.harness === harness);
  }

  private host(harness: StartHarness): Host {
    return this.integrations[HOSTS[harness]];
  }

  // OpenCode 2's service starts and resumes OpenCode's sessions where it runs.
  private async hosting(harness: StartHarness): Promise<Host> {
    const { service } = this.integrations;
    return harness === 'opencode' && (await service.available()) ? service : this.host(harness);
  }

  recorded(harness: Harness, settings: Settings): AgentOption[] {
    return isStartHarness(harness) ? (this.host(harness).recorded?.(settings) ?? []) : [];
  }

  startModels(harness: StartHarness): NonNullable<AgentOption['choices']> {
    return (this.host(harness).models?.() ?? [])
      .slice(0, 40)
      .filter((choice) => choice.value.length <= 200 && choice.name.length <= 200);
  }

  // The agents this computer can start.
  async agents(): Promise<StartHarness[]> {
    const available = await Promise.all(OFFERED.map((harness) => this.host(harness).available()));
    return OFFERED.filter((_, index) => available[index]);
  }

  async start(
    harness: StartHarness,
    cwd: string,
    text: string,
    files?: InputFile[],
    model?: string,
  ): Promise<string> {
    return (await this.hosting(harness)).start(cwd, text, files, model);
  }

  async resume(
    harness: StartHarness,
    id: string,
    cwd: string,
    text: string,
    files?: InputFile[],
  ): Promise<void> {
    return (await this.hosting(harness)).resume(id, cwd, text, files);
  }

  watch(onChange: () => void): () => void {
    this.listeners.add(onChange);
    this.integrations.claude
      .listen()
      .catch((error: unknown) =>
        process.stderr.write(
          `Claude Code sessions cannot take replies: ${error instanceof Error ? error.message : error}\n`,
        ));
    if (!this.timer && liveDiscovery()) {
      // This discovers newly opened native listeners; content changes use native event streams.
      this.timer = setInterval(() => this.changed(), DISCOVERY_MS);
      this.timer.unref();
    }
    return () => {
      this.listeners.delete(onChange);
      if (!this.listeners.size) {
        clearInterval(this.timer);
        this.timer = undefined;
      }
    };
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.listeners.clear();
    for (const integration of this.all) integration.stop();
  }
}
