/**
 * Recovered-settings contract shared by the server and the SPA. Keep this
 * module free of Node-only imports so `src/web/src/types.ts` can re-export it
 * for Vite.
 */

/** A settings unit that was reset to its defaults while loading. */
export interface SettingsWarning {
  /**
   * Recovery unit such as `budget` or `notifications.email`; null when the
   * whole settings file was unusable.
   */
  block: string | null;
  /** Short, value-free reason (zod issue text or a fixed message). */
  message: string;
}
