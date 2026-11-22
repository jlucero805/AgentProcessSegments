import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn, type IPty } from 'node-pty';
import type { TerminalEvent, TerminalSessionInfo } from './types.js';

export type { TerminalEvent, TerminalSessionInfo } from './types.js';

export interface TerminalOpenOptions {
  cols?: number;
  rows?: number;
}

export interface TerminalAttachment {
  session: TerminalSessionInfo;
  /** Bounded scrollback, oldest first. */
  buffer: string;
  detach: () => void;
}

export class TerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalError';
  }
}

const MAX_SESSIONS = 4;
const MAX_BUFFER = 200_000;

interface Session {
  info: Omit<TerminalSessionInfo, 'attached'>;
  pty: IPty;
  buffer: string;
  listeners: Set<(event: TerminalEvent) => void>;
}

function directoryOrHome(cwd: string): string {
  try {
    if (existsSync(cwd) && statSync(cwd).isDirectory()) return cwd;
  } catch {
    // Fall through to home.
  }
  return os.homedir();
}

function shellPath(): string {
  const candidates = [process.env.SHELL, '/bin/bash', '/bin/zsh', '/bin/sh'];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return '/bin/sh';
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Server-owned PTY sessions. A browser WebSocket attaches and detaches; hiding the
 * panel or losing the connection never kills the shell. Sessions stay visible in the
 * terminal list until an explicit close or the brain exits.
 */
export class TerminalService {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly enabled: boolean,
    private readonly cwd: string,
  ) {}

  status(): { available: boolean; cwd: string; sessions: number } {
    return {
      available: this.enabled,
      cwd: directoryOrHome(this.cwd),
      sessions: this.sessions.size,
    };
  }

  list(): TerminalSessionInfo[] {
    return [...this.sessions.values()]
      .map((session) => this.info(session))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  create(options: TerminalOpenOptions = {}): TerminalSessionInfo {
    if (!this.enabled) throw new TerminalError('terminal is disabled');
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new TerminalError(`too many terminals (max ${MAX_SESSIONS})`);
    }

    const shell = shellPath();
    const cwd = directoryOrHome(this.cwd);
    const pty = spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: clamp(options.cols, 20, 500, 100),
      rows: clamp(options.rows, 5, 200, 30),
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    });

    const id = randomUUID();
    const now = Date.now();
    const session: Session = {
      info: {
        id,
        pid: pty.pid,
        shell,
        cwd,
        createdAt: now,
        lastActivityAt: now,
        alive: true,
        exitCode: null,
      },
      pty,
      buffer: '',
      listeners: new Set(),
    };
    this.sessions.set(id, session);

    pty.onData((data) => {
      session.info.lastActivityAt = Date.now();
      session.buffer = `${session.buffer}${data}`.slice(-MAX_BUFFER);
      this.emit(session, { t: 'data', data });
    });
    pty.onExit(({ exitCode }) => {
      session.info.alive = false;
      session.info.exitCode = exitCode;
      this.emit(session, { t: 'exit', code: exitCode });
    });

    return this.info(session);
  }

  attach(id: string, listener: (event: TerminalEvent) => void): TerminalAttachment | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    session.listeners.add(listener);
    session.info.lastActivityAt = Date.now();
    return {
      session: this.info(session),
      buffer: session.buffer,
      detach: () => {
        session.listeners.delete(listener);
      },
    };
  }

  write(id: string, data: string): void {
    const session = this.sessions.get(id);
    if (!session || !session.info.alive) return;
    session.info.lastActivityAt = Date.now();
    session.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (!session || !session.info.alive) return;
    try {
      session.pty.resize(clamp(cols, 20, 500, 100), clamp(rows, 5, 200, 30));
    } catch {
      // The child may have exited between an input and a resize.
    }
  }

  close(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.sessions.delete(id);
    this.emit(session, { t: 'closed' });
    try {
      session.pty.kill();
    } catch {
      // Already gone.
    }
    return true;
  }

  closeAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }

  private info(session: Session): TerminalSessionInfo {
    return { ...session.info, attached: session.listeners.size };
  }

  private emit(session: Session, event: TerminalEvent): void {
    for (const listener of [...session.listeners]) {
      try {
        listener(event);
      } catch {
        // A broken client must not take down the PTY or other clients.
      }
    }
  }
}
