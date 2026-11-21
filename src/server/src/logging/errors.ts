import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';

export type ErrorContext = Record<string, unknown>;

/** The narrow seam other modules depend on, so tests can pass a no-op sink. */
export interface ErrorSink {
  error(source: string, error: unknown, context?: ErrorContext): void;
}

export interface ErrorLoggerOptions {
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function errorFields(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function safeContext(context: ErrorContext): ErrorContext {
  try {
    JSON.stringify(context);
    return context;
  } catch {
    return { note: 'context was not JSON-serializable' };
  }
}

/**
 * Append-only error log. One JSON object per line, size-rotated to `<path>.1`.
 * Only explicit error paths call this; ordinary logs stay on stderr/nowhere.
 * Logging must never throw into the caller, so every failure is swallowed.
 */
export class ErrorLogger implements ErrorSink {
  private readonly maxBytes: number;

  constructor(
    readonly path: string,
    options: ErrorLoggerOptions = {},
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  error(source: string, error: unknown, context: ErrorContext = {}): void {
    if (this.path === '') return;
    try {
      mkdirSync(path.dirname(this.path), { recursive: true });
      this.rotate();
      const record = {
        at: new Date().toISOString(),
        pid: process.pid,
        source,
        ...errorFields(error),
        context: safeContext(context),
      };
      appendFileSync(this.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {
      // A broken log path must never break the request that was being handled.
    }
  }

  private rotate(): void {
    try {
      if (statSync(this.path).size < this.maxBytes) return;
    } catch {
      return;
    }
    try {
      renameSync(this.path, `${this.path}.1`);
    } catch {
      // If rotation fails, keep appending to the existing file.
    }
  }
}
