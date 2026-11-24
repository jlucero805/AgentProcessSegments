import type { SpendPause } from '../domain/budget.js';
import type { ErrorSink } from '../logging/errors.js';

/** The engine seam this service needs; kept narrow so tests can fake it. */
export interface SpendCapTarget {
  liveTurns(): Array<{ id: string; cellId: string | null }>;
  cancelForSpendCap(id: string, pause: SpendPause): boolean;
}

export interface SpendCapEnforcerDeps {
  engine: SpendCapTarget;
  admission: (cellId: string | null) => SpendPause | null;
  errors?: ErrorSink;
}

/** Nested checks come from a stopped turn recording its usage; bound the retries. */
const MAX_PASSES = 3;

/**
 * The enforcement half of the hard spend caps (D54/D65). Admission refuses new
 * turns; this stops turns that were already running when a usage row or a
 * policy change crossed the cap. It owns no timer: the engine's usage hook and
 * `BudgetService` evaluation call it. It never throws into a turn.
 */
export class SpendCapEnforcer {
  private checking = false;
  private again = false;

  constructor(private readonly deps: SpendCapEnforcerDeps) {}

  check(): void {
    if (this.checking) {
      this.again = true;
      return;
    }
    this.checking = true;
    try {
      let passes = 0;
      do {
        this.again = false;
        passes += 1;
        this.stopPausedTurns();
      } while (this.again && passes < MAX_PASSES);
    } finally {
      this.checking = false;
      this.again = false;
    }
  }

  private stopPausedTurns(): void {
    const live = this.deps.engine.liveTurns();
    if (live.length === 0) return;

    // One ledger read per scope, not per turn. A cell's request, master, and
    // summary turns share the cell pause; null covers KB, setup, and unassigned.
    const pauses = new Map<string | null, SpendPause | null>();
    for (const turn of live) {
      if (pauses.has(turn.cellId)) continue;
      try {
        pauses.set(turn.cellId, this.deps.admission(turn.cellId));
      } catch {
        // Admission already fails open; a thrown check must not stop work.
        pauses.set(turn.cellId, null);
      }
    }

    for (const turn of live) {
      const pause = pauses.get(turn.cellId) ?? null;
      if (!pause) continue;
      try {
        this.deps.engine.cancelForSpendCap(turn.id, pause);
      } catch (error) {
        this.deps.errors?.error('budget.enforce', error, {
          session: turn.id,
          scope: pause.scope,
          ...(pause.cellId ? { cellId: pause.cellId } : {}),
        });
      }
    }
  }
}
