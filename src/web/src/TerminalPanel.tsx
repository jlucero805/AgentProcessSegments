import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Button, IconButton, cn } from './ui';

interface TerminalPanelProps {
  maximized: boolean;
  onToggleMaximize: () => void;
  onClose: () => void;
}

type Connection = 'connecting' | 'connected' | 'closed' | 'error';

function wsUrl(cols: number, rows: number): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws/terminal?cols=${cols}&rows=${rows}`;
}

/**
 * A real PTY in the browser, independent of every harness/agent session.
 * Desktop-only; the app hides the trigger and this panel below `md`.
 */
export function TerminalPanel({ maximized, onToggleMaximize, onClose }: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [reconnectKey, setReconnectKey] = useState(0);
  const [cwd, setCwd] = useState('');

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: {
        background: '#09090b',
        foreground: '#d4d4d8',
        cursor: '#a1a1aa',
        selectionBackground: '#3f3f46',
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    try {
      fit.fit();
    } catch {
      // The panel may mount while its height is still settling.
    }

    const socket = new WebSocket(wsUrl(term.cols, term.rows));
    setConnection('connecting');

    const send = (value: unknown): void => {
      if (socket.readyState === 1) socket.send(JSON.stringify(value));
    };
    const resize = (): void => {
      try {
        fit.fit();
        send({ type: 'resize', cols: term.cols, rows: term.rows });
      } catch {
        // Ignore a resize before layout.
      }
    };

    term.onData((data) => send({ type: 'input', data }));

    socket.onopen = () => setConnection('connected');
    socket.onerror = () => {
      setConnection('error');
      term.write('\r\n\x1b[31mterminal connection failed\x1b[0m\r\n');
    };
    socket.onclose = () => setConnection((current) => (current === 'error' ? current : 'closed'));
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as {
          t?: string;
          data?: string;
          cwd?: string;
          message?: string;
          code?: number;
        };
        if (message.t === 'data' && typeof message.data === 'string') term.write(message.data);
        else if (message.t === 'ready' && message.cwd) setCwd(message.cwd);
        else if (message.t === 'error') {
          setConnection('error');
          term.write(`\r\n\x1b[31m${message.message ?? 'terminal error'}\x1b[0m\r\n`);
        } else if (message.t === 'exit') {
          term.write(`\r\n\x1b[90m[shell exited${message.code === undefined ? '' : `: ${message.code}`}]\x1b[0m\r\n`);
        }
      } catch {
        // Ignore malformed frames.
      }
    };

    const observer = new ResizeObserver(resize);
    observer.observe(container);
    window.addEventListener('resize', resize);
    term.focus();

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resize);
      socket.close();
      term.dispose();
    };
  }, [reconnectKey]);

  return (
    <section
      className={cn(
        'fixed z-50 hidden flex-col border-t border-zinc-800 bg-zinc-950 shadow-2xl md:flex',
        maximized ? 'inset-0' : 'inset-x-0 bottom-0 h-[45vh] md:left-56',
      )}
      aria-label="Terminal"
    >
      <header className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
        <span className="text-xs font-semibold uppercase tracking-widest text-zinc-400">
          Terminal
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-zinc-600">
          {cwd || 'starting shell…'}
        </span>
        <span
          className={cn(
            'text-[10px]',
            connection === 'connected'
              ? 'text-emerald-400'
              : connection === 'error'
                ? 'text-red-400'
                : 'text-amber-400',
          )}
        >
          {connection}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setReconnectKey((key) => key + 1)}
        >
          Reconnect
        </Button>
        <IconButton
          label={maximized ? 'Restore terminal' : 'Maximize terminal'}
          onClick={onToggleMaximize}
        >
          {maximized ? '⤡' : '⤢'}
        </IconButton>
        <IconButton label="Close terminal" onClick={onClose}>
          ×
        </IconButton>
      </header>
      <div
        ref={containerRef}
        className="min-h-0 flex-1 overflow-hidden bg-zinc-950 p-1"
        onClick={() => containerRef.current?.querySelector('textarea')?.focus()}
      />
    </section>
  );
}
