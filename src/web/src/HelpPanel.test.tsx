import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HelpPanel } from './HelpPanel';
import { jsonResponse } from './test/fixtures';
import type { DocContent, DocPage } from './types';

const mermaidMock = vi.hoisted(() => ({
  loadMermaid: vi.fn(),
  render: vi.fn(),
}));

vi.mock('./mermaid', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mermaid')>();
  return { ...actual, loadMermaid: mermaidMock.loadMermaid };
});

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

const MERMAID_SOURCE = 'flowchart LR\n  A-->B';

function docWithMermaid(...sources: string[]): DocContent {
  return {
    ...gettingStarted,
    markdown: [
      '# Mermaid diagrams',
      '',
      ...sources.flatMap((source) => ['```mermaid', source, '```', '']),
      '```bash',
      'npm test',
      '```',
    ].join('\n'),
  };
}

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
  const view = render(<HelpPanel slug={slug} onNavigate={onNavigate} onClose={onClose} />);
  return { onNavigate, onClose, ...view };
}

describe('HelpPanel', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    mermaidMock.render.mockReset();
    mermaidMock.render.mockImplementation(
      async (id: string, _source: string) => ({
        svg: `<svg data-testid="mermaid-svg" data-mermaid-id="${id}"></svg>`,
        diagramType: 'flowchart',
      }),
    );
    mermaidMock.loadMermaid.mockReset();
    mermaidMock.loadMermaid.mockResolvedValue({ render: mermaidMock.render });
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
    expect(mermaidMock.loadMermaid).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('renders Mermaid fences as SVG and leaves ordinary code blocks alone', async () => {
    const { container } = renderPanel('getting-started', {
      'getting-started': docWithMermaid(MERMAID_SOURCE),
    });

    expect(await screen.findByRole('heading', { name: 'Mermaid diagrams' })).toBeInTheDocument();
    await waitFor(() =>
      expect(container.querySelector('svg[data-testid="mermaid-svg"]')).not.toBeNull(),
    );

    const svg = container.querySelector('svg[data-testid="mermaid-svg"]');
    expect(svg).toHaveAttribute('data-mermaid-id', expect.stringMatching(/^help-mermaid-/));
    expect(screen.queryByText('flowchart LR')).not.toBeInTheDocument();
    expect(screen.getByText('npm test')).toBeInTheDocument();
    expect(mermaidMock.loadMermaid).toHaveBeenCalledTimes(1);
    expect(mermaidMock.render).toHaveBeenCalledWith(
      expect.stringMatching(/^help-mermaid-/),
      MERMAID_SOURCE,
    );
  });

  it('gives each diagram on a page a unique render id', async () => {
    const { container } = renderPanel('getting-started', {
      'getting-started': docWithMermaid(
        MERMAID_SOURCE,
        'sequenceDiagram\n  A->>B: hello',
      ),
    });

    await waitFor(() =>
      expect(container.querySelectorAll('svg[data-testid="mermaid-svg"]')).toHaveLength(2),
    );
    const ids = [...container.querySelectorAll('svg[data-testid="mermaid-svg"]')].map((svg) =>
      svg.getAttribute('data-mermaid-id'),
    );
    expect(new Set(ids).size).toBe(2);
  });

  it('shows a loading state while Mermaid resolves', async () => {
    let release: (value: { render: typeof mermaidMock.render }) => void = () => {};
    const pending = new Promise<{ render: typeof mermaidMock.render }>((resolve) => {
      release = resolve;
    });
    mermaidMock.loadMermaid.mockReturnValueOnce(pending);
    const { container } = renderPanel('getting-started', {
      'getting-started': docWithMermaid(MERMAID_SOURCE),
    });

    expect(await screen.findByRole('status')).toHaveTextContent('Rendering diagram…');
    release({ render: mermaidMock.render });
    await waitFor(() =>
      expect(container.querySelector('svg[data-testid="mermaid-svg"]')).not.toBeNull(),
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('falls back to the fence source when Mermaid cannot load', async () => {
    mermaidMock.loadMermaid.mockRejectedValueOnce(new Error('chunk unavailable'));
    const { container } = renderPanel('getting-started', {
      'getting-started': docWithMermaid(MERMAID_SOURCE),
    });

    await waitFor(() =>
      expect(container.querySelector('article pre')?.textContent).toContain(MERMAID_SOURCE),
    );
    expect(container.querySelector('svg[data-testid="mermaid-svg"]')).toBeNull();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('npm test')).toBeInTheDocument();
  });

  it('falls back to the fence source when rendering fails', async () => {
    mermaidMock.render.mockRejectedValueOnce(new Error('parse error'));
    const { container } = renderPanel('getting-started', {
      'getting-started': docWithMermaid(MERMAID_SOURCE),
    });

    await waitFor(() =>
      expect(container.querySelector('article pre')?.textContent).toContain(MERMAID_SOURCE),
    );
    expect(container.querySelector('svg[data-testid="mermaid-svg"]')).toBeNull();
    expect(screen.getByText('npm test')).toBeInTheDocument();
  });

  it('does not insert a diagram after the page unmounts', async () => {
    let release: (value: { render: typeof mermaidMock.render }) => void = () => {};
    const pending = new Promise<{ render: typeof mermaidMock.render }>((resolve) => {
      release = resolve;
    });
    mermaidMock.loadMermaid.mockReturnValueOnce(pending);
    const { unmount } = renderPanel('getting-started', {
      'getting-started': docWithMermaid(MERMAID_SOURCE),
    });

    expect(await screen.findByRole('heading', { name: 'Mermaid diagrams' })).toBeInTheDocument();
    unmount();
    release({ render: mermaidMock.render });
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector('svg[data-testid="mermaid-svg"]')).toBeNull();
  });

  it('copies the article as Markdown including Mermaid fences', async () => {
    const markdown = [gettingStarted.markdown, '', '```mermaid', MERMAID_SOURCE, '```'].join('\n');
    const doc = { ...gettingStarted, markdown };
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { container } = renderPanel('getting-started', { 'getting-started': doc });

    await screen.findByText('Intro paragraph.');
    await waitFor(() =>
      expect(container.querySelector('svg[data-testid="mermaid-svg"]')).not.toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Copy as Markdown' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(markdown));
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
