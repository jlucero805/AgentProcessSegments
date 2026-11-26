import ReactMarkdown from 'react-markdown';
import { markdownComponents } from './Thread';
import type { Summary } from './types';

/** One persisted scorecard report, rendered as markdown. */
export function Scorecard({ summary }: { summary: Summary }) {
  return (
    <div className="break-words rounded-lg border border-zinc-800 bg-black/20 p-3">
      <ReactMarkdown components={markdownComponents}>{summary.content}</ReactMarkdown>
    </div>
  );
}
