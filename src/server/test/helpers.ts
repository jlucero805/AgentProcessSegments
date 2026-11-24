import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CellRepository } from '../src/cells/repository.js';
import { Engine } from '../src/clarify/engine.js';
import type {
  AgentHarness,
  HarnessCommand,
  HarnessSession,
  TurnParserLike,
} from '../src/clarify/harness.js';
import type { ModelOption } from '../src/clarify/models.js';
import { TurnParser } from '../src/clarify/stream.js';
import type { AgentProcess } from '../src/clarify/transport.js';
import { loadConfig, type Config } from '../src/config.js';
import { openDb, type Db } from '../src/db.js';
import type { SpendPause } from '../src/domain/budget.js';
import type { HarnessId } from '../src/domain/harness.js';
import type { Effort, TranscriptMsg } from '../src/domain/request.js';
import { KbRepository } from '../src/kb/repository.js';
import type { ErrorSink } from '../src/logging/errors.js';
import { PluginManager } from '../src/plugins/manager.js';
import { PricingRepository } from '../src/pricing/repository.js';
import { RequestRepository } from '../src/requests/repository.js';
import { UsageRepository } from '../src/usage/repository.js';

export function testConfig(): Config {
  const base = mkdtempSync(path.join(os.tmpdir(), 'sbox-test-'));
  return {
    ...loadConfig({}, base, path.join(base, 'home')),
    dbPath: path.join(base, 'harness.sqlite'),
    dataDir: path.join(base, 'data'),
    webDir: path.join(base, 'no-web-build'),
    pluginsDir: path.join(base, 'data', 'plugins'),
    configPath: path.join(base, 'config.json'),
    processPath: path.join(base, 'process.json'),
    errorLogPath: path.join(base, 'errors.log'),
    errorLogMaxBytes: 4096,
    terminalCwd: base,
  };
}

/**
 * Apply a test's config overrides on top of a fresh config. `defaultModel` is a
 * convenience for the effective harness only, matching `APS_DEFAULT_MODEL`.
 */
function withConfigOverrides(base: Config, overrides: Partial<Config>): Config {
  const merged: Config = { ...base, ...overrides };
  if (overrides.defaultModel !== undefined) {
    merged.defaultModels = { ...merged.defaultModels, [merged.harness]: overrides.defaultModel };
  }
  // Keep the scalar alias in step with the per-harness map.
  return { ...merged, defaultModel: merged.defaultModels[merged.harness] };
}

export function line(value: unknown): string {
  return JSON.stringify(value);
}

export function initLine(sessionId = 'session-1'): string {
  return line({ type: 'system', subtype: 'init', session_id: sessionId });
}

export function textLine(text: string): string {
  return line({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  });
}

export function resultLine(
  text = 'ok',
  usage?: Record<string, number>,
  totalCostUsd?: number,
): string {
  return line({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: text,
    ...(usage ? { usage } : {}),
    ...(totalCostUsd === undefined ? {} : { total_cost_usd: totalCostUsd }),
  });
}

export function errorResultLine(
  text = '',
  options: {
    subtype?: string;
    isError?: boolean;
    usage?: Record<string, number>;
    totalCostUsd?: number;
  } = {},
): string {
  return line({
    type: 'result',
    subtype: options.subtype ?? 'error_during_execution',
    is_error: options.isError ?? true,
    result: text,
    ...(options.usage ? { usage: options.usage } : {}),
    ...(options.totalCostUsd === undefined ? {} : { total_cost_usd: options.totalCostUsd }),
  });
}

export function defaultScript(): string[] {
  return [initLine(), textLine('Ready '), textLine('to groom.'), resultLine()];
}

/** Test double for a harness process; scripted lines stand in for the CLI. */
export class FakeAgentProcess implements AgentProcess {
  readonly messages: string[] = [];
  stderrText = '';
  killed = false;

  private readonly lineHandlers: Array<(line: string) => void> = [];
  private readonly exitHandlers: Array<(code: number | null) => void> = [];

  constructor(private readonly respond: (text: string) => string[] = () => []) {}

  writeUserMessage(text: string): void {
    this.messages.push(text);
    const lines = this.respond(text);
    if (lines.length === 0) return;
    queueMicrotask(() => {
      for (const line of lines) this.emit(line);
    });
  }

  kill(): void {
    this.killed = true;
  }

  recentStderr(): string {
    return this.stderrText;
  }

  emitStderr(text: string): void {
    this.stderrText += this.stderrText === '' ? text : `\n${text}`;
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandlers.push(handler);
  }

  onExit(handler: (code: number | null) => void): void {
    this.exitHandlers.push(handler);
  }

  emit(line: string): void {
    for (const handler of this.lineHandlers) handler(line);
  }

  emitExit(code: number | null): void {
    for (const handler of this.exitHandlers) handler(code);
  }
}

/** Records prepare/spawn calls and uses the real Claude stream parser. */
export class FakeHarness implements AgentHarness {
  readonly fallbackModels: readonly ModelOption[] = [];
  readonly sessions: HarnessSession[] = [];
  readonly commands: HarnessCommand[] = [];
  process: FakeAgentProcess | null = null;
  /** Override the real Claude parser when a test needs another harness format. */
  parserFactory: ((transcript: TranscriptMsg[]) => TurnParserLike) | null = null;

  constructor(
    private readonly respond: (text: string) => string[] = () => [],
    readonly id: HarnessId = 'claude',
  ) {}

  async prepare(session: HarnessSession): Promise<HarnessCommand> {
    this.sessions.push(session);
    const command: HarnessCommand = {
      cmd: 'fake',
      args: [],
      env: {},
      cwd: session.cwd,
      sessionId: session.sessionId,
    };
    this.commands.push(command);
    return command;
  }

  spawn(_command: HarnessCommand): AgentProcess {
    this.process = new FakeAgentProcess(this.respond);
    return this.process;
  }

  createParser(transcript: TranscriptMsg[]): TurnParserLike {
    return this.parserFactory?.(transcript) ?? new TurnParser(transcript);
  }

  async probeModels(): Promise<ModelOption[] | null> {
    return null;
  }
}

export interface Harness {
  config: Config;
  db: Db;
  repo: RequestRepository;
  cells: CellRepository;
  kb: KbRepository;
  usage: UsageRepository;
  pricing: PricingRepository;
  plugins: PluginManager;
  harness: FakeHarness;
  opencode: FakeHarness;
  engine: Engine;
}

export function createHarness(
  script: (text: string) => string[] = defaultScript,
  cellConfig?: (
    cellId: string,
  ) =>
    | {
        model: string | null;
        effort: Effort | null;
        harness: HarnessId | null;
        autocompactPercent?: number;
      }
    | null,
  spendCap?: (cellId: string | null) => SpendPause | null,
  errors?: ErrorSink,
  configOverrides: Partial<Config> = {},
  onUsageRecorded?: () => void,
): Harness {
  const config = withConfigOverrides(testConfig(), configOverrides);
  const db = openDb(config.dbPath);
  const repo = new RequestRepository(db);
  const cells = new CellRepository(db);
  const kb = new KbRepository(db);
  const plugins = new PluginManager(config.pluginsDir);
  const agentHarness = new FakeHarness(script, 'claude');
  const opencodeHarness = new FakeHarness(script, 'opencode');
  const usage = new UsageRepository(db);
  const pricing = new PricingRepository(db);
  const engine = new Engine({
    repo,
    harnesses: {
      defaultId: config.harness,
      get: (id) => (id === 'opencode' ? opencodeHarness : agentHarness),
    },
    config,
    usage,
    pluginDirs: () => plugins.installedPluginDirs(),
    spendCap,
    ...(onUsageRecorded ? { onUsageRecorded } : {}),
    ...(errors ? { errors } : {}),
    cellConfig:
      cellConfig ??
      ((cellId) => {
        const cell = cells.get(cellId);
        return cell
          ? {
              model: cell.model,
              effort: cell.effort,
              harness: cell.harness,
              autocompactPercent: cell.autocompactPercent,
            }
          : null;
      }),
  });
  return {
    config,
    db,
    repo,
    cells,
    kb,
    usage,
    pricing,
    plugins,
    harness: agentHarness,
    opencode: opencodeHarness,
    engine,
  };
}

/** Let queued microtasks (and the turn's finally block) run. */
export async function settle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}
