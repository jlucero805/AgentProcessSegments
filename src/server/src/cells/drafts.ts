import type { HarnessId } from '../domain/harness.js';
import type { Effort } from '../domain/request.js';
import type { ProcessConfig } from '../process/definition.js';

/** Mutable configuration while the cell creation wizard is open. */
export interface CellDraft {
  id: string;
  name: string;
  masterIntervalMinutes: number | null;
  maxConcurrent: number;
  harness: HarnessId | null;
  model: string | null;
  effort: Effort | null;
  process: ProcessConfig;
  updatedAt: number;
}

export type CellDraftPatch = Partial<Omit<CellDraft, 'id' | 'updatedAt'>>;

/** In-memory drafts; they exist only for the lifetime of the wizard. */
export class CellDraftStore {
  private readonly drafts = new Map<string, CellDraft>();

  get(id: string): CellDraft | null {
    return this.drafts.get(id) ?? null;
  }

  put(draft: Omit<CellDraft, 'updatedAt'>): CellDraft {
    const next = { ...draft, updatedAt: Date.now() };
    this.drafts.set(draft.id, next);
    return next;
  }

  patch(id: string, fields: CellDraftPatch): CellDraft | null {
    const current = this.drafts.get(id);
    if (!current) return null;
    const next = { ...current, ...fields, id, updatedAt: Date.now() };
    this.drafts.set(id, next);
    return next;
  }

  remove(id: string): boolean {
    return this.drafts.delete(id);
  }
}
