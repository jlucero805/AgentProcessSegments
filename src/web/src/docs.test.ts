import { describe, expect, it } from 'vitest';
import {
  extractHeadings,
  groupDocs,
  helpSlugFromHref,
  resolveDocHref,
  resolveDocImage,
  slugForDocPath,
  slugifyHeading,
} from './docs';
import type { DocPage } from './types';

const pages: DocPage[] = [
  { slug: 'getting-started', title: 'Getting started', group: 'Getting started' },
  { slug: '07-process-segments', title: 'Process segments', group: 'Guides' },
  { slug: '08-user-workflows', title: 'User workflows', group: 'Guides' },
  { slug: 'deploy-vps', title: 'VPS', group: 'Operations' },
];

describe('docs helpers', () => {
  it('groups pages in manifest order without reordering pages', () => {
    expect(groupDocs(pages)).toEqual([
      { group: 'Getting started', pages: [pages[0]] },
      { group: 'Guides', pages: [pages[1], pages[2]] },
      { group: 'Operations', pages: [pages[3]] },
    ]);
  });

  it('maps docs links and README/deploy aliases to help slugs', () => {
    expect(slugForDocPath('01-system-spec.md')).toBe('01-system-spec');
    expect(slugForDocPath('docs/08-user-workflows.md')).toBe('08-user-workflows');
    expect(slugForDocPath('../README.md')).toBe('getting-started');
    expect(slugForDocPath('deploy/vps.md')).toBe('deploy-vps');
    expect(slugForDocPath('notes.txt')).toBeNull();

    expect(resolveDocHref('01-system-spec.md')).toBe('?help=01-system-spec');
    expect(resolveDocHref('docs/08-user-workflows.md#flow')).toBe(
      '?help=08-user-workflows#flow',
    );
    expect(resolveDocHref('deploy/vps.md')).toBe('?help=deploy-vps');
    expect(resolveDocHref('../README.md')).toBe('?help=getting-started');
    expect(resolveDocHref('#local')).toBe('#local');
    expect(resolveDocHref('?help=02-status')).toBe('?help=02-status');
    expect(resolveDocHref('https://example.com/docs')).toBe('https://example.com/docs');
    expect(resolveDocHref('mailto:ops@example.com')).toBe('mailto:ops@example.com');
  });

  it('maps screenshots to the same-origin asset route', () => {
    expect(resolveDocImage('docs/screenshots/board.png')).toBe('/api/docs/assets/board.png');
    expect(resolveDocImage('screenshots/master.png')).toBe('/api/docs/assets/master.png');
    expect(resolveDocImage('../docs/screenshots/nested/shot.png')).toBe(
      '/api/docs/assets/nested/shot.png',
    );
    expect(resolveDocImage('/api/docs/assets/board.png')).toBe('/api/docs/assets/board.png');
    expect(resolveDocImage('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(resolveDocImage('screenshots/../secret.png')).toBe('screenshots/../secret.png');
  });

  it('reads help slugs from in-app links', () => {
    expect(helpSlugFromHref('?help=07-process-segments')).toBe('07-process-segments');
    expect(helpSlugFromHref('?help=deploy-vps&x=1')).toBe('deploy-vps');
    expect(helpSlugFromHref('https://example.com')).toBeNull();
  });

  it('extracts h2/h3 headings and skips fenced code blocks', () => {
    const markdown = [
      '# Title',
      '## Install `the brain`',
      '### Details',
      '```bash',
      '## not a heading',
      '```',
      '## Repeat',
      '## Repeat',
      '#### Too deep',
    ].join('\n');
    expect(extractHeadings(markdown)).toEqual([
      { id: 'install-the-brain', text: 'Install the brain', level: 2 },
      { id: 'details', text: 'Details', level: 3 },
      { id: 'repeat', text: 'Repeat', level: 2 },
      { id: 'repeat-2', text: 'Repeat', level: 2 },
    ]);
    expect(slugifyHeading('A & B: c_d')).toBe('a-b-cd');
  });
});
