/** Public source repository linked from the sidebar footer. */
export const REPO_URL = 'https://github.com/jlucero805/AgentProcessSegments';

/** In-app Help target for the receiver-side webhook signature instructions. */
export const VERIFY_WEBHOOK_SIGNATURES_HELP = {
  slug: '08-user-workflows',
  anchor: 'verify-webhook-signatures',
} as const;

/** Build an in-app Help URL, optionally scoped to a rendered heading. */
export function helpHref(slug: string, anchor?: string | null): string {
  const base = `?help=${encodeURIComponent(slug)}`;
  return anchor ? `${base}#${encodeURIComponent(anchor)}` : base;
}
