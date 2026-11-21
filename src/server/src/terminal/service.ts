import { existsSync, statSync } from 'node:fs';
import os from 'node:os';
import { spawn, type IPty } from 'node-pty';

export interface TerminalOpenOptions {
  cols?: number;
  rows?: number;
  onData: (data: string) => void;
  onExit?: (code: number, signal?: number) => void;
}

export interface TerminalHandle {
  readonly pid: number;
  readonly shell: string;
  readonly cwd: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export class TerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TerminalError';
  }
}

const MAX_SESSIONS = 4;

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
 * Desktop terminal sessions. One PTY per browser socket, independent of the
 * harness agent sessions. Intentionally small: a shell in a configured cwd.
 */
export class TerminalService {
  private readonly active = new Set<IPty>();

  constructor(
    private readonly enabled: boolean,
    private readonly cwd: string,
  ) {}

  status(): { available: boolean; cwd: string } {
    return { available: this.enabled, cwd: directoryOrHome(this.cwd) };
  }

  open(options: TerminalOpenOptions): TerminalHandle {
    if (!this.enabled) throw new TerminalError('terminal is disabled');
    if (this.active.size >= MAX_SESSIONS) {
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
    this.active.add(pty);

    pty.onData((data) => options.onData(data));
    pty.onExit(({ exitCode, signal }) => {
      this.active.delete(pty);
      options.onExit?.(exitCode, signal);
    });

    return {
      pid: pty.pid,
      shell,
      cwd,
      write: (data) => pty.write(data),
      resize: (cols, rows) => {
        try {
          pty.resize(clamp(cols, 20, 500, 100), clamp(rows, 5, 200, 30));
        } catch {
          // The child may have exited between an input and a resize.
        }
      },
      kill: () => {
        this.active.delete(pty);
        try {
          pty.kill();
        } catch {
          // Already gone.
        }
      },
    };
  }
}
