import type { Engine, LiveTurn } from '../clarify/engine.js';
import { MASTER_SESSION_ID } from '../clarify/engine.js';
import type { CellRepository } from '../cells/repository.js';
import { canTransition, isTerminal, type Request, type State } from '../domain/request.js';
import type { MasterEventRepository, MasterEventInput } from '../master/events.js';
import type { MasterResult } from '../master/types.js';
import { SEGMENT_STATES, type ProcessConfig, type SegmentConfig } from '../process/definition.js';
import {
  DEFAULT_SEGMENT_PROMPTS,
  defaultProcess,
} from '../process/defaults.js';
import { parseFollowUps } from '../process/follow-ups.js';
import type { ProcessStore } from '../process/store.js';
import type { RequestRepository } from '../requests/repository.js';
import type { SettingsStore } from '../settings.js';
import { errorMessage } from '../util/errors.js';

interface Bucket {
  cellId: string | null;
  label: string;
}

export interface MasterServiceDeps {
  repo: RequestRepository;
  cells: CellRepository;
  engine: Engine;
  settings: SettingsStore;
  events: MasterEventRepository;
  /** Optional so tests and old callers keep the legacy derived policy. */
  process?: ProcessStore | undefined;
}

/**
 * Deterministic process automation: walks the configured segments, starts or prods
 * due requests, records follow-up requests, and advances on exact markers.
 */
export class MasterService {
  lastRunAt: number | null = null;
  lastResult: MasterResult | null = null;

  constructor(private readonly deps: MasterServiceDeps) {}

  private note(text: string): void {
    this.deps.engine.note(MASTER_SESSION_ID, text);
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

  private createFollowUps(source: Request, text: string, segment: SegmentConfig): number {
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
      this.record({
        cellId: source.cellId,
        requestId: source.id,
        action: 'followup',
        detail: title,
      });
      this.note(`Created follow-up "${title}" from "${source.title}".`);
      created += 1;
    }
    return created;
  }

  private async advanceIfReady(
    request: Request,
    segment: SegmentConfig,
    text: string,
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
      `Moved "${request.title}" from ${segment.label} to ${target}: agent reported ${segment.readyMarker}.`,
    );
    return target;
  }

  async runOnce(): Promise<MasterResult> {
    const master = this.deps.settings.get().master;
    const globalProcess = this.process();
    const now = Date.now();

    const buckets: Bucket[] = this.deps.cells
      .list()
      .filter((cell) => cell.masterEnabled)
      .map((cell) => ({ cellId: cell.id, label: cell.name }));
    if (master.includeUnassigned) buckets.push({ cellId: null, label: 'Unassigned' });

    let dispatch = 0;
    let started = 0;
    let prodded = 0;
    let reviewed = 0;
    let advanced = 0;
    let followUps = 0;
    let skipped = 0;

    for (const bucket of buckets) {
      // A cell can own its policy; without one it inherits the global template.
      const process =
        bucket.cellId === null
          ? globalProcess
          : (this.deps.cells.getProcess(bucket.cellId) ?? globalProcess);
      let bucketDispatch = 0;
      let bucketStarted = 0;
      let bucketProdded = 0;
      let bucketAdvanced = 0;
      let bucketFollowUps = 0;
      let bucketSkipped = 0;

      for (const segment of process.segments) {
        if (!segment.enabled) continue;
        const queue = this.segmentQueue(segment, bucket.cellId);
        bucketDispatch += queue.length;
        dispatch += queue.length;

        let handled = 0;
        for (const request of queue) {
          if (handled >= segment.maxPerCycle) break;
          if (this.shouldSkip(request, now, segment)) {
            bucketSkipped += 1;
            skipped += 1;
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
              `${starting ? 'Started' : 'Prodded'} "${request.title}" in ${segment.label}.`,
            );
            if (starting) {
              bucketStarted += 1;
              started += 1;
            } else {
              bucketProdded += 1;
              prodded += 1;
            }

            await turn.promise;
            // finishTurn persists the transcript in its finally block, one tick
            // after the promise settles.
            await new Promise<void>((resolve) => setImmediate(resolve));

            const text = this.lastAgentText(request.id);
            const created = this.createFollowUps(request, text, segment);
            bucketFollowUps += created;
            followUps += created;

            const target = await this.advanceIfReady(request, segment, text);
            if (target) {
              bucketAdvanced += 1;
              advanced += 1;
              if (target === 'review') reviewed += 1;
            }
          } catch (error) {
            bucketSkipped += 1;
            skipped += 1;
            const message = errorMessage(error);
            this.record({
              cellId: bucket.cellId,
              requestId: request.id,
              action: 'skip',
              detail: message,
            });
            this.note(`Could not run "${request.title}" in ${segment.label}: ${message}`);
          }
        }
      }

      if (bucket.cellId !== null || bucketDispatch > 0) {
        this.record({
          cellId: bucket.cellId,
          requestId: null,
          action: 'cycle',
          detail: JSON.stringify({
            cell: bucket.label,
            dispatch: bucketDispatch,
            started: bucketStarted,
            prodded: bucketProdded,
            advanced: bucketAdvanced,
            followUps: bucketFollowUps,
            skipped: bucketSkipped,
          }),
        });
      }
    }

    const result: MasterResult = {
      ranAt: now,
      cells: buckets.length,
      dispatch,
      started,
      prodded,
      reviewed,
      advanced,
      followUps,
      skipped,
    };
    if (dispatch > 0 || started > 0 || prodded > 0 || advanced > 0 || followUps > 0 || skipped > 0) {
      this.note(
        `Master cycle: ${dispatch} queued, ${started} started, ${prodded} prodded, ${advanced} advanced, ${followUps} follow-ups, ${skipped} skipped.`,
      );
    }
    this.lastRunAt = now;
    this.lastResult = result;
    return result;
  }
}
