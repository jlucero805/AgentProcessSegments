import type { HarnessId } from './harness.js';

export const STATES = ['clarify', 'dispatch', 'review', 'merge', 'finalize', 'done', 'dropped'] as const;
export type State = (typeof STATES)[number];

export const TERMINAL_STATES: readonly State[] = ['done', 'dropped'];

export function isTerminal(state: State): boolean {
  return TERMINAL_STATES.includes(state);
}

export const TRANSITIONS: Record<State, readonly State[]> = {
  clarify: ['dispatch', 'dropped'],
  dispatch: ['review', 'clarify', 'dropped'],
  review: ['merge', 'finalize', 'clarify', 'dispatch', 'dropped'],
  merge: ['finalize', 'review', 'dispatch', 'clarify', 'dropped'],
  finalize: ['done', 'dropped'],
  done: [],
  dropped: [],
};

export function canTransition(from: State, to: State): boolean {
  return TRANSITIONS[from].includes(to);
}

export const AGENT_STATUSES = ['none', 'idle', 'working', 'blocked', 'error'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_LEVELS)[number];

/** Default cap when a cell has no explicit concurrency limit. */
export const DEFAULT_MAX_CONCURRENT = 3;

export interface Request {
  id: string;
  title: string;
  body: string;
  state: State;
  groomed: boolean;
  clarifyStarted: boolean;
  model: string | null;
  effort: Effort | null;
  targetRepo: string | null;
  acceptanceCriteria: string | null;
  context: string | null;
  skills: string[];
  kbDigest: boolean;
  digest: string | null;
  agentStatus: AgentStatus;
  unchecked: boolean;
  hcRunIds: string[];
  branch: string | null;
  crUrl: string | null;
  cellId: string | null;
  /** Explicit request override; null inherits the cell, then the process default. */
  harness: HarnessId | null;
  createdAt: number;
  updatedAt: number;
}

export interface Cell {
  id: string;
  name: string;
  masterEnabled: boolean;
  /** Null means inherit the scheduler's global interval. */
  masterIntervalMinutes: number | null;
  /** Cap on requests currently working in this cell. */
  maxConcurrent: number;
  /** Cell-level defaults; a request's own model/effort wins. */
  model: string | null;
  effort: Effort | null;
  /** Cell harness; null inherits the process default. */
  harness: HarnessId | null;
  createdAt: number;
}

export interface KbEntry {
  id: string;
  requestId: string;
  title: string;
  content: string;
  createdAt: number;
}

/** Intake is a view over clarify, not its own state. */
export function isIntake(request: Pick<Request, 'state' | 'clarifyStarted'>): boolean {
  return request.state === 'clarify' && !request.clarifyStarted;
}

export interface TranscriptMsg {
  role: 'you' | 'agent';
  kind: 'text' | 'tool';
  text: string;
  toolId?: string;
  toolName?: string;
  toolInput?: string;
  toolResult?: string;
  toolError?: boolean;
  ts: number;
}

export type ClarifyEvent =
  | { t: 'text'; text: string }
  | { t: 'tool'; id: string; name: string; input: string }
  | { t: 'tool_result'; id: string; text: string; isError: boolean }
  | { t: 'done'; request: Request | null; transcript: TranscriptMsg[] }
  | { t: 'error'; message: string };
