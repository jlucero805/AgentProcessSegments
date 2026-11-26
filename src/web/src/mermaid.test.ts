import type { Element } from 'hast';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock('mermaid', () => ({
  default: {
    initialize: mermaidMock.initialize,
    render: mermaidMock.render,
  },
}));

function codeBlock(language: string, source: string): Element {
  return {
    type: 'element',
    tagName: 'pre',
    properties: {},
    children: [
      {
        type: 'element',
        tagName: 'code',
        properties: { className: [`language-${language}`] },
        children: [{ type: 'text', value: source }],
      },
    ],
  };
}

describe('mermaid helpers', () => {
  beforeEach(() => {
    vi.resetModules();
    mermaidMock.initialize.mockClear();
    mermaidMock.render.mockClear();
  });

  it('extracts source from a Mermaid fence only', async () => {
    const { mermaidSource } = await import('./mermaid');

    expect(mermaidSource(codeBlock('mermaid', 'flowchart LR\n  A-->B'))).toBe(
      'flowchart LR\n  A-->B',
    );
    expect(mermaidSource(codeBlock('bash', 'npm test'))).toBeNull();
    expect(mermaidSource(undefined)).toBeNull();
  });

  it('loads Mermaid lazily, initializes it once, and reuses the module', async () => {
    const { loadMermaid } = await import('./mermaid');

    const first = loadMermaid();
    const second = loadMermaid();
    expect(first).toBe(second);
    expect(mermaidMock.initialize).not.toHaveBeenCalled();

    await Promise.all([first, second]);
    expect(mermaidMock.initialize).toHaveBeenCalledTimes(1);
    expect(mermaidMock.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        startOnLoad: false,
        theme: 'dark',
        darkMode: true,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        layout: 'elk',
        look: 'neo',
      }),
    );
  });

  it('allows a retry after initialization fails', async () => {
    mermaidMock.initialize.mockImplementationOnce(() => {
      throw new Error('bad config');
    });
    const { loadMermaid } = await import('./mermaid');

    await expect(loadMermaid()).rejects.toThrow('bad config');
    await expect(loadMermaid()).resolves.toBeDefined();
    expect(mermaidMock.initialize).toHaveBeenCalledTimes(2);
  });
});
