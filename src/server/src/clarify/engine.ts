import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.js';
import { requestDir } from '../config.js';
import {
  isHarnessId,
  resolveHarness,
  type HarnessChoice,
  type HarnessId,
} from '../domain/harness.js';
import type { ClarifyEvent, Effort, Request, TranscriptMsg } from '../domain/request.js';
import {
  KB_SESSION_ID,
  MASTER_SESSION_ID,
  isSetupSession,
  masterCellId,
  setupDraftId,
  summaryCellId,
} from '../domain/sessions.js';
import type { ErrorSink } from '../logging/errors.js';
import type { RequestRepository } from '../requests/repository.js';
import { errorMessage } from '../util/errors.js';
import type { AgentHarness, TurnParserLike } from './harness.js';
import {
  dispatchPrompt,
  finalizePrompt,
  kbSeedPrompt,
  masterSeedPrompt,
  seedPrompt,
  setupSeedPrompt,
  summarySeedPrompt,
} from './prompts.js';
import type { AgentProcess } from './transport.js';
import { ensureWorktree, removeWorktree } from './worktree.js';

export {
  KB_SESSION_ID,
  MASTER_SESSION_ID,
  SETUP_SESSION_PREFIX,
  isMasterSession,
  isSetupSession,
  isVirtualSessionId,
  masterCellId,
  masterSessionId,
  setupDraftId,
  setupSessionId,
} from '../domain/sessions.js';

export interface LiveTurn {
  readonly events: ClarifyEvent[];
  readonly subscribers: Set<(event: ClarifyEvent) => void>;
  readonly promise: Promise<void>;
  done: boolean;
  cancelled: boolean;
  resolve: () => void;
  failure: string | null;
}

interface StoredSession {
  sessionId: string;
  /** Legacy files have no harness; they belong to the process default. */
  harness: HarnessId | null;
}

/** The per-id adapter cache the engine resolves against. */
export interface HarnessSource {
  readonly defaultId: HarnessId;
  get(id: HarnessId): AgentHarness;
}

export interface EngineDeps {
  repo: RequestRepository;
  harnesses: HarnessSource;
  config: Config;
  pluginDirs?: () => string[];
  /** Cell-level defaults; a request's own values win. */
  cellDefaults?: (
    cellId: string,
  ) => { model: string | null; effort: Effort | null; harness?: HarnessId | null } | null;
  /** Error-only sink; ordinary transcript/turn logs are not persisted here. */
  errors?: ErrorSink;
}

export class Engine {
  private readonly turns = new Map<string, LiveTurn>();
  private readonly parsers = new Map<string, TurnParserLike>();
  private readonly procs = new Map<string, AgentProcess>();
  private readonly procHarnesses = new Map<string, HarnessId>();
  private readonly turnHarnesses = new Map<string, HarnessId>();
  private readonly watchdogs = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: EngineDeps) {}

  private get repo(): RequestRepository {
    return this.deps.repo;
  }

  private get harnesses(): HarnessSource {
    return this.deps.harnesses;
  }

  private get config(): Config {
    return this.deps.config;
  }

  hasLive(id: string): boolean {
    return this.turns.has(id);
  }

  /**
   * Stop a live turn without disposing the session. The partial transcript is
   * finished and saved; the saved session id is reused by the next message.
   */
  cancel(id: string): boolean {
    const turn = this.turns.get(id);
    if (!turn || turn.done) return false;

    turn.cancelled = true;
    this.clearWatchdog(id);
    const proc = this.procs.get(id);
    this.procs.delete(id);
    this.procHarnesses.delete(id);
    if (proc) {
      proc.kill('SIGTERM');
      const force = setTimeout(() => proc.kill('SIGKILL'), 2_000);
      force.unref();
    }
    // Finish now even if the harness is still stuck inside `prepare()`. The
    // later `runTurn` continuation sees `turn.done` and only cleans up.
    this.finishTurn(id, turn, this.repo.get(id) ?? null);
    turn.resolve();
    return true;
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

  async start(id: string, extraPrompt = ''): Promise<LiveTurn> {
    const existing = this.turns.get(id);
    if (existing) return existing;

    const request = this.repo.setClarifyStarted(id, true);
    const savedSession = this.sessionIdFor(id, this.resolveChoice(id, request).harness);
    const base = savedSession
      ? 'Continue grooming this ticket. Ask the next question you need answered.'
      : seedPrompt(request);
    const extra = extraPrompt.trim();
    // An enabled intake segment contributes its prompt to the first turn. This
    // is how a cell can add repo identity and standing context before planning.
    const message = !savedSession && extra !== ''
      ? `${base}\n\nAdditional process instructions:\n${extra}`
      : base;
    return this.beginTurn(id, message, request);
  }

  async send(id: string, text: string): Promise<LiveTurn> {
    const existing = this.turns.get(id);
    if (existing) return existing;
    // Sending the first message is starting clarify, even if `/start` was skipped.
    const request = this.repo.setClarifyStarted(id, true);
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
    const saved = this.sessionIdFor(KB_SESSION_ID, this.resolveChoice(KB_SESSION_ID, null).harness);
    const message = saved ? text : `${kbSeedPrompt()}\n\n---\n\n${text}`;
    return this.beginTurn(KB_SESSION_ID, message, null);
  }

  /** Chat with a cell master. Advisory and read-only; the scheduler notes into it. */
  async startMaster(
    text: string,
    sessionId: string = MASTER_SESSION_ID,
    context?: string,
  ): Promise<LiveTurn> {
    const existing = this.turns.get(sessionId);
    if (existing) return existing;
    const saved = this.sessionIdFor(sessionId, this.resolveChoice(sessionId, null).harness);
    const message = saved
      ? text.trim() === ''
        ? 'Report the current board state and what this cell master has been doing.'
        : text
      : `${masterSeedPrompt(context)}\n\n---\n\n${text}`;
    return this.beginTurn(sessionId, message, null);
  }

  /** Internal scorecard generator. Read-only and separate from the master chat. */
  async startSummary(
    text: string,
    sessionId: string,
    context?: string,
  ): Promise<LiveTurn> {
    const existing = this.turns.get(sessionId);
    if (existing) return existing;
    const saved = this.sessionIdFor(sessionId, this.resolveChoice(sessionId, null).harness);
    const message = saved
      ? text
      : `${summarySeedPrompt(context)}\n\n---\n\n${text}`;
    return this.beginTurn(sessionId, message, null);
  }

  /** Transient cell-setup chat used by the creation wizard. */
  async startSetup(text: string, sessionId: string): Promise<LiveTurn> {
    const existing = this.turns.get(sessionId);
    if (existing) return existing;
    const saved = this.sessionIdFor(sessionId, this.resolveChoice(sessionId, null).harness);
    const message = saved
      ? text.trim() === ''
        ? 'Suggest sane defaults for the cell I am creating.'
        : text
      : `${setupSeedPrompt()}\n\n---\n\n${text}`;
    return this.beginTurn(sessionId, message, null);
  }

  /** Append a master log line to its chat without starting a model turn. */
  note(id: string, text: string): void {
    const trimmed = text.trim();
    if (trimmed === '') return;
    const parser = this.parsers.get(id);
    const entry: TranscriptMsg = {
      role: 'agent',
      kind: 'text',
      text: trimmed,
      ts: Date.now(),
    };
    const transcript = parser ? parser.transcript : this.loadTranscript(id);
    if (parser) parser.transcript.push(entry);
    else transcript.push(entry);
    this.saveTranscript(id, transcript);
    const turn = this.turns.get(id);
    if (turn) this.broadcast(turn, { t: 'text', text: trimmed });
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
      cancelled: false,
      resolve,
      failure: null,
    };

    this.turns.set(id, turn);
    const choice = this.resolveChoice(id, request);
    this.turnHarnesses.set(id, choice.harness);
    this.parsers.set(id, this.harnesses.get(choice.harness).createParser(this.loadTranscript(id)));
    if (request) this.repo.setAgentStatus(id, 'working');
    this.armWatchdog(id, turn, request);

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
      if (turn.cancelled || turn.done) {
        proc.kill();
        this.procs.delete(id);
        this.procHarnesses.delete(id);
        return;
      }
      this.appendUserMessage(id, message);
      parser.transcript.push({ role: 'you', kind: 'text', text: message, ts: Date.now() });
      proc.writeUserMessage(message);
      await turn.promise;
      if (turn.failure && !turn.cancelled) this.broadcast(turn, { t: 'error', message: turn.failure });
    } catch (error) {
      if (!turn.done && !turn.cancelled) {
        this.deps.errors?.error('engine.turn', error, { session: id });
        const message = errorMessage(error);
        turn.failure = message;
        this.broadcast(turn, { t: 'error', message });
      }
    } finally {
      this.finishTurn(id, turn, request);
    }
  }

  private finishTurn(id: string, turn: LiveTurn, request: Request | null): void {
    if (turn.done) return;
    this.clearWatchdog(id);
    const parser = this.parsers.get(id);
    const transcript = parser ? parser.finalize() : this.loadTranscript(id);
    const failure = turn.failure;
    if (
      failure &&
      !transcript.some((message) => message.kind === 'text' && message.text.includes(failure))
    ) {
      transcript.push({
        role: 'agent',
        kind: 'text',
        text: `⚠ ${failure}`,
        ts: Date.now(),
      });
    }
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
    this.turnHarnesses.delete(id);
  }

  private broadcast(turn: LiveTurn, event: ClarifyEvent): void {
    turn.events.push(event);
    for (const subscriber of turn.subscribers) subscriber(event);
  }

  private armWatchdog(id: string, turn: LiveTurn, request: Request | null): void {
    const timeoutMs = this.config.turnTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
    const timer = setTimeout(() => this.timeoutTurn(id, turn, request, timeoutMs), timeoutMs);
    timer.unref();
    this.watchdogs.set(id, timer);
  }

  private clearWatchdog(id: string): void {
    const timer = this.watchdogs.get(id);
    if (!timer) return;
    clearTimeout(timer);
    this.watchdogs.delete(id);
  }

  private timeoutTurn(
    id: string,
    turn: LiveTurn,
    request: Request | null,
    timeoutMs: number,
  ): void {
    if (turn.done || turn.cancelled) return;
    const proc = this.procs.get(id);
    const stderr = proc?.recentStderr().trim() ?? '';
    const label = timeoutMs < 1_000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1_000)}s`;
    const message = `agent turn timed out after ${label}${stderr ? `\nstderr:\n${stderr}` : ''}`;
    turn.failure = message;
    // Mark it cancelled so `runTurn` does not broadcast the same failure twice.
    turn.cancelled = true;
    this.deps.errors?.error('engine.timeout', new Error(message), {
      session: id,
      timeoutMs,
      ...(stderr ? { stderr } : {}),
    });
    this.broadcast(turn, { t: 'error', message });
    if (proc) {
      this.procs.delete(id);
      this.procHarnesses.delete(id);
      proc.kill('SIGTERM');
      const force = setTimeout(() => proc.kill('SIGKILL'), 2_000);
      force.unref();
    }
    // A child that is stuck in `prepare()` may never resolve; finish the turn
    // here so the stream always receives `done`.
    this.finishTurn(id, turn, request);
    turn.resolve();
  }

  private consume(id: string, line: string): void {
    const turn = this.turns.get(id);
    const parser = this.parsers.get(id);
    if (!turn || !parser) return;

    for (const event of parser.push(line)) this.broadcast(turn, event);

    const harness = this.turnHarnesses.get(id) ?? this.harnesses.defaultId;
    if (parser.sessionId && this.sessionIdFor(id, harness) !== parser.sessionId) {
      this.writeSession(id, parser.sessionId, harness);
    }

    if (parser.finished) turn.resolve();
  }

  private onExit(id: string, proc: AgentProcess, code: number | null): void {
    if (this.procs.get(id) !== proc) return;
    const stderr = proc.recentStderr().trim() ?? '';
    this.procs.delete(id);
    this.procHarnesses.delete(id);
    const turn = this.turns.get(id);
    // A harness whose process ends after its final event has already finished
    // the turn normally; only an exit before completion is a failure.
    if (!turn || turn.done || turn.cancelled || this.parsers.get(id)?.finished) return;
    turn.failure = `agent process exited with code ${code ?? 'unknown'}${
      stderr ? `\nstderr:\n${stderr}` : ''
    }`;
    this.deps.errors?.error('engine.exit', new Error(turn.failure), {
      session: id,
      code,
      ...(stderr ? { stderr } : {}),
    });
    turn.resolve();
  }

  private resolveChoice(id: string, request: Request | null): HarnessChoice {
    const cellId = request?.cellId ?? masterCellId(id) ?? summaryCellId(id);
    const cell = cellId ? (this.deps.cellDefaults?.(cellId)?.harness ?? null) : null;
    return resolveHarness({
      request: request?.harness ?? null,
      cell,
      process: this.harnesses.defaultId,
    });
  }

  private async ensureProc(id: string, request: Request | null): Promise<AgentProcess> {
    const harness = this.turnHarnesses.get(id) ?? this.resolveChoice(id, request).harness;
    const adapter = this.harnesses.get(harness);

    const existing = this.procs.get(id);
    if (existing) {
      if (this.procHarnesses.get(id) === harness) return existing;
      // A harness change must not reuse a child from the old adapter.
      this.procs.delete(id);
      this.procHarnesses.delete(id);
      existing.kill('SIGTERM');
    }

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

    const cellId = request?.cellId ?? masterCellId(id) ?? summaryCellId(id);
    const defaults = cellId ? (this.deps.cellDefaults?.(cellId) ?? null) : null;
    const cellHarness = defaults?.harness ?? null;
    const cellEffective = cellHarness ?? this.harnesses.defaultId;
    const inheritsCell = cellEffective === harness;
    const model =
      request?.model ??
      (inheritsCell ? defaults?.model ?? null : null) ??
      this.config.defaultModels[harness] ??
      null;
    const effort =
      harness === 'claude'
        ? (request?.effort ?? (inheritsCell ? defaults?.effort ?? null : null))
        : null;
    const draftId = isSetupSession(id) ? (setupDraftId(id) ?? undefined) : undefined;

    const command = await adapter.prepare({
      scope: request ? 'request' : id === KB_SESSION_ID ? 'kb' : draftId ? 'setup' : 'master',
      requestId: request ? id : '',
      ...(draftId ? { draftId } : {}),
      dir,
      cwd,
      sessionId: this.sessionIdFor(id, harness),
      model,
      effort,
      pluginDirs: request ? (this.deps.pluginDirs?.() ?? []) : [],
    });
    const proc = adapter.spawn(command);

    this.procs.set(id, proc);
    this.procHarnesses.set(id, harness);
    proc.onLine((line) => {
      if (this.procs.get(id) === proc) this.consume(id, line);
    });
    proc.onExit((code) => this.onExit(id, proc, code));
    return proc;
  }

  private readStoredSession(id: string): StoredSession | null {
    try {
      const raw = readFileSync(path.join(requestDir(this.config, id), 'session.json'), 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoredSession>;
      if (typeof parsed.sessionId !== 'string') return null;
      return {
        sessionId: parsed.sessionId,
        harness: isHarnessId(parsed.harness) ? parsed.harness : null,
      };
    } catch {
      return null;
    }
  }

  private sessionIdFor(id: string, harness: HarnessId): string | null {
    const stored = this.readStoredSession(id);
    if (!stored) return null;
    const storedHarness = stored.harness ?? this.harnesses.defaultId;
    return storedHarness === harness ? stored.sessionId : null;
  }

  private writeSession(id: string, sessionId: string, harness: HarnessId): void {
    const dir = requestDir(this.config, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'session.json'),
      JSON.stringify({ harness, sessionId }, null, 2),
    );
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
    const turn = this.turns.get(id);
    const request = this.repo.get(id);
    this.clearWatchdog(id);
    proc?.kill();
    this.procs.delete(id);
    this.procHarnesses.delete(id);

    if (turn && !turn.done) {
      // A terminal route can dispose a live turn. Finish it so the stream gets
      // `done` and the maps are cleaned up even if the harness is stuck.
      turn.cancelled = true;
      this.finishTurn(id, turn, request);
      turn.resolve();
    } else {
      this.turns.delete(id);
      this.parsers.delete(id);
      this.turnHarnesses.delete(id);
    }

    await removeWorktree({
      targetRepo: request?.targetRepo ?? null,
      requestId: id,
      dataDir: this.config.dataDir,
      scratchDir: requestDir(this.config, id),
    });
  }
}
