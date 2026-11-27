// Shared Markdown link extraction for the offline docs gate
// (src/web/src/doc-links.ts) and the opt-in external checker
// (scripts/check-external-links.mjs). Keep this module free of app imports so
// Node can load it directly under the documented 22.13 floor.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * @typedef {object} DocLink
 * @property {number} line 1-based line in the file that contains the link.
 * @property {string} target Raw destination text between the parentheses (or after a reference label).
 * @property {'link' | 'image' | 'html' | 'reference'} kind
 */

/**
 * @typedef {object} CollectedDocLink
 * @property {string} file
 * @property {DocLink} link
 */

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
function maskCode(markdown) {
  const chars = markdown.split('');
  let open = null;
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
        fence[1][0] === open.char &&
        fence[1].length >= open.length &&
        fence[2].trim() === ''
      ) {
        open = null;
      }
    } else if (fence) {
      open = { char: fence[1][0], length: fence[1].length };
    }

    if (newline === -1) break;
    start = newline + 1;
  }

  return chars.join('').replace(/(`+)[\s\S]*?\1/g, (span) => span.replace(/[^\n]/g, ' '));
}

function lineAt(markdown, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (markdown.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function stripAngles(target) {
  return target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target;
}

function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** True when a raw destination has an explicit URI scheme. */
export function isExternalHref(raw) {
  return EXTERNAL.test(raw);
}

/** Actual link/image destinations, plus reference definitions. Usages resolve through their definition. */
export function extractDocLinks(markdown) {
  const masked = maskCode(markdown);
  const links = [];

  for (const match of masked.matchAll(INLINE_LINK)) {
    links.push({
      line: lineAt(markdown, match.index ?? 0),
      target: stripAngles(match[3]),
      kind: match[1] === '!' ? 'image' : 'link',
    });
  }

  for (const match of masked.matchAll(REFERENCE_DEFINITION)) {
    links.push({
      line: lineAt(markdown, match.index ?? 0),
      target: stripAngles(match[2]),
      kind: 'reference',
    });
  }

  for (const match of masked.matchAll(HTML_LINK)) {
    const tag = match[1].toLowerCase();
    const attribute = match[2].toLowerCase();
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
export function undefinedReferenceLabels(markdown) {
  const masked = maskCode(markdown);
  const defined = new Set();
  for (const match of masked.matchAll(REFERENCE_DEFINITION)) {
    defined.add(normalizeLabel(match[1]));
  }

  const missing = [];
  for (const match of masked.matchAll(REFERENCE_USAGE)) {
    const label = normalizeLabel(match[3] === '' ? match[2] : match[3]);
    // CommonMark renders an undefined reference as literal text, so this is a
    // deliberate heuristic: a `[text][label]` pair is treated as a broken link
    // and must get a definition. Fenced blocks and inline code never get here.
    if (!defined.has(label)) missing.push({ line: lineAt(markdown, match.index ?? 0), label });
  }
  return missing;
}

const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', 'dist']);

function walkMarkdown(directory, root, files) {
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
export function markdownFiles(root) {
  const absoluteRoot = path.resolve(root);
  const files = [];
  walkMarkdown(absoluteRoot, absoluteRoot, files);
  return files.sort();
}

/** Every link in the corpus, tagged with its repo-relative file. */
export function collectDocLinks(root) {
  const absoluteRoot = path.resolve(root);
  const links = [];
  for (const file of markdownFiles(absoluteRoot)) {
    const markdown = readFileSync(path.join(absoluteRoot, file), 'utf8');
    for (const link of extractDocLinks(markdown)) links.push({ file, link });
  }
  return links;
}
