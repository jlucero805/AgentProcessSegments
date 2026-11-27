/**
 * The operator documentation exposed by the in-app Help surface.
 *
 * Keep this list explicit: a slug must resolve through it, and a user-supplied
 * string is never joined onto a filesystem path. Internal working notes
 * (AGENTS.md, 05-plan, 06-refactor-audit, 09-backlog) are intentionally absent.
 *
 * This module is the only manifest authority. The server reads it through
 * `DocsService`; the documentation link gate imports it so a served page cannot
 * link a file Help refuses to render. Keep it free of Node-only imports: the web
 * workspace type-checks this module through `src/web/src/doc-links.test.ts`.
 */
export interface DocPage {
  slug: string;
  title: string;
  group: string;
  description?: string;
}

export interface DocManifestEntry extends DocPage {
  /** Repo-relative source. The manifest is the only path authority. */
  source: string;
}

export const HELP_MANIFEST: readonly DocManifestEntry[] = Object.freeze([
  {
    slug: 'getting-started',
    title: 'Getting started',
    group: 'Getting started',
    description: 'Install, run, and understand the single-origin brain.',
    source: 'README.md',
  },
  {
    slug: '07-process-segments',
    title: 'Process segments',
    group: 'Guides',
    description: 'Configure cells, prompts, markers, concurrency, and merge buckets.',
    source: 'docs/07-process-segments.md',
  },
  {
    slug: '08-user-workflows',
    title: 'User workflows',
    group: 'Guides',
    description: 'Create cells, stage work, watch the master, and finish requests.',
    source: 'docs/08-user-workflows.md',
  },
  {
    slug: '11-skills',
    title: 'Chat skills',
    group: 'Guides',
    description: 'Discover and invoke skills from the slash menu.',
    source: 'docs/11-skills.md',
  },
  {
    slug: '13-cell-wizard',
    title: 'Cell wizard',
    group: 'Guides',
    description: 'Build a cell flow conversationally with the setup chat.',
    source: 'docs/13-cell-wizard.md',
  },
  {
    slug: 'deploy-vps',
    title: 'VPS deployment',
    group: 'Operations',
    description: 'VPS install, systemd user unit, Tailscale Serve, settings, and operations.',
    source: 'deploy/vps.md',
  },
  {
    slug: '10-error-log',
    title: 'Error log',
    group: 'Operations',
    description: 'Where errors are persisted and how to read them.',
    source: 'docs/10-error-log.md',
  },
  {
    slug: '12-terminals',
    title: 'Terminal sessions',
    group: 'Operations',
    description: 'Server-owned PTYs, detach/reattach, and explicit close.',
    source: 'docs/12-terminals.md',
  },
  {
    slug: '01-system-spec',
    title: 'System spec',
    group: 'Reference',
    description: 'The governing data model, contracts, and invariants.',
    source: 'docs/01-system-spec.md',
  },
  {
    slug: '02-status',
    title: 'Status',
    group: 'Reference',
    description: 'Built versus not built, routes, and verification.',
    source: 'docs/02-status.md',
  },
  {
    slug: '03-decisions',
    title: 'Decisions',
    group: 'Reference',
    description: 'Why the rebuild chose its architecture and migrations.',
    source: 'docs/03-decisions.md',
  },
  {
    slug: '04-design-liberties',
    title: 'Design liberties',
    group: 'Reference',
    description: 'Autonomous choices, alternatives, and review notes.',
    source: 'docs/04-design-liberties.md',
  },
  {
    slug: '14-webhook-payloads',
    title: 'Webhook payloads',
    group: 'Reference',
    description: 'Receiver-facing JSON bodies for budget alerts and event notifications.',
    source: 'docs/14-webhook-payloads.md',
  },
]);
