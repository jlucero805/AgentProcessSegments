/** The swappable agent substrates. Keep this module free of Node-only imports. */
export const HARNESS_IDS = ['claude', 'opencode'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export const HARNESS_LABELS: Record<HarnessId, string> = {
  claude: 'Claude Code',
  opencode: 'OpenCode',
};

export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === 'string' && (HARNESS_IDS as readonly string[]).includes(value);
}

/** Which layer supplied the effective harness. */
export type HarnessSource = 'request' | 'cell' | 'process';

export interface HarnessChoice {
  harness: HarnessId;
  source: HarnessSource;
}

/**
 * The single resolution order for every session. A request override wins, then
 * its cell, then the brain's process default.
 */
export function resolveHarness(input: {
  request?: HarnessId | null | undefined;
  cell?: HarnessId | null | undefined;
  process: HarnessId;
}): HarnessChoice {
  if (input.request) return { harness: input.request, source: 'request' };
  if (input.cell) return { harness: input.cell, source: 'cell' };
  return { harness: input.process, source: 'process' };
}
