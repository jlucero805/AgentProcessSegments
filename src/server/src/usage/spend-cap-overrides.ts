import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type { BudgetScope } from '../domain/budget.js';

export interface SpendCapOverrideRecord {
  id: string;
  scope: BudgetScope;
  scopeId: string;
  periodStart: number;
  expiresAt: number;
  note: string | null;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
}

export interface SpendCapOverrideInput {
  scope: BudgetScope;
  scopeId: string;
  periodStart: number;
  expiresAt: number;
  note: string | null;
}

interface SpendCapOverrideRow {
  id: string;
  scope: BudgetScope;
  scope_id: string;
  period_start: number;
  expires_at: number;
  note: string | null;
  created_at: number;
  updated_at: number;
  revoked_at: number | null;
}

function toRecord(row: SpendCapOverrideRow): SpendCapOverrideRecord {
  return {
    id: row.id,
    scope: row.scope,
    scopeId: row.scope_id,
    periodStart: row.period_start,
    expiresAt: row.expires_at,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * Durable operator overrides of hard spend caps. One non-revoked row per scope
 * and UTC period is enforced by a partial unique index, so a re-grant extends
 * the existing window instead of stacking rows. Revoked and expired rows stay
 * as history until the retention prune removes them.
 */
export class SpendCapOverrideRepository {
  constructor(private readonly db: Db) {}

  activeFor(
    scope: BudgetScope,
    scopeId: string,
    periodStart: number,
    now: number,
  ): SpendCapOverrideRecord | null {
    const row = this.db
      .prepare(
        `SELECT * FROM spend_cap_overrides
          WHERE scope = ? AND scope_id = ? AND period_start = ?
            AND revoked_at IS NULL AND expires_at > ?
          LIMIT 1`,
      )
      .get(scope, scopeId, periodStart, now) as SpendCapOverrideRow | undefined;
    return row ? toRecord(row) : null;
  }

  listActive(periodStart: number, now: number): SpendCapOverrideRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM spend_cap_overrides
          WHERE period_start = ? AND revoked_at IS NULL AND expires_at > ?
          ORDER BY created_at ASC, id ASC`,
      )
      .all(periodStart, now) as SpendCapOverrideRow[];
    return rows.map(toRecord);
  }

  grant(input: SpendCapOverrideInput, now: number): {
    record: SpendCapOverrideRecord;
    created: boolean;
  } {
    const existing = this.db
      .prepare(
        `SELECT * FROM spend_cap_overrides
          WHERE scope = ? AND scope_id = ? AND period_start = ? AND revoked_at IS NULL
          LIMIT 1`,
      )
      .get(input.scope, input.scopeId, input.periodStart) as
      | SpendCapOverrideRow
      | undefined;

    if (existing) {
      // Re-granting extends the window; a null note keeps the stored reason.
      this.db
        .prepare(
          `UPDATE spend_cap_overrides
              SET expires_at = MAX(expires_at, ?),
                  note = COALESCE(?, note),
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(input.expiresAt, input.note, now, existing.id);
      return { record: this.get(existing.id)!, created: false };
    }

    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO spend_cap_overrides
           (id, scope, scope_id, period_start, expires_at, note, created_at, updated_at,
            revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        id,
        input.scope,
        input.scopeId,
        input.periodStart,
        input.expiresAt,
        input.note,
        now,
        now,
      );
    return { record: this.get(id)!, created: true };
  }

  get(id: string): SpendCapOverrideRecord | null {
    const row = this.db
      .prepare('SELECT * FROM spend_cap_overrides WHERE id = ?')
      .get(id) as SpendCapOverrideRow | undefined;
    return row ? toRecord(row) : null;
  }

  revoke(id: string, now: number): SpendCapOverrideRecord | null {
    this.db
      .prepare(
        `UPDATE spend_cap_overrides
            SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
          WHERE id = ?`,
      )
      .run(now, now, id);
    return this.get(id);
  }

  pruneBefore(periodStartCutoff: number): number {
    return this.db
      .prepare('DELETE FROM spend_cap_overrides WHERE period_start < ?')
      .run(periodStartCutoff).changes;
  }
}
