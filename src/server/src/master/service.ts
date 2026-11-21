import type { Engine } from '../clarify/engine.js';
import { MASTER_SESSION_ID } from '../clarify/engine.js';
import type { CellRepository } from '../cells/repository.js';
import type { RequestRepository } from '../requests/repository.js';
import type { SettingsStore } from '../settings.js';
import type { MasterEventRepository } from './events.js';

export const READY_MARKER = 'READY FOR REVIEW';

export interface MasterResult {
  ranAt: number;
  cells: number;
  dispatch: number;
  prodded: number;
  reviewed: number;
  skipped: number;
}

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

        if (this.deps.engine.hasLive(request.id) || request.agentStatus === 'working') {
          bucketSkipped += 1;
          continue;
        }
        if (now - request.updatedAt < idleMs) {
          bucketSkipped += 1;
          continue;
        }
        const lastProd = this.deps.events.lastProdAt(request.id);
        if (lastProd !== null && now - lastProd < minProdGapMs) {
          bucketSkipped += 1;
          continue;
        }

        try {
          const turn = await this.deps.engine.send(request.id, config.prompt);
          this.deps.events.record({
            cellId: bucket.cellId,
            requestId: request.id,
            action: 'prod',
            detail: request.title,
          });
          this.deps.engine.note(
            MASTER_SESSION_ID,
            `Prodded "${request.title}" in ${bucket.label}.`,
          );
          bucketProdded += 1;

          await turn.promise;
          // finishTurn persists the transcript in its finally block, one tick
          // after the promise settles.
          await new Promise<void>((resolve) => setImmediate(resolve));

          if (config.autoReview) {
            const current = this.deps.repo.get(request.id);
            if (current?.state === 'dispatch') {
              const transcript = this.deps.engine.transcript(request.id);
              const lastAgentText =
                [...transcript].reverse().find((entry) => entry.role === 'agent' && entry.kind === 'text')
                  ?.text ?? '';
              if (lastAgentText.includes(READY_MARKER)) {
                this.deps.repo.transition(request.id, 'review');
                reviewed += 1;
                this.deps.events.record({
                  cellId: bucket.cellId,
                  requestId: request.id,
                  action: 'review',
                  detail: 'agent reported ' + READY_MARKER,
                });
                this.deps.engine.note(
                  MASTER_SESSION_ID,
                  `Moved "${request.title}" to Review: agent reported ${READY_MARKER}.`,
                );
              }
            }
          }
        } catch (error) {
          bucketSkipped += 1;
          const message = error instanceof Error ? error.message : String(error);
          this.deps.events.record({
            cellId: bucket.cellId,
            requestId: request.id,
            action: 'skip',
            detail: message,
          });
          this.deps.engine.note(
            MASTER_SESSION_ID,
            `Could not prod "${request.title}": ${message}`,
          );
        }
      }

      prodded += bucketProdded;
      skipped += bucketSkipped;
      if (bucket.cellId !== null || queue.length > 0) {
        this.deps.events.record({
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
      this.deps.engine.note(
        MASTER_SESSION_ID,
        `Master cycle: ${dispatch} queued, ${prodded} prodded, ${reviewed} reviewed, ${skipped} skipped.`,
      );
    }
    this.lastRunAt = now;
    this.lastResult = result;
    return result;
  }
}
