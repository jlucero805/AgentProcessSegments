import { useCallback, useEffect, useState } from 'react';
import { api, describeError } from './api';
import { ClarifyChat } from './ClarifyChat';
import { KB_SESSION_ID, type CommandInfo, type KbEntry } from './types';
import { EmptyState, Input, Spinner, cn } from './ui';

interface KbEntriesProps {
  commands: CommandInfo[];
  onError: (message: string) => void;
}

/** Knowledge base: literal search over approved digests, plus a read-only KB chat. */
export function KbEntries({ commands, onError }: KbEntriesProps) {
  const [entries, setEntries] = useState<KbEntry[]>([]);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<KbEntry | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (q: string) => {
      try {
        setEntries(await api.getKb(q || undefined));
      } catch (error) {
        onError(describeError(error));
      } finally {
        setLoading(false);
      }
    },
    [onError],
  );

  useEffect(() => {
    void load('');
  }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(query), 250);
    return () => window.clearTimeout(timer);
  }, [query, load]);

  return (
    <div className="flex h-full">
      <section className="flex w-[22rem] shrink-0 flex-col border-r border-zinc-900">
        <div className="border-b border-zinc-900 p-3">
          <h1 className="mb-2 text-sm font-semibold text-zinc-100">Knowledge base</h1>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search entries..."
          />
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
          {loading ? (
            <div className="flex items-center gap-2 p-2 text-xs text-zinc-500">
              <Spinner /> Loading entries...
            </div>
          ) : entries.length === 0 ? (
            <EmptyState title="No entries" hint="Index a finalized request to add one." />
          ) : (
            entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setSelected(entry)}
                className={cn(
                  'w-full rounded-lg border p-2 text-left transition-colors',
                  selected?.id === entry.id
                    ? 'border-zinc-700 bg-zinc-800/70'
                    : 'border-transparent hover:bg-zinc-900',
                )}
              >
                <p className="truncate text-sm text-zinc-200">{entry.title}</p>
                <p className="mt-1 line-clamp-2 text-[11px] leading-snug text-zinc-600">
                  {entry.content.slice(0, 160)}
                </p>
              </button>
            ))
          )}
        </div>
      </section>

      <section className="grid min-h-0 flex-1 grid-rows-[1fr_auto]">
        <div className="overflow-y-auto p-6">
          {selected ? (
            <article className="mx-auto max-w-3xl">
              <h2 className="text-lg font-semibold text-zinc-100">{selected.title}</h2>
              <p className="mt-1 text-[11px] text-zinc-600">
                {new Date(selected.createdAt).toLocaleString()} · request{' '}
                <span className="font-mono">{selected.requestId.slice(0, 8)}</span>
              </p>
              <pre className="mt-4 whitespace-pre-wrap font-sans text-sm leading-relaxed text-zinc-300">
                {selected.content}
              </pre>
            </article>
          ) : (
            <EmptyState title="Select an entry" hint="Or ask the knowledge base below." />
          )}
        </div>
        <div className="h-60 border-t border-zinc-900 p-3">
          <ClarifyChat
            requestId={KB_SESSION_ID}
            started
            commands={commands}
            onError={onError}
            placeholder="Ask the knowledge base..."
          />
        </div>
      </section>
    </div>
  );
}
