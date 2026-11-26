import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  checkDocLinks,
  collectDocLinks,
  extractDocLinks,
  markdownFiles,
  undefinedReferenceLabels,
} from './doc-links';

const repoRoot = path.resolve(process.cwd(), '../..');

let tempRoot: string | null = null;

afterAll(() => {
  if (tempRoot !== null) rmSync(tempRoot, { recursive: true, force: true });
});

function makeFixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aps-doc-links-'));
  const docs = path.join(root, 'docs');
  mkdirSync(docs, { recursive: true });
  writeFileSync(path.join(docs, 'target.md'), '# Target\n\n## Real heading\n');
  writeFileSync(path.join(docs, 'shot.png'), '');
  writeFileSync(
    path.join(docs, 'guide.md'),
    [
      '[missing](nope.md)',
      '[bad](#no-such-heading)',
      '[ok](#real-heading)',
      '[external](https://example.com/x)',
      '`[code](nope.md)`',
      '```md',
      '[fenced](nope.md)',
      '```',
      '[cross](target.md#real-heading)',
      '[bad cross](target.md#missing)',
      '[undefined][label]',
      '[image anchor](shot.png#top)',
      '[escape](../../outside.md)',
      '## Real heading',
    ].join('\n'),
  );
  return root;
}

describe('documents links and anchors', () => {
  it('extracts inline links, images, references, HTML, and skips code', () => {
    const markdown = [
      '# Title',
      '[guide](docs/guide.md "Guide") and ![shot](docs/screenshots/board.png)',
      '[angle](<docs/with space.md>)',
      '[full][ref] and [collapsed][ref]',
      '[ref]: docs/ref.md "Reference"',
      '<a href="docs/html.md">html</a> and <img src="docs/html.png">',
      '```md',
      '[fenced](docs/fenced.md)',
      '```',
      'Inline `[span](docs/span.md)` is a code span.',
    ].join('\n');

    expect(extractDocLinks(markdown)).toEqual([
      { line: 2, target: 'docs/guide.md', kind: 'link' },
      { line: 2, target: 'docs/screenshots/board.png', kind: 'image' },
      { line: 3, target: 'docs/with space.md', kind: 'link' },
      { line: 5, target: 'docs/ref.md', kind: 'reference' },
      { line: 6, target: 'docs/html.md', kind: 'html' },
      { line: 6, target: 'docs/html.png', kind: 'html' },
    ]);
    expect(undefinedReferenceLabels(markdown)).toEqual([]);
  });

  it('reports a reference usage without a definition', () => {
    expect(undefinedReferenceLabels('[nope][missing-label]')).toEqual([
      { line: 1, label: 'missing-label' },
    ]);
    expect(undefinedReferenceLabels('[defined][]\n\n[defined]: docs/ref.md')).toEqual([]);
  });

  it('reports missing files, bad anchors, image fragments, escapes, and undefined references', () => {
    tempRoot = makeFixture();

    expect(checkDocLinks(tempRoot)).toEqual([
      { file: 'docs/guide.md', line: 1, target: 'nope.md', reason: 'missing file' },
      {
        file: 'docs/guide.md',
        line: 2,
        target: '#no-such-heading',
        reason: 'no heading with id "no-such-heading"',
      },
      {
        file: 'docs/guide.md',
        line: 10,
        target: 'target.md#missing',
        reason: 'no heading with id "missing"',
      },
      {
        file: 'docs/guide.md',
        line: 11,
        target: '[label]',
        reason: 'no matching reference definition',
      },
      {
        file: 'docs/guide.md',
        line: 12,
        target: 'shot.png#top',
        reason: 'fragment target is not Markdown',
      },
      {
        file: 'docs/guide.md',
        line: 13,
        target: '../../outside.md',
        reason: 'path escapes the repository',
      },
    ]);
  });

  it('checks every local link, image, and anchor in the repository', () => {
    expect(checkDocLinks(repoRoot)).toEqual([]);
  });

  it('walks the whole docs corpus and still sees its known links', () => {
    expect(markdownFiles(repoRoot)).toEqual(
      expect.arrayContaining([
        'README.md',
        'AGENTS.md',
        'deploy/vps.md',
        'docs/08-user-workflows.md',
        '.opencode/skills/codebase-refactor-audit/SKILL.md',
      ]),
    );

    const links = collectDocLinks(repoRoot);
    const has = (file: string, target: string, kind: string) =>
      links.some(
        (entry) => entry.file === file && entry.link.target === target && entry.link.kind === kind,
      );

    expect(has('README.md', 'docs/screenshots/board.png', 'image')).toBe(true);
    expect(has('README.md', 'docs/08-user-workflows.md#verify-webhook-signatures', 'link')).toBe(
      true,
    );
    expect(has('docs/08-user-workflows.md', '#verify-webhook-signatures', 'link')).toBe(true);
  });

  it('exposes the documented check:docs shortcut', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    ) as { scripts?: Record<string, string> };
    expect(packageJson.scripts?.['check:docs']).toBe(
      'npm test --workspace src/web -- doc-links',
    );
  });
});
