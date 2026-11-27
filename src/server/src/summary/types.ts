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

export interface SummaryStatus {
  enabled: boolean;
  intervalMinutes: number;
  windowMinutes: number;
  running: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastError: string | null;
}

/** The cell identity carried by the all-cells latest-scorecard feed. */
export interface SummaryCellRef {
  id: string;
  name: string;
}

/** One cell's newest in-range report for the all-cells feed. */
export interface LatestSummaryGroup {
  cell: SummaryCellRef;
  summary: Summary;
  /** Another in-range report exists below `summary`. */
  hasOlder: boolean;
}

export interface LatestSummaryOptions {
  /** Inclusive lower bound on `created_at` (epoch ms). */
  since?: number | undefined;
  /** Inclusive upper bound on `created_at` (epoch ms). */
  until?: number | undefined;
}
