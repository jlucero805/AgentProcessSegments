import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import { processSchema } from '../process/defaults.js';
import type { CellDetail, ProcessConfig } from '../process/definition.js';

interface CellRow {
  id: string;
  name: string;
  master_enabled: number;
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
    const result = processSchema.safeParse(JSON.parse(raw));
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

  create(name: string, process: ProcessConfig | null = null): CellDetail {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO cells (id, name, master_enabled, process_json, created_at) VALUES (?, ?, 1, ?, ?)',
      )
      .run(id, name, process ? JSON.stringify(process) : null, Date.now());
    return this.require(id);
  }

  setProcess(id: string, process: ProcessConfig | null): CellDetail {
    const result = this.db
      .prepare('UPDATE cells SET process_json = ? WHERE id = ?')
      .run(process ? JSON.stringify(process) : null, id);
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
      return this.db.prepare('DELETE FROM cells WHERE id = ?').run(cellId).changes;
    });
    if (remove(id) === 0) throw new CellNotFoundError(id);
  }
}
