import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HELP_MANIFEST } from '../../server/src/docs/manifest';
import { walkFiles } from '../../server/src/util/files';
import {
  checkDocLinks,
  checkHelpLinks,
  collectDocLinks,
  extractDocLinks,
  manifestProblems,
  markdownFiles,
  undefinedReferenceLabels,
} from './doc-links';
import { extractHeadings, helpSlugFromHref } from './docs';
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

const ASSET_FIXTURE_MANIFEST = [
  { slug: 'served', source: 'docs/served.md' },
  { slug: 'target', source: 'docs/target.md' },
] as const;

function makeAssetFixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'aps-help-assets-'));
  tempRoots.push(root);
  for (const directory of [
    'docs/screenshots',
    'docs/images',
    'src/server/src',
    'src/screenshots',
    'scripts',
    'deploy',
  ]) {
    mkdirSync(path.join(root, directory), { recursive: true });
  }
  for (const file of [
    'docs/screenshots/shot.png',
    'docs/images/bad.png',
    'src/screenshots/shot.png',
    'src/server/src/app.ts',
    'scripts/e2e.mjs',
    'deploy/ci-workflow.yml',
  ]) {
    writeFileSync(path.join(root, file), '');
  }
  writeFileSync(path.join(root, 'package.json'), '{}\n');
  writeFileSync(path.join(root, 'docs', 'target.md'), '# Target\n');
  writeFileSync(
    path.join(root, 'docs', 'internal.md'),
    ['![bad](images/bad.png)', '[file](../src/server/src/app.ts)'].join('\n'),
  );
  writeFileSync(
    path.join(root, 'docs', 'served.md'),
    [
      '![bad image](images/bad.png)',
      '<img src="images/bad.png">',
      '![bad ref][badimg]',
      '![ok image](screenshots/shot.png)',
      '![ok ref][shotref]',
      '[badimg]: images/bad.png',
      '[shotref]: screenshots/shot.png',
      '![external](https://example.com/x.png)',
      '![data](data:image/png;base64,AAAA)',
      '![proto](//example.com/x.png)',
      '![asset](/api/docs/assets/shot.png)',
      '![outside](../src/screenshots/shot.png)',
      '![missing](images/missing.png)',
      '![frag](images/bad.png#top)',
      '[code file](../src/server/src/app.ts)',
      '[ci](../deploy/ci-workflow.yml)',
      '[script](../scripts/e2e.mjs)',
      '[package](../package.json)',
      '[shot link](screenshots/shot.png)',
      '[asset link](/api/docs/assets/shot.png)',
      '[github](https://github.com/example/repo)',
      '[mail](mailto:ops@example.com)',
      '[anchor](#real-heading)',
      '[app route](/api/requests)',
      '[ok help](?help=target)',
      '[bad help](?help=missing)',
      '[missing file](nope.txt)',
      '[code fragment](../src/server/src/app.ts#L1)',
      '`[code](images/bad.png)`',
      '<a href="../src/server/src/app.ts">html link</a>',
      '<img src="screenshots/shot.png">',
      '~~~md',
      '![fenced](images/bad.png)',
      '[fenced link](../src/server/src/app.ts)',
      '~~~',
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
      { line: 6, target: 'docs/html.png', kind: 'image' },
    ]);
    expect(undefinedReferenceLabels(markdown)).toEqual([]);
  });

  it('tags image reference definitions and raw img tags as images', () => {
    const markdown = [
      '<img src="docs/a.png">',
      '![board][shot]',
      '[link][doc]',
      '[shot]: docs/screenshots/board.png',
      '[doc]: docs/guide.md',
    ].join('\n');

    expect(extractDocLinks(markdown)).toEqual([
      { line: 1, target: 'docs/a.png', kind: 'image' },
      { line: 4, target: 'docs/screenshots/board.png', kind: 'image' },
      { line: 5, target: 'docs/guide.md', kind: 'reference' },
    ]);
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

  it('checks every local link, image, and anchor in the repository', () => {
    expect(checkDocLinks(repoRoot)).toEqual([]);
    expect(checkHelpLinks(repoRoot, HELP_MANIFEST)).toEqual([]);
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

  it('reports images and non-Markdown targets Help cannot serve', () => {
    const root = makeAssetFixture();

    expect(checkHelpLinks(root, ASSET_FIXTURE_MANIFEST)).toEqual([
      {
        file: 'docs/served.md',
        line: 1,
        target: 'images/bad.png',
        reason: 'local image is not served by Help',
      },
      {
        file: 'docs/served.md',
        line: 2,
        target: 'images/bad.png',
        reason: 'local image is not served by Help',
      },
      {
        file: 'docs/served.md',
        line: 6,
        target: 'images/bad.png',
        reason: 'local image is not served by Help',
      },
      {
        file: 'docs/served.md',
        line: 12,
        target: '../src/screenshots/shot.png',
        reason: 'local image is not served by Help',
      },
      {
        file: 'docs/served.md',
        line: 15,
        target: '../src/server/src/app.ts',
        reason: 'local non-Markdown target is not served by Help',
      },
      {
        file: 'docs/served.md',
        line: 16,
        target: '../deploy/ci-workflow.yml',
        reason: 'local non-Markdown target is not served by Help',
      },
      {
        file: 'docs/served.md',
        line: 17,
        target: '../scripts/e2e.mjs',
        reason: 'local non-Markdown target is not served by Help',
      },
      {
        file: 'docs/served.md',
        line: 18,
        target: '../package.json',
        reason: 'local non-Markdown target is not served by Help',
      },
      {
        file: 'docs/served.md',
        line: 26,
        target: '?help=missing',
        reason: 'Help has no page for slug "missing"',
      },
      {
        file: 'docs/served.md',
        line: 30,
        target: '../src/server/src/app.ts',
        reason: 'local non-Markdown target is not served by Help',
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

describe('SPA Help targets', () => {
  it('declares the known in-app Help targets', () => {
    expect(SPA_HELP_TARGETS).toEqual(
      expect.arrayContaining([VERIFY_WEBHOOK_SIGNATURES_HELP, GETTING_STARTED_HELP]),
    );
  });

  it('resolves every SPA Help target through the manifest and its headings', () => {
    const entries = new Map(HELP_MANIFEST.map((entry) => [entry.slug, entry]));
    for (const target of SPA_HELP_TARGETS) {
      const entry = entries.get(target.slug);
      expect(entry, `Help target "${target.slug}" is not in HELP_MANIFEST`).toBeDefined();
      if (!entry) continue;

      const source = path.join(repoRoot, entry.source);
      expect(
        existsSync(source),
        `Help target "${target.slug}" source "${entry.source}" is missing`,
      ).toBe(true);
      if (!existsSync(source)) continue;

      if (target.anchor !== null) {
        const ids = extractHeadings(readFileSync(source, 'utf8')).map((heading) => heading.id);
        expect(
          ids,
          `Help target "${target.slug}#${target.anchor}" is not a heading of "${entry.source}"`,
        ).toContain(target.anchor);
      }
    }
  });

  it('builds the in-app href for every SPA Help target', () => {
    for (const target of SPA_HELP_TARGETS) {
      const expected = `?help=${target.slug}${target.anchor ? `#${target.anchor}` : ''}`;
      expect(helpHref(target)).toBe(expected);
      expect(helpSlugFromHref(helpHref(target))).toBe(target.slug);
    }
  });

  it('rejects hard-coded Help targets in the SPA', () => {
    const sourceRoot = path.join(repoRoot, 'src/web/src');
    const problems: string[] = [];
    for (const file of walkFiles(sourceRoot)) {
      if (/\.test\.tsx?$/.test(file)) continue;
      if (file.split(path.sep).includes('test')) continue;
      if (file === 'links.ts' || file === 'docs.ts') continue;
      const lines = readFileSync(path.join(sourceRoot, file), 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (
          /\?help=[a-z0-9-]/i.test(line) ||
          /(['"`])(?:getting-started|08-user-workflows)\1/.test(line)
        ) {
          problems.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(problems).toEqual([]);
  });
});
