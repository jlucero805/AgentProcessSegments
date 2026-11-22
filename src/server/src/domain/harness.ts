/** The agent substrates the brain can drive. Keep this module free of Node imports. */
export const HARNESS_IDS = ['claude', 'opencode'] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

export const HARNESS_LABELS: Record<HarnessId, string> = {
  claude: 'Claude Code',
  opencode: 'OpenCode',
};

export function isHarnessId(value: unknown): value is HarnessId {
  return typeof value === 'string' && (HARNESS_IDS as readonly string[]).includes(value);
}
