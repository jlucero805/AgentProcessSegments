/** Sentinel session for the knowledge-base chat; it has no request row. */
export const KB_SESSION_ID = '__kb__';

export type State = 'clarify' | 'dispatch' | 'review' | 'finalize' | 'done' | 'dropped';
export type AgentStatus = 'none' | 'idle' | 'working' | 'blocked' | 'error';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const STATES = ['clarify', 'dispatch', 'review', 'finalize', 'done', 'dropped'] as const;
export const TERMINAL_STATES: readonly State[] = ['done', 'dropped'];
export const EFFORT_LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

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

export type MasterAction = 'cycle' | 'prod' | 'review' | 'skip';

export interface MasterEvent {
  id: string;
  cellId: string | null;
  requestId: string | null;
  action: MasterAction;
  detail: string;
  createdAt: number;
}

export interface MasterResult {
  ranAt: number;
  cells: number;
  dispatch: number;
  prodded: number;
  reviewed: number;
  skipped: number;
}

export interface MasterStatus {
  enabled: boolean;
  intervalMinutes: number;
  running: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastResult: MasterResult | null;
}

export interface KbEntry {
  id: string;
  requestId: string;
  title: string;
  content: string;
  createdAt: number;
}

export interface ModelOption {
  id: string;
  label: string;
}

export interface ModelsResult {
  models: ModelOption[];
  source: 'probe' | 'fallback';
  effortLevels: readonly string[];
  /** Additive capability fields from the brain. */
  harness?: string;
  supportsEffort?: boolean;
}

export interface MasterConfig {
  enabled: boolean;
  intervalMinutes: number;
  idleMinutes: number;
  autoReview: boolean;
  includeUnassigned: boolean;
  prompt: string;
}

export interface AppConfig {
  master: MasterConfig;
}

export interface ConfigResponse extends AppConfig {
  path: string;
}

export interface PluginInfo {
  name: string;
  description: string;
  dir: string;
}

export interface CommandInfo {
  command: string;
  description: string;
  plugin: string;
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

export interface ClarifyState {
  started: boolean;
  transcript: TranscriptMsg[];
  /** True when a turn is live and can be reattached. */
  active?: boolean;
}

export type ClarifyEvent =
  | { t: 'text'; text: string }
  | { t: 'tool'; id: string; name: string; input: string }
  | { t: 'tool_result'; id: string; text: string; isError: boolean }
  | { t: 'done'; request: Request | null; transcript: TranscriptMsg[] }
  | { t: 'error'; message: string };

export type Column = 'intake' | 'clarify' | 'dispatch' | 'review' | 'finalize';
export const COLUMNS: readonly Column[] = ['intake', 'clarify', 'dispatch', 'review', 'finalize'];

export const COLUMN_LABELS: Record<Column, string> = {
  intake: 'Requests',
  clarify: 'Plan',
  dispatch: 'Implement',
  review: 'Review',
  finalize: 'Finalize',
};

/** Human labels for the workflow states themselves. */
export const STATE_LABELS: Record<State, string> = {
  clarify: 'Clarify',
  dispatch: 'Implement',
  review: 'Review',
  finalize: 'Finalize',
  done: 'Done',
  dropped: 'Dropped',
};

/** The state a column represents; null for intake, which is a view over clarify. */
export const COLUMN_STATE: Record<Column, State | null> = {
  intake: null,
  clarify: 'clarify',
  dispatch: 'dispatch',
  review: 'review',
  finalize: 'finalize',
};

export function columnOf(request: Pick<Request, 'state' | 'clarifyStarted'>): Column | null {
  if (request.state === 'clarify') return request.clarifyStarted ? 'clarify' : 'intake';
  if (request.state === 'dispatch') return 'dispatch';
  if (request.state === 'review') return 'review';
  if (request.state === 'finalize') return 'finalize';
  return null;
}

export const AGENT_BADGE: Record<AgentStatus, { label: string; className: string; dot: string }> = {
  none: { label: 'none', className: 'text-zinc-500', dot: 'bg-zinc-600' },
  idle: { label: 'idle', className: 'text-emerald-400', dot: 'bg-emerald-500' },
  working: { label: 'working', className: 'text-blue-400', dot: 'bg-blue-500 animate-pulse' },
  blocked: { label: 'blocked', className: 'text-amber-400', dot: 'bg-amber-500' },
  error: { label: 'error', className: 'text-red-400', dot: 'bg-red-500' },
};

export function timeAgo(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
