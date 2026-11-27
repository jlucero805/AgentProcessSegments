import { GETTING_STARTED_HELP } from './links';
import type { DocPage } from './types';

export interface DocHeading {
  id: string;
  text: string;
  level: 2 | 3;
}

export interface DocGroup {
  group: string;
  pages: DocPage[];
}

/** Preserve the manifest order while grouping pages for the nav rail. */
export function groupDocs(pages: DocPage[]): DocGroup[] {
  const groups: DocGroup[] = [];
  for (const page of pages) {
    const existing = groups.find((group) => group.group === page.group);
    if (existing) existing.pages.push(page);
    else groups.push({ group: page.group, pages: [page] });
  }
  return groups;
}

function isExternal(href: string): boolean {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(href) ||
    href.startsWith('//') ||
    href.startsWith('mailto:') ||
    href.startsWith('tel:')
  );
}

/**
 * Map an `href` from a Markdown file to an in-app Help slug.
 *
 * A slug is never joined onto a path: unknown Markdown links simply point at a
 * slug the server will reject, which renders the page-not-found state. README
 * and deploy docs have explicit slug aliases.
 */
export function slugForDocPath(href: string): string | null {
  const pathPart = href.split('#')[0]?.split('?')[0] ?? '';
  if (!/\.md$/i.test(pathPart)) return null;
  const segments = pathPart.replace(/\\/g, '/').split('/');
  const base = (segments.at(-1) ?? '').replace(/\.md$/i, '').toLowerCase();
  if (!base) return null;
  if (base === 'readme') return GETTING_STARTED_HELP.slug;
  if (segments.includes('deploy')) return `deploy-${base}`;
  return base;
}

/** Resolve a Markdown link: local docs become Help deep links, external ones stay. */
export function resolveDocHref(href: string): string {
  const value = href.trim();
  if (value === '' || value.startsWith('#') || value.startsWith('?help=')) return value;
  if (value.startsWith('/api/docs/assets/')) return value;
  if (isExternal(value)) return value;

  const hashIndex = value.indexOf('#');
  const hash = hashIndex >= 0 ? value.slice(hashIndex) : '';
  const withoutHash = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const slug = slugForDocPath(withoutHash);
  if (slug) return `?help=${encodeURIComponent(slug)}${hash}`;

  return resolveDocImage(value);
}

/** Map screenshots referenced from Markdown onto the same-origin asset route. */
export function resolveDocImage(src: string): string {
  const value = src.trim();
  if (value === '' || value.startsWith('/') || isExternal(value)) return value;
  const clean = value.split('#')[0]?.split('?')[0] ?? '';
  const marker = 'screenshots/';
  const index = clean.lastIndexOf(marker);
  if (index < 0) return value;
  const rest = clean.slice(index + marker.length);
  const parts = rest.split('/');
  if (rest === '' || parts.some((part) => part === '' || part === '.' || part === '..')) {
    return value;
  }
  return `/api/docs/assets/${parts.map(encodeURIComponent).join('/')}`;
}

/** Read the slug out of a `?help=<slug>` link, if it is one. */
export function helpSlugFromHref(href: string): string | null {
  if (!href.startsWith('?help=')) return null;
  const query = href.slice(1).split('#')[0] ?? '';
  const params = new URLSearchParams(query);
  return params.get('help');
}

function headingText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

export function slugifyHeading(text: string): string {
  const cleaned = headingText(text).toLowerCase();
  const slug = cleaned
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  return slug || 'section';
}

/**
 * Extract the h2/h3 headings for the sticky "On this page" rail. Fenced code
 * blocks are skipped so a shell comment cannot become a table of contents item.
 */
export function extractHeadings(markdown: string): DocHeading[] {
  const headings: DocHeading[] = [];
  const seen = new Map<string, number>();
  let fenced = false;

  for (const line of markdown.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const match = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match || !match[1] || !match[2]) continue;
    const text = headingText(match[2]);
    if (!text) continue;
    const base = slugifyHeading(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    headings.push({
      id: count === 0 ? base : `${base}-${count + 1}`,
      text,
      level: match[1].length === 2 ? 2 : 3,
    });
  }
  return headings;
}

/** Strip Markdown/HTML emphasis from rendered heading children. */
export function textFromChildren(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textFromChildren).join('');
  if (value !== null && typeof value === 'object' && 'props' in value) {
    const props = (value as { props?: { children?: unknown } }).props;
    return textFromChildren(props?.children);
  }
  return '';
}
