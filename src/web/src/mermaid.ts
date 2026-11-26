import type { Element, ElementContent } from 'hast';
import type { ExtraProps } from 'react-markdown';

type MermaidApi = (typeof import('mermaid'))['default'];

export const MERMAID_CLASS = 'language-mermaid';

let pending: Promise<MermaidApi> | null = null;

/**
 * Load Mermaid only when a Help page actually contains a diagram. The module is
 * deliberately imported dynamically so Vite keeps it out of the initial bundle.
 */
export function loadMermaid(): Promise<MermaidApi> {
  pending ??= import('mermaid')
    .then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        theme: 'dark',
        darkMode: true,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        // Adopt Mermaid 12's ELK layout and `neo` look deliberately. The first
        // diagram loads the lazy ~1.5 MB ELK chunk behind MermaidDiagram's spinner;
        // later diagrams reuse the loaded modules.
        layout: 'elk',
        look: 'neo',
      });
      return mermaid;
    })
    .catch((error: unknown) => {
      // Allow a later diagram to retry after a transient chunk-load failure.
      pending = null;
      throw error;
    });
  return pending;
}

function classes(value: Element['properties']['className']): string[] {
  const raw: unknown = value;
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') return raw.split(/\s+/).filter(Boolean);
  return [];
}

function text(node: ElementContent): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element') return node.children.map(text).join('');
  return '';
}

/** Read the source out of a react-markdown `pre` node when it is a Mermaid fence. */
export function mermaidSource(node: ExtraProps['node']): string | null {
  const code = node?.children.find(
    (child): child is Element => child.type === 'element' && child.tagName === 'code',
  );
  if (!code || !classes(code.properties.className).includes(MERMAID_CLASS)) return null;
  return text(code).replace(/\r?\n$/, '');
}
