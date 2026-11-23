import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

/** Create `dir` when missing and force it owner-only, repairing an older directory. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/**
 * Write a file atomically with owner-only permissions.
 *
 * `writeFileSync`'s `mode` applies only when the file is created, so an
 * existing file is replaced rather than reopened. The explicit `chmod` keeps
 * the result `0600` even under an unusual umask.
 */
export function writePrivateFile(file: string, contents: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, contents, { mode: 0o600 });
  renameSync(temp, file);
  chmodSync(file, 0o600);
}

/** Recursively list files below `dir`, relative to `base`. Missing dirs are empty. */
export function walkFiles(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkFiles(full, base));
    else if (entry.isFile()) found.push(path.relative(base, full));
  }
  return found;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export interface MarkdownParts {
  frontmatter: string;
  body: string;
}

/** Split a leading YAML frontmatter block from a markdown document. */
export function splitMarkdown(markdown: string): MarkdownParts {
  const match = FRONTMATTER.exec(markdown);
  if (!match) return { frontmatter: '', body: markdown };
  return { frontmatter: match[1] ?? '', body: markdown.slice(match[0].length) };
}

/** Read one scalar frontmatter field, with surrounding quotes removed. */
export function frontmatterField(frontmatter: string, key: string): string {
  const line = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(frontmatter);
  return line?.[1]?.trim().replace(/^["']|["']$/g, '') ?? '';
}

/** The one-line description used by the skills/commands menu. */
export function markdownDescription(markdown: string): string {
  return frontmatterField(splitMarkdown(markdown).frontmatter, 'description');
}
