import { useEffect, useId, useState } from 'react';
import { loadMermaid } from './mermaid';
import { Spinner } from './ui';

interface MermaidDiagramProps {
  source: string;
}

type RenderState =
  | { status: 'loading' }
  | { status: 'ready'; svg: string }
  | { status: 'error' };

export function MermaidDiagram({ source }: MermaidDiagramProps) {
  const reactId = useId();
  const renderId = `help-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [state, setState] = useState<RenderState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });

    void (async () => {
      try {
        const mermaid = await loadMermaid();
        if (cancelled) return;
        const { svg } = await mermaid.render(renderId, source);
        if (!cancelled) setState({ status: 'ready', svg });
      } catch {
        if (!cancelled) setState({ status: 'error' });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [renderId, source]);

  if (state.status === 'loading') {
    return (
      <div
        role="status"
        className="mb-3 flex items-center gap-2 rounded-lg border border-zinc-800 bg-black/50 p-3 text-xs text-zinc-500"
      >
        <Spinner /> Rendering diagram…
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <pre className="mb-3 overflow-x-auto rounded-lg border border-zinc-800 bg-black/50 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
        <code>{source}</code>
      </pre>
    );
  }

  return (
    <div
      className="mb-3 overflow-x-auto rounded-lg border border-zinc-800 bg-zinc-950 p-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
      // Mermaid returns an SVG string. Help docs are repo-controlled and rendered
      // with Mermaid's strict security level.
      dangerouslySetInnerHTML={{ __html: state.svg }}
    />
  );
}
