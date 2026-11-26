import type { Engine, LiveTurn } from '../clarify/engine.js';
import { masterSessionId } from '../clarify/engine.js';
import type { CellRepository } from '../cells/repository.js';
import type { SpendPause } from '../domain/budget.js';
import type { MasterErrorNotification } from '../domain/notifications.js';
import { canTransition, isTerminal, type Request, type State } from '../domain/request.js';
import type { MasterEventRepository, MasterEventInput } from '../master/events.js';
import type { MasterResult } from '../master/types.js';
import type { ErrorSink } from '../logging/errors.js';
import {
  SEGMENT_IDS,
  SEGMENT_STATES,
  type ProcessConfig,
  type SegmentConfig,
  type SegmentId,
} from '../process/definition.js';
import { DEFAULT_SEGMENT_PROMPTS, defaultProcess } from '../process/defaults.js';
import { parseFollowUps } from '../process/follow-ups.js';
import type { ProcessStore } from '../process/store.js';
import type { RequestRepository } from '../requests/repository.js';
import type { SettingsStore } from '../settings.js';
import { errorMessage } from '../util/errors.js';
import { SpendCapError, spendPauseMessage } from '../usage/spend-cap.js';

interface Bucket {
  cellId: string;
  label: string;
  maxConcurrent: number;
}

interface CandidateOutcome {
  started: number;
  prodded: number;
  advanced: number;
  reviewed: number;
  followUps: number;
  skipped: number;
}

export interface MasterServiceDeps {
  repo: RequestRepository;
  cells: CellRepository;
  engine: Engine;
  settings: SettingsStore;
  events: MasterEventRepository;
  /** Optional so tests and old callers keep the legacy derived policy. */
  process?: ProcessStore | undefined;
  errors?: ErrorSink;
  /** Optional hard-cap admission check for a cell. */
  spendCap?: (cellId: string) => SpendPause | null;
  /** Advisory. A callback failure is logged and never fails a cycle. */
  onMasterError?: (event: MasterErrorNotification) => void;
}

/** Pipeline position, with the finishing stages later than the planning stages. */
const SEGMENT_RANK = new Map<SegmentId, number>(
  SEGMENT_IDS.map((id, index) => [id, index] as const),
);

/**
 * Later stages run first so a steady supply of planning work cannot starve
 * implementation, review, merge, or finalize. When the right side has nothing
 * due, the cycle falls through to the earlier segments.
 */
function evaluationOrder(process: ProcessConfig): SegmentConfig[] {
  return [...process.segments].sort(
    (a, b) => (SEGMENT_RANK.get(b.id) ?? 0) - (SEGMENT_RANK.get(a.id) ?? 0),
  );
}

function emptyResult(now: number): MasterResult {
  return {
    ranAt: now,
    cells: 0,
    dispatch: 0,
    started: 0,
    prodded: 0,
    reviewed: 0,
    advanced: 0,
    followUps: 0,
    skipped: 0,
  };
}

/**
 * Deterministic process automation: walks the configured segments right-to-left,
 * selects at most the cell's spare concurrency for the cycle, starts or prods
 * the selected batch concurrently, and returns without waiting for the turns.
 * Completion handlers create follow-ups and advance on exact markers later.
 * Finishing work takes precedence over starting more left-side work, and a
 * cycle never reads or notes the whole board.
 *
 * Every cell runs its own bucket with its own policy and its own master chat.
 * Unassigned requests have no bucket: they stay manual until assigned to a cell.
 */
export class MasterService {
  lastRunAt: number | null = null;
  lastResult: MasterResult | null = null;

  private readonly lastByCell = new Map<string, { at: number; result: MasterResult }>();
  private readonly paused = new Map<string, string>();

  constructor(private readonly deps: MasterServiceDeps) {}

  /** Exposed so a manual Run now can return a structured refusal. */
  pauseFor(cellId: string): SpendPause | null {
    return this.deps.spendCap?.(cellId) ?? null;
  }

  /** True while the cell still exists; a deleted cell must not gain new activity. */
  private cellExists(cellId: string): boolean {
    return this.deps.cells.get(cellId) !== null;
  }

  private note(cellId: string, text: string): void {
    if (!this.cellExists(cellId)) return;
    this.deps.engine.note(masterSessionId(cellId), text);
  }

  private record(event: MasterEventInput): void {
    if (event.cellId !== null && !this.cellExists(event.cellId)) return;
    this.deps.events.record(event);
  }

  private notifyError(event: MasterErrorNotification): void {
    try {
      this.deps.onMasterError?.(event);
    } catch (error) {
      this.deps.errors?.error('notifications.event', error, {
        kind: 'master.error',
        cellId: event.cellId,
        source: event.source,
      });
    }
  }

  private process(): ProcessConfig {
    return this.deps.process?.get() ?? defaultProcess(this.deps.settings.get().master);
  }

  private segmentQueue(segment: SegmentConfig, cellId: string): Request[] {
    const requests =
      segment.id === 'intake'
        ? this.deps.repo.list({ view: 'intake', cellId })
        : this.deps.repo.list({ state: SEGMENT_STATES[segment.id], cellId });
    const scoped =
      segment.id === 'plan' ? requests.filter((request) => request.clarifyStarted) : requests;
    // Oldest start date first inside a bucket; `updatedAt` only breaks ties so the
    // order stays stable when two requests were created in the same millisecond.
    return scoped.sort(
      (a, b) => a.createdAt - b.createdAt || a.updatedAt - b.updatedAt || a.id.localeCompare(b.id),
    );
  }

  /**
   * Pick this cycle's work without walking the whole board. Later segments win,
   * then the oldest request inside each segment, until the cell's spare
   * concurrency is full. This keeps the master chat's cycle notes and turns
   * bounded instead of reporting every request in every queue.
   */
  private selectCandidates(
    process: ProcessConfig,
    bucket: Bucket,
    now: number,
  ): {
    candidates: Array<{ request: Request; segment: SegmentConfig }>;
    skipped: number;
    blockedAtCapacity: boolean;
    blockedSegment: SegmentConfig | null;
  } {
    const capacity = bucket.maxConcurrent - this.deps.repo.countWorking(bucket.cellId);
    const selection = {
      candidates: [] as Array<{ request: Request; segment: SegmentConfig }>,
      skipped: 0,
      blockedAtCapacity: capacity <= 0,
      blockedSegment: null as SegmentConfig | null,
    };
    if (capacity <= 0) return selection;

    for (const segment of evaluationOrder(process)) {
      if (!segment.enabled) continue;
      if (selection.candidates.length >= capacity) break;
      const selectedHere = selection.candidates.filter(
        (candidate) => candidate.segment.id === segment.id,
      ).length;
      const workingHere = this.deps.repo.countWorking(
        bucket.cellId,
        SEGMENT_STATES[segment.id],
      );
      if (segment.maxConcurrent !== null && workingHere >= segment.maxConcurrent) {
        selection.blockedSegment = segment;
        continue;
      }

      let handled = 0;
      for (const request of this.segmentQueue(segment, bucket.cellId)) {
        if (selection.candidates.length >= capacity || handled >= segment.maxPerCycle) break;
        if (
          segment.maxConcurrent !== null &&
          workingHere + selectedHere + handled >= segment.maxConcurrent
        ) {
          break;
        }
        if (this.shouldSkip(request, now, segment)) {
          selection.skipped += 1;
          continue;
        }
        selection.candidates.push({ request, segment });
        handled += 1;
      }
    }
    return selection;
  }

  private shouldSkip(request: Request, now: number, segment: SegmentConfig): boolean {
    if (this.deps.engine.hasLive(request.id) || request.agentStatus === 'working') return true;
    const idleMs = segment.idleMinutes * 60_000;
    if (now - request.updatedAt < idleMs) return true;
    const lastTurn = this.deps.events.lastTurnAt(request.id);
    return lastTurn !== null && now - lastTurn < idleMs;
  }

  private lastAgentText(id: string): string {
    const transcript = this.deps.engine.transcript(id);
    return (
      [...transcript].reverse().find((entry) => entry.role === 'agent' && entry.kind === 'text')
        ?.text ?? ''
    );
  }

  private promptFor(segment: SegmentConfig): string {
    const base = segment.prompt.trim() || DEFAULT_SEGMENT_PROMPTS[segment.id];
    if (!segment.followUps.enabled) return base;
    return [
      base,
      '',
      'If you discover work that should happen later, list each item on its own line as',
      `\`${segment.followUps.marker} <short title>\`.`,
    ].join('\n');
  }

  private runTurn(segment: SegmentConfig, request: Request): Promise<LiveTurn> {
    if (segment.id === 'intake') {
      return this.deps.engine.start(request.id, this.promptFor(segment), segment.id);
    }
    return this.deps.engine.send(request.id, this.promptFor(segment), segment.id);
  }

  private createFollowUps(
    source: Request,
    text: string,
    segment: SegmentConfig,
    cellId: string,
  ): number {
    if (!segment.followUps.enabled || !this.cellExists(cellId)) return 0;
    const titles = parseFollowUps(text, segment.followUps.marker);
    let created = 0;
    for (const title of titles) {
      if (this.deps.events.hasEvent(source.id, 'followup', title)) continue;
      this.deps.repo.create({
        title,
        body: `Follow-up from "${source.title}" (${source.id}).\n\nCreated by the ${segment.label} segment.`,
        cellId,
        harness: source.harness,
        targetRepo: source.targetRepo,
      });
      this.record({ cellId, requestId: source.id, action: 'followup', detail: title });
      this.note(cellId, `Created follow-up "${title}" from "${source.title}".`);
      created += 1;
    }
    return created;
  }

  private async advanceIfReady(
    request: Request,
    segment: SegmentConfig,
    text: string,
    cellId: string,
  ): Promise<State | null> {
    const target = segment.advanceTo;
    if (!target || !segment.readyMarker || !text.includes(segment.readyMarker)) return null;

    const current = this.deps.repo.get(request.id);
    if (!current || current.cellId !== cellId) return null;
    if (current.state !== SEGMENT_STATES[segment.id]) return null;
    if (!canTransition(current.state, target)) return null;

    this.deps.repo.transition(request.id, target);
    if (isTerminal(target)) await this.deps.engine.dispose(request.id);
    this.record({
      cellId,
      requestId: request.id,
      action: target === 'review' ? 'review' : 'advance',
      detail: `agent reported ${segment.readyMarker}`,
    });
    this.note(
      cellId,
      `Moved "${request.title}" from ${segment.label} to ${target}: agent reported ${segment.readyMarker}.`,
    );
    return target;
  }

  private bucketForCell(cellId: string): Bucket {
    const cell = this.deps.cells.require(cellId);
    return { cellId, label: cell.name, maxConcurrent: cell.maxConcurrent };
  }

  private applyOutcome(result: MasterResult, outcome: CandidateOutcome): void {
    result.started += outcome.started;
    result.prodded += outcome.prodded;
    result.advanced += outcome.advanced;
    result.reviewed += outcome.reviewed;
    result.followUps += outcome.followUps;
    result.skipped += outcome.skipped;
  }

  private async startCandidate(
    bucket: Bucket,
    candidate: Request,
    segment: SegmentConfig,
    result: MasterResult,
  ): Promise<CandidateOutcome> {
    const outcome: CandidateOutcome = {
      started: 0,
      prodded: 0,
      advanced: 0,
      reviewed: 0,
      followUps: 0,
      skipped: 0,
    };

    // Selection uses a queue snapshot. Re-read before turning so a request moved
    // to another cell cannot be prodded by the cell that used to own it.
    const request = this.deps.repo.get(candidate.id);
    if (
      !request ||
      request.cellId !== bucket.cellId ||
      this.deps.engine.hasLive(request.id) ||
      request.agentStatus === 'working'
    ) {
      outcome.skipped = 1;
      return outcome;
    }

    try {
      const turn = await this.runTurn(segment, request);
      const starting = segment.id === 'intake';
      this.record({
        cellId: bucket.cellId,
        requestId: request.id,
        action: starting ? 'start' : 'prod',
        detail: request.title,
      });
      this.note(
        bucket.cellId,
        `${starting ? 'Started' : 'Prodded'} "${request.title}" in ${segment.label}.`,
      );
      if (starting) outcome.started = 1;
      else outcome.prodded = 1;

      // Stay light: the cycle ends after starting the batch. The completion
      // handler creates follow-ups and applies the marker later.
      void this.settleCandidate(bucket, request, segment, turn, result);
    } catch (error) {
      outcome.skipped = 1;
      // An admission race is an expected policy refusal, not a turn failure.
      // The next cycle records the pause episode once.
      if (error instanceof SpendCapError) return outcome;
      const message = errorMessage(error);
      this.deps.errors?.error('master.turn', error, {
        cellId: bucket.cellId,
        requestId: request.id,
        segment: segment.id,
      });
      if (!(error instanceof SpendCapError)) {
        this.notifyError({
          source: 'master.turn',
          cellId: bucket.cellId,
          requestId: request.id,
          segment: segment.id,
          occurredAt: Date.now(),
        });
      }
      this.record({
        cellId: bucket.cellId,
        requestId: request.id,
        action: 'skip',
        detail: message,
      });
      this.note(
        bucket.cellId,
        `Could not run "${request.title}" in ${segment.label}: ${message}`,
      );
    }

    return outcome;
  }

  private async settleCandidate(
    bucket: Bucket,
    request: Request,
    segment: SegmentConfig,
    turn: LiveTurn,
    result: MasterResult,
  ): Promise<void> {
    const outcome: CandidateOutcome = {
      started: 0,
      prodded: 0,
      advanced: 0,
      reviewed: 0,
      followUps: 0,
      skipped: 0,
    };

    try {
      await turn.promise;
      // finishTurn persists the transcript in its finally block, one tick
      // after the promise settles.
      await new Promise<void>((resolve) => setImmediate(resolve));

      if (turn.stoppedBy) {
        // A cap stopped the turn mid-segment. Its partial text is not a
        // completion: never create follow-ups or advance the marker from it.
        outcome.skipped = 1;
      } else {
        const text = this.lastAgentText(request.id);
        outcome.followUps = this.createFollowUps(request, text, segment, bucket.cellId);
        const target = await this.advanceIfReady(request, segment, text, bucket.cellId);
        if (target) {
          outcome.advanced = 1;
          if (target === 'review') outcome.reviewed = 1;
        }
      }
    } catch (error) {
      outcome.skipped = 1;
      const message = errorMessage(error);
      this.deps.errors?.error('master.turn', error, {
        cellId: bucket.cellId,
        requestId: request.id,
        segment: segment.id,
      });
      if (!(error instanceof SpendCapError)) {
        this.notifyError({
          source: 'master.turn',
          cellId: bucket.cellId,
          requestId: request.id,
          segment: segment.id,
          occurredAt: Date.now(),
        });
      }
      this.record({
        cellId: bucket.cellId,
        requestId: request.id,
        action: 'skip',
        detail: message,
      });
      this.note(
        bucket.cellId,
        `Could not finish "${request.title}" in ${segment.label}: ${message}`,
      );
    }

    this.applyOutcome(result, outcome);
  }

  private async runBucket(bucket: Bucket): Promise<MasterResult> {
    const now = Date.now();
    const globalProcess = this.process();
    const process = this.deps.cells.getProcess(bucket.cellId) ?? globalProcess;
    const result = emptyResult(now);
    result.cells = 1;

    const pause = this.deps.spendCap?.(bucket.cellId) ?? null;
    if (pause) {
      // A pause episode is the scope + period + budget + reason. Re-noting on
      // every tick would bury the master chat in identical skip messages.
      const key = `${pause.scope}:${pause.periodStart}:${pause.budgetUsd}:${pause.reason}`;
      if (this.paused.get(bucket.cellId) !== key) {
        this.paused.set(bucket.cellId, key);
        const detail = spendPauseMessage(pause);
        this.record({
          cellId: bucket.cellId,
          requestId: null,
          action: 'skip',
          detail: `paused: ${detail}`,
        });
        this.note(bucket.cellId, `Paused new work: ${detail}`);
      }
      result.skipped = 1;
      this.lastByCell.set(bucket.cellId, { at: now, result });
      this.lastRunAt = now;
      this.lastResult = result;
      return result;
    }
    if (this.paused.delete(bucket.cellId)) {
      this.note(bucket.cellId, 'Resumed new work: the spend cap no longer blocks this cell.');
    }

    const selection = this.selectCandidates(process, bucket, now);
    result.dispatch = selection.candidates.length;
    result.skipped = selection.skipped;
    const blockedAtCapacity = selection.blockedAtCapacity;
    const blockedSegment = selection.blockedSegment;

    // Start the selected batch together, then return. Completion handling runs
    // in the background so the next tick can refill capacity.
    const outcomes = await Promise.all(
      selection.candidates.map(({ request, segment }) =>
        this.startCandidate(bucket, request, segment, result),
      ),
    );
    for (const outcome of outcomes) {
      this.applyOutcome(result, outcome);
    }

    if (blockedAtCapacity) {
      result.skipped += 1;
      this.record({
        cellId: bucket.cellId,
        requestId: null,
        action: 'skip',
        detail: `concurrency limit reached (${bucket.maxConcurrent})`,
      });
      this.note(
        bucket.cellId,
        `Skipped new work: this cell is at its concurrency limit (${bucket.maxConcurrent}).`,
      );
    }
    if (blockedSegment) {
      result.skipped += 1;
      this.record({
        cellId: bucket.cellId,
        requestId: null,
        action: 'skip',
        detail: `segment concurrency limit reached (${blockedSegment.label}: ${blockedSegment.maxConcurrent})`,
      });
      this.note(
        bucket.cellId,
        `Held ${blockedSegment.label}: its segment concurrency limit is ${blockedSegment.maxConcurrent}.`,
      );
    }

    this.record({
      cellId: bucket.cellId,
      requestId: null,
      action: 'cycle',
      detail: JSON.stringify({
        cell: bucket.label,
        dispatch: result.dispatch,
        started: result.started,
        prodded: result.prodded,
        advanced: result.advanced,
        followUps: result.followUps,
        skipped: result.skipped,
      }),
    });

    if (
      result.dispatch > 0 ||
      result.started > 0 ||
      result.prodded > 0 ||
      result.advanced > 0 ||
      result.followUps > 0 ||
      result.skipped > 0
    ) {
      this.note(
        bucket.cellId,
        `Master cycle: ${result.dispatch} selected, ${result.started} started, ${result.prodded} prodded, ${result.advanced} advanced, ${result.followUps} follow-ups, ${result.skipped} skipped.`,
      );
    }

    this.lastByCell.set(bucket.cellId, { at: now, result });
    this.lastRunAt = now;
    this.lastResult = result;
    return result;
  }

  async runCell(cellId: string): Promise<MasterResult> {
    return this.runBucket(this.bucketForCell(cellId));
  }

  lastFor(cellId: string): { at: number; result: MasterResult } | null {
    return this.lastByCell.get(cellId) ?? null;
  }
}
