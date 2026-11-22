import { useCallback, useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { api, describeError } from './api';
import type { TerminalSessionInfo } from './types';
import { Button, IconButton, cn } from './ui';

interface TerminalPanelProps {
  maximized: boolean;
  onToggleMaximize: () => void;
  onClose: () => void;
  onError: (message: string) => void;
}

type Connection = 'connecting' | 'connected' | 'closed' | 'error';

function wsUrl(sessionId: string, cols: number, rows: number): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const query = new URLSearchParams({
    sessionId,
    cols: String(cols),
    rows: String(rows),
  });
  return `${protocol}//${window.location.host}/ws/terminal?${query.toString()}`;
}

function shortCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/**
 * A server-owned PTY session. Hiding the panel only detaches; the shell stays in
 * the session strip and can be reattached with its scrollback. Explicit close kills it.
 */
export function TerminalPanel({
  maximized,
  onToggleMaximize,
  onClose,
  onError,
}: TerminalPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [sessions, setSessions] = useState<TerminalSessionInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [reconnectKey, setReconnectKey] = useState(0);
  const [loading, setLoading] = useState(true);

  const refreshSessions = useCallback(async () => {
    try {
      const list = await api.getTerminals();
      setSessions(list);
      setActiveId((current) => {
        if (current && list.some((session) => session.id === current)) return current;
        return list[list.length - 1]?.id ?? null;
      });
    } catch (error) {
      onError(describeError(error));
    }
  }, [onError]);

  const newTerminal = useCallback(async () => {
    try {
      const created = await api.createTerminal();
      setSessions((current) => [...current, created]);
      setActiveId(created.id);
    } catch (error) {
      onError(describeError(error));
    }
  }, [onError]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await api.getTerminals();
        if (cancelled) return;
        if (list.length > 0) {
          setSessions(list);
          setActiveId(list[list.length - 1]?.id ?? null);
        } else {
          const created = await api.createTerminal();
          if (cancelled) return;
          setSessions([created]);
          setActiveId(created.id);
        }
      } catch (error) {
        if (!cancelled) onError(describeError(error));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [onError]);

  const active = sessions.find((session) => session.id === activeId) ?? null;

  useEffect(() => {
    if (!activeId) return;
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

    const socket = new WebSocket(wsUrl(activeId, term.cols, term.rows));
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
    const markClosed = (): void => {
      setConnection((current) => (current === 'error' ? current : 'closed'));
      void refreshSessions();
    };

    term.onData((data) => send({ type: 'input', data }));

    socket.onopen = () => setConnection('connected');
    socket.onerror = () => {
      setConnection('error');
      term.write('\r\n\x1b[31mterminal connection failed\x1b[0m\r\n');
    };
    socket.onclose = markClosed;
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as {
          t?: string;
          data?: string;
          message?: string;
          code?: number;
          session?: TerminalSessionInfo;
        };
        if (message.t === 'data' && typeof message.data === 'string') term.write(message.data);
        else if (message.t === 'buffer' && typeof message.data === 'string') term.write(message.data);
        else if (message.t === 'ready' && message.session) {
          setSessions((current) => {
            const next = current.some((item) => item.id === message.session?.id)
              ? current.map((item) => (item.id === message.session?.id ? message.session! : item))
              : [...current, message.session!];
            return next;
          });
        } else if (message.t === 'error') {
          setConnection('error');
          term.write(`\r\n\x1b[31m${message.message ?? 'terminal error'}\x1b[0m\r\n`);
        } else if (message.t === 'exit') {
          term.write(
            `\r\n\x1b[90m[shell exited${message.code == null ? '' : `: ${message.code}`}]\x1b[0m\r\n`,
          );
        } else if (message.t === 'closed') {
          term.write('\r\n\x1b[90m[terminal closed]\x1b[0m\r\n');
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
  }, [activeId, reconnectKey, refreshSessions]);

  async function closeSession(id: string) {
    try {
      await api.closeTerminal(id);
      setSessions((current) => {
        const next = current.filter((session) => session.id !== id);
        if (id === activeId) setActiveId(next[next.length - 1]?.id ?? null);
        return next;
      });
      if (id === activeId) setConnection('closed');
    } catch (error) {
      onError(describeError(error));
    }
  }

  return (
    <section
      className={cn(
        'fixed z-50 hidden flex-col border-t border-zinc-800 bg-zinc-950 shadow-2xl md:flex',
        maximized ? 'inset-0' : 'inset-x-0 bottom-0 h-[45vh] md:left-56',
      )}
      aria-label="Terminal"
    >
      <div className="flex items-center gap-1 overflow-x-auto border-b border-zinc-800 px-2 py-1">
        {sessions.map((session, index) => (
          <div
            key={session.id}
            className={cn(
              'flex shrink-0 items-center gap-1 rounded border px-1 text-[11px]',
              session.id === activeId
                ? 'border-zinc-700 bg-zinc-800 text-zinc-100'
                : 'border-transparent text-zinc-500 hover:bg-zinc-900',
            )}
          >
            <button
              type="button"
              className="flex items-center gap-1 px-1 py-0.5"
              onClick={() => setActiveId(session.id)}
              title={`${session.shell} · ${session.cwd} · pid ${session.pid}`}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  session.alive ? 'bg-emerald-400' : 'bg-zinc-600',
                )}
              />
              #{index + 1} {shortCwd(session.cwd)}
            </button>
            <button
              type="button"
              aria-label={`Close terminal ${index + 1}`}
              className="px-1 text-zinc-600 hover:text-red-400"
              onClick={() => void closeSession(session.id)}
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          aria-label="New terminal"
          className="shrink-0 rounded px-2 py-0.5 text-sm text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          onClick={() => void newTerminal()}
        >
          +
        </button>
      </div>

      <header className="flex items-center gap-2 border-b border-zinc-800 px-3 py-1.5">
        <span className="text-xs font-semibold uppercase tracking-widest text-zinc-400">
          Terminal
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-zinc-600">
          {active ? `${active.shell} · ${active.cwd}` : 'no active terminal'}
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
          disabled={!active}
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
        <IconButton label="Hide terminal panel" onClick={onClose}>
          ×
        </IconButton>
      </header>

      {loading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-zinc-500">
          Loading terminals…
        </div>
      ) : active ? (
        <div
          ref={containerRef}
          className="min-h-0 flex-1 overflow-hidden bg-zinc-950 p-1"
          onClick={() => containerRef.current?.querySelector('textarea')?.focus()}
        />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-xs text-zinc-500">
          <p>No terminal sessions. Hiding keeps sessions alive; closing a tab ends it.</p>
          <Button variant="secondary" size="sm" onClick={() => void newTerminal()}>
            New terminal
          </Button>
        </div>
      )}
    </section>
  );
}
