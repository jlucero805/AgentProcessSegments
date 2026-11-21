import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Config } from '../config.js';
import { requestDir } from '../config.js';
import type { ClarifyEvent, Request, TranscriptMsg } from '../domain/request.js';
import type { RequestRepository } from '../requests/repository.js';
import { dispatchPrompt, finalizePrompt, kbSeedPrompt, seedPrompt } from './prompts.js';
import { TurnParser } from './stream.js';
import type { AgentProcess, AgentTransport } from './transport.js';
import { ensureWorktree, removeWorktree } from './worktree.js';

export const KB_SESSION_ID = '__kb__';

const HARNESS_TOOLS = [
  'mcp__harness__update_request',
  'mcp__harness__get_request',
  'mcp__harness__spawn_request',
  'mcp__harness__list_requests',
  'mcp__harness__index_to_kb',
];

const REQUEST_TOOLS = ['Write', 'Read', 'Edit', 'Bash', 'Skill', 'Glob', 'Grep', ...HARNESS_TOOLS];
const KB_TOOLS = ['Read', 'mcp__harness__search_kb', 'mcp__harness__list_kb'];

/** `claude mcp list` prints one `name: command` line per configured server. */
export function parseMcpListServers(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('No MCP servers'))
    .map((line) => line.split(':')[0]?.trim() ?? '')
    .filter((name) => name !== '');
}

export interface LiveTurn {
  readonly events: ClarifyEvent[];
  readonly subscribers: Set<(event: ClarifyEvent) => void>;
  readonly promise: Promise<void>;
  done: boolean;
  resolve: () => void;
  failure: string | null;
}

interface StoredSession {
  sessionId: string;
}

export interface EngineDeps {
  repo: RequestRepository;
  transport: AgentTransport;
  config: Config;
  pluginDirs?: () => string[];
}

export class Engine {
  private readonly turns = new Map<string, LiveTurn>();
  private readonly parsers = new Map<string, TurnParser>();
  private readonly procs = new Map<string, AgentProcess>();

  constructor(private readonly deps: EngineDeps) {}

  private get repo(): RequestRepository {
    return this.deps.repo;
  }

  private get config(): Config {
    return this.deps.config;
  }

  hasLive(id: string): boolean {
    return this.turns.has(id);
  }

  attach(id: string, emit: (event: ClarifyEvent) => void): boolean {
    const turn = this.turns.get(id);
    if (!turn || turn.done) return false;
    for (const event of turn.events) emit(event);
    turn.subscribers.add(emit);
    return true;
  }

  transcript(id: string): TranscriptMsg[] {
    return this.loadTranscript(id);
  }

  async start(id: string): Promise<LiveTurn> {
    const existing = this.turns.get(id);
    if (existing) return existing;

    const request = this.repo.setClarifyStarted(id, true);
    const message = this.readSession(id)
      ? 'Continue grooming this ticket. Ask the next question you need answered.'
      : seedPrompt(request);
    return this.beginTurn(id, message, request);
  }

  async send(id: string, text: string): Promise<LiveTurn> {
    const existing = this.turns.get(id);
    if (existing) return existing;
    const request = this.repo.require(id);
    return this.beginTurn(id, text, request);
  }

  async kickoffDispatch(id: string): Promise<LiveTurn> {
    const existing = this.turns.get(id);
    if (existing) return existing;
    const current = this.repo.require(id);
    const request = current.state === 'dispatch' ? current : this.repo.transition(id, 'dispatch');
    return this.beginTurn(id, dispatchPrompt(request), request);
  }

  async kickoffFinalize(id: string): Promise<LiveTurn> {
    const existing = this.turns.get(id);
    if (existing) return existing;
    const current = this.repo.require(id);
    const request = current.state === 'finalize' ? current : this.repo.transition(id, 'finalize');
    return this.beginTurn(id, finalizePrompt(request), request);
  }

  async startKb(text: string): Promise<LiveTurn> {
    const existing = this.turns.get(KB_SESSION_ID);
    if (existing) return existing;
    const message = this.readSession(KB_SESSION_ID) ? text : `${kbSeedPrompt()}\n\n---\n\n${text}`;
    return this.beginTurn(KB_SESSION_ID, message, null);
  }

  private beginTurn(id: string, message: string, request: Request | null): LiveTurn {
    let resolve = () => {};
    const settled = new Promise<void>((done) => {
      resolve = done;
    });

    const turn: LiveTurn = {
      events: [],
      subscribers: new Set(),
      promise: settled,
      done: false,
      resolve,
      failure: null,
    };

    this.turns.set(id, turn);
    this.parsers.set(id, new TurnParser(this.loadTranscript(id)));
    if (request) this.repo.setAgentStatus(id, 'working');

    void this.runTurn(id, turn, message, request);
    return turn;
  }

  private async runTurn(
    id: string,
    turn: LiveTurn,
    message: string,
    request: Request | null,
  ): Promise<void> {
    const parser = this.parsers.get(id);
    if (!parser) return;

    try {
      const proc = await this.ensureProc(id, request);
      this.appendUserMessage(id, message);
      parser.transcript.push({ role: 'you', kind: 'text', text: message, ts: Date.now() });
      proc.writeUserMessage(message);
      await turn.promise;
      if (turn.failure) this.broadcast(turn, { t: 'error', message: turn.failure });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.broadcast(turn, { t: 'error', message });
    } finally {
      this.finishTurn(id, turn, request);
    }
  }

  private finishTurn(id: string, turn: LiveTurn, request: Request | null): void {
    const parser = this.parsers.get(id);
    const transcript = parser ? parser.finalize() : this.loadTranscript(id);
    this.saveTranscript(id, transcript);

    if (request) {
      this.repo.setAgentStatus(id, 'idle');
      this.repo.setUnchecked(id, true);
    }

    const fresh = this.repo.get(id) ?? null;
    turn.done = true;
    this.broadcast(turn, { t: 'done', request: fresh, transcript });

    this.turns.delete(id);
    this.parsers.delete(id);
  }

  private broadcast(turn: LiveTurn, event: ClarifyEvent): void {
    turn.events.push(event);
    for (const subscriber of turn.subscribers) subscriber(event);
  }

  private consume(id: string, line: string): void {
    const turn = this.turns.get(id);
    const parser = this.parsers.get(id);
    if (!turn || !parser) return;

    for (const event of parser.push(line)) this.broadcast(turn, event);

    if (parser.sessionId && parser.sessionId !== this.readSession(id)) {
      this.writeSession(id, parser.sessionId);
    }

    if (parser.finished) turn.resolve();
  }

  private onExit(id: string, code: number | null): void {
    this.procs.delete(id);
    const turn = this.turns.get(id);
    if (!turn || turn.done) return;
    turn.failure = `agent process exited with code ${code ?? 'unknown'}`;
    turn.resolve();
  }

  private async ensureProc(id: string, request: Request | null): Promise<AgentProcess> {
    const existing = this.procs.get(id);
    if (existing) return existing;

    const dir = requestDir(this.config, id);
    const scratch = path.join(dir, 'cwd');
    mkdirSync(scratch, { recursive: true });

    let cwd = scratch;
    if (request?.targetRepo) {
      const worktree = await ensureWorktree({
        targetRepo: request.targetRepo,
        requestId: id,
        dataDir: this.config.dataDir,
        scratchDir: scratch,
      });
      cwd = worktree.cwd;
      if (worktree.branch !== request.branch) this.repo.setBranch(id, worktree.branch);
    }

    const mcpConfigPath = this.writeMcpConfig(dir, request ? id : '');
    const proc = this.deps.transport.spawn({
      cwd,
      allowedTools: request ? REQUEST_TOOLS : KB_TOOLS,
      sessionId: this.readSession(id),
      model: request?.model ?? null,
      effort: request?.effort ?? null,
      mcpConfigPath,
      pluginDirs: request ? (this.deps.pluginDirs?.() ?? []) : [],
    });

    this.procs.set(id, proc);
    proc.onLine((line) => this.consume(id, line));
    proc.onExit((code) => this.onExit(id, code));
    return proc;
  }

  private writeMcpConfig(dir: string, requestId: string): string | null {
    const serverPath = fileURLToPath(new URL('../mcp/server.js', import.meta.url));
    const configPath = path.join(dir, 'mcp-config.json');
    const config = {
      mcpServers: {
        harness: {
          command: process.execPath,
          args: [serverPath],
          env: {
            SBOX_BRAIN_URL: this.config.brainUrl,
            SBOX_REQUEST_ID: requestId,
          },
        },
      },
    };
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    return configPath;
  }

  private readSession(id: string): string | null {
    try {
      const raw = readFileSync(path.join(requestDir(this.config, id), 'session.json'), 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoredSession>;
      return typeof parsed.sessionId === 'string' ? parsed.sessionId : null;
    } catch {
      return null;
    }
  }

  private writeSession(id: string, sessionId: string): void {
    const dir = requestDir(this.config, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ sessionId }, null, 2));
  }

  private loadTranscript(id: string): TranscriptMsg[] {
    try {
      const raw = readFileSync(path.join(requestDir(this.config, id), 'transcript.json'), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as TranscriptMsg[]) : [];
    } catch {
      return [];
    }
  }

  private saveTranscript(id: string, transcript: TranscriptMsg[]): void {
    const dir = requestDir(this.config, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'transcript.json'), JSON.stringify(transcript, null, 2));
  }

  private appendUserMessage(id: string, text: string): void {
    const transcript = this.loadTranscript(id);
    transcript.push({ role: 'you', kind: 'text', text, ts: Date.now() });
    this.saveTranscript(id, transcript);
  }

  async dispose(id: string): Promise<void> {
    const proc = this.procs.get(id);
    proc?.kill();
    this.procs.delete(id);
    this.turns.delete(id);
    this.parsers.delete(id);

    const request = this.repo.get(id);
    await removeWorktree({
      targetRepo: request?.targetRepo ?? null,
      requestId: id,
      dataDir: this.config.dataDir,
      scratchDir: requestDir(this.config, id),
    });
  }
}
