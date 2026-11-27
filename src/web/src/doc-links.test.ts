import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HELP_MANIFEST } from '../../server/src/docs/manifest';
import {
  checkDocLinks,
  checkHelpLinks,
  checkSpaHelpLinks,
  collectDocLinks,
  extractDocLinks,
  manifestProblems,
  markdownFiles,
  undefinedReferenceLabels,
} from './doc-links';
import { helpSlugFromHref } from './docs';
import {
  GETTING_STARTED_HELP,
  SPA_HELP_TARGETS,
  VERIFY_WEBHOOK_SIGNATURES_HELP,
  helpHref,
} from './links';

const repoRoot = path.resolve(process.cwd(), '../..');

const tempRoots: string[] = [];

afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

function makeFixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aps-doc-links-'));
  tempRoots.push(root);
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

const HELP_FIXTURE_MANIFEST = [
  { slug: 'getting-started', source: 'README.md' },
  { slug: 'served', source: 'docs/served.md' },
  { slug: 'target', source: 'docs/target.md' },
  { slug: 'deploy-vps', source: 'deploy/vps.md' },
] as const;

function makeHelpFixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aps-help-links-'));
  tempRoots.push(root);
  for (const directory of ['docs', 'notes', 'deploy']) {
    mkdirSync(path.join(root, directory), { recursive: true });
  }
  writeFileSync(path.join(root, 'README.md'), '# Getting started\n\n## Install\n');
  writeFileSync(path.join(root, 'docs', 'target.md'), '# Target\n\n## Real heading\n');
  writeFileSync(path.join(root, 'docs', 'internal.md'), '[bad](?help=nope)\n');
  writeFileSync(path.join(root, 'docs', 'new-page.md'), '# New page\n');
  writeFileSync(path.join(root, 'notes', 'target.md'), '# Other target\n');
  writeFileSync(path.join(root, 'deploy', 'vps.md'), '# VPS\n\n## Tailscale\n');
  writeFileSync(
    path.join(root, 'docs', 'served.md'),
    [
      '[internal](internal.md)',
      '[unmanifested](new-page.md)',
      '[served anchor](target.md#real-heading)',
      '[bad anchor](target.md#missing)',
      '[readme](../README.md)',
      '[deploy](../deploy/vps.md#tailscale)',
      '[collision](../notes/target.md)',
      '[unknown help](?help=nope)',
      '[bad help anchor](?help=target#nope)',
      '[ok help](?help=target#real-heading)',
      '[external](https://example.com/x)',
      '`[code](internal.md)` and `?help=nope`',
      '```md',
      '[fenced](internal.md)',
      '?help=nope',
      '```',
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
    const root = makeFixture();

    expect(checkDocLinks(root)).toEqual([
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

  it('checks every local link, image, anchor, and SPA Help target in the repository', () => {
    expect(checkDocLinks(repoRoot)).toEqual([]);
    expect(checkHelpLinks(repoRoot, HELP_MANIFEST)).toEqual([]);
    expect(checkSpaHelpLinks(repoRoot, HELP_MANIFEST, SPA_HELP_TARGETS)).toEqual([]);
  });

  it('keeps the real Help manifest honest', () => {
    expect(HELP_MANIFEST).toHaveLength(13);
    expect(HELP_MANIFEST.map((entry) => entry.source)).toEqual(
      expect.arrayContaining(['README.md', 'deploy/vps.md', 'docs/08-user-workflows.md']),
    );
    expect(HELP_MANIFEST.some((entry) => entry.slug === '05-plan')).toBe(false);
    expect(manifestProblems(repoRoot, HELP_MANIFEST)).toEqual([]);
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

describe('Help-served links and the manifest', () => {
  it('reports only served-page links Help cannot resolve, without duplicating anchors', () => {
    const root = makeHelpFixture();

    expect(checkHelpLinks(root, HELP_FIXTURE_MANIFEST)).toEqual([
      {
        file: 'docs/served.md',
        line: 1,
        target: 'internal.md',
        reason: 'Help has no page for "docs/internal.md" (slug "internal")',
      },
      {
        file: 'docs/served.md',
        line: 2,
        target: 'new-page.md',
        reason: 'Help has no page for "docs/new-page.md" (slug "new-page")',
      },
      {
        file: 'docs/served.md',
        line: 7,
        target: '../notes/target.md',
        reason: 'Help slug "target" serves "docs/target.md", not "notes/target.md"',
      },
      {
        file: 'docs/served.md',
        line: 8,
        target: '?help=nope',
        reason: 'Help has no page for slug "nope"',
      },
      {
        file: 'docs/served.md',
        line: 9,
        target: '?help=target#nope',
        reason: 'no heading with id "nope" in Help page "target"',
      },
    ]);

    // The bad cross-page fragment on line 4 stays checkDocLinks' finding.
    expect(checkDocLinks(root)).toEqual([
      {
        file: 'docs/served.md',
        line: 4,
        target: 'target.md#missing',
        reason: 'no heading with id "missing"',
      },
    ]);
  });

  it('ignores ?help targets on internal-only pages', () => {
    const root = makeHelpFixture();
    expect(checkHelpLinks(root, HELP_FIXTURE_MANIFEST).some((entry) => entry.file === 'docs/internal.md')).toBe(
      false,
    );
  });

  it('validates manifest sources, slugs, duplicates, and app routing', () => {
    const root = makeHelpFixture();
    writeFileSync(path.join(root, 'docs', 'not-a-doc.txt'), '');
    writeFileSync(path.join(root, 'docs', 'ok.md'), '# OK\n');

    const reasons = (manifest: Array<{ slug: string; source: string }>) =>
      manifestProblems(root, manifest).map((problem) => `${problem.target}: ${problem.reason}`);

    expect(reasons([{ slug: 'ghost', source: 'docs/ghost.md' }])).toEqual([
      'docs/ghost.md: missing source file',
    ]);
    expect(reasons([{ slug: 'escape', source: '../outside.md' }])).toEqual([
      '../outside.md: source is not a repo-relative path',
    ]);
    expect(reasons([{ slug: 'renamed', source: 'docs/ok.md' }])).toEqual([
      'renamed: source "docs/ok.md" maps to slug "ok", not "renamed"',
    ]);
    expect(reasons([{ slug: 'Bad Slug', source: 'docs/ok.md' }])).toEqual([
      'Bad Slug: slug is not lowercase letters, digits, or hyphens',
      'Bad Slug: source "docs/ok.md" maps to slug "ok", not "Bad Slug"',
    ]);
    expect(reasons([{ slug: 'shot', source: 'docs/not-a-doc.txt' }])).toEqual([
      'docs/not-a-doc.txt: source is not a Markdown file',
      'shot: source "docs/not-a-doc.txt" maps to slug "(none)", not "shot"',
    ]);
    expect(
      reasons([
        { slug: 'target', source: 'docs/target.md' },
        { slug: 'target', source: 'notes/target.md' },
      ]),
    ).toEqual(['target: duplicate Help slug']);
    expect(
      reasons([
        { slug: 'target', source: 'docs/target.md' },
        { slug: 'target-copy', source: 'docs/target.md' },
      ]),
    ).toEqual([
      'docs/target.md: duplicate manifest source',
      'target-copy: source "docs/target.md" maps to slug "target", not "target-copy"',
    ]);
  });
});

const SPA_FIXTURE_MANIFEST = [
  { slug: 'getting-started', source: 'README.md' },
  { slug: 'served', source: 'docs/served.md' },
  { slug: '13-cell-wizard', source: 'docs/13.md' },
] as const;

const SPA_LINKS = 'src/web/src/links.ts';

/** A temp repo with a tiny manifest and one SPA source tree. */
function makeSpaFixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aps-spa-help-'));
  tempRoots.push(root);
  const sources = path.join(root, 'src', 'web', 'src');
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  mkdirSync(sources, { recursive: true });
  writeFileSync(path.join(root, 'README.md'), '# Getting started\n');
  writeFileSync(path.join(root, 'docs', 'served.md'), '# Served\n\n## Real heading\n');
  writeFileSync(path.join(root, 'docs', '13.md'), '# Cell wizard\n');
  writeFileSync(path.join(sources, 'links.ts'), "export const HELP = { slug: 'served' } as const;\n");
  writeFileSync(path.join(sources, 'App.tsx'), 'export const App = null;\n');
  return root;
}

function writeSpaSource(root: string, name: string, lines: string[]): void {
  writeFileSync(path.join(root, 'src', 'web', 'src', name), `${lines.join('\n')}\n`);
}

describe('SPA Help targets', () => {
  it('declares the in-app Help targets in one registry', () => {
    expect(SPA_HELP_TARGETS).toEqual(
      expect.arrayContaining([GETTING_STARTED_HELP, VERIFY_WEBHOOK_SIGNATURES_HELP]),
    );
    for (const target of SPA_HELP_TARGETS) {
      const expected = `?help=${target.slug}${target.anchor ? `#${target.anchor}` : ''}`;
      expect(helpHref(target)).toBe(expected);
      expect(helpSlugFromHref(helpHref(target))).toBe(target.slug);
    }
  });

  it('accepts declared targets whose slug and anchor exist', () => {
    const root = makeSpaFixture();
    expect(
      checkSpaHelpLinks(root, SPA_FIXTURE_MANIFEST, [
        { slug: 'getting-started' },
        { slug: 'served', anchor: 'real-heading' },
      ]),
    ).toEqual([]);
  });

  it('reports an unknown slug and an unknown anchor at the declaration', () => {
    const root = makeSpaFixture();
    expect(
      checkSpaHelpLinks(root, SPA_FIXTURE_MANIFEST, [
        { slug: 'nope' },
        { slug: 'served', anchor: 'missing' },
      ]),
    ).toEqual([
      {
        file: SPA_LINKS,
        line: 0,
        target: 'nope',
        reason: 'Help has no page for slug "nope" (SPA Help target)',
      },
      {
        file: SPA_LINKS,
        line: 0,
        target: 'served#missing',
        reason: 'no heading with id "missing" in Help page "served" (SPA Help target)',
      },
    ]);
  });

  it('leaves a missing manifest source to manifestProblems', () => {
    const root = makeSpaFixture();
    expect(
      checkSpaHelpLinks(root, [{ slug: 'ghost', source: 'docs/ghost.md' }], [
        { slug: 'ghost', anchor: 'anything' },
      ]),
    ).toEqual([]);
    expect(manifestProblems(root, [{ slug: 'ghost', source: 'docs/ghost.md' }])).toEqual([
      {
        file: 'src/server/src/docs/manifest.ts',
        line: 0,
        target: 'docs/ghost.md',
        reason: 'missing source file',
      },
    ]);
  });

  it('rejects a hard-coded ?help= URL in a component', () => {
    const root = makeSpaFixture();
    writeSpaSource(root, 'HelpPanel.tsx', [
      'export const Panel = () => <a href="?help=typo">back</a>;',
    ]);

    expect(checkSpaHelpLinks(root, SPA_FIXTURE_MANIFEST, [])).toEqual([
      {
        file: 'src/web/src/HelpPanel.tsx',
        line: 1,
        target: '?help=typo',
        reason: 'literal Help URL "?help=typo"; declare it in SPA_HELP_TARGETS',
      },
    ]);
  });

  it('rejects a quoted manifest slug that is not in the registry', () => {
    const root = makeSpaFixture();
    writeSpaSource(root, 'App.tsx', ['const page = openHelpAt(`13-cell-wizard`);']);

    expect(checkSpaHelpLinks(root, SPA_FIXTURE_MANIFEST, [])).toEqual([
      {
        file: 'src/web/src/App.tsx',
        line: 1,
        target: '13-cell-wizard',
        reason: 'literal Help slug "13-cell-wizard"; use a target from src/web/src/links.ts',
      },
    ]);
  });

  it('ignores templates, guards, tests, and the declaration file', () => {
    const root = makeSpaFixture();
    writeSpaSource(root, 'docs.ts', [
      'export const href = (slug: string) => `?help=${encodeURIComponent(slug)}`;',
      "export const isHelp = (href: string) => href.startsWith('?help=');",
    ]);
    writeSpaSource(root, 'App.test.tsx', ["expect(href).toBe('?help=typo');"]);
    mkdirSync(path.join(root, 'src', 'web', 'src', 'test'), { recursive: true });
    writeSpaSource(root, path.join('test', 'fixtures.ts'), [
      "export const fixture = 'getting-started';",
    ]);

    expect(checkSpaHelpLinks(root, SPA_FIXTURE_MANIFEST, [])).toEqual([]);
  });

});
