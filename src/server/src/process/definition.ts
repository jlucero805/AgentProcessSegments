import type { Cell, State } from '../domain/request.js';

/** Ordered pipeline segments. The ids are stable; labels are presentation. */
export const SEGMENT_IDS = [
  'intake',
  'plan',
  'implement',
  'review',
  'merge',
  'finalize',
] as const;
export type SegmentId = (typeof SEGMENT_IDS)[number];

/** The request state each segment operates on. Intake and Plan share clarify. */
export const SEGMENT_STATES: Record<SegmentId, State> = {
  intake: 'clarify',
  plan: 'clarify',
  implement: 'dispatch',
  review: 'review',
  merge: 'merge',
  finalize: 'finalize',
};

export interface FollowUpPolicy {
  enabled: boolean;
  /** A line starting with this marker becomes a new request. */
  marker: string;
}

export interface SegmentConfig {
  id: SegmentId;
  label: string;
  /** What this segment is for. Shown in the UI and used as context for operators. */
  purpose: string;
  enabled: boolean;
  /** Idle time before the master starts or prods a request in this segment. */
  idleMinutes: number;
  /** Upper bound of requests handled per cell per cycle. */
  maxPerCycle: number;
  /** Optional cap on requests working in this segment; null inherits the cell cap. */
  maxConcurrent: number | null;
  /** Agent prompt for this segment. Empty uses the built-in default. */
  prompt: string;
  /** Exact text that means this segment is done; null disables advancement. */
  readyMarker: string | null;
  /** Legal next state, or null to stay in this segment. */
  advanceTo: State | null;
  followUps: FollowUpPolicy;
}

export interface ProcessConfig {
  version: 1;
  /** Always contains every segment exactly once. */
  segments: SegmentConfig[];
}

/** A cell plus its own process policy; null means "use the global default". */
export interface CellDetail extends Cell {
  process: ProcessConfig | null;
}
