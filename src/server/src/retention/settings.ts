/**
 * Brain-level activity retention contract. Pure: the SPA imports this module
 * through `src/web/src/types.ts`, so it must not pull in Node-only imports.
 */
export const DEFAULT_MASTER_EVENTS_RETENTION_DAYS = 90;
export const MAX_MASTER_EVENTS_RETENTION_DAYS = 3650;

export interface RetentionSettings {
  /** Master activity older than this many days is pruned. 0 keeps it forever. */
  masterEventsDays: number;
}
