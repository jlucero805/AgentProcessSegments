export const STATES = ['clarify', 'dispatch', 'review', 'finalize', 'done', 'dropped'] as const;
export type State = (typeof STATES)[number];

export const TERMINAL_STATES: readonly State[] = ['done', 'dropped'];

export function isTerminal(state: State): boolean {
  return TERMINAL_STATES.includes(state);
}

export const TRANSITIONS: Record<State, readonly State[]> = {
  clarify: ['dispatch', 'dropped'],
  dispatch: ['review', 'clarify', 'dropped'],
  review: ['finalize', 'clarify', 'dispatch', 'dropped'],
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
  createdAt: number;
  updatedAt: number;
}

export interface Cell {
  id: string;
  name: string;
  masterEnabled: boolean;
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
