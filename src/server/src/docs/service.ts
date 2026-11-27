import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { SCREENSHOT_TYPES } from './assets.js';
import { HELP_MANIFEST } from './manifest.js';
import type { DocManifestEntry, DocPage } from './manifest.js';

export type { DocPage } from './manifest.js';

export interface DocContent extends DocPage {
  markdown: string;
  updatedAt: number;
}

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
    return HELP_MANIFEST.filter((entry) => existsSync(this.file(entry))).map((entry) => ({
      slug: entry.slug,
      title: entry.title,
      group: entry.group,
      ...(entry.description ? { description: entry.description } : {}),
    }));
  }

  read(slug: string): DocContent | null {
    if (!existsSync(this.docsDir)) return null;
    if (!SLUG.test(slug)) return null;
    const entry = HELP_MANIFEST.find((page) => page.slug === slug);
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
    const type = SCREENSHOT_TYPES[path.extname(real).toLowerCase()];
    if (!type) return null;
    return { file: real, type };
  }

  private file(entry: DocManifestEntry): string {
    const repoRoot = path.dirname(this.docsDir);
    return path.resolve(
      entry.source.startsWith('docs/')
        ? path.join(this.docsDir, entry.source.slice('docs/'.length))
        : path.join(repoRoot, entry.source),
    );
  }
}
