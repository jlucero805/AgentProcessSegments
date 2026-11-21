export type MasterAction =
  | 'cycle'
  | 'start'
  | 'prod'
  | 'review'
  | 'advance'
  | 'followup'
  | 'skip';

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
  started: number;
  prodded: number;
  reviewed: number;
  advanced: number;
  followUps: number;
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

/** The operator-editable master policy. Kept in sync with `masterSchema`. */
export interface MasterConfig {
  enabled: boolean;
  intervalMinutes: number;
  idleMinutes: number;
  autoReview: boolean;
  includeUnassigned: boolean;
  prompt: string;
}
