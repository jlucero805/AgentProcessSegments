import type { Engine } from '../clarify/engine.js';
import { MASTER_SESSION_ID } from '../clarify/engine.js';
import type { CellRepository } from '../cells/repository.js';
import type { Request } from '../domain/request.js';
import type { RequestRepository } from '../requests/repository.js';
import type { SettingsStore } from '../settings.js';
import { errorMessage } from '../util/errors.js';
import type { MasterEventRepository, MasterEventInput } from './events.js';
import type { MasterResult } from './types.js';

export const READY_MARKER = 'READY FOR REVIEW';

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
}

/**
 * Deterministic cell master: reviews dispatch queues, prods stalled sessions,
 * and moves work to Review when the agent signals the READY marker.
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

  private shouldSkip(
    request: Pick<Request, 'id' | 'agentStatus' | 'updatedAt'>,
    now: number,
    idleMs: number,
    minProdGapMs: number,
  ): boolean {
    if (this.deps.engine.hasLive(request.id) || request.agentStatus === 'working') return true;
    if (now - request.updatedAt < idleMs) return true;
    const lastProd = this.deps.events.lastProdAt(request.id);
    return lastProd !== null && now - lastProd < minProdGapMs;
  }

  private lastAgentText(id: string): string {
    const transcript = this.deps.engine.transcript(id);
    return (
      [...transcript].reverse().find((entry) => entry.role === 'agent' && entry.kind === 'text')
        ?.text ?? ''
    );
  }

  async runOnce(): Promise<MasterResult> {
    const config = this.deps.settings.get().master;
    const now = Date.now();
    const idleMs = config.idleMinutes * 60_000;
    const minProdGapMs = config.intervalMinutes * 60_000;

    const buckets: Bucket[] = this.deps.cells
      .list()
      .filter((cell) => cell.masterEnabled)
      .map((cell) => ({ cellId: cell.id, label: cell.name }));
    if (config.includeUnassigned) buckets.push({ cellId: null, label: 'Unassigned' });

    let dispatch = 0;
    let prodded = 0;
    let reviewed = 0;
    let skipped = 0;

    for (const bucket of buckets) {
      const queue = this.deps.repo
        .list({ state: 'dispatch', cellId: bucket.cellId })
        .sort((a, b) => a.updatedAt - b.updatedAt);

      let bucketProdded = 0;
      let bucketSkipped = 0;

      for (const request of queue) {
        dispatch += 1;

        if (this.shouldSkip(request, now, idleMs, minProdGapMs)) {
          bucketSkipped += 1;
          continue;
        }

        try {
          const turn = await this.deps.engine.send(request.id, config.prompt);
          this.record({
            cellId: bucket.cellId,
            requestId: request.id,
            action: 'prod',
            detail: request.title,
          });
          this.note(`Prodded "${request.title}" in ${bucket.label}.`);
          bucketProdded += 1;

          await turn.promise;
          // finishTurn persists the transcript in its finally block, one tick
          // after the promise settles.
          await new Promise<void>((resolve) => setImmediate(resolve));

          if (config.autoReview) {
            const current = this.deps.repo.get(request.id);
            const ready =
              current?.state === 'dispatch' && this.lastAgentText(request.id).includes(READY_MARKER);
            if (ready) {
              this.deps.repo.transition(request.id, 'review');
              reviewed += 1;
              this.record({
                cellId: bucket.cellId,
                requestId: request.id,
                action: 'review',
                detail: 'agent reported ' + READY_MARKER,
              });
              this.note(`Moved "${request.title}" to Review: agent reported ${READY_MARKER}.`);
            }
          }
        } catch (error) {
          bucketSkipped += 1;
          const message = errorMessage(error);
          this.record({
            cellId: bucket.cellId,
            requestId: request.id,
            action: 'skip',
            detail: message,
          });
          this.note(`Could not prod "${request.title}": ${message}`);
        }
      }

      prodded += bucketProdded;
      skipped += bucketSkipped;
      if (bucket.cellId !== null || queue.length > 0) {
        this.record({
          cellId: bucket.cellId,
          requestId: null,
          action: 'cycle',
          detail: JSON.stringify({
            cell: bucket.label,
            dispatch: queue.length,
            prodded: bucketProdded,
            skipped: bucketSkipped,
          }),
        });
      }
    }

    const result: MasterResult = {
      ranAt: now,
      cells: buckets.length,
      dispatch,
      prodded,
      reviewed,
      skipped,
    };
    if (dispatch > 0 || prodded > 0 || reviewed > 0 || skipped > 0) {
      this.note(
        `Master cycle: ${dispatch} queued, ${prodded} prodded, ${reviewed} reviewed, ${skipped} skipped.`,
      );
    }
    this.lastRunAt = now;
    this.lastResult = result;
    return result;
  }
}
