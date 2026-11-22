/**
 * The SPA reuses the pure contract modules from the server workspace so the
 * workflow table, request shape, and master/plugin shapes cannot drift. Those
 * modules must stay free of Node-only imports; `npm run build --workspace src/web`
 * bundles them into the SPA.
 */
export type {
  AgentStatus,
  Cell,
  ClarifyEvent,
  Effort,
  KbEntry,
  Request,
  State,
  TranscriptMsg,
} from '../../server/src/domain/request';
export {
  EFFORT_LEVELS,
  STATES,
  TERMINAL_STATES,
  canTransition,
  isIntake,
  isTerminal,
} from '../../server/src/domain/request';
export type {
  MasterAction,
  MasterConfig,
  MasterEvent,
  MasterResult,
  MasterStatus,
} from '../../server/src/master/types';
export type { CommandInfo, PluginInfo } from '../../server/src/plugins/types';
export type { SkillInfo } from '../../server/src/skills/types';
export type { TerminalSessionInfo } from '../../server/src/terminal/types';
export type { ModelOption } from '../../server/src/clarify/models';
export type {
  CellDetail,
  FollowUpPolicy,
  ProcessConfig,
  SegmentConfig,
  SegmentId,
} from '../../server/src/process/definition';
export { SEGMENT_IDS, SEGMENT_STATES } from '../../server/src/process/definition';
export {
  KB_SESSION_ID,
  MASTER_SESSION_ID,
  SETUP_SESSION_PREFIX,
  isMasterSession,
  isSetupSession,
  isVirtualSessionId,
  masterCellId,
  masterSessionId,
  setupSessionId,
} from '../../server/src/domain/sessions';

import type { AgentStatus, Effort, Request, State, TranscriptMsg } from '../../server/src/domain/request';
import type { MasterConfig } from '../../server/src/master/types';
import type { ModelOption } from '../../server/src/clarify/models';
import type { CellDetail, ProcessConfig } from '../../server/src/process/definition';

export interface ModelsResult {
  models: ModelOption[];
  source: 'probe' | 'fallback';
  effortLevels: readonly string[];
  /** Additive capability fields from the brain. */
  harness?: string;
  supportsEffort?: boolean;
}

export interface AppConfig {
  master: MasterConfig;
}

export interface ConfigResponse extends AppConfig {
  path: string;
}

export interface ProcessResponse extends ProcessConfig {
  path: string;
}

export interface CellDraft {
  id: string;
  name: string;
  masterIntervalMinutes: number | null;
  maxConcurrent: number;
  model: string | null;
  effort: Effort | null;
  process: ProcessConfig;
  updatedAt: number;
}

export interface TerminalStatus {
  available: boolean;
  cwd: string;
  sessions?: number;
}

export interface ClarifyState {
  started: boolean;
  transcript: TranscriptMsg[];
  /** True when a turn is live and can be reattached. */
  active?: boolean;
}

export type Column = 'intake' | 'clarify' | 'dispatch' | 'review' | 'merge' | 'finalize';
export const COLUMNS: readonly Column[] = [
  'intake',
  'clarify',
  'dispatch',
  'review',
  'merge',
  'finalize',
];

export const COLUMN_LABELS: Record<Column, string> = {
  intake: 'Requests',
  clarify: 'Plan',
  dispatch: 'Implement',
  review: 'Review',
  merge: 'Merge',
  finalize: 'Finalize',
};

/** Human labels for the workflow states themselves. */
export const STATE_LABELS: Record<State, string> = {
  clarify: 'Clarify',
  dispatch: 'Implement',
  review: 'Review',
  merge: 'Merge',
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
  merge: 'merge',
  finalize: 'finalize',
};

export function columnOf(request: Pick<Request, 'state' | 'clarifyStarted'>): Column | null {
  if (request.state === 'clarify') return request.clarifyStarted ? 'clarify' : 'intake';
  if (request.state === 'dispatch') return 'dispatch';
  if (request.state === 'review') return 'review';
  if (request.state === 'merge') return 'merge';
  if (request.state === 'finalize') return 'finalize';
  return null;
}

export const AGENT_BADGE: Record<AgentStatus, { label: string; className: string }> = {
  none: { label: 'none', className: 'text-zinc-500' },
  idle: { label: 'idle', className: 'text-emerald-400' },
  working: { label: 'working', className: 'text-blue-400' },
  blocked: { label: 'blocked', className: 'text-amber-400' },
  error: { label: 'error', className: 'text-red-400' },
};

export function timeAgo(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
