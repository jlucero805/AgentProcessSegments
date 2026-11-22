import type { ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentProcess } from '../transport.js';

export interface LineProcessHooks {
  /** Runs before the line is delivered to subscribers (for session capture). */
  onLine?: (line: string) => void;
  /** Runs before exit subscribers (for child bookkeeping). */
  onExit?: (code: number | null) => void;
}

/**
 * Shared plumbing for CLIs that emit one JSON value per stdout line. Subclasses
 * own the spawn/write/kill lifecycle; this class owns handlers and piping.
 */
export abstract class LineProcess implements AgentProcess {
  private readonly lineHandlers: Array<(line: string) => void> = [];
  private readonly exitHandlers: Array<(code: number | null) => void> = [];
  private stderrLines: string[] = [];
  private stderrPartial = '';

  private static readonly MAX_STDERR_LINES = 20;
  private static readonly MAX_STDERR_LINE = 500;

  protected emitLine(line: string): void {
    for (const handler of this.lineHandlers) handler(line);
  }

  protected emitExit(code: number | null): void {
    for (const handler of this.exitHandlers) handler(code);
  }

  protected attach(child: ChildProcess, hooks: LineProcessHooks = {}): void {
    if (child.stdout) {
      createInterface({ input: child.stdout }).on('line', (line) => {
        hooks.onLine?.(line);
        this.emitLine(line);
      });
    }
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      this.captureStderr(chunk.toString());
    });
    child.on('exit', (code) => {
      hooks.onExit?.(code);
      this.emitExit(code);
    });
    child.on('error', (error) => this.emitLine(this.errorLine(error)));
  }

  private captureStderr(text: string): void {
    this.stderrPartial += text;
    const lines = this.stderrPartial.split(/\r?\n/);
    this.stderrPartial = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.slice(0, LineProcess.MAX_STDERR_LINE).trimEnd();
      if (trimmed === '') continue;
      this.stderrLines.push(trimmed);
      if (this.stderrLines.length > LineProcess.MAX_STDERR_LINES) {
        this.stderrLines = this.stderrLines.slice(-LineProcess.MAX_STDERR_LINES);
      }
    }
  }

  recentStderr(): string {
    const lines = [...this.stderrLines];
    const partial = this.stderrPartial.slice(0, LineProcess.MAX_STDERR_LINE).trim();
    if (partial !== '') lines.push(partial);
    return lines.slice(-LineProcess.MAX_STDERR_LINES).join('\n');
  }

  /** Each CLI has its own error-event shape; turn it into one line for the parser. */
  protected abstract errorLine(error: Error): string;

  onLine(handler: (line: string) => void): void {
    this.lineHandlers.push(handler);
  }

  onExit(handler: (code: number | null) => void): void {
    this.exitHandlers.push(handler);
  }

  abstract writeUserMessage(text: string): void;
  abstract kill(signal?: NodeJS.Signals): void;
}
