import {
  AssistantRuntimeProvider,
  MessagePrimitive,
  ThreadPrimitive,
  type AssistantRuntime,
} from '@assistant-ui/react';
import ReactMarkdown, { type Components } from 'react-markdown';
import type { CommandInfo } from './types';
import { Composer } from './Composer';
import { cn } from './ui';

export const markdownComponents: Components = {
  p: ({ children }) => (
    <p className="mb-1.5 text-sm leading-relaxed text-zinc-300 last:mb-0">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="mb-1.5 list-disc pl-4 text-sm text-zinc-300">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-1.5 list-decimal pl-4 text-sm text-zinc-300">{children}</ol>
  ),
  li: ({ children }) => <li className="mb-0.5">{children}</li>,
  code: ({ children }) => (
    <code className="rounded bg-black/40 px-1 py-0.5 font-mono text-[11px] text-zinc-300">
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="mb-2 max-h-64 overflow-auto rounded-lg bg-black/40 p-2 font-mono text-[11px] text-zinc-400">
      {children}
    </pre>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-blue-400 underline">
      {children}
    </a>
  ),
};

function TextPart({ text }: { text: string }) {
  return (
    <div className="break-words">
      <ReactMarkdown components={markdownComponents}>{text}</ReactMarkdown>
    </div>
  );
}

interface ToolCardProps {
  toolName: string;
  argsText?: string;
  result?: string;
  isError?: boolean;
}

function ToolCard({ toolName, argsText, result, isError }: ToolCardProps) {
  return (
    <details className="rounded-lg border border-zinc-800 bg-zinc-950/70 text-xs">
      <summary className="cursor-pointer px-2 py-1.5 text-zinc-400">
        <span className="font-mono text-zinc-300">{toolName}</span>
        {isError ? <span className="ml-2 font-semibold text-red-400">error</span> : null}
      </summary>
      {argsText ? (
        <pre className="max-h-40 overflow-auto border-t border-zinc-800 p-2 font-mono text-[10px] text-zinc-500">
          {argsText}
        </pre>
      ) : null}
      {result ? (
        <pre
          className={cn(
            'max-h-52 overflow-auto border-t border-zinc-800 p-2 font-mono text-[10px]',
            isError ? 'text-red-300' : 'text-zinc-400',
          )}
        >
          {result}
        </pre>
      ) : null}
    </details>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-zinc-800 px-3 py-2">
        <MessagePrimitive.Parts
          components={{
            Text: ({ text }) => <p className="whitespace-pre-wrap text-sm text-zinc-100">{text}</p>,
          }}
        />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-start">
      <div className="max-w-[92%] space-y-2 rounded-2xl rounded-bl-sm border border-zinc-800 bg-zinc-900/50 px-3 py-2">
        <MessagePrimitive.Parts
          components={{
            Text: ({ text }) => <TextPart text={text} />,
            tools: {
              Override: ({ toolName, argsText, result, isError }) => (
                <ToolCard
                  toolName={toolName}
                  argsText={argsText}
                  result={
                    typeof result === 'string'
                      ? result
                      : result === undefined || result === null
                        ? undefined
                        : JSON.stringify(result, null, 2)
                  }
                  isError={isError}
                />
              ),
            },
          }}
        />
      </div>
    </MessagePrimitive.Root>
  );
}

export interface ThreadProps {
  runtime: AssistantRuntime;
  commands: CommandInfo[];
  onSend: (text: string) => void | Promise<void>;
  disabled?: boolean;
  placeholder?: string;
}

/** The chat surface: assistant-ui thread primitives, markdown, tool cards, custom composer. */
export function Thread({ runtime, commands, onSend, disabled, placeholder }: ThreadProps) {
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex h-full flex-col">
        <ThreadPrimitive.Viewport className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
          <ThreadPrimitive.Empty>
            <p className="py-8 text-center text-xs text-zinc-600">No messages yet.</p>
          </ThreadPrimitive.Empty>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </ThreadPrimitive.Viewport>
        <div className="border-t border-zinc-800 p-2">
          <Composer
            commands={commands}
            onSend={onSend}
            disabled={disabled}
            placeholder={placeholder}
          />
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
