import { fileURLToPath } from 'node:url';
import type { ClarifyEvent, TranscriptMsg } from '../domain/request.js';
import type { ModelOption } from './models.js';
import type { AgentProcess } from './transport.js';

export type SessionScope = 'request' | 'kb' | 'master' | 'setup';

/** Tools the harness MCP server exposes. Keep in sync with `mcp/server.ts`. */
export const HARNESS_TOOLS = [
  'mcp__harness__update_request',
  'mcp__harness__get_request',
  'mcp__harness__spawn_request',
  'mcp__harness__list_requests',
  'mcp__harness__index_to_kb',
];

export const REQUEST_TOOLS = ['Write', 'Read', 'Edit', 'Bash', 'Skill', 'Glob', 'Grep', ...HARNESS_TOOLS];
export const KB_TOOLS = ['Read', 'mcp__harness__search_kb', 'mcp__harness__list_kb'];
/** The master chat is advisory: read the board and the KB, change nothing. */
export const MASTER_TOOLS = [
  'Read',
  'mcp__harness__list_requests',
  'mcp__harness__get_request',
  'mcp__harness__list_kb',
  'mcp__harness__search_kb',
];
/** Setup chat can read and edit only its transient cell draft. */
export const SETUP_TOOLS = [
  'Read',
  'mcp__harness__get_cell_draft',
  'mcp__harness__update_cell_draft',
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
  readonly transcript: TranscriptMsg[];
  push(line: string): ClarifyEvent[];
  finalize(): TranscriptMsg[];
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
