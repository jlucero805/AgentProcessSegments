import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type { TranscriptMsg } from '../../domain/request.js';
import {
  HARNESS_MCP_SERVER,
  KB_TOOLS,
  REQUEST_TOOLS,
  isRecord,
  type AgentHarness,
  type HarnessCommand,
  type HarnessSession,
  type McpServerMap,
  type TurnParserLike,
} from '../harness.js';
import { HARDCODED_MODELS, type ModelOption } from '../models.js';
import { TurnParser } from '../stream.js';
import type { AgentProcess } from '../transport.js';

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

/**
 * Servers Claude Code already knows about, read from the files the CLI writes:
 * user/local scope in `~/.claude.json`, project scope in `<cwd>/.mcp.json`.
 * Later scopes win, matching the CLI's local > project > user precedence.
 */
export function claudeUserMcpServers(
  home = os.homedir(),
  cwd = process.cwd(),
): McpServerMap {
  const readJson = (file: string): unknown => {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };

  const merged: McpServerMap = {};
  const user = readJson(path.join(home, '.claude.json'));
  if (isRecord(user)) {
    if (isRecord(user['mcpServers'])) Object.assign(merged, pickServers(user['mcpServers']));
    if (isRecord(user['projects'])) {
      const project = user['projects'][cwd];
      if (isRecord(project) && isRecord(project['mcpServers'])) {
        Object.assign(merged, pickServers(project['mcpServers']));
      }
    }
  }

  const projectFile = readJson(path.join(cwd, '.mcp.json'));
  if (isRecord(projectFile) && isRecord(projectFile['mcpServers'])) {
    Object.assign(merged, pickServers(projectFile['mcpServers']));
  }

  return merged;
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
  ) {}

  async prepare(session: HarnessSession): Promise<HarnessCommand> {
    // The KB session is read-only: harness MCP only, no user servers, no plugins.
    const userServers = session.requestId === '' ? {} : claudeUserMcpServers(this.home, session.cwd);
    const allowedTools = [...(session.requestId === '' ? KB_TOOLS : REQUEST_TOOLS)];
    for (const name of Object.keys(userServers)) allowedTools.push(`mcp__${name}__*`);

    const servers: McpServerMap = {
      ...userServers,
      harness: {
        command: process.execPath,
        args: [HARNESS_MCP_SERVER],
        env: {
          SBOX_BRAIN_URL: this.brainUrl,
          SBOX_REQUEST_ID: session.requestId,
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

    return {
      cmd: this.bin,
      args,
      env: { CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1' },
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
class ClaudeProcess implements AgentProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lineHandlers: Array<(line: string) => void> = [];
  private readonly exitHandlers: Array<(code: number | null) => void> = [];

  constructor(command: HarnessCommand) {
    this.child = spawn(command.cmd, command.args, {
      cwd: command.cwd,
      env: { ...process.env, ...command.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    createInterface({ input: this.child.stdout }).on('line', (line) => {
      for (const handler of this.lineHandlers) handler(line);
    });
    this.child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    this.child.on('exit', (code) => {
      for (const handler of this.exitHandlers) handler(code);
    });
    this.child.on('error', (error) => {
      const line = JSON.stringify({
        type: 'result',
        subtype: 'error',
        is_error: true,
        result: error.message,
      });
      for (const handler of this.lineHandlers) handler(line);
    });
  }

  writeUserMessage(text: string): void {
    const payload = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    this.child.kill(signal);
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandlers.push(handler);
  }

  onExit(handler: (code: number | null) => void): void {
    this.exitHandlers.push(handler);
  }
}
