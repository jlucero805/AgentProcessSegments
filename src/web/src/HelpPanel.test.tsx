import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HelpPanel } from './HelpPanel';
import { jsonResponse } from './test/fixtures';
import type { DocContent, DocPage } from './types';

const PAGES: DocPage[] = [
  {
    slug: 'getting-started',
    title: 'Getting started',
    group: 'Getting started',
    description: 'Start here.',
  },
  { slug: '07-process-segments', title: 'Process segments', group: 'Guides' },
  { slug: '01-system-spec', title: 'System spec', group: 'Reference' },
];

const gettingStarted: DocContent = {
  ...PAGES[0]!,
  updatedAt: 1,
  markdown: [
    '# Sandbox Harness',
    '',
    'Intro paragraph.',
    '',
    '## Install',
    '',
    'Run **this**.',
    '',
    'See [process segments](07-process-segments.md) and [external docs](https://example.com).',
    '',
    '![Board](docs/screenshots/board.png)',
    '',
    '```bash',
    '## not a heading',
    '```',
  ].join('\n'),
};

const processSegments: DocContent = {
  ...PAGES[1]!,
  updatedAt: 2,
  markdown: '# Process segments\n\nSegment text.\n\n## Merge bucket',
};

function installFetch(pages: DocPage[] = PAGES, docs: Record<string, DocContent> = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/docs') return jsonResponse({ pages });
    if (url.startsWith('/api/docs/')) {
      const slug = decodeURIComponent(url.slice('/api/docs/'.length).split('?')[0] ?? '');
      const doc = docs[slug];
      if (doc) return jsonResponse(doc);
      return jsonResponse({ error: 'not_found' }, 404);
    }
    return jsonResponse({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPanel(
  slug = 'getting-started',
  overrides: Partial<Record<string, DocContent>> = {},
) {
  installFetch(PAGES, { 'getting-started': gettingStarted, ...overrides });
  const onNavigate = vi.fn();
  const onClose = vi.fn();
  render(<HelpPanel slug={slug} onNavigate={onNavigate} onClose={onClose} />);
  return { onNavigate, onClose };
}

describe('HelpPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('renders the grouped nav, markdown, external links, and screenshot images', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const { onNavigate, onClose } = renderPanel();

    expect(await screen.findByText('Intro paragraph.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Documentation' })).toBeInTheDocument();
    expect(screen.getAllByText('Getting started').length).toBeGreaterThan(0);
    expect(screen.getByText('Guides')).toBeInTheDocument();
    expect(screen.getByText('Reference')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Process segments' })).toBeInTheDocument();

    const external = screen.getByRole('link', { name: 'external docs' });
    expect(external).toHaveAttribute('target', '_blank');
    expect(external.getAttribute('rel')).toContain('noopener');
    expect(external.getAttribute('rel')).toContain('noreferrer');

    const image = screen.getByRole('img', { name: 'Board' });
    expect(image).toHaveAttribute('src', '/api/docs/assets/board.png');

    fireEvent.click(screen.getByRole('link', { name: 'process segments' }));
    expect(onNavigate).toHaveBeenCalledWith('07-process-segments');

    // Fenced code does not become an "On this page" entry.
    expect(screen.getByRole('link', { name: 'Install' })).toHaveAttribute('href', '#install');
    expect(screen.queryByRole('link', { name: 'not a heading' })).not.toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('copies the article as Markdown', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderPanel();

    await screen.findByText('Intro paragraph.');
    fireEvent.click(screen.getByRole('button', { name: 'Copy as Markdown' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(gettingStarted.markdown));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
  });

  it('swaps pages through the nav rail', async () => {
    const { onNavigate } = renderPanel();
    await screen.findByText('Intro paragraph.');

    fireEvent.click(screen.getByRole('button', { name: 'Process segments' }));
    expect(onNavigate).toHaveBeenCalledWith('07-process-segments');
  });

  it('renders a page-not-found state with a link back', async () => {
    const { onNavigate } = renderPanel('nope');
    expect((await screen.findAllByText('Page not found')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('link', { name: 'Back to Getting started' }));
    expect(onNavigate).toHaveBeenCalledWith('getting-started');
  });

  it('renders the unavailable state when the build has no docs', async () => {
    installFetch([]);
    render(<HelpPanel slug="getting-started" onNavigate={vi.fn()} onClose={vi.fn()} />);
    expect(
      await screen.findByText('Documentation is not available in this build'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Documentation' })).toBeInTheDocument();
  });
});
