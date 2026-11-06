import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import type { Harness, AgentOption, StartHarness } from '@dashup/protocol';

import { Headless } from './headless';
import { Codex, codexModels, codexOptions } from './codex';
import { Kimi, kimiCommand, kimiOptions } from './kimi';
import { Claude, claudeModels, claudeOptions, forgetModels } from './claude';
import { VSCode } from './vscode';
import { Pi } from './pi';
import { T3 } from './t3';
import { Kilo } from './kilo';
import { Orca } from './orca';
import { Cline } from './cline';
import { Junie } from './junie';
import { OpenCodeService } from './opencode-service';
import { OpenCode, openCodeOptions } from './opencode';
import { sessionKey, type Settings, type InputFile, type LiveSession } from './session';

// =============================================================================
// Existing harness connections
// =============================================================================

const DISCOVERY_MS = 10_000;

export class LiveHarnesses {
  private readonly listeners = new Set<() => void>();
  private readonly codex = new Codex(() => this.changed());
  private readonly headless = new Headless(() => this.changed());
  private readonly kimi = new Kimi(() => this.changed());
  private readonly claude = new Claude(() => this.changed());
  private readonly vscode = new VSCode(() => this.changed());
  private readonly opencode = new OpenCode(() => this.changed());
  private readonly service = new OpenCodeService(() => this.changed());
  private readonly pi = new Pi(() => this.changed());
  private readonly kilo = new Kilo(() => this.changed());
  private readonly cline = new Cline(() => this.changed());
  private readonly junie = new Junie(() => this.changed());
  private readonly t3 = new T3(() => this.changed());
  private readonly orca = new Orca(() => this.changed());
  private timer?: ReturnType<typeof setInterval>;
  private refreshing?: Promise<LiveSession[]>;
  private stopped = false;

  private changed(): void {
    if (!this.stopped) for (const listener of this.listeners) listener();
  }

  refresh(): Promise<LiveSession[]> {
    if (this.stopped) return Promise.resolve([]);
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      // Sessions Dashup runs come first, so their controls win over any other view of them.
      const results = await Promise.allSettled([
        this.headless.refresh(),
        this.kimi.refresh(),
        this.service.refresh(),
        this.opencode.refresh(),
        this.junie.refresh(),
        this.kilo.refresh(),
        this.cline.refresh(),
        this.pi.refresh(),
        this.codex.refresh(),
        this.claude.refresh(),
        this.vscode.refresh(),
        this.t3.refresh(),
        this.orca.refresh(),
      ]);
      const sessions = new Map<string, LiveSession>();
      for (const result of results)
        if (result.status === 'fulfilled') {
          for (const session of result.value) {
            const key = sessionKey(session);
            const known = sessions.get(key);
            // OpenCode servers share history, but only the executing server reports its work.
            // Keep that server's controls too, so stop and replies reach the actual owner.
            if (
              !known ||
              (session.harness === 'opencode' &&
                ['working', 'attention'].includes(session.status) &&
                !['working', 'attention'].includes(known.status))
            )
              sessions.set(key, session);
          }
        }
      return this.stopped ? [] : [...sessions.values()];
    })();
    void this.refreshing.finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  async sessionsFor(harness: Harness): Promise<LiveSession[]> {
    const owners: Partial<Record<Harness, Array<{ refresh(): Promise<LiveSession[]> }>>> = {
      claude: [this.headless, this.claude],
      opencode: [this.service, this.opencode],
      codex: [this.codex],
      kimi: [this.kimi],
      junie: [this.junie],
      kilo: [this.kilo],
      cline: [this.cline],
      pi: [this.pi],
      other: [this.vscode],
      t3: [this.t3],
      orca: [this.orca],
    };
    const found = await Promise.allSettled((owners[harness] ?? []).map((owner) => owner.refresh()));
    const sessions = new Map<string, LiveSession>();
    for (const result of found)
      if (result.status === 'fulfilled')
        for (const session of result.value)
          if (!sessions.has(session.id)) sessions.set(session.id, session);
    return [...sessions.values()];
  }

  // What a saved session last ran with, as its agent names its options.
  recorded(harness: Harness, settings: Settings): AgentOption[] {
    const changed = () => this.changed();
    if (harness === 'claude') return claudeOptions(claudeModels(changed), settings);
    if (harness === 'kimi') return kimiOptions(settings);
    if (harness === 'opencode') return openCodeOptions(settings);
    return harness === 'codex' ? codexOptions(settings) : [];
  }

  startModels(harness: StartHarness): NonNullable<AgentOption['choices']> {
    const choices =
      harness === 'claude'
        ? claudeModels(() => this.changed()).map((model) => ({
            value: model.value,
            name: model.displayName,
          }))
        : harness === 'codex'
          ? codexModels()
          : [];
    return choices
      .slice(0, 40)
      .filter((choice) => choice.value.length <= 200 && choice.name.length <= 200);
  }

  // The agents whose own command runs on this computer. Claude Code is asked its models again.
  async agents(): Promise<StartHarness[]> {
    const harnesses: StartHarness[] = ['claude', 'codex', 'opencode'];
    const extra = Promise.all([kimiCommand(), this.kilo.available(), this.junie.available()]);
    forgetModels();
    const runs = await Promise.all(
      harnesses.map((harness) =>
        promisify(execFile)(harness, ['--version'], {
          timeout: 10_000,
          shell: process.platform === 'win32',
        }).then(
          () => true,
          () => false,
        )),
    );
    const [kimi, kilo, junie] = await extra;
    return [
      ...harnesses.filter((_, index) => runs[index]),
      ...(kimi ? (['kimi'] as const) : []),
      ...(kilo ? (['kilo'] as const) : []),
      ...(junie ? (['junie'] as const) : []),
    ];
  }

  // The harness that starts and resumes each agent's sessions: OpenCode 2's service where it runs.
  private host(
    harness: StartHarness,
  ): Headless | Codex | Kimi | OpenCode | OpenCodeService | Kilo | Junie {
    if (harness === 'opencode') return this.service.available() ? this.service : this.opencode;
    return {
      claude: this.headless,
      codex: this.codex,
      kimi: this.kimi,
      kilo: this.kilo,
      junie: this.junie,
    }[harness];
  }

  // Starts a session in `cwd` with its first message, and resolves with the session's native id.
  start(
    harness: StartHarness,
    cwd: string,
    text: string,
    files?: InputFile[],
    model?: string,
  ): Promise<string> {
    if (harness === 'claude') return this.headless.start(cwd, text, files, model);
    if (harness === 'codex') return this.codex.start(cwd, text, undefined, files, model);
    return this.host(harness).start(cwd, text);
  }

  // Continues a saved session with a message, and resolves once its agent takes it.
  resume(
    harness: StartHarness,
    id: string,
    cwd: string,
    text: string,
    files?: InputFile[],
  ): Promise<void> {
    if (harness === 'claude') return this.headless.resume(id, cwd, text, files);
    if (harness === 'codex') return this.codex.resume(id, cwd, text, files);
    return this.host(harness).resume(id, cwd, text);
  }

  watch(onChange: () => void): () => void {
    this.listeners.add(onChange);
    this.claude
      .listen()
      .catch((error: unknown) =>
        process.stderr.write(
          `Claude Code sessions cannot take replies: ${error instanceof Error ? error.message : error}\n`,
        ));
    if (!this.timer && process.env.DASHUP_LIVE_DISCOVERY !== '0') {
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
    this.headless.stop();
    this.kimi.stop();
    this.opencode.stop();
    this.service.stop();
    this.pi.stop();
    this.kilo.stop();
    this.cline.stop();
    this.junie.stop();
    this.codex.stop();
    this.claude.stop();
    this.vscode.stop();
    this.t3.stop();
    this.orca.stop();
  }
}
