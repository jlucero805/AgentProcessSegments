import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { CommandInfo } from './types';
import { Button, cn } from './ui';

export interface ComposerProps {
  commands?: CommandInfo[];
  onSend: (text: string) => void | Promise<void>;
  disabled?: boolean;
  placeholder?: string;
}

/** Custom composer with slash-command autocomplete driven by GET /api/commands. */
export function Composer({ commands = [], onSend, disabled, placeholder }: ComposerProps) {
  const [value, setValue] = useState('');
  const [highlight, setHighlight] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const suggestions = useMemo(() => {
    if (!value.startsWith('/') || value.includes(' ') || value.includes('\n')) return [];
    const query = value.slice(1).toLowerCase();
    return commands
      .filter((command) => command.command.toLowerCase().includes(query))
      .slice(0, 8);
  }, [value, commands]);

  function choose(command: string) {
    setValue(`/${command}`);
    setHighlight(0);
    textareaRef.current?.focus();
  }

  function submit() {
    const text = value.trim();
    if (!text || disabled) return;
    setValue('');
    void onSend(text);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (suggestions.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlight((index) => (index + 1) % suggestions.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlight((index) => (index - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        choose(suggestions[highlight].command);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <div className="relative">
      {suggestions.length > 0 ? (
        <div className="absolute bottom-full left-0 right-0 mb-1 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 shadow-xl">
          {suggestions.map((suggestion, index) => (
            <button
              key={`${suggestion.plugin}:${suggestion.command}`}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                choose(suggestion.command);
              }}
              className={cn(
                'flex w-full items-baseline gap-2 px-2 py-1.5 text-left text-xs',
                index === highlight ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900',
              )}
            >
              <span className="font-mono">/{suggestion.command}</span>
              <span className="truncate text-[11px] text-zinc-500">{suggestion.description}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          rows={2}
          value={value}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder ?? 'Ask a question...'}
          className="min-h-[2.5rem] flex-1 resize-none rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-500 focus:outline-none disabled:opacity-50"
        />
        <Button
          variant="primary"
          size="sm"
          disabled={disabled || value.trim() === ''}
          onClick={submit}
        >
          Send
        </Button>
      </div>
      <p className="mt-1 text-[10px] text-zinc-600">
        Enter to send · Shift+Enter for a newline · / for commands
      </p>
    </div>
  );
}
