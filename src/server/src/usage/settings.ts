/**
 * Brain-level usage retention contract. Pure: the SPA imports this module
 * through `src/web/src/types.ts`, so it must not pull in Node-only imports.
 */
export const DEFAULT_USAGE_RETENTION_DAYS = 90;
export const MAX_USAGE_RETENTION_DAYS = 3650;

export interface UsageSettings {
  /** Raw usage rows older than this many days are pruned. 0 keeps them forever. */
  retentionDays: number;
}
