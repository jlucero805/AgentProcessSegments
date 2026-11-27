export interface DocLink {
  /** 1-based line in the file that contains the link. */
  line: number;
  /** Raw destination text between the parentheses (or after a reference label). */
  target: string;
  kind: 'link' | 'image' | 'html' | 'reference';
}

export interface CollectedDocLink {
  file: string;
  link: DocLink;
}

export const SKIP_DIRECTORIES: ReadonlySet<string>;

export function isExternalHref(raw: string): boolean;

export function extractDocLinks(markdown: string): DocLink[];

export function undefinedReferenceLabels(markdown: string): Array<{ line: number; label: string }>;

export function markdownFiles(root: string): string[];

export function collectDocLinks(root: string): CollectedDocLink[];
