import type { AgentStatus, State } from '../domain/request.js';

export const SUMMARY_DERIVED_NOTE =
  'Derived from request timestamps and master activity events; terminal timing may be approximate.';

/** The operator-editable scorecard policy. Kept in sync with `summarySchema`. */
export interface SummaryConfig {
  enabled: boolean;
  intervalMinutes: number;
  windowMinutes: number;
  prompt: string;
}

export interface StalledRequest {
  id: string;
  title: string;
  state: State;
  ageMinutes: number;
}

export interface SummaryActivity {
  cycles: number;
  started: number;
  prodded: number;
  reviewed: number;
  advanced: number;
  followUps: number;
  skipped: number;
  followUpTitles: string[];
  skipReasons: string[];
}

export interface SummaryPreviousActivity {
  cycles: number;
  started: number;
  prodded: number;
  reviewed: number;
  advanced: number;
  followUps: number;
  skipped: number;
}

/** The deterministic facts a scorecard is written from. */
export interface SummaryStats {
  windowStart: number;
  windowEnd: number;
  windowMinutes: number;
  cell: { id: string; name: string };
  requests: {
    total: number;
    byState: Record<State, number>;
    created: number;
    updated: number;
    completed: number;
    dropped: number;
    stalled: StalledRequest[];
    unchecked: number;
    agentStatus: Record<AgentStatus, number>;
  };
  activity: SummaryActivity;
  previous: {
    created: number;
    completed: number;
    dropped: number;
    activity: SummaryPreviousActivity;
  };
}

export interface Summary {
  id: string;
  cellId: string;
  windowStart: number;
  windowEnd: number;
  windowMinutes: number;
  content: string;
  stats: SummaryStats;
  createdAt: number;
}

/** The tie-safe cursor for the next page of the flat cross-cell feed. */
export interface SummaryFeedCursor {
  before: number;
  beforeId: string;
}

/** One page of the flat cross-cell scorecard feed. */
export interface SummaryFeedPage {
  reports: Summary[];
  hasMore: boolean;
  nextCursor: SummaryFeedCursor | null;
}

export interface SummaryStatus {
  enabled: boolean;
  intervalMinutes: number;
  windowMinutes: number;
  running: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastError: string | null;
}
