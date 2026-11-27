import { fileURLToPath } from 'node:url';
import type { HarnessId } from '../domain/harness.js';
import type { ClarifyEvent, TranscriptMsg } from '../domain/request.js';
import { mcpTool } from '../mcp/identity.js';
import type { ModelOption } from './models.js';
import type { AgentProcess } from './transport.js';

export type SessionScope = 'request' | 'kb' | 'master' | 'setup';

/** Tools the bundled `aps` MCP server exposes. Keep in sync with `mcp/server.ts`. */
export const HARNESS_TOOLS = [
  mcpTool('update_request'),
  mcpTool('get_request'),
  mcpTool('spawn_request'),
  mcpTool('list_requests'),
  mcpTool('index_to_kb'),
];

export const REQUEST_TOOLS = ['Write', 'Read', 'Edit', 'Bash', 'Skill', 'Glob', 'Grep', ...HARNESS_TOOLS];
export const KB_TOOLS = ['Read', mcpTool('search_kb'), mcpTool('list_kb')];
/** The master chat is advisory: read the board and the KB, change nothing. */
export const MASTER_TOOLS = [
  'Read',
  mcpTool('list_requests'),
  mcpTool('get_request'),
  mcpTool('list_kb'),
  mcpTool('search_kb'),
];
/** Setup chat can read and edit only its transient cell draft. */
export const SETUP_TOOLS = [
  'Read',
  mcpTool('get_cell_draft'),
  mcpTool('update_cell_draft'),
];

/** The built stdio MCP server the engine hands to every harness session. */
export const HARNESS_MCP_SERVER = fileURLToPath(new URL('../mcp/server.js', import.meta.url));

export type McpServerMap = Record<string, Record<string, unknown>>;

export interface HarnessSession {
  scope: SessionScope;
  /** The request id, or an empty string for the knowledge-base/master/setup sessions. */
  requestId: string;
  /** Setup wizard draft id, when the scope is `setup`. */
  draftId?: string;
  /** Scratch directory for harness files (config, transcripts live here). */
  dir: string;
  /** The worktree or scratch cwd the agent runs in. */
  cwd: string;
  sessionId: string | null;
  model: string | null;
  effort: string | null;
  /** Request-session auto-compaction trigger, as a context-window percentage. */
  autocompactPercent?: number | null;
  pluginDirs: string[];
}

export interface HarnessCommand {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  sessionId?: string | null;
}

export interface TurnParserLike {
  sessionId: string | null;
  finished: boolean;
  /** Usage reported by the harness for this turn, or null when it reported none. */
  usage: TurnUsage | null;
  readonly transcript: TranscriptMsg[];
  push(line: string): ClarifyEvent[];
  finalize(): TranscriptMsg[];
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Null when no sample reported a cost, or when only part of the turn did. */
  costUsd: number | null;
}

/**
 * The agent substrate seam. A harness knows how to prepare a session config,
 * spawn its CLI, parse its event stream, and discover models. Adding another
 * harness is one implementation of this interface.
 */
export interface AgentHarness {
  readonly id: string;
  readonly fallbackModels: readonly ModelOption[];
  prepare(session: HarnessSession): Promise<HarnessCommand>;
  spawn(command: HarnessCommand): AgentProcess;
  createParser(transcript: TranscriptMsg[]): TurnParserLike;
  probeModels(): Promise<ModelOption[] | null>;
}

/** One cached adapter per known harness, plus the brain's default. */
export interface HarnessRegistry {
  readonly defaultId: HarnessId;
  get(id: HarnessId): AgentHarness;
}

/**
 * True when OpenCode refused to resume a session whose recorded directory is
 * gone, for example after the data directory moved. The failure can arrive as a
 * harness error event or wrapped in the engine's `stderr:` text.
 */
export function isStaleSessionLocationFailure(
  harnessId: HarnessId,
  message: string,
): boolean {
  return harnessId === 'opencode' && /(?:^|\n)Location not found: \//.test(message);
}
