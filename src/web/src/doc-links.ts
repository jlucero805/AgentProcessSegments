import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { extractHeadings } from './docs';

export interface DocLink {
  /** 1-based line in the file that contains the link. */
  line: number;
  /** Raw destination text between the parentheses (or after a reference label). */
  target: string;
  kind: 'link' | 'image' | 'html' | 'reference';
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

function checkLink({ root, file, absoluteFile, link, headingIds }: LinkContext): DocLinkProblem | null {
  const raw = link.target.trim();
  const problem = (reason: string): DocLinkProblem => ({ file, line: link.line, target: raw, reason });

  if (raw === '') return problem('empty link target');
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
    return problem('unreadable link');
  }

  if (decodedPath === '' && decodedFragment === null) return problem('empty link target');

  const target =
    decodedPath === ''
      ? absoluteFile
      : path.resolve(
          decodedPath.startsWith('/') ? root : path.dirname(absoluteFile),
          decodedPath.startsWith('/') ? `.${decodedPath}` : decodedPath,
        );

  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return problem('path escapes the repository');
  }
  if (!existsSync(target)) return problem('missing file');
  if (decodedFragment === null) return null;

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
  if (!ids.includes(decodedFragment)) {
    return problem(`no heading with id "${decodedFragment}"`);
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
