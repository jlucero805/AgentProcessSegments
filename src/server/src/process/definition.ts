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

/**
 * Segments the master may schedule. Finalize is a human gate: a person runs the
 * digest turn and indexes, so the master never prods a request in that state.
 */
const MANUAL_ONLY_SEGMENTS: ReadonlySet<SegmentId> = new Set(['finalize']);

export function isSchedulableSegment(id: SegmentId): boolean {
  return !MANUAL_ONLY_SEGMENTS.has(id);
}

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

/**
 * Short, model-facing contract for the setup assistant. The validator allows
 * more state-machine edges than these; this is the safe happy path and the
 * special cases that repeatedly caused guessed transitions.
 */
export const SEGMENT_FLOW_GUIDE = [
  'intake: leave advanceTo null; enabling it starts clarification and moves the request to Plan. To apply an intake prompt, set intake.enabled true; the prompt is included in the first clarification turn.',
  'plan: advanceTo "dispatch".',
  'implement: advanceTo "review".',
  'review: advanceTo "merge", "finalize", or "dispatch".',
  'merge: advanceTo "finalize".',
  'finalize: leave advanceTo null; the master never schedules it, and a human runs the digest turn and indexes the result.',
  'Enabling a segment is separate from setting advanceTo: enable every step the master should run (never finalize).',
  'Any non-null advanceTo requires a non-empty readyMarker. Keep every segment exactly once and preserve fields you are not changing.',
].join('\n');

/** A cell plus its own process policy; null means "use the global default". */
export interface CellDetail extends Cell {
  process: ProcessConfig | null;
}
