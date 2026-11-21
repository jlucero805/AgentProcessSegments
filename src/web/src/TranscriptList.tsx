import type { TranscriptMsg } from './types';
import { EmptyState, cn } from './ui';

/** Read-only transcript used once a request reaches a terminal state. */
export function TranscriptList({ transcript }: { transcript: TranscriptMsg[] }) {
  if (transcript.length === 0) {
    return <EmptyState title="No agent output yet" hint="Start a step to see the transcript." />;
  }
  return (
    <div className="space-y-2">
      {transcript.map((message, index) => (
        <div
          key={`${message.ts}-${index}`}
          className={cn(
            'rounded-lg border p-2 text-xs',
            message.role === 'you'
              ? 'border-zinc-800 bg-zinc-900/60'
              : 'border-zinc-900 bg-zinc-950',
          )}
        >
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            {message.role === 'you'
              ? 'You'
              : message.kind === 'tool'
                ? message.toolName ?? 'Tool'
                : 'Agent'}
          </div>
          <pre className="whitespace-pre-wrap font-sans text-zinc-300">
            {message.kind === 'tool' ? message.toolInput ?? '' : message.text}
          </pre>
          {message.toolResult ? (
            <pre className="mt-1 max-h-40 overflow-auto rounded bg-black/40 p-1.5 font-mono text-[10px] text-zinc-500">
              {message.toolResult}
            </pre>
          ) : null}
        </div>
      ))}
    </div>
  );
}
