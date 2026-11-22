import type { Engine, LiveTurn } from '../clarify/engine.js';
import { masterSessionId } from '../clarify/engine.js';
import type { CellRepository } from '../cells/repository.js';
import { canTransition, DEFAULT_MAX_CONCURRENT, isTerminal, type Request, type State } from '../domain/request.js';
import type { MasterEventRepository, MasterEventInput } from '../master/events.js';
import type { MasterResult } from '../master/types.js';
import type { ErrorSink } from '../logging/errors.js';
import { SEGMENT_STATES, type ProcessConfig, type SegmentConfig } from '../process/definition.js';
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

function addResult(total: MasterResult, next: MasterResult): void {
  total.cells += next.cells;
  total.dispatch += next.dispatch;
  total.started += next.started;
  total.prodded += next.prodded;
  total.reviewed += next.reviewed;
  total.advanced += next.advanced;
  total.followUps += next.followUps;
  total.skipped += next.skipped;
}

/**
 * Deterministic process automation: walks the configured segments, starts or prods
 * due requests, records follow-up requests, and advances on exact markers.
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
    return scoped.sort((a, b) => a.updatedAt - b.updatedAt);
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
    if (segment.id === 'intake') return this.deps.engine.start(request.id);
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

  private async runBucket(bucket: Bucket): Promise<MasterResult> {
    const now = Date.now();
    const globalProcess = this.process();
    const process =
      bucket.cellId === null
        ? globalProcess
        : (this.deps.cells.getProcess(bucket.cellId) ?? globalProcess);
    const result = emptyResult(now);
    result.cells = 1;
    let blockedAtCapacity = false;
    let blockedSegment: SegmentConfig | null = null;

    for (const segment of process.segments) {
      if (!segment.enabled) continue;
      const queue = this.segmentQueue(segment, bucket.cellId);
      result.dispatch += queue.length;

      let handled = 0;
      for (const request of queue) {
        if (handled >= segment.maxPerCycle) break;
        if (this.deps.repo.countWorking(bucket.cellId) >= bucket.maxConcurrent) {
          blockedAtCapacity = true;
          break;
        }
        if (
          segment.maxConcurrent !== null &&
          this.deps.repo.countWorking(bucket.cellId, SEGMENT_STATES[segment.id]) >=
            segment.maxConcurrent
        ) {
          blockedSegment = segment;
          break;
        }
        if (this.shouldSkip(request, now, segment)) {
          result.skipped += 1;
          continue;
        }
        handled += 1;

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
          if (starting) result.started += 1;
          else result.prodded += 1;

          await turn.promise;
          // finishTurn persists the transcript in its finally block, one tick
          // after the promise settles.
          await new Promise<void>((resolve) => setImmediate(resolve));

          const text = this.lastAgentText(request.id);
          result.followUps += this.createFollowUps(request, text, segment, bucket.cellId);
          const target = await this.advanceIfReady(request, segment, text, bucket.cellId);
          if (target) {
            result.advanced += 1;
            if (target === 'review') result.reviewed += 1;
          }
        } catch (error) {
          result.skipped += 1;
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
          this.note(bucket.cellId, `Could not run "${request.title}" in ${segment.label}: ${message}`);
        }
      }
      if (blockedAtCapacity || blockedSegment) break;
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
        `Master cycle: ${result.dispatch} queued, ${result.started} started, ${result.prodded} prodded, ${result.advanced} advanced, ${result.followUps} follow-ups, ${result.skipped} skipped.`,
      );
    }

    this.lastByCell.set(bucketKey(bucket.cellId), { at: now, result });
    this.lastRunAt = now;
    this.lastResult = result;
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
      addResult(total, await this.runBucket(bucket));
    }
    this.lastRunAt = now;
    this.lastResult = total;
    return total;
  }

  lastFor(cellId: string | null): { at: number; result: MasterResult } | null {
    return this.lastByCell.get(bucketKey(cellId)) ?? null;
  }
}
