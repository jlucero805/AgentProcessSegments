/** Public source repository linked from the sidebar footer. */
export const REPO_URL = 'https://github.com/jlucero805/AgentProcessSegments';

/** One in-app Help target: a manifest slug and an optional rendered heading id. */
export interface HelpTarget {
  readonly slug: string;
  readonly anchor: string | null;
}

/** In-app Help target for the documentation landing page. */
export const GETTING_STARTED_HELP = {
  slug: 'getting-started',
  anchor: null,
} as const satisfies HelpTarget;

/** In-app Help target for the receiver-side webhook signature instructions. */
export const VERIFY_WEBHOOK_SIGNATURES_HELP = {
  slug: '08-user-workflows',
  anchor: 'verify-webhook-signatures',
} as const satisfies HelpTarget;

/** Every Help target the SPA declares; the docs gate validates each one. */
export const SPA_HELP_TARGETS = [
  VERIFY_WEBHOOK_SIGNATURES_HELP,
  GETTING_STARTED_HELP,
] as const satisfies readonly HelpTarget[];

/** Build an in-app Help URL for a declared target. */
export function helpHref(target: HelpTarget): string {
  const base = `?help=${encodeURIComponent(target.slug)}`;
  return target.anchor ? `${base}#${encodeURIComponent(target.anchor)}` : base;
}
