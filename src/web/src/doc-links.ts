import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { SCREENSHOT_TYPES } from '../../server/src/docs/assets';
import {
  extractHeadings,
  helpSlugFromHref,
  resolveDocHref,
  resolveDocImage,
  slugForDocPath,
} from './docs';

export interface DocLink {
  /** 1-based line in the file that contains the link. */
  line: number;
  /** Raw destination text between the parentheses (or after a reference label). */
  target: string;
  kind: 'link' | 'image' | 'html' | 'reference';
  /** Raw HTML tag for `kind: 'html'`, so image rules can separate `<img>` from `<a>`. */
  tag?: 'a' | 'img';
}

export interface DocLinkProblem {
  /** Repo-relative path with forward slashes. */
  file: string;
  line: number;
  target: string;
  reason: string;
}

export interface CollectedDocLink {
  file: string;
  link: DocLink;
}

const INLINE_LINK =
  /(!?)\[([^\]\n]*)\]\(\s*(<[^<>\n]*>|[^\s()\n]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^()\n]*\)))?\s*\)/g;
const REFERENCE_DEFINITION = /^ {0,3}\[([^\]\n]+)\]:\s*(<[^<>\n]*>|\S+)/gm;
const REFERENCE_USAGE = /(!?)\[([^\]\n]+)\]\[([^\]\n]*)\]/g;
const HTML_LINK = /<(a|img)\b[^>]*?\b(href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Blank out fenced code blocks and inline code spans while keeping every
 * character position (including newlines). Extraction then runs over the whole
 * document, so a link split across lines still gets the right line number and
 * an example inside a fence is never mistaken for a real link.
 */
function maskCode(markdown: string): string {
  const chars = markdown.split('');
  let open: { char: string; length: number } | null = null;
  let start = 0;

  while (start <= markdown.length) {
    const newline = markdown.indexOf('\n', start);
    const end = newline === -1 ? markdown.length : newline;
    const line = markdown.slice(start, end);
    const fence = FENCE.exec(line);

    if (open !== null || fence) {
      for (let index = start; index < end; index += 1) chars[index] = ' ';
    }
    if (open !== null) {
      if (
        fence &&
        fence[1]![0] === open.char &&
        fence[1]!.length >= open.length &&
        fence[2]!.trim() === ''
      ) {
        open = null;
      }
    } else if (fence) {
      open = { char: fence[1]![0]!, length: fence[1]!.length };
    }

    if (newline === -1) break;
    start = newline + 1;
  }

  return chars.join('').replace(/(`+)[\s\S]*?\1/g, (span) => span.replace(/[^\n]/g, ' '));
}

function lineAt(markdown: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (markdown.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function stripAngles(target: string): string {
  return target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target;
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Actual link/image destinations, plus reference definitions. Usages resolve through their definition. */
export function extractDocLinks(markdown: string): DocLink[] {
  const masked = maskCode(markdown);
  const links: DocLink[] = [];

  for (const match of masked.matchAll(INLINE_LINK)) {
    links.push({
      line: lineAt(markdown, match.index ?? 0),
      target: stripAngles(match[3]!),
      kind: match[1] === '!' ? 'image' : 'link',
    });
  }

  for (const match of masked.matchAll(REFERENCE_DEFINITION)) {
    links.push({
      line: lineAt(markdown, match.index ?? 0),
      target: stripAngles(match[2]!),
      kind: 'reference',
    });
  }

  for (const match of masked.matchAll(HTML_LINK)) {
    const tag = match[1]!.toLowerCase();
    const attribute = match[2]!.toLowerCase();
    if (tag === 'a' ? attribute !== 'href' : attribute !== 'src') continue;
    links.push({
      line: lineAt(markdown, match.index ?? 0),
      target: match[3] ?? match[4] ?? '',
      kind: 'html',
      tag: tag === 'a' ? 'a' : 'img',
    });
  }

  return links.sort((left, right) => left.line - right.line);
}

/** Reference-style usages whose label has no `[label]: destination` definition. */
export function undefinedReferenceLabels(markdown: string): Array<{ line: number; label: string }> {
  const masked = maskCode(markdown);
  const defined = new Set<string>();
  for (const match of masked.matchAll(REFERENCE_DEFINITION)) {
    defined.add(normalizeLabel(match[1]!));
  }

  const missing: Array<{ line: number; label: string }> = [];
  for (const match of masked.matchAll(REFERENCE_USAGE)) {
    const label = normalizeLabel(match[3] === '' ? match[2]! : match[3]!);
    // CommonMark renders an undefined reference as literal text, so this is a
    // deliberate heuristic: a `[text][label]` pair is treated as a broken link
    // and must get a definition. Fenced blocks and inline code never get here.
    if (!defined.has(label)) missing.push({ line: lineAt(markdown, match.index ?? 0), label });
  }
  return missing;
}

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'dist']);

function walkMarkdown(directory: string, root: string, files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) walkMarkdown(absolute, root, files);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  }
}

/** Repo-relative paths of every Markdown file the docs gate owns, sorted. */
export function markdownFiles(root: string): string[] {
  const absoluteRoot = path.resolve(root);
  const files: string[] = [];
  walkMarkdown(absoluteRoot, absoluteRoot, files);
  return files.sort();
}

/** Every link in the corpus, tagged with its repo-relative file. */
export function collectDocLinks(root: string): CollectedDocLink[] {
  const absoluteRoot = path.resolve(root);
  const links: CollectedDocLink[] = [];
  for (const file of markdownFiles(absoluteRoot)) {
    const markdown = readFileSync(path.join(absoluteRoot, file), 'utf8');
    for (const link of extractDocLinks(markdown)) links.push({ file, link });
  }
  return links;
}

interface LinkContext {
  root: string;
  file: string;
  absoluteFile: string;
  link: DocLink;
  headingIds: (absoluteFile: string) => string[];
}

interface ResolvedLinkTarget {
  /** Repo-relative path with forward slashes. */
  relative: string;
  absolute: string;
  fragment: string | null;
}

type LinkResolution = { target: ResolvedLinkTarget } | { error: string } | null;

/**
 * Resolve a raw Markdown destination to a repo path and fragment.
 *
 * `null` means the destination is not a repo link (external, protocol-relative,
 * or the app's bare `?query` form). Errors are the reasons `checkDocLinks`
 * reports, so a caller can skip targets another check already owns.
 */
function resolveLinkTarget(root: string, absoluteFile: string, raw: string): LinkResolution {
  if (raw === '') return { error: 'empty link target' };
  // External schemes and protocol-relative URLs are never fetched; a bare
  // `?query` is the app's own deep-link form and names no file.
  if (EXTERNAL.test(raw) || raw.startsWith('//') || raw.startsWith('?')) return null;

  const hash = raw.indexOf('#');
  const fragment = hash >= 0 ? raw.slice(hash + 1) : null;
  const withoutFragment = hash >= 0 ? raw.slice(0, hash) : raw;
  const query = withoutFragment.indexOf('?');
  const pathPart = query >= 0 ? withoutFragment.slice(0, query) : withoutFragment;

  let decodedPath: string;
  let decodedFragment: string | null = null;
  try {
    decodedPath = decodeURIComponent(pathPart);
    if (fragment !== null) decodedFragment = decodeURIComponent(fragment);
  } catch {
    return { error: 'unreadable link' };
  }

  if (decodedPath === '' && decodedFragment === null) return { error: 'empty link target' };

  const resolved =
    decodedPath === ''
      ? absoluteFile
      : path.resolve(
          decodedPath.startsWith('/') ? root : path.dirname(absoluteFile),
          decodedPath.startsWith('/') ? `.${decodedPath}` : decodedPath,
        );

  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return { error: 'path escapes the repository' };
  }
  return {
    target: {
      relative: relative.split(path.sep).join('/'),
      absolute: resolved,
      fragment: decodedFragment,
    },
  };
}

function checkLink({ root, file, absoluteFile, link, headingIds }: LinkContext): DocLinkProblem | null {
  const raw = link.target.trim();
  const problem = (reason: string): DocLinkProblem => ({ file, line: link.line, target: raw, reason });

  const resolution = resolveLinkTarget(root, absoluteFile, raw);
  if (resolution === null) return null;
  if ('error' in resolution) return problem(resolution.error);

  const target = resolution.target.absolute;
  if (!existsSync(target)) return problem('missing file');
  if (resolution.target.fragment === null) return null;

  let isFile = false;
  try {
    isFile = statSync(target).isFile();
  } catch {
    return problem('unreadable file');
  }
  if (!isFile || !/\.(md|markdown)$/i.test(target)) {
    return problem('fragment target is not Markdown');
  }

  let ids: string[];
  try {
    ids = headingIds(target);
  } catch {
    return problem('unreadable file');
  }
  if (!ids.includes(resolution.target.fragment)) {
    return problem(`no heading with id "${resolution.target.fragment}"`);
  }
  return null;
}

/**
 * Validate every local Markdown link, image, and `#fragment` in the corpus.
 *
 * Anchors use the in-app Help ids (`extractHeadings`), not GitHub's slugger,
 * because Help renders these pages and assigns ids only to h2/h3. External
 * URLs are skipped: the gate is deterministic and never touches the network.
 */
export function checkDocLinks(root: string): DocLinkProblem[] {
  const absoluteRoot = path.resolve(root);
  const headingCache = new Map<string, string[]>();
  const headingIds = (absoluteFile: string): string[] => {
    const cached = headingCache.get(absoluteFile);
    if (cached) return cached;
    const ids = extractHeadings(readFileSync(absoluteFile, 'utf8')).map((heading) => heading.id);
    headingCache.set(absoluteFile, ids);
    return ids;
  };

  const problems: DocLinkProblem[] = [];
  for (const file of markdownFiles(absoluteRoot)) {
    const absoluteFile = path.join(absoluteRoot, file);
    const markdown = readFileSync(absoluteFile, 'utf8');
    for (const link of extractDocLinks(markdown)) {
      const problem = checkLink({ root: absoluteRoot, file, absoluteFile, link, headingIds });
      if (problem) problems.push(problem);
    }
    for (const missing of undefinedReferenceLabels(markdown)) {
      problems.push({
        file,
        line: missing.line,
        target: `[${missing.label}]`,
        reason: 'no matching reference definition',
      });
    }
  }
  return problems.sort(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
  );
}

/** The only manifest authority; manifest problems have no line in that file. */
const MANIFEST_FILE = 'src/server/src/docs/manifest.ts';
const HELP_SLUG = /^[a-z0-9-]+$/;
const SCREENSHOT_ROOT = 'docs/screenshots/';
const ASSET_PREFIX = '/api/docs/assets/';

/** The asset URL Help builds for a repo-relative screenshot path. */
function screenshotAssetUrl(relative: string): string {
  return `${ASSET_PREFIX}${relative
    .slice(SCREENSHOT_ROOT.length)
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`;
}

/** The manifest fields the Help link gate needs. */
export interface HelpManifestEntry {
  slug: string;
  source: string;
}

function normalizeManifestSource(source: string): string | null {
  const normalized = source.replace(/\\/g, '/');
  if (normalized === '' || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    return null;
  }
  return normalized;
}

/** Validate the manifest itself: slugs, sources, and the SPA's link routing. */
export function manifestProblems(
  root: string,
  manifest: readonly HelpManifestEntry[],
): DocLinkProblem[] {
  const absoluteRoot = path.resolve(root);
  const problems: DocLinkProblem[] = [];
  const report = (target: string, reason: string): void => {
    problems.push({ file: MANIFEST_FILE, line: 0, target, reason });
  };
  const slugs = new Set<string>();
  const sources = new Set<string>();

  for (const entry of manifest) {
    if (!HELP_SLUG.test(entry.slug)) {
      report(entry.slug, 'slug is not lowercase letters, digits, or hyphens');
    }
    if (slugs.has(entry.slug)) report(entry.slug, 'duplicate Help slug');
    else slugs.add(entry.slug);

    const source = normalizeManifestSource(entry.source);
    if (source === null) {
      report(entry.source, 'source is not a repo-relative path');
      continue;
    }
    if (sources.has(source)) report(entry.source, 'duplicate manifest source');
    else sources.add(source);

    if (!/\.(md|markdown)$/i.test(source)) report(entry.source, 'source is not a Markdown file');
    let exists = false;
    let isFile = false;
    try {
      const stat = statSync(path.join(absoluteRoot, source));
      exists = true;
      isFile = stat.isFile();
    } catch {
      // Reported below; the runtime filters missing sources out of the list.
    }
    if (!exists) report(entry.source, 'missing source file');
    else if (!isFile) report(entry.source, 'source is not a file');

    const mapped = slugForDocPath(source);
    if (mapped !== entry.slug) {
      report(
        entry.slug,
        `source "${source}" maps to slug "${mapped ?? '(none)'}", not "${entry.slug}"`,
      );
    }
  }
  return problems;
}

/** Parse a `?help=<slug>#<fragment>` target, keeping the raw fragment on a bad escape. */
function helpTarget(raw: string): { slug: string; fragment: string | null } | null {
  const slug = helpSlugFromHref(raw);
  if (slug === null) return null;
  const hash = raw.indexOf('#');
  if (hash < 0) return { slug, fragment: null };
  const fragment = raw.slice(hash + 1);
  try {
    return { slug, fragment: decodeURIComponent(fragment) };
  } catch {
    return { slug, fragment };
  }
}

/**
 * Validate links on Help-served pages against the manifest.
 *
 * Only manifest sources are constrained: internal-only docs never render in
 * Help, so they may link anywhere in the repo. A served page may only point at
 * a manifest page (or a `?help=` slug that resolves to one), because Help
 * rewrites every local `*.md` link to `?help=<basename>` and the server 404s
 * anything the manifest does not list. Images and other local files must be
 * served screenshots under `docs/screenshots/`; Help returns every other local
 * non-Markdown path unchanged, which renders as a 404 or SPA fallback.
 */
export function checkHelpLinks(
  root: string,
  manifest: readonly HelpManifestEntry[],
): DocLinkProblem[] {
  const absoluteRoot = path.resolve(root);
  const problems = manifestProblems(absoluteRoot, manifest);

  const entries = new Map<string, HelpManifestEntry>();
  const served = new Set<string>();
  for (const entry of manifest) {
    const source = normalizeManifestSource(entry.source);
    if (source === null) continue;
    served.add(source);
    if (!entries.has(entry.slug)) entries.set(entry.slug, { slug: entry.slug, source });
  }

  const headingCache = new Map<string, string[] | null>();
  const headingIds = (source: string): string[] | null => {
    const cached = headingCache.get(source);
    if (cached !== undefined) return cached;
    let ids: string[] | null = null;
    try {
      ids = extractHeadings(readFileSync(path.join(absoluteRoot, source), 'utf8')).map(
        (heading) => heading.id,
      );
    } catch {
      // A missing source is a manifest problem; do not add anchor noise.
    }
    headingCache.set(source, ids);
    return ids;
  };

  for (const file of markdownFiles(absoluteRoot)) {
    if (!served.has(file)) continue;
    const absoluteFile = path.join(absoluteRoot, file);
    let markdown: string;
    try {
      markdown = readFileSync(absoluteFile, 'utf8');
    } catch {
      continue;
    }
    for (const link of extractDocLinks(markdown)) {
      const raw = link.target.trim();
      if (raw === '') continue; // checkDocLinks owns the empty target.
      const problem = (reason: string): DocLinkProblem => ({
        file,
        line: link.line,
        target: raw,
        reason,
      });
      const isImage = link.kind === 'image' || link.tag === 'img';

      if (!isImage) {
        const help = helpTarget(raw);
        if (help !== null) {
          const entry = entries.get(help.slug);
          if (!entry) {
            problems.push(problem(`Help has no page for slug "${help.slug}"`));
            continue;
          }
          if (help.fragment !== null) {
            const ids = headingIds(entry.source);
            if (ids !== null && !ids.includes(help.fragment)) {
              problems.push(
                problem(`no heading with id "${help.fragment}" in Help page "${help.slug}"`),
              );
            }
          }
          continue;
        }
      }

      if (EXTERNAL.test(raw) || raw.startsWith('//')) continue;
      if (raw.startsWith('?')) {
        // Other bare queries are SPA-authored deep links, but an <img> cannot
        // render one: Help only rewrites a screenshot path to the asset route.
        if (isImage) problems.push(problem(`Help does not serve the image target "${raw}"`));
        continue;
      }
      if (raw.startsWith('#')) continue; // checkDocLinks owns fragments.

      const resolution = resolveLinkTarget(absoluteRoot, absoluteFile, raw);
      if (resolution === null || 'error' in resolution) continue;

      const relative = resolution.target.relative;
      const markdownLink = !isImage && /\.md$/i.test(relative);
      if (resolution.target.fragment !== null && !markdownLink) continue;

      // Missing and escaping targets are checkDocLinks' findings.
      if (!existsSync(resolution.target.absolute)) continue;

      if (markdownLink) {
        const slug = helpSlugFromHref(resolveDocHref(raw));
        if (slug === null) continue;

        const entry = entries.get(slug);
        if (!entry) {
          problems.push(problem(`Help has no page for "${relative}" (slug "${slug}")`));
        } else if (entry.source !== relative) {
          problems.push(
            problem(`Help slug "${slug}" serves "${entry.source}", not "${relative}"`),
          );
        }
        // Fragments on direct Markdown links are checkDocLinks' job: it already
        // matches them against the same extractHeadings ids.
        continue;
      }

      if (!relative.startsWith(SCREENSHOT_ROOT)) {
        problems.push(
          problem(
            `Help does not serve local file "${relative}"; use an absolute URL or inline code`,
          ),
        );
        continue;
      }

      const expected = screenshotAssetUrl(relative);
      const mapped = resolveDocImage(raw);
      if (mapped !== expected) {
        problems.push(problem(`Help maps this target to "${mapped}", not "${expected}"`));
        continue;
      }

      let isFile = false;
      try {
        isFile = statSync(resolution.target.absolute).isFile();
      } catch {
        // Reported as not a file below; checkDocLinks owns unreadable targets.
      }
      if (!isFile) {
        problems.push(problem(`Help asset "${relative}" is not a file`));
        continue;
      }

      const extension = path.extname(relative).toLowerCase();
      if (!Object.hasOwn(SCREENSHOT_TYPES, extension)) {
        problems.push(problem(`Help does not serve "${extension}" screenshot files`));
      }
    }
  }

  return problems.sort(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
  );
}

/** The SPA's own Help target: a manifest slug and an optional rendered heading id. */
export interface SpaHelpTarget {
  slug: string;
  anchor?: string | null;
}

/** The SPA file that declares every in-app Help target. */
const SPA_LINKS_FILE = 'src/web/src/links.ts';
const SPA_SOURCE_ROOT = 'src/web/src';
const SPA_SOURCE = /\.tsx?$/;
const TEST_SOURCE = /\.test\.tsx?$/;
/** A literal slug in a `?help=` URL; templates (`?help=${...}`) never match. */
const LITERAL_HELP_URL = /\?help=([a-z0-9][a-z0-9-]*)/g;

function walkSources(directory: string, root: string, files: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) walkSources(absolute, root, files);
    } else if (entry.isFile() && SPA_SOURCE.test(entry.name)) {
      files.push(path.relative(root, absolute).split(path.sep).join('/'));
    }
  }
}

/** Repo-relative SPA source files, sorted. */
function spaSourceFiles(root: string): string[] {
  const directory = path.join(root, SPA_SOURCE_ROOT);
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  walkSources(directory, root, files);
  return files.sort();
}

/**
 * Validate the SPA's own Help targets and keep them centralized.
 *
 * `src/web/src/links.ts` declares every target; components import those
 * constants instead of spelling a slug. The scan is a text guard, not a parser:
 * it catches a quoted manifest slug or a literal `?help=<slug>` URL anywhere in
 * the SPA's non-test source (comments included) but not a slug assembled at
 * runtime.
 */
export function checkSpaHelpLinks(
  root: string,
  manifest: readonly HelpManifestEntry[],
  targets: readonly SpaHelpTarget[],
): DocLinkProblem[] {
  const absoluteRoot = path.resolve(root);
  const problems: DocLinkProblem[] = [];

  const entries = new Map<string, string>();
  for (const entry of manifest) {
    const source = normalizeManifestSource(entry.source);
    if (source === null) continue;
    if (!entries.has(entry.slug)) entries.set(entry.slug, source);
  }

  const headingCache = new Map<string, string[] | null>();
  const headingIds = (source: string): string[] | null => {
    const cached = headingCache.get(source);
    if (cached !== undefined) return cached;
    let ids: string[] | null = null;
    try {
      ids = extractHeadings(readFileSync(path.join(absoluteRoot, source), 'utf8')).map(
        (heading) => heading.id,
      );
    } catch {
      // A missing source is a manifest problem; do not add anchor noise.
    }
    headingCache.set(source, ids);
    return ids;
  };

  const reportTarget = (target: string, reason: string): void => {
    problems.push({ file: SPA_LINKS_FILE, line: 0, target, reason });
  };

  for (const target of targets) {
    const source = entries.get(target.slug);
    if (source === undefined) {
      reportTarget(target.slug, `Help has no page for slug "${target.slug}" (SPA Help target)`);
      continue;
    }
    const anchor = target.anchor ?? null;
    if (anchor === null) continue;
    const ids = headingIds(source);
    if (ids !== null && !ids.includes(anchor)) {
      reportTarget(
        `${target.slug}#${anchor}`,
        `no heading with id "${anchor}" in Help page "${target.slug}" (SPA Help target)`,
      );
    }
  }

  // A quoted manifest slug is a second copy of a target, in any of the three
  // quote styles. Slugs are `[a-z0-9-]`, so they need no regex escaping.
  const slugs = [...new Set(manifest.map((entry) => entry.slug))].filter((slug) =>
    HELP_SLUG.test(slug),
  );
  const quotedSlug =
    slugs.length === 0 ? null : new RegExp(`(['"\`])(${slugs.join('|')})\\1`, 'g');

  for (const file of spaSourceFiles(absoluteRoot)) {
    if (file === SPA_LINKS_FILE || TEST_SOURCE.test(file)) continue;
    if (file.split('/').includes('test')) continue;
    const lines = readFileSync(path.join(absoluteRoot, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      const lineNumber = index + 1;
      const inUrl = new Set<string>();
      for (const match of line.matchAll(LITERAL_HELP_URL)) {
        const slug = match[1]!;
        inUrl.add(slug);
        problems.push({
          file,
          line: lineNumber,
          target: `?help=${slug}`,
          reason: `literal Help URL "?help=${slug}"; declare it in SPA_HELP_TARGETS`,
        });
      }
      if (quotedSlug === null) return;
      for (const match of line.matchAll(quotedSlug)) {
        const slug = match[2]!;
        if (inUrl.has(slug)) continue;
        problems.push({
          file,
          line: lineNumber,
          target: slug,
          reason: `literal Help slug "${slug}"; use a target from ${SPA_LINKS_FILE}`,
        });
      }
    });
  }

  return problems.sort(
    (left, right) => left.file.localeCompare(right.file) || left.line - right.line,
  );
}
