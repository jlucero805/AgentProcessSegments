import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { TranscriptMsg } from '../../domain/request.js';
import type { ErrorSink } from '../../logging/errors.js';
import { MCP_SERVER_KEY } from '../../mcp/identity.js';
import { isRecord } from '../../util/json.js';
import { warnOnce } from '../../util/warn-once.js';
import {
  HARNESS_MCP_SERVER,
  KB_TOOLS,
  MASTER_TOOLS,
  REQUEST_TOOLS,
  SETUP_TOOLS,
  type AgentHarness,
  type HarnessCommand,
  type HarnessSession,
  type McpServerMap,
  type TurnParserLike,
} from '../harness.js';
import { HARDCODED_MODELS, type ModelOption } from '../models.js';
import { TurnParser } from '../stream.js';
import type { AgentProcess } from '../transport.js';
import { type McpConfigIssue, reportMcpConfigIssues } from './config-diagnostics.js';
import { LineProcess } from './line-process.js';

const exec = promisify(execFile);

const PROBE_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    models: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, label: { type: 'string' } },
        required: ['id', 'label'],
      },
    },
  },
  required: ['models'],
});

export function parseProbeOutput(stdout: string): ModelOption[] | null {
  try {
    const outer: unknown = JSON.parse(stdout);
    const record = isRecord(outer) ? outer : {};
    const inner: unknown = typeof record['result'] === 'string' ? JSON.parse(record['result']) : record;
    const models = isRecord(inner) ? inner['models'] : null;
    if (!Array.isArray(models)) return null;

    const parsed: ModelOption[] = [];
    for (const item of models) {
      const entry = isRecord(item) ? item : {};
      if (typeof entry['id'] !== 'string') continue;
      parsed.push({
        id: entry['id'],
        label: typeof entry['label'] === 'string' ? entry['label'] : entry['id'],
      });
    }
    return parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

export async function probeClaudeModels(bin: string): Promise<ModelOption[] | null> {
  try {
    const { stdout } = await exec(
      bin,
      [
        '-p',
        'List every Claude model this CLI can run. Return an id and a short human label for each.',
        '--output-format',
        'json',
        '--model',
        'haiku',
        '--json-schema',
        PROBE_SCHEMA,
      ],
      { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 },
    );
    return parseProbeOutput(stdout);
  } catch {
    return null;
  }
}

/** Claude Code's MCP scopes, in the order they are merged. */
export type ClaudeMcpScope = 'user' | 'project' | 'local';

export interface McpServerSource {
  /** The config file that supplied the winning definition. */
  file: string;
  /** The scope that supplied the winning definition. */
  scope: ClaudeMcpScope;
}

export interface ClaudeUserMcpServers {
  servers: McpServerMap;
  /** The file and scope that defined each server, after scope precedence. */
  sources: Map<string, McpServerSource>;
  /** Files that exist but could not be read or interpreted. */
  issues: McpConfigIssue[];
}

type JsonFile =
  | { status: 'ok'; value: unknown }
  | { status: 'missing' }
  | { status: 'issue'; issue: McpConfigIssue };

function readJsonFile(file: string): JsonFile {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown';
    return { status: 'issue', issue: { path: file, reason: `unreadable: ${code}` } };
  }

  try {
    return { status: 'ok', value: JSON.parse(raw) };
  } catch {
    // Never include the parser message: recent Node versions quote the input.
    return { status: 'issue', issue: { path: file, reason: 'invalid JSON' } };
  }
}

/**
 * Servers Claude Code already knows about, read from the files the CLI writes:
 * user/local scope in `~/.claude.json`, project scope in `<cwd>/.mcp.json`.
 * Merge order follows the CLI's local > project > user precedence, so a later
 * merge replaces an earlier definition whole and `sources` names the winning
 * file and scope.
 * Unreadable files are skipped and reported through `issues`.
 */
export function claudeUserMcpServers(
  home = os.homedir(),
  cwd = process.cwd(),
): ClaudeUserMcpServers {
  const loaded: ClaudeUserMcpServers = { servers: {}, sources: new Map(), issues: [] };

  const read = (file: string): Record<string, unknown> | null => {
    const result = readJsonFile(file);
    if (result.status === 'issue') loaded.issues.push(result.issue);
    if (result.status !== 'ok') return null;
    if (!isRecord(result.value)) {
      loaded.issues.push({ path: file, reason: 'not a JSON object' });
      return null;
    }
    return result.value;
  };

  const serversIn = (
    record: Record<string, unknown>,
    field: string,
    file: string,
  ): Record<string, unknown> | null => {
    const value = record[field];
    if (value === undefined) return null;
    if (isRecord(value)) return value;
    loaded.issues.push({ path: file, reason: `${field} is not an object` });
    return null;
  };

  const merge = (
    raw: Record<string, unknown>,
    file: string,
    scope: ClaudeMcpScope,
  ): void => {
    for (const [name, definition] of Object.entries(pickServers(raw))) {
      loaded.servers[name] = definition;
      loaded.sources.set(name, { file, scope });
    }
  };

  const userFile = path.join(home, '.claude.json');
  const user = read(userFile);
  if (user) {
    const userServers = serversIn(user, 'mcpServers', userFile);
    if (userServers) merge(userServers, userFile, 'user');
  }

  const projectFile = path.join(cwd, '.mcp.json');
  const project = read(projectFile);
  if (project) {
    const projectServers = serversIn(project, 'mcpServers', projectFile);
    if (projectServers) merge(projectServers, projectFile, 'project');
  }

  if (user && isRecord(user['projects'])) {
    const localProject = user['projects'][cwd];
    if (isRecord(localProject)) {
      const localServers = serversIn(localProject, 'mcpServers', userFile);
      if (localServers) merge(localServers, userFile, 'local');
    }
  }

  return loaded;
}

function pickServers(raw: Record<string, unknown>): McpServerMap {
  const out: McpServerMap = {};
  for (const [name, definition] of Object.entries(raw)) {
    if (!isRecord(definition) || definition['disabled'] === true) continue;
    out[name] = definition;
  }
  return out;
}

export class ClaudeHarness implements AgentHarness {
  readonly id = 'claude';
  readonly fallbackModels = HARDCODED_MODELS;

  constructor(
    private readonly bin = 'claude',
    private readonly brainUrl = 'http://127.0.0.1:7391',
    private readonly home = os.homedir(),
    private readonly errors?: ErrorSink,
  ) {}

  async prepare(session: HarnessSession): Promise<HarnessCommand> {
    // The KB and master sessions are read-only: no user servers, no plugins.
    const requestScope = session.scope === 'request';
    const loaded = requestScope ? claudeUserMcpServers(this.home, session.cwd) : null;
    const userServers = loaded?.servers ?? {};
    if (loaded) {
      reportMcpConfigIssues('claude', loaded.issues, this.errors);
      const source = loaded.sources.get(MCP_SERVER_KEY);
      if (source) {
        warnOnce(
          `mcp-reserved:${source.file}`,
          `ignoring ${source.scope} MCP server "${MCP_SERVER_KEY}" from ${source.file}: ` +
            `the bundled "${MCP_SERVER_KEY}" server takes precedence`,
        );
      }
    }
    const baseTools =
      session.scope === 'kb'
        ? KB_TOOLS
        : session.scope === 'master'
          ? MASTER_TOOLS
          : session.scope === 'setup'
            ? SETUP_TOOLS
            : REQUEST_TOOLS;
    const allowedTools = [...baseTools];
    for (const name of Object.keys(userServers)) allowedTools.push(`mcp__${name}__*`);

    const servers: McpServerMap = {
      ...userServers,
      [MCP_SERVER_KEY]: {
        command: process.execPath,
        args: [HARNESS_MCP_SERVER],
        env: {
          APS_BRAIN_URL: this.brainUrl,
          APS_REQUEST_ID: session.requestId,
          APS_SESSION_SCOPE: session.scope,
          ...(session.draftId ? { APS_SETUP_DRAFT_ID: session.draftId } : {}),
        },
      },
    };

    mkdirSync(session.dir, { recursive: true });
    const configPath = path.join(session.dir, 'mcp-config.json');
    writeFileSync(configPath, `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`);

    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--allowedTools',
      allowedTools.join(','),
      '--mcp-config',
      configPath,
      '--strict-mcp-config',
    ];
    if (session.model) args.push('--model', session.model);
    if (session.effort) args.push('--effort', session.effort);
    if (session.sessionId) args.push('--resume', session.sessionId);
    for (const dir of session.pluginDirs) args.push('--plugin-dir', dir);

    const env: Record<string, string> = { CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' };
    if (
      requestScope &&
      session.autocompactPercent !== null &&
      session.autocompactPercent !== undefined
    ) {
      // Claude can lower its auto-compact threshold but cannot raise it above
      // its own default; the UI states that limitation.
      env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(session.autocompactPercent);
      args.push('--settings', JSON.stringify({ autoCompactEnabled: true }));
    }

    return {
      cmd: this.bin,
      args,
      env,
      cwd: session.cwd,
      sessionId: session.sessionId,
    };
  }

  spawn(command: HarnessCommand): AgentProcess {
    return new ClaudeProcess(command);
  }

  createParser(transcript: TranscriptMsg[]): TurnParserLike {
    return new TurnParser(transcript);
  }

  probeModels(): Promise<ModelOption[] | null> {
    return probeClaudeModels(this.bin);
  }
}

/** Long-lived `claude -p` child; turns are written to stdin as stream-json. */
class ClaudeProcess extends LineProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  /** Set once stdin fails; later writes must not report the same failure again. */
  private stdinFailed = false;

  constructor(command: HarnessCommand) {
    super();
    this.child = spawn(command.cmd, command.args, {
      cwd: command.cwd,
      // Pin PWD: OpenCode resolves the project root from it, and an inherited
      // value would point the child at the brain's own cwd.
      env: { ...process.env, ...command.env, PWD: command.cwd },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // A child that exits or closes stdin while a write is in flight emits EPIPE
    // here asynchronously; without this listener it would be an unhandled
    // 'error' event and kill the brain.
    this.child.stdin.on('error', (error) => this.failStdin(error));
    this.attach(this.child);
  }

  protected errorLine(error: Error): string {
    return JSON.stringify({
      type: 'result',
      subtype: 'error',
      is_error: true,
      result: error.message,
    });
  }

  private failStdin(error: Error): void {
    if (this.stdinFailed) return;
    this.stdinFailed = true;
    this.emitLine(this.errorLine(new Error(`claude stdin is closed: ${error.message}`)));
  }

  writeUserMessage(text: string): void {
    const { stdin } = this.child;
    if (stdin.destroyed || stdin.writableEnded || !stdin.writable) {
      this.failStdin(new Error('stream is not writable'));
      return;
    }
    const payload = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
    stdin.write(`${JSON.stringify(payload)}\n`);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.child.kill(signal);
  }
}
