import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface SpawnOptions {
  cwd: string;
  allowedTools: string[];
  sessionId?: string | null;
  model?: string | null;
  effort?: string | null;
  mcpConfigPath?: string | null;
  pluginDirs?: string[];
  env?: Record<string, string>;
}

export interface AgentProcess {
  writeUserMessage(text: string): void;
  kill(signal?: NodeJS.Signals): void;
  onLine(handler: (line: string) => void): void;
  onExit(handler: (code: number | null) => void): void;
}

export interface AgentTransport {
  spawn(options: SpawnOptions): AgentProcess;
}

function buildArgs(options: SpawnOptions): string[] {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--allowedTools',
    options.allowedTools.join(','),
  ];

  if (options.mcpConfigPath) {
    args.push('--mcp-config', options.mcpConfigPath, '--strict-mcp-config');
  }
  if (options.model) args.push('--model', options.model);
  if (options.effort) args.push('--effort', options.effort);
  if (options.sessionId) args.push('--resume', options.sessionId);
  for (const dir of options.pluginDirs ?? []) args.push('--plugin-dir', dir);

  return args;
}

/** Shells out to the `claude` CLI. The binary is an external install, never vendored. */
export class ClaudeCliTransport implements AgentTransport {
  constructor(private readonly bin = 'claude') {}

  spawn(options: SpawnOptions): AgentProcess {
    const child = spawn(this.bin, buildArgs(options), {
      cwd: options.cwd,
      env: {
        ...process.env,
        CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1',
        ...options.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const lineHandlers: Array<(line: string) => void> = [];
    const exitHandlers: Array<(code: number | null) => void> = [];

    createInterface({ input: child.stdout }).on('line', (line) => {
      for (const handler of lineHandlers) handler(line);
    });
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.on('exit', (code) => {
      for (const handler of exitHandlers) handler(code);
    });
    child.on('error', (error) => {
      for (const handler of lineHandlers) {
        handler(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: error.message }));
      }
    });

    return {
      writeUserMessage(text: string) {
        const payload = { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } };
        child.stdin.write(`${JSON.stringify(payload)}\n`);
      },
      kill(signal = 'SIGTERM') {
        child.kill(signal);
      },
      onLine(handler) {
        lineHandlers.push(handler);
      },
      onExit(handler) {
        exitHandlers.push(handler);
      },
    };
  }
}

/** Test double. Scripted lines replace the CLI so the turn engine is verifiable. */
export class FakeAgentProcess implements AgentProcess {
  readonly messages: string[] = [];
  killed = false;

  private readonly lineHandlers: Array<(line: string) => void> = [];
  private readonly exitHandlers: Array<(code: number | null) => void> = [];

  constructor(private readonly respond: (text: string) => string[] = () => []) {}

  writeUserMessage(text: string): void {
    this.messages.push(text);
    const lines = this.respond(text);
    if (lines.length === 0) return;
    queueMicrotask(() => {
      for (const line of lines) this.emit(line);
    });
  }

  kill(): void {
    this.killed = true;
  }

  onLine(handler: (line: string) => void): void {
    this.lineHandlers.push(handler);
  }

  onExit(handler: (code: number | null) => void): void {
    this.exitHandlers.push(handler);
  }

  emit(line: string): void {
    for (const handler of this.lineHandlers) handler(line);
  }

  emitExit(code: number | null): void {
    for (const handler of this.exitHandlers) handler(code);
  }
}

export class FakeTransport implements AgentTransport {
  readonly spawns: SpawnOptions[] = [];
  process: FakeAgentProcess | null = null;

  constructor(private readonly respond: (text: string) => string[] = () => []) {}

  spawn(options: SpawnOptions): AgentProcess {
    this.spawns.push(options);
    this.process = new FakeAgentProcess(this.respond);
    return this.process;
  }
}
