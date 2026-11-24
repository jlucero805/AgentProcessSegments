import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import { requestDir } from '../config.js';
import type { SpendPause } from '../domain/budget.js';
import { isHarnessId, resolveHarness as resolveHarnessOrder, type HarnessId } from '../domain/harness.js';
import {
  clipNotificationText,
  type TurnFailureNotification,
  type TurnFailureSource,
} from '../domain/notifications.js';
import type { ClarifyEvent, Effort, Request, TranscriptMsg } from '../domain/request.js';
import { DEFAULT_AUTOCOMPACT_PERCENT } from '../domain/request.js';
import {
  KB_SESSION_ID,
  isSetupSession,
  masterCellId,
  setupDraftId,
  summaryCellId,
} from '../domain/sessions.js';
import type { ErrorSink } from '../logging/errors.js';
import type { RequestRepository } from '../requests/repository.js';
import type { UsageRepository } from '../usage/repository.js';
import { SpendCapError, spendPauseInterruptMessage } from '../usage/spend-cap.js';
import type { UsageScope } from '../usage/types.js';
import { errorMessage } from '../util/errors.js';
import { ensurePrivateDir, writePrivateFile } from '../util/files.js';
import type {
  AgentHarness,
  HarnessRegistry,
  TurnParserLike,
  TurnUsage,
} from './harness.js';
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
  /** Set when a hard spend cap stopped the turn instead of the user or dispose. */
  stoppedBy: SpendPause | null;
  resolve: () => void;
  failure: string | null;
  /** A safe classification for outbound event notifications. */
  failureEvent: { source: TurnFailureSource; reason: string } | null;
  /** True once the failure has been broadcast to this turn's subscribers. */
  failureReported: boolean;
  /** Index in the seeded transcript where this turn's messages start. */
  readonly transcriptStart: number;
  /** Identity and resolved settings captured once for usage recording. */
  readonly turnId: string;
  readonly scope: UsageScope;
  readonly requestId: string | null;
  readonly cellId: string | null;
  readonly harnessId: HarnessId;
  readonly model: string | null;
  readonly effort: Effort | null;
  readonly autocompactPercent: number | null;
}

interface StoredSession {
  sessionId: string;
  /** The adapter that owns the session id; a mismatch must not be resumed. */
  harness?: string;
  /** Claude reports cumulative usage for a resumed session; keep the last total. */
  usage?: StoredUsage;
}

interface StoredUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number | null;
}

const EMPTY_USAGE: StoredUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: null,
};

interface ActiveProcess {
  harnessId: HarnessId;
  proc: AgentProcess;
}

export interface EngineDeps {
  repo: RequestRepository;
  harnesses: HarnessRegistry;
  config: Config;
  usage: UsageRepository;
  pluginDirs?: () => string[];
  /** Cell-level model/effort/harness and compaction defaults; request values win. */
  cellConfig?: (
    cellId: string,
  ) =>
    | {
        model: string | null;
        effort: Effort | null;
        harness: HarnessId | null;
        autocompactPercent?: number;
      }
    | null;
  /** Error-only sink; ordinary transcript/turn logs are not persisted here. */
  errors?: ErrorSink;
  /** Optional admission check; returning a pause refuses a new turn. */
  spendCap?: (cellId: string | null) => SpendPause | null;
  /** Called after a usage row is written so hard caps can stop sibling turns. */
  onUsageRecorded?: () => void;
  /** Advisory. A callback failure is logged and never changes the turn. */
  onTurnFailure?: (event: TurnFailureNotification) => void;
}

export class Engine {
  private readonly turns = new Map<string, LiveTurn>();
  private readonly parsers = new Map<string, TurnParserLike>();
  private readonly procs = new Map<string, ActiveProcess>();
  private readonly watchdogs = new Map<string, NodeJS.Timeout>();
  /** Background runTurn continuations, so a discarded session can be settled first. */
  private readonly runs = new Map<string, Promise<void>>();
  /** Reserved sessions whose directories were deleted with their cell. */
  private readonly discarded = new Set<string>();

  constructor(private readonly deps: EngineDeps) {}

  private get repo(): RequestRepository {
    return this.deps.repo;
  }

  private get config(): Config {
    return this.deps.config;
  }

  private resolveHarness(id: string, request: Request | null): HarnessId {
    const cellId = request
      ? request.cellId
      : (masterCellId(id) ?? summaryCellId(id));
    const cell = cellId ? (this.deps.cellConfig?.(cellId) ?? null) : null;
    return resolveHarnessOrder({
      request: request?.harness ?? null,
      cell: cell?.harness ?? null,
      process: this.deps.harnesses.defaultId,
    }).harness;
  }

  private harnessFor(harnessId: HarnessId): AgentHarness {
    return this.deps.harnesses.get(harnessId);
  }

  /** Refuse a new turn before any request/session/process side effect. */
  private assertSpend(cellId: string | null): void {
    const pause = this.deps.spendCap?.(cellId) ?? null;
    if (pause) throw new SpendCapError(pause);
  }

  private assertNotDiscarded(id: string): void {
    if (this.discarded.has(id)) throw new Error(`session ${id} was discarded`);
  }

  hasLive(id: string): boolean {
    return this.turns.has(id);
  }

  /** Snapshot of in-flight work so hard-cap enforcement can target a scope. */
  liveTurns(): Array<{ id: string; cellId: string | null; scope: UsageScope }> {
    return [...this.turns.entries()]
      .filter(([, turn]) => !turn.done)
      .map(([id, turn]) => ({ id, cellId: turn.cellId, scope: turn.scope }));
  }

  /**
   * Stop a live turn without disposing the session. The partial transcript is
   * finished and saved; the saved session id is reused by the next message.
   */
  cancel(id: string): boolean {
    const turn = this.turns.get(id);
    if (!turn || turn.done) return false;
    this.stopTurn(id, turn, null);
    return true;
  }

  /**
   * Stop a live turn because a hard spend cap is paused for its scope. The
   * session is kept, the partial transcript is saved with a visible reason, and
   * the next send after the pause clears resumes from the saved session.
   */
  cancelForSpendCap(id: string, pause: SpendPause): boolean {
    const turn = this.turns.get(id);
    if (!turn || turn.done) return false;
    this.stopTurn(id, turn, pause);
    return true;
  }

  private stopTurn(id: string, turn: LiveTurn, stoppedBy: SpendPause | null): void {
    turn.cancelled = true;
    if (stoppedBy) turn.stoppedBy = stoppedBy;
    this.clearWatchdog(id);
    const active = this.procs.get(id);
    this.procs.delete(id);
    if (active) {
      active.proc.kill('SIGTERM');
      const force = setTimeout(() => active.proc.kill('SIGKILL'), 2_000);
      force.unref();
    }
    // Finish now even if the harness is still stuck inside `prepare()`. The
    // later `runTurn` continuation sees `turn.done` and only cleans up.
    this.finishTurn(id, turn, this.repo.get(id) ?? null);
    turn.resolve();
  }

  /**
   * Forget a cell-owned reserved session: cancel any live turn, wait for its
   * background continuation to finish touching the workdir, then delete the
   * whole session directory. Safe to call twice.
   */
  async discardSession(id: string): Promise<void> {
    this.discarded.add(id);
    this.cancel(id);
    const run = this.runs.get(id);
    if (run) await run.catch(() => {});
    await rm(requestDir(this.config, id), {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
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

    this.assertSpend(this.repo.require(id).cellId);
    const request = this.repo.setClarifyStarted(id, true);
    const savedSession = this.readSession(id, this.resolveHarness(id, request));
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
    this.assertSpend(this.repo.require(id).cellId);
    const request = this.repo.setClarifyStarted(id, true);
    return this.beginTurn(id, text, request);
  }

  async kickoffDispatch(id: string): Promise<LiveTurn> {
    const existing = this.turns.get(id);
    if (existing) return existing;
    const current = this.repo.require(id);
    this.assertSpend(current.cellId);
    const request = current.state === 'dispatch' ? current : this.repo.transition(id, 'dispatch');
    return this.beginTurn(id, dispatchPrompt(request), request);
  }

  async kickoffFinalize(id: string): Promise<LiveTurn> {
    const existing = this.turns.get(id);
    if (existing) return existing;
    const current = this.repo.require(id);
    this.assertSpend(current.cellId);
    const request = current.state === 'finalize' ? current : this.repo.transition(id, 'finalize');
    return this.beginTurn(id, finalizePrompt(request), request);
  }

  async startKb(text: string): Promise<LiveTurn> {
    const existing = this.turns.get(KB_SESSION_ID);
    if (existing) return existing;
    this.assertSpend(null);
    const saved = this.readSession(KB_SESSION_ID, this.deps.harnesses.defaultId);
    const message = saved ? text : `${kbSeedPrompt()}\n\n---\n\n${text}`;
    return this.beginTurn(KB_SESSION_ID, message, null);
  }

  /** Chat with a cell master. Advisory and read-only; the scheduler notes into it. */
  async startMaster(
    text: string,
    sessionId: string,
    context?: string,
  ): Promise<LiveTurn> {
    this.assertNotDiscarded(sessionId);
    const existing = this.turns.get(sessionId);
    if (existing) return existing;
    this.assertSpend(masterCellId(sessionId));
    const saved = this.readSession(sessionId, this.resolveHarness(sessionId, null));
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
    this.assertNotDiscarded(sessionId);
    const existing = this.turns.get(sessionId);
    if (existing) return existing;
    this.assertSpend(summaryCellId(sessionId));
    const saved = this.readSession(sessionId, this.resolveHarness(sessionId, null));
    const message = saved
      ? text
      : `${summarySeedPrompt(context)}\n\n---\n\n${text}`;
    return this.beginTurn(sessionId, message, null);
  }

  /** Transient cell-setup chat used by the creation wizard. */
  async startSetup(text: string, sessionId: string): Promise<LiveTurn> {
    const existing = this.turns.get(sessionId);
    if (existing) return existing;
    this.assertSpend(null);
    const saved = this.readSession(sessionId, this.deps.harnesses.defaultId);
    const message = saved
      ? text.trim() === ''
        ? 'Suggest sane defaults for the cell I am creating.'
        : text
      : `${setupSeedPrompt()}\n\n---\n\n${text}`;
    return this.beginTurn(sessionId, message, null);
  }

  /** Append a master log line to its chat without starting a model turn. */
  note(id: string, text: string): void {
    if (this.discarded.has(id)) return;
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

    const meta = this.turnMeta(id, request);
    const parser = this.harnessFor(meta.harnessId).createParser(this.loadTranscript(id));
    const turn: LiveTurn = {
      events: [],
      subscribers: new Set(),
      promise: settled,
      done: false,
      cancelled: false,
      stoppedBy: null,
      resolve,
      failure: null,
      failureEvent: null,
      failureReported: false,
      transcriptStart: parser.transcript.length,
      turnId: randomUUID(),
      ...meta,
    };

    this.turns.set(id, turn);
    this.parsers.set(id, parser);
    if (request) this.repo.setAgentStatus(id, 'working');
    this.armWatchdog(id, turn, request);

    const run = this.runTurn(id, turn, message, request);
    this.runs.set(id, run);
    void run
      .finally(() => {
        if (this.runs.get(id) === run) this.runs.delete(id);
      })
      .catch(() => {});
    return turn;
  }

  /**
   * Resolve the effective scope and settings once per turn. The harness and the
   * usage row must record the same model/effort, so both read this result.
   */
  private turnMeta(
    id: string,
    request: Request | null,
  ): Pick<
    LiveTurn,
    'scope' | 'requestId' | 'cellId' | 'harnessId' | 'model' | 'effort' | 'autocompactPercent'
  > {
    const scope: UsageScope = request
      ? 'request'
      : id === KB_SESSION_ID
        ? 'kb'
        : isSetupSession(id)
          ? 'setup'
          : 'master';
    const requestId = request ? request.id : null;
    const cellId = request
      ? request.cellId
      : (masterCellId(id) ?? summaryCellId(id));
    const cell = cellId ? (this.deps.cellConfig?.(cellId) ?? null) : null;
    const harnessId = resolveHarnessOrder({
      request: request?.harness ?? null,
      cell: cell?.harness ?? null,
      process: this.deps.harnesses.defaultId,
    }).harness;
    const cellEffective = cell?.harness ?? this.deps.harnesses.defaultId;
    const inheritsCell = cellEffective === harnessId;
    return {
      scope,
      requestId,
      cellId,
      harnessId,
      model:
        request?.model ??
        (inheritsCell ? cell?.model ?? null : null) ??
        this.config.defaultModels[harnessId] ??
        null,
      effort:
        harnessId === 'claude'
          ? (request?.effort ?? (inheritsCell ? cell?.effort ?? null : null))
          : null,
      autocompactPercent:
        scope === 'request'
          ? (cell?.autocompactPercent ?? DEFAULT_AUTOCOMPACT_PERCENT)
          : null,
    };
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
      const proc = await this.ensureProc(id, request, turn);
      if (turn.cancelled || turn.done) {
        proc.kill();
        this.procs.delete(id);
        return;
      }
      this.appendUserMessage(id, message);
      parser.transcript.push({ role: 'you', kind: 'text', text: message, ts: Date.now() });
      proc.writeUserMessage(message);
      await turn.promise;
      if (turn.failure && !turn.cancelled && !turn.failureReported) {
        this.broadcast(turn, { t: 'error', message: turn.failure });
        turn.failureReported = true;
      }
    } catch (error) {
      if (!turn.done && !turn.cancelled) {
        this.deps.errors?.error('engine.turn', error, { session: id });
        const message = errorMessage(error);
        turn.failure = message;
        turn.failureEvent = { source: 'engine.turn', reason: 'engine error' };
        this.broadcast(turn, { t: 'error', message });
        turn.failureReported = true;
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
    const warning = turn.stoppedBy
      ? `⏸ ${spendPauseInterruptMessage(turn.stoppedBy)}`
      : turn.failure
        ? `⚠ ${turn.failure}`
        : null;
    if (warning) {
      const alreadySaved = transcript
        .slice(turn.transcriptStart)
        .some((message) => message.kind === 'text' && message.text === warning);
      if (!alreadySaved) {
        transcript.push({
          role: 'agent',
          kind: 'text',
          text: warning,
          ts: Date.now(),
        });
      }
    }
    this.saveTranscript(id, transcript);

    if (request) {
      this.repo.setAgentStatus(id, 'idle');
      this.repo.setUnchecked(id, true);
    }

    const recorded = this.recordUsage(id, turn, parser);
    this.notifyTurnFailure(id, turn, request);

    const fresh = this.repo.get(id) ?? null;
    turn.done = true;
    if (turn.stoppedBy) this.broadcast(turn, { t: 'paused', pause: turn.stoppedBy });
    this.broadcast(turn, { t: 'done', request: fresh, transcript });

    this.turns.delete(id);
    this.parsers.delete(id);
    if (recorded) {
      try {
        this.deps.onUsageRecorded?.();
      } catch (error) {
        this.deps.errors?.error('budget.enforce', error, { session: id });
      }
    }
  }

  /** Advisory outbound notification for a failed request-scoped turn. */
  private notifyTurnFailure(
    id: string,
    turn: LiveTurn,
    request: Request | null,
  ): void {
    if (
      !turn.failure ||
      turn.scope !== 'request' ||
      turn.requestId === null ||
      request === null
    ) {
      return;
    }
    const failure = turn.failureEvent ?? {
      source: 'engine.turn' as const,
      reason: 'engine error',
    };
    try {
      this.deps.onTurnFailure?.({
        turnId: turn.turnId,
        requestId: turn.requestId,
        requestTitle: clipNotificationText(request.title),
        state: request.state,
        cellId: turn.cellId,
        harness: turn.harnessId,
        model: turn.model,
        source: failure.source,
        reason: failure.reason,
        occurredAt: Date.now(),
      });
    } catch (error) {
      this.deps.errors?.error('notifications.event', error, {
        kind: 'turn.failed',
        session: id,
        turnId: turn.turnId,
      });
    }
  }

  /** Best-effort persistence: a failed usage write never changes turn outcome. */
  private recordUsage(id: string, turn: LiveTurn, parser: TurnParserLike | undefined): boolean {
    const usage = parser?.usage ?? null;
    // A cap stop keeps spend the harness already reported: dropping it would
    // erase real work from the ledger. User stop and timeout still write nothing.
    const reportedBeforeStop = turn.stoppedBy !== null && usage !== null;
    if (!usage || !(parser?.finished === true || reportedBeforeStop)) return false;
    if (turn.cancelled && !reportedBeforeStop) return false;
    const previous = turn.harnessId === 'claude' ? this.readStoredUsage(id) : EMPTY_USAGE;
    const delta = this.deltaUsage(usage, previous);
    try {
      this.deps.usage.record({
        turnId: turn.turnId,
        sessionId: id,
        scope: turn.scope,
        cellId: turn.cellId,
        requestId: turn.requestId,
        model: turn.model,
        effort: turn.effort,
        inputTokens: delta.inputTokens,
        outputTokens: delta.outputTokens,
        cacheReadTokens: delta.cacheReadTokens,
        cacheWriteTokens: delta.cacheWriteTokens,
        reasoningTokens: delta.reasoningTokens,
        costUsd: delta.costUsd,
        createdAt: Date.now(),
      });
      if (turn.harnessId === 'claude') this.writeStoredUsage(id, usage);
      return true;
    } catch (error) {
      this.deps.errors?.error('usage.record', error, {
        session: id,
        turnId: turn.turnId,
      });
      return false;
    }
  }

  private deltaUsage(current: TurnUsage, previous: StoredUsage): TurnUsage {
    return {
      inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
      outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
      cacheReadTokens: Math.max(0, current.cacheReadTokens - previous.cacheReadTokens),
      cacheWriteTokens: Math.max(0, current.cacheWriteTokens - previous.cacheWriteTokens),
      reasoningTokens: Math.max(0, current.reasoningTokens - previous.reasoningTokens),
      costUsd:
        current.costUsd === null
          ? null
          : Math.max(0, current.costUsd - (previous.costUsd ?? 0)),
    };
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
    const active = this.procs.get(id);
    const stderr = active?.proc.recentStderr().trim() ?? '';
    const label = timeoutMs < 1_000 ? `${timeoutMs}ms` : `${Math.round(timeoutMs / 1_000)}s`;
    const message = `agent turn timed out after ${label}${stderr ? `\nstderr:\n${stderr}` : ''}`;
    turn.failure = message;
    turn.failureEvent = { source: 'engine.timeout', reason: `timeout after ${label}` };
    // Mark it cancelled so `runTurn` does not broadcast the same failure twice.
    turn.cancelled = true;
    this.deps.errors?.error('engine.timeout', new Error(message), {
      session: id,
      timeoutMs,
      ...(stderr ? { stderr } : {}),
    });
    this.broadcast(turn, { t: 'error', message });
    if (active) {
      this.procs.delete(id);
      active.proc.kill('SIGTERM');
      const force = setTimeout(() => active.proc.kill('SIGKILL'), 2_000);
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

    for (const event of parser.push(line)) {
      if (event.t !== 'error') {
        this.broadcast(turn, event);
        continue;
      }
      if (turn.failureReported) continue;
      if (!turn.failure) turn.failure = event.message;
      turn.failureEvent ??= { source: 'engine.result', reason: 'harness error result' };
      turn.failureReported = true;
      const message = turn.failure;
      this.deps.errors?.error('engine.result', new Error(message), {
        session: id,
        harness: turn.harnessId,
        ...(turn.requestId ? { request: turn.requestId } : {}),
      });
      this.broadcast(turn, { t: 'error', message });
    }

    if (parser.sessionId && parser.sessionId !== this.readSession(id, turn.harnessId)) {
      this.writeSession(id, turn.harnessId, parser.sessionId);
    }

    if (parser.finished) turn.resolve();
  }

  private onExit(id: string, proc: AgentProcess, code: number | null): void {
    const active = this.procs.get(id);
    if (!active || active.proc !== proc) return;
    const stderr = active.proc.recentStderr().trim() ?? '';
    this.procs.delete(id);
    const turn = this.turns.get(id);
    // A harness whose process ends after its final event has already finished
    // the turn normally; only an exit before completion is a failure.
    if (!turn || turn.done || turn.cancelled || this.parsers.get(id)?.finished) return;
    turn.failure = `agent process exited with code ${code ?? 'unknown'}${
      stderr ? `\nstderr:\n${stderr}` : ''
    }`;
    turn.failureEvent = {
      source: 'engine.exit',
      reason: `process exited with code ${code ?? 'unknown'}`,
    };
    this.deps.errors?.error('engine.exit', new Error(turn.failure), {
      session: id,
      code,
      ...(stderr ? { stderr } : {}),
    });
    turn.resolve();
  }

  /** Session state dir, kept owner-only so transcripts are not world-readable. */
  private privateDir(id: string): string {
    ensurePrivateDir(path.join(this.config.dataDir, 'requests'));
    const dir = requestDir(this.config, id);
    ensurePrivateDir(dir);
    return dir;
  }

  private async ensureProc(
    id: string,
    request: Request | null,
    turn: LiveTurn,
  ): Promise<AgentProcess> {
    const harnessId = turn.harnessId;
    const existing = this.procs.get(id);
    if (existing && existing.harnessId === harnessId) return existing.proc;
    if (existing) {
      this.procs.delete(id);
      existing.proc.kill('SIGTERM');
      const force = setTimeout(() => existing.proc.kill('SIGKILL'), 2_000);
      force.unref();
    }

    const dir = this.privateDir(id);
    const scratch = path.join(dir, 'cwd');
    ensurePrivateDir(scratch);

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

    const draftId = isSetupSession(id) ? (setupDraftId(id) ?? undefined) : undefined;
    const harness = this.harnessFor(harnessId);

    const command = await harness.prepare({
      scope: turn.scope,
      requestId: turn.requestId ?? '',
      ...(draftId ? { draftId } : {}),
      dir,
      cwd,
      sessionId: this.readSession(id, harnessId),
      model: turn.model,
      effort: turn.effort,
      autocompactPercent: turn.autocompactPercent,
      pluginDirs: request ? (this.deps.pluginDirs?.() ?? []) : [],
    });
    const proc = harness.spawn(command);

    this.procs.set(id, { harnessId, proc });
    proc.onLine((line) => {
      const active = this.procs.get(id);
      if (active?.proc === proc) this.consume(id, line);
    });
    proc.onExit((code) => this.onExit(id, proc, code));
    return proc;
  }

  private readStoredSession(id: string): Partial<StoredSession> | null {
    try {
      const raw = readFileSync(path.join(requestDir(this.config, id), 'session.json'), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Partial<StoredSession>)
        : null;
    } catch {
      return null;
    }
  }

  private readSession(id: string, expectedHarness: HarnessId): string | null {
    const parsed = this.readStoredSession(id);
    const stored = isHarnessId(parsed?.harness)
      ? parsed.harness
      : this.deps.harnesses.defaultId;
    if (stored !== expectedHarness) return null;
    return typeof parsed?.sessionId === 'string' ? parsed.sessionId : null;
  }

  private writeSession(id: string, harness: HarnessId, sessionId: string): void {
    const dir = this.privateDir(id);
    const current = this.readStoredSession(id);
    writePrivateFile(
      path.join(dir, 'session.json'),
      JSON.stringify({ ...current, harness, sessionId }, null, 2),
    );
  }

  private readStoredUsage(id: string): StoredUsage {
    const usage = this.readStoredSession(id)?.usage;
    if (!usage || typeof usage !== 'object') return EMPTY_USAGE;
    return {
      inputTokens: Number(usage.inputTokens ?? 0),
      outputTokens: Number(usage.outputTokens ?? 0),
      cacheReadTokens: Number(usage.cacheReadTokens ?? 0),
      cacheWriteTokens: Number(usage.cacheWriteTokens ?? 0),
      reasoningTokens: Number(usage.reasoningTokens ?? 0),
      costUsd: typeof usage.costUsd === 'number' ? usage.costUsd : null,
    };
  }

  private writeStoredUsage(id: string, usage: StoredUsage): void {
    const dir = this.privateDir(id);
    const current = this.readStoredSession(id);
    writePrivateFile(
      path.join(dir, 'session.json'),
      JSON.stringify({ ...current, usage }, null, 2),
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
    const dir = this.privateDir(id);
    writePrivateFile(path.join(dir, 'transcript.json'), JSON.stringify(transcript, null, 2));
  }

  private appendUserMessage(id: string, text: string): void {
    const transcript = this.loadTranscript(id);
    transcript.push({ role: 'you', kind: 'text', text, ts: Date.now() });
    this.saveTranscript(id, transcript);
  }

  async dispose(id: string): Promise<void> {
    const active = this.procs.get(id);
    const turn = this.turns.get(id);
    const request = this.repo.get(id);
    this.clearWatchdog(id);
    active?.proc.kill();
    this.procs.delete(id);

    if (turn && !turn.done) {
      // A terminal route can dispose a live turn. Finish it so the stream gets
      // `done` and the maps are cleaned up even if the harness is stuck.
      turn.cancelled = true;
      this.finishTurn(id, turn, request);
      turn.resolve();
    } else {
      this.turns.delete(id);
      this.parsers.delete(id);
    }

    await removeWorktree({
      targetRepo: request?.targetRepo ?? null,
      requestId: id,
      dataDir: this.config.dataDir,
      scratchDir: requestDir(this.config, id),
    });
  }
}
