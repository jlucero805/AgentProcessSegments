import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export interface DocPage {
  slug: string;
  title: string;
  group: string;
  description?: string;
}

export interface DocContent extends DocPage {
  markdown: string;
  updatedAt: number;
}

interface ManifestEntry extends DocPage {
  /** Repo-relative source. The manifest is the only path authority. */
  source: string;
}

/**
 * The operator documentation exposed by the in-app Help surface.
 *
 * Keep this list explicit: a slug must resolve through it, and a user-supplied
 * string is never joined onto a filesystem path. Internal working notes
 * (AGENTS.md, 05-plan, 06-refactor-audit, 09-backlog) are intentionally absent.
 */
const MANIFEST: ManifestEntry[] = [
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
];

const ASSET_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

const SLUG = /^[a-z0-9-]+$/;

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Read-only access to the repo docs, with an explicit slug manifest. */
export class DocsService {
  constructor(private readonly docsDir: string) {}

  list(): DocPage[] {
    if (!existsSync(this.docsDir)) return [];
    return MANIFEST.filter((entry) => existsSync(this.file(entry))).map((entry) => ({
      slug: entry.slug,
      title: entry.title,
      group: entry.group,
      ...(entry.description ? { description: entry.description } : {}),
    }));
  }

  read(slug: string): DocContent | null {
    if (!existsSync(this.docsDir)) return null;
    if (!SLUG.test(slug)) return null;
    const entry = MANIFEST.find((page) => page.slug === slug);
    if (!entry) return null;
    const file = this.file(entry);
    if (!existsSync(file)) return null;
    try {
      return {
        slug: entry.slug,
        title: entry.title,
        group: entry.group,
        ...(entry.description ? { description: entry.description } : {}),
        markdown: readFileSync(file, 'utf8'),
        updatedAt: statSync(file).mtimeMs,
      };
    } catch {
      return null;
    }
  }

  /** Resolve a screenshots asset under docs/screenshots, rejecting traversal. */
  asset(relative: string): { file: string; type: string } | null {
    if (relative === '' || relative.includes('\0')) return null;
    if (!existsSync(this.docsDir)) return null;
    const root = path.join(this.docsDir, 'screenshots');
    if (!existsSync(root)) return null;
    const candidate = path.resolve(root, relative);
    if (!inside(root, candidate)) return null;
    let real: string;
    let realRoot: string;
    try {
      real = realpathSync(candidate);
      realRoot = realpathSync(root);
    } catch {
      return null;
    }
    if (!inside(realRoot, real)) return null;
    const type = ASSET_TYPES[path.extname(real).toLowerCase()];
    if (!type) return null;
    return { file: real, type };
  }

  private file(entry: ManifestEntry): string {
    const repoRoot = path.dirname(this.docsDir);
    return path.resolve(
      entry.source.startsWith('docs/')
        ? path.join(this.docsDir, entry.source.slice('docs/'.length))
        : path.join(repoRoot, entry.source),
    );
  }
}
