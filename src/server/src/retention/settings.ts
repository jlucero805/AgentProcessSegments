/**
 * Brain-level retention contract. Pure: the SPA imports this module through
 * `src/web/src/types.ts`, so it must not pull in Node-only imports.
 */
export const DEFAULT_MASTER_EVENTS_RETENTION_DAYS = 90;
export const MAX_MASTER_EVENTS_RETENTION_DAYS = 3650;
export const DEFAULT_CELL_SUMMARIES_RETENTION_DAYS = 90;
export const MAX_CELL_SUMMARIES_RETENTION_DAYS = 3650;
export const DEFAULT_REQUEST_ARTIFACTS_RETENTION_DAYS = 30;
export const MAX_REQUEST_ARTIFACTS_RETENTION_DAYS = 3650;
export const DEFAULT_BUDGET_ALERTS_RETENTION_DAYS = 400;
export const MAX_BUDGET_ALERTS_RETENTION_DAYS = 3650;

export interface RetentionSettings {
  /** Master activity older than this many days is pruned. 0 keeps it forever. */
  masterEventsDays: number;
  /** Scorecard history older than this many days is pruned. 0 keeps it forever. */
  cellSummariesDays: number;
  /** Terminal request dirs and leftover worktrees older than this are pruned. 0 keeps them. */
  requestArtifactsDays: number;
  /** Acknowledged alerts and terminal delivery rows older than this are pruned. 0 keeps them. */
  budgetAlertsDays: number;
}
