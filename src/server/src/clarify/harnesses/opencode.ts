import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { ClarifyEvent, TranscriptMsg } from '../../domain/request.js';
import type { ErrorSink } from '../../logging/errors.js';
import { MCP_SERVER_KEY } from '../../mcp/identity.js';
import { isRecord } from '../../util/json.js';
import { parseJsonc } from '../../util/jsonc.js';
import { warnOnce } from '../../util/warn-once.js';
import {
  HARNESS_MCP_SERVER,
  type AgentHarness,
  type HarnessCommand,
  type HarnessSession,
  type McpServerMap,
  type TurnParserLike,
  type TurnUsage,
} from '../harness.js';
import type { ModelOption } from '../models.js';
import type { AgentProcess } from '../transport.js';
import { type McpConfigIssue, reportMcpConfigIssues } from './config-diagnostics.js';
import { LineProcess } from './line-process.js';
import { mergeSkillPaths, readPluginAssets } from './plugin-assets.js';

const exec = promisify(execFile);

/** OpenCode config overrides that must not reach a harness child. */
const CONFIG_ENV_KEYS = ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT'] as const;

/**
 * Remove process-level OpenCode config overrides so only the config the harness
 * generates under OPENCODE_CONFIG_DIR can apply. OpenCode layers these above
 * the generated file, where they could replace the bundled `aps` server or a
 * read-only permission.
 */
export function scrubOpencodeConfigEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  for (const key of CONFIG_ENV_KEYS) delete clean[key];
  return clean;
}

/** Warn once per set override without naming its value; inline config may hold secrets. */
function warnConfigEnvOverrides(env: NodeJS.ProcessEnv): void {
  for (const key of CONFIG_ENV_KEYS) {
    const value = env[key];
    if (value === undefined || value === '') continue;
    warnOnce(
      `opencode-config-env:${key}`,
      `ignoring ${key} for OpenCode harness sessions: ` +
        `the harness uses the generated OPENCODE_CONFIG_DIR config`,
    );
  }
}

/** The bundled `aps` MCP server in OpenCode's config shape. */
export function opencodeHarnessServer(
  requestId: string,
  brainUrl: string,
  scope: string,
  draftId?: string,
): Record<string, unknown> {
  return {
    type: 'local',
    command: [process.execPath, HARNESS_MCP_SERVER],
    environment: {
      APS_BRAIN_URL: brainUrl,
      APS_REQUEST_ID: requestId,
      APS_SESSION_SCOPE: scope,
      ...(draftId ? { APS_SETUP_DRAFT_ID: draftId } : {}),
    },
    // Keep harness tools native so each call is visible and small models do not
    // have to generate Code Mode JavaScript between steps.
    codemode: false,
    enabled: true,
  };
}

export interface OpencodeConfigFile {
  config: Record<string, unknown>;
  /** The file that supplied the config, or null when none parsed. */
  path: string | null;
  /** Candidates that exist but could not be read or interpreted. */
  issues: McpConfigIssue[];
}

/** Reads the user's OpenCode config so its MCP servers and settings survive injection. */
export function readOpencodeConfig(
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): OpencodeConfigFile {
  const dir =
    env.OPENCODE_CONFIG_DIR ??
    path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'opencode');

  const issues: McpConfigIssue[] = [];
  for (const name of ['opencode.json', 'opencode.jsonc']) {
    const file = path.join(dir, name);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
        issues.push({ path: file, reason: `unreadable: ${code}` });
      }
      continue;
    }

    let parsed: unknown;
    try {
      parsed = parseJsonc(raw);
    } catch {
      // Never include the parser message: recent Node versions quote the input.
      issues.push({ path: file, reason: 'invalid JSON' });
      continue;
    }
    if (!isRecord(parsed)) {
      issues.push({ path: file, reason: 'not a JSON object' });
      continue;
    }
    if (parsed.mcp !== undefined && !isRecord(parsed.mcp)) {
      issues.push({ path: file, reason: 'mcp is not an object' });
    }
    return { config: parsed, path: file, issues };
  }
  return { config: {}, path: null, issues };
}

/** Accepts both the documented direct `mcp.<name>` shape and the encoded `mcp.servers` shape. */
export function opencodeMcpServers(config: Record<string, unknown>): McpServerMap {
  const mcp = config.mcp;
  if (!isRecord(mcp)) return {};
  const source = isRecord(mcp.servers) ? mcp.servers : mcp;
  const out: McpServerMap = {};
  for (const [name, definition] of Object.entries(source)) {
    if (!isRecord(definition)) continue;
    out[name] = definition;
  }
  return out;
}

const READ_ONLY_PERMISSIONS = {
  read: 'allow',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  edit: 'deny',
  bash: 'deny',
  task: 'deny',
  external_directory: 'deny',
  webfetch: 'deny',
  websearch: 'deny',
  // `opencode run` is non-interactive. Leaving the interactive question tool
  // enabled lets the model stall the whole turn waiting for a reply.
  question: 'deny',
};

export class OpencodeHarness implements AgentHarness {
  readonly id = 'opencode';
  readonly fallbackModels: readonly ModelOption[] = [];

  constructor(
    private readonly bin = 'opencode',
    private readonly brainUrl = 'http://127.0.0.1:7391',
    private readonly home = os.homedir(),
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly errors?: ErrorSink,
  ) {}

  async prepare(session: HarnessSession): Promise<HarnessCommand> {
    warnConfigEnvOverrides(this.env);
    const { config: user, path: configPath, issues } = readOpencodeConfig(this.home, this.env);
    const requestScope = session.scope === 'request';
    // User MCP servers, plugins, and user permissions are request-session only.
    if (requestScope) reportMcpConfigIssues('opencode', issues, this.errors);
    const userServers = requestScope ? opencodeMcpServers(user) : {};
    if (requestScope && configPath !== null && userServers[MCP_SERVER_KEY] !== undefined) {
      warnOnce(
        `mcp-reserved:${configPath}`,
        `ignoring user MCP server "${MCP_SERVER_KEY}" from ${configPath}: ` +
          `the bundled "${MCP_SERVER_KEY}" server takes precedence`,
      );
    }
    const config: Record<string, unknown> = {
      ...user,
      mcp: {
        ...userServers,
        [MCP_SERVER_KEY]: opencodeHarnessServer(
          session.requestId,
          this.brainUrl,
          session.scope,
          session.draftId,
        ),
      },
    };

    if (!requestScope) {
      // Read-only harness sessions keep the user's MCP merge out and must not
      // load user plugins, commands, skills, or agents.
      for (const key of ['plugin', 'plugins', 'command', 'commands', 'skills', 'agent', 'agents']) {
        delete config[key];
      }
      const current = isRecord(user.permission) ? user.permission : {};
      config.permission = { ...current, ...READ_ONLY_PERMISSIONS };
    } else {
      // Request sessions keep the user's permission posture, but every brain
      // session is non-interactive: the question tool must never wait for a UI.
      const current = isRecord(user.permission) ? user.permission : {};
      config.permission = { ...current, question: 'deny' };
    }

    if (
      requestScope &&
      session.autocompactPercent !== null &&
      session.autocompactPercent !== undefined
    ) {
      // Request sessions compact at the cell's threshold. `buffer` is the share
      // of the context window kept free, so 80% used leaves a 20% buffer.
      const compaction: Record<string, unknown> = isRecord(config.compaction)
        ? { ...config.compaction }
        : {};
      // The v2 percentage `buffer` supersedes the deprecated token `reserved`.
      delete compaction.reserved;
      compaction.auto = true;
      compaction.buffer = `${100 - session.autocompactPercent}%`;
      config.compaction = compaction;
    }

    if (requestScope) {
      const assets = readPluginAssets(session.pluginDirs);
      if (Object.keys(assets.commands).length > 0) {
        const userCommands = {
          ...(isRecord(user.command) ? user.command : {}),
          ...(isRecord(user.commands) ? user.commands : {}),
        };
        config.commands = { ...userCommands, ...assets.commands };
      }
      if (assets.skills.length > 0) {
        config.skills = mergeSkillPaths(user.skills, assets.skills);
      }
    }

    const configDir = path.join(session.dir, 'opencode');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, 'opencode.json'), `${JSON.stringify(config, null, 2)}\n`);

    // --standalone keeps each turn's server private so OPENCODE_CONFIG_DIR applies.
    // --archived keeps scripted brain sessions out of the user's session list.
    const args = ['run', '--format', 'json', '--auto', '--standalone', '--archived'];
    if (session.model) args.push('--model', session.model);

    return {
      cmd: this.bin,
      args,
      env: { OPENCODE_CONFIG_DIR: configDir },
      cwd: session.cwd,
      sessionId: session.sessionId,
    };
  }

  spawn(command: HarnessCommand): AgentProcess {
    return new OpencodeProcess(command);
  }

  createParser(transcript: TranscriptMsg[]): TurnParserLike {
    return new OpencodeTurnParser(transcript);
  }

  probeModels(): Promise<ModelOption[] | null> {
    return probeOpencodeModels(this.bin);
  }
}

/**
 * OpenCode is one-shot per message, so the process controller starts a fresh
 * `opencode run` for every turn. The session id is carried forward from the
 * events, which is what makes `--session` resume work across processes.
 */
export class OpencodeProcess extends LineProcess {
  private child: ChildProcess | null = null;
  private sessionId: string | null;

  constructor(private readonly command: HarnessCommand) {
    super();
    this.sessionId = command.sessionId ?? null;
  }

  protected errorLine(error: Error): string {
    return JSON.stringify({ type: 'error', message: error.message });
  }

  writeUserMessage(text: string): void {
    const args = [...this.command.args];
    if (this.sessionId) args.push('--session', this.sessionId);
    args.push('--', text);

    const child = spawn(this.command.cmd, args, {
      cwd: this.command.cwd,
      // OpenCode resolves its project root from PWD; inheriting the brain's PWD
      // would make it ignore the per-request config/cwd.
      env: {
        ...scrubOpencodeConfigEnv({ ...process.env, ...this.command.env }),
        PWD: this.command.cwd,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.attach(child, {
      onLine: (line) => this.captureSession(line),
      onExit: () => {
        if (this.child === child) this.child = null;
      },
    });
  }

  private captureSession(line: string): void {
    try {
      const event: unknown = JSON.parse(line);
      if (isRecord(event) && typeof event.sessionID === 'string') {
        this.sessionId = event.sessionID;
      }
    } catch {
      // Not a JSON event line.
    }
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.child?.kill(signal);
  }
}

/**
 * Maps OpenCode's `--format json` events to the harness event contract.
 * Events: step_start, text, tool_use, step_finish, error.
 */
export class OpencodeTurnParser implements TurnParserLike {
  sessionId: string | null = null;
  finished = false;
  usage: TurnUsage | null = null;

  private readonly toolIndex = new Map<string, number>();
  private readonly resultEmitted = new Set<string>();
  private readonly tokens = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
  private sawUsage = false;
  private sawCost = false;
  private costComplete = true;
  private costTotal = 0;

  constructor(readonly transcript: TranscriptMsg[]) {}

  push(line: string): ClarifyEvent[] {
    if (this.finished) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    if (!isRecord(parsed)) return [];

    if (typeof parsed.sessionID === 'string') this.sessionId = parsed.sessionID;
    const part = isRecord(parsed.part) ? parsed.part : {};

    switch (parsed.type) {
      case 'text': {
        const text = typeof part.text === 'string' ? part.text : '';
        if (text === '') return [];
        this.transcript.push({ role: 'agent', kind: 'text', text, ts: Date.now() });
        return [{ t: 'text', text }];
      }
      case 'tool_use':
        return this.onTool(part);
      case 'step_finish':
        return this.onStepFinish(part);
      case 'error':
        this.finished = true;
        return [{ t: 'error', message: errorText(parsed) }];
      default:
        return [];
    }
  }

  private onTool(part: Record<string, unknown>): ClarifyEvent[] {
    const state = isRecord(part.state) ? part.state : {};
    const id =
      typeof part.callID === 'string'
        ? part.callID
        : typeof part.id === 'string'
          ? part.id
          : `tool_${this.transcript.length}`;
    const name = typeof part.tool === 'string' ? part.tool : 'tool';
    const input =
      typeof state.input === 'string' ? state.input : JSON.stringify(state.input ?? {}, null, 2);

    const events: ClarifyEvent[] = [];
    let index = this.toolIndex.get(id);
    if (index === undefined) {
      index = this.transcript.length;
      this.toolIndex.set(id, index);
      this.transcript.push({
        role: 'agent',
        kind: 'tool',
        text: name,
        toolId: id,
        toolName: name,
        toolInput: input,
        ts: Date.now(),
      });
      events.push({ t: 'tool', id, name, input });
    }

    const raw = state.output ?? state.error;
    if (raw !== undefined && !this.resultEmitted.has(id)) {
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
      const isError = state.status === 'error';
      const entry = this.transcript[index];
      if (entry) {
        entry.toolResult = text;
        entry.toolError = isError;
      }
      this.resultEmitted.add(id);
      events.push({ t: 'tool_result', id, text, isError });
    }
    return events;
  }

  private onStepFinish(part: Record<string, unknown>): ClarifyEvent[] {
    this.accumulateUsage(part);
    const reason = typeof part.reason === 'string' ? part.reason : 'unknown';
    if (reason === 'tool-calls') return [];
    this.finished = true;
    if (reason === 'stop' || reason === 'length') return [];
    return [{ t: 'error', message: `agent stopped: ${reason}` }];
  }

  private accumulateUsage(part: Record<string, unknown>): void {
    const tokens = isRecord(part.tokens) ? part.tokens : {};
    const cache = isRecord(tokens.cache) ? tokens.cache : {};
    const cost = reportedCost(part.cost);
    const hasTokens =
      Object.keys(tokens).length > 0 ||
      typeof tokens['input'] === 'number' ||
      typeof tokens['output'] === 'number' ||
      typeof tokens['reasoning'] === 'number';
    if (!hasTokens && cost === null) return;

    this.sawUsage = true;
    this.tokens.inputTokens += tokenCount(tokens['input']);
    this.tokens.outputTokens += tokenCount(tokens['output']);
    this.tokens.reasoningTokens += tokenCount(tokens['reasoning']);
    this.tokens.cacheReadTokens += tokenCount(cache['read']);
    this.tokens.cacheWriteTokens += tokenCount(cache['write']);

    if (cost === null) {
      this.costComplete = false;
    } else {
      this.sawCost = true;
      this.costTotal += cost;
    }

    this.usage = {
      ...this.tokens,
      costUsd: this.sawCost && this.costComplete ? this.costTotal : null,
    };
  }

  finalize(): TranscriptMsg[] {
    return this.transcript;
  }
}

function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function reportedCost(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function errorText(event: Record<string, unknown>): string {
  if (typeof event.message === 'string') return event.message;
  const error = event.error;
  if (isRecord(error)) {
    const data = isRecord(error.data) ? error.data : error;
    if (typeof data.message === 'string') return data.message;
  }
  return 'agent error';
}

export async function probeOpencodeModels(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ModelOption[] | null> {
  try {
    const { stdout } = await exec(bin, ['models'], {
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
      env: scrubOpencodeConfigEnv(env),
    });
    const models: ModelOption[] = [];
    for (const line of stdout.split('\n')) {
      const id = line.trim();
      if (!id.includes('/') || /\s/.test(id)) continue;
      models.push({ id, label: id });
    }
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}
