import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DocsService } from '../src/docs/service.js';

const repo = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const docsDir = path.join(repo, 'docs');
const docs = new DocsService(docsDir);

const EXPECTED = [
  'getting-started',
  '07-process-segments',
  '08-user-workflows',
  '11-skills',
  '13-cell-wizard',
  'deploy-vps',
  '10-error-log',
  '12-terminals',
  '01-system-spec',
  '02-status',
  '03-decisions',
  '04-design-liberties',
];

describe('docs service', () => {
  it('lists operator docs once, in manifest order and groups', () => {
    const pages = docs.list();
    expect(pages.map((page) => page.slug)).toEqual(EXPECTED);
    expect(new Set(pages.map((page) => page.slug)).size).toBe(pages.length);
    expect(pages[0]).toMatchObject({
      slug: 'getting-started',
      title: 'Getting started',
      group: 'Getting started',
    });
    expect(pages.find((page) => page.slug === '07-process-segments')).toMatchObject({
      group: 'Guides',
    });
    expect(pages.find((page) => page.slug === 'deploy-vps')).toMatchObject({
      group: 'Operations',
    });
    expect(pages.find((page) => page.slug === '01-system-spec')).toMatchObject({
      group: 'Reference',
    });
    expect(pages.some((page) => page.slug === '05-plan')).toBe(false);
    expect(pages.some((page) => page.slug === '09-backlog')).toBe(false);
  });

  it('reads a manifest page and rejects unknown or invalid slugs', () => {
    const page = docs.read('07-process-segments');
    expect(page).toMatchObject({ slug: '07-process-segments', title: 'Process segments' });
    expect(page?.markdown).toContain('# Process segments');
    expect(page?.updatedAt).toBeGreaterThan(0);

    expect(docs.read('nope')).toBeNull();
    expect(docs.read('../README')).toBeNull();
    expect(docs.read('..%2fREADME')).toBeNull();
    expect(docs.read('/etc/passwd')).toBeNull();
    expect(docs.read('')).toBeNull();
  });

  it('documents the VPS Tailscale Serve commands', () => {
    const markdown = docs.read('deploy-vps')?.markdown ?? '';
    expect(markdown).toContain(
      'sudo tailscale serve --bg --https=443 http://127.0.0.1:7391',
    );
    expect(markdown).toContain('sudo tailscale serve reset');
  });

  it('serves only screenshots under docs/screenshots', () => {
    const asset = docs.asset('board.png');
    expect(asset?.type).toBe('image/png');
    expect(asset?.file.endsWith(path.join('screenshots', 'board.png'))).toBe(true);

    expect(docs.asset('')).toBeNull();
    expect(docs.asset('../service.ts')).toBeNull();
    expect(docs.asset('../../src/server/src/config.ts')).toBeNull();
    expect(docs.asset('/etc/passwd')).toBeNull();
    expect(docs.asset('..%2f..%2fREADME.md')).toBeNull();
    expect(docs.asset('board.txt')).toBeNull();
  });

  it('returns an empty manifest when the docs directory is missing', () => {
    const missing = new DocsService(path.join(repo, 'does-not-exist'));
    expect(missing.list()).toEqual([]);
    expect(missing.read('getting-started')).toBeNull();
    expect(missing.asset('board.png')).toBeNull();
  });
});
