import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import { isHarnessId, type HarnessId } from '../domain/harness.js';
import type { Effort } from '../domain/request.js';
import { DEFAULT_MAX_CONCURRENT } from '../domain/request.js';
import { normalizeProcess, processSchema } from '../process/defaults.js';
import type { CellDetail, ProcessConfig } from '../process/definition.js';

interface CellRow {
  id: string;
  name: string;
  master_enabled: number;
  master_interval_minutes: number | null;
  max_concurrent: number;
  harness: HarnessId | null;
  model: string | null;
  effort: Effort | null;
  monthly_budget_usd: number | null;
  process_json: string | null;
  created_at: number;
}

export class CellNotFoundError extends Error {
  constructor(id: string) {
    super(`cell ${id} not found`);
    this.name = 'CellNotFoundError';
  }
}

function parseProcess(raw: string | null): ProcessConfig | null {
  if (!raw) return null;
  try {
    const result = processSchema.safeParse(normalizeProcess(JSON.parse(raw)));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function toCell(row: CellRow): CellDetail {
  return {
    id: row.id,
    name: row.name,
    masterEnabled: row.master_enabled === 1,
    masterIntervalMinutes: row.master_interval_minutes,
    maxConcurrent: row.max_concurrent ?? DEFAULT_MAX_CONCURRENT,
    harness: isHarnessId(row.harness) ? row.harness : null,
    model: row.model,
    effort: row.effort,
    monthlyBudgetUsd: row.monthly_budget_usd ?? null,
    process: parseProcess(row.process_json),
    createdAt: row.created_at,
  };
}

export class CellRepository {
  constructor(private readonly db: Db) {}

  list(): CellDetail[] {
    const rows = this.db.prepare('SELECT * FROM cells ORDER BY name COLLATE NOCASE').all() as CellRow[];
    return rows.map(toCell);
  }

  get(id: string): CellDetail | null {
    const row = this.db.prepare('SELECT * FROM cells WHERE id = ?').get(id) as CellRow | undefined;
    return row ? toCell(row) : null;
  }

  require(id: string): CellDetail {
    const cell = this.get(id);
    if (!cell) throw new CellNotFoundError(id);
    return cell;
  }

  create(
    name: string,
    process: ProcessConfig | null = null,
    masterIntervalMinutes: number | null = null,
    options: {
      maxConcurrent?: number;
      harness?: HarnessId | null;
      model?: string | null;
      effort?: Effort | null;
      monthlyBudgetUsd?: number | null;
    } = {},
  ): CellDetail {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO cells
           (id, name, master_enabled, master_interval_minutes, max_concurrent, harness, model,
            effort, monthly_budget_usd, process_json, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        masterIntervalMinutes,
        options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
        options.harness ?? null,
        options.model ?? null,
        options.effort ?? null,
        options.monthlyBudgetUsd ?? null,
        process ? JSON.stringify(process) : null,
        Date.now(),
      );
    return this.require(id);
  }

  setProcess(id: string, process: ProcessConfig | null): CellDetail {
    const result = this.db
      .prepare('UPDATE cells SET process_json = ? WHERE id = ?')
      .run(process ? JSON.stringify(process) : null, id);
    if (result.changes === 0) throw new CellNotFoundError(id);
    return this.require(id);
  }

  setMasterInterval(id: string, minutes: number | null): CellDetail {
    const result = this.db
      .prepare('UPDATE cells SET master_interval_minutes = ? WHERE id = ?')
      .run(minutes, id);
    if (result.changes === 0) throw new CellNotFoundError(id);
    return this.require(id);
  }

  setMaxConcurrent(id: string, maxConcurrent: number): CellDetail {
    const result = this.db
      .prepare('UPDATE cells SET max_concurrent = ? WHERE id = ?')
      .run(maxConcurrent, id);
    if (result.changes === 0) throw new CellNotFoundError(id);
    return this.require(id);
  }

  setHarness(id: string, harness: HarnessId | null): CellDetail {
    const result = this.db
      .prepare('UPDATE cells SET harness = ? WHERE id = ?')
      .run(harness, id);
    if (result.changes === 0) throw new CellNotFoundError(id);
    return this.require(id);
  }

  setAgentDefaults(id: string, model: string | null, effort: Effort | null): CellDetail {
    const result = this.db
      .prepare('UPDATE cells SET model = ?, effort = ? WHERE id = ?')
      .run(model, effort, id);
    if (result.changes === 0) throw new CellNotFoundError(id);
    return this.require(id);
  }

  setMonthlyBudget(id: string, monthlyBudgetUsd: number | null): CellDetail {
    const result = this.db
      .prepare('UPDATE cells SET monthly_budget_usd = ? WHERE id = ?')
      .run(monthlyBudgetUsd, id);
    if (result.changes === 0) throw new CellNotFoundError(id);
    return this.require(id);
  }

  getProcess(id: string): ProcessConfig | null {
    return this.get(id)?.process ?? null;
  }

  setMasterEnabled(id: string, enabled: boolean): CellDetail {
    const result = this.db
      .prepare('UPDATE cells SET master_enabled = ? WHERE id = ?')
      .run(enabled ? 1 : 0, id);
    if (result.changes === 0) throw new CellNotFoundError(id);
    return this.require(id);
  }

  rename(id: string, name: string): CellDetail {
    const result = this.db.prepare('UPDATE cells SET name = ? WHERE id = ?').run(name, id);
    if (result.changes === 0) throw new CellNotFoundError(id);
    return this.require(id);
  }

  /**
   * A cell owns no requests. Deleting one only detaches its requests so they
   * fall back to the unfiltered floor.
   */
  remove(id: string): void {
    const remove = this.db.transaction((cellId: string) => {
      this.db.prepare('UPDATE requests SET cell_id = NULL WHERE cell_id = ?').run(cellId);
      this.db.prepare('DELETE FROM cell_summaries WHERE cell_id = ?').run(cellId);
      return this.db.prepare('DELETE FROM cells WHERE id = ?').run(cellId).changes;
    });
    if (remove(id) === 0) throw new CellNotFoundError(id);
  }
}
