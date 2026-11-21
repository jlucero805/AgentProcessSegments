import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type { Cell } from '../domain/request.js';

interface CellRow {
  id: string;
  name: string;
  master_enabled: number;
  created_at: number;
}

export class CellNotFoundError extends Error {
  constructor(id: string) {
    super(`cell ${id} not found`);
    this.name = 'CellNotFoundError';
  }
}

function toCell(row: CellRow): Cell {
  return {
    id: row.id,
    name: row.name,
    masterEnabled: row.master_enabled === 1,
    createdAt: row.created_at,
  };
}

export class CellRepository {
  constructor(private readonly db: Db) {}

  list(): Cell[] {
    const rows = this.db.prepare('SELECT * FROM cells ORDER BY name COLLATE NOCASE').all() as CellRow[];
    return rows.map(toCell);
  }

  get(id: string): Cell | null {
    const row = this.db.prepare('SELECT * FROM cells WHERE id = ?').get(id) as CellRow | undefined;
    return row ? toCell(row) : null;
  }

  require(id: string): Cell {
    const cell = this.get(id);
    if (!cell) throw new CellNotFoundError(id);
    return cell;
  }

  create(name: string): Cell {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO cells (id, name, master_enabled, created_at) VALUES (?, ?, 1, ?)')
      .run(id, name, Date.now());
    const cell = this.get(id);
    if (!cell) throw new Error('cell insert did not persist');
    return cell;
  }

  setMasterEnabled(id: string, enabled: boolean): Cell {
    const result = this.db
      .prepare('UPDATE cells SET master_enabled = ? WHERE id = ?')
      .run(enabled ? 1 : 0, id);
    if (result.changes === 0) throw new CellNotFoundError(id);
    return this.require(id);
  }

  rename(id: string, name: string): Cell {
    const result = this.db.prepare('UPDATE cells SET name = ? WHERE id = ?').run(name, id);
    if (result.changes === 0) throw new CellNotFoundError(id);
    const cell = this.get(id);
    if (!cell) throw new CellNotFoundError(id);
    return cell;
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
