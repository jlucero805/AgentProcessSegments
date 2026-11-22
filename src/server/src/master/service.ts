import type { Engine, LiveTurn } from '../clarify/engine.js';
import { masterSessionId } from '../clarify/engine.js';
import type { CellRepository } from '../cells/repository.js';
import { canTransition, DEFAULT_MAX_CONCURRENT, isTerminal, type Request, type State } from '../domain/request.js';
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

interface Bucket {
  cellId: string | null;
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
}

function bucketKey(cellId: string | null): string {
  return cellId ?? '';
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
 * Every cell runs its own bucket with its own policy and its own master chat; the
 * unassigned bucket uses the global template and global master chat.
 */
export class MasterService {
  lastRunAt: number | null = null;
  lastResult: MasterResult | null = null;

  private readonly lastByCell = new Map<string, { at: number; result: MasterResult }>();

  constructor(private readonly deps: MasterServiceDeps) {}

  private note(cellId: string | null, text: string): void {
    this.deps.engine.note(masterSessionId(cellId), text);
  }

  private record(event: MasterEventInput): void {
    this.deps.events.record(event);
  }

  private process(): ProcessConfig {
    return this.deps.process?.get() ?? defaultProcess(this.deps.settings.get().master);
  }

  private segmentQueue(segment: SegmentConfig, cellId: string | null): Request[] {
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
      return this.deps.engine.start(request.id, this.promptFor(segment));
    }
    return this.deps.engine.send(request.id, this.promptFor(segment));
  }

  private createFollowUps(
    source: Request,
    text: string,
    segment: SegmentConfig,
    cellId: string | null,
  ): number {
    if (!segment.followUps.enabled) return 0;
    const titles = parseFollowUps(text, segment.followUps.marker);
    let created = 0;
    for (const title of titles) {
      if (this.deps.events.hasEvent(source.id, 'followup', title)) continue;
      this.deps.repo.create({
        title,
        body: `Follow-up from "${source.title}" (${source.id}).\n\nCreated by the ${segment.label} segment.`,
        cellId: source.cellId,
      });
      this.record({ cellId: source.cellId, requestId: source.id, action: 'followup', detail: title });
      this.note(cellId, `Created follow-up "${title}" from "${source.title}".`);
      created += 1;
    }
    return created;
  }

  private async advanceIfReady(
    request: Request,
    segment: SegmentConfig,
    text: string,
    cellId: string | null,
  ): Promise<State | null> {
    const target = segment.advanceTo;
    if (!target || !segment.readyMarker || !text.includes(segment.readyMarker)) return null;

    const current = this.deps.repo.get(request.id);
    if (!current || current.state !== SEGMENT_STATES[segment.id]) return null;
    if (!canTransition(current.state, target)) return null;

    this.deps.repo.transition(request.id, target);
    if (isTerminal(target)) await this.deps.engine.dispose(request.id);
    this.record({
      cellId: current.cellId,
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

  private applyOutcome(
    result: MasterResult,
    outcome: CandidateOutcome,
    aggregate?: MasterResult,
  ): void {
    result.started += outcome.started;
    result.prodded += outcome.prodded;
    result.advanced += outcome.advanced;
    result.reviewed += outcome.reviewed;
    result.followUps += outcome.followUps;
    result.skipped += outcome.skipped;
    if (!aggregate) return;
    aggregate.started += outcome.started;
    aggregate.prodded += outcome.prodded;
    aggregate.advanced += outcome.advanced;
    aggregate.reviewed += outcome.reviewed;
    aggregate.followUps += outcome.followUps;
    aggregate.skipped += outcome.skipped;
  }

  private async startCandidate(
    bucket: Bucket,
    request: Request,
    segment: SegmentConfig,
    result: MasterResult,
    aggregate?: MasterResult,
  ): Promise<CandidateOutcome> {
    const outcome: CandidateOutcome = {
      started: 0,
      prodded: 0,
      advanced: 0,
      reviewed: 0,
      followUps: 0,
      skipped: 0,
    };

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
      void this.settleCandidate(bucket, request, segment, turn, result, aggregate);
    } catch (error) {
      outcome.skipped = 1;
      const message = errorMessage(error);
      this.deps.errors?.error('master.turn', error, {
        cellId: bucket.cellId,
        requestId: request.id,
        segment: segment.id,
      });
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
    aggregate?: MasterResult,
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

      const text = this.lastAgentText(request.id);
      outcome.followUps = this.createFollowUps(request, text, segment, bucket.cellId);
      const target = await this.advanceIfReady(request, segment, text, bucket.cellId);
      if (target) {
        outcome.advanced = 1;
        if (target === 'review') outcome.reviewed = 1;
      }
    } catch (error) {
      outcome.skipped = 1;
      const message = errorMessage(error);
      this.deps.errors?.error('master.turn', error, {
        cellId: bucket.cellId,
        requestId: request.id,
        segment: segment.id,
      });
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

    this.applyOutcome(result, outcome, aggregate);
  }

  private async runBucket(bucket: Bucket, aggregate?: MasterResult): Promise<MasterResult> {
    const now = Date.now();
    const globalProcess = this.process();
    const process =
      bucket.cellId === null
        ? globalProcess
        : (this.deps.cells.getProcess(bucket.cellId) ?? globalProcess);
    const result = emptyResult(now);
    result.cells = 1;

    const selection = this.selectCandidates(process, bucket, now);
    result.dispatch = selection.candidates.length;
    result.skipped = selection.skipped;
    if (aggregate) {
      aggregate.cells += 1;
      aggregate.dispatch += result.dispatch;
      aggregate.skipped += result.skipped;
    }
    const blockedAtCapacity = selection.blockedAtCapacity;
    const blockedSegment = selection.blockedSegment;

    // Start the selected batch together, then return. Completion handling runs
    // in the background so the next tick can refill capacity.
    const outcomes = await Promise.all(
      selection.candidates.map(({ request, segment }) =>
        this.startCandidate(bucket, request, segment, result, aggregate),
      ),
    );
    for (const outcome of outcomes) {
      this.applyOutcome(result, outcome, aggregate);
    }

    if (blockedAtCapacity) {
      result.skipped += 1;
      if (aggregate) aggregate.skipped += 1;
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
      if (aggregate) aggregate.skipped += 1;
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

    if (bucket.cellId !== null || result.dispatch > 0) {
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
    }

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

    this.lastByCell.set(bucketKey(bucket.cellId), { at: now, result });
    this.lastRunAt = now;
    if (!aggregate) this.lastResult = result;
    return result;
  }

  async runCell(cellId: string): Promise<MasterResult> {
    return this.runBucket(this.bucketForCell(cellId));
  }

  async runUnassigned(): Promise<MasterResult> {
    return this.runBucket({
      cellId: null,
      label: 'Unassigned',
      maxConcurrent: DEFAULT_MAX_CONCURRENT,
    });
  }

  async runOnce(): Promise<MasterResult> {
    const master = this.deps.settings.get().master;
    const buckets: Bucket[] = this.deps.cells
      .list()
      .filter((cell) => cell.masterEnabled)
      .map((cell) => ({
        cellId: cell.id,
        label: cell.name,
        maxConcurrent: cell.maxConcurrent,
      }));
    if (master.includeUnassigned) {
      buckets.push({
        cellId: null,
        label: 'Unassigned',
        maxConcurrent: DEFAULT_MAX_CONCURRENT,
      });
    }

    const now = Date.now();
    const total = emptyResult(now);
    for (const bucket of buckets) {
      await this.runBucket(bucket, total);
    }
    this.lastRunAt = now;
    this.lastResult = total;
    return total;
  }

  lastFor(cellId: string | null): { at: number; result: MasterResult } | null {
    return this.lastByCell.get(bucketKey(cellId)) ?? null;
  }
}
