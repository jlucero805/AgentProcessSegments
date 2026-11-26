import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type { BudgetScope, SpendCapOverrideState } from '../domain/budget.js';

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
  extendedAt: number | null;
  extensionCount: number;
}

export interface SpendCapOverrideHistoryFilter {
  scope?: BudgetScope;
  scopeId?: string;
  state?: SpendCapOverrideState;
  /** Inclusive period_start lower bound. */
  from?: number;
  /** Exclusive period_start upper bound. */
  to?: number;
  limit: number;
  offset: number;
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
  extended_at: number | null;
  extension_count: number;
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
    extendedAt: row.extended_at,
    extensionCount: row.extension_count,
  };
}

function historyWhere(
  filter: SpendCapOverrideHistoryFilter,
  now: number,
): { clause: string; params: Array<string | number> } {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.scope !== undefined) {
    clauses.push('scope = ?');
    params.push(filter.scope);
  }
  if (filter.scopeId !== undefined) {
    clauses.push('scope_id = ?');
    params.push(filter.scopeId);
  }
  if (filter.state === 'revoked') {
    clauses.push('revoked_at IS NOT NULL');
  } else if (filter.state === 'expired') {
    clauses.push('revoked_at IS NULL AND expires_at <= ?');
    params.push(now);
  } else if (filter.state === 'active') {
    clauses.push('revoked_at IS NULL AND expires_at > ?');
    params.push(now);
  }
  if (filter.from !== undefined) {
    clauses.push('period_start >= ?');
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    clauses.push('period_start < ?');
    params.push(filter.to);
  }
  return {
    clause: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
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
      // Re-granting can extend the window; a null note keeps the stored reason.
      // Only a later expiry counts as an extension, and every extension refreshes
      // the history timestamp while an equal/shorter regrant does not.
      const extended = input.expiresAt > existing.expires_at;
      this.db
        .prepare(
          `UPDATE spend_cap_overrides
              SET expires_at = MAX(expires_at, ?),
                  note = COALESCE(?, note),
                  extended_at = ?,
                  extension_count = ?,
                  updated_at = ?
            WHERE id = ?`,
        )
        .run(
          input.expiresAt,
          input.note,
          extended ? now : existing.extended_at,
          existing.extension_count + (extended ? 1 : 0),
          now,
          existing.id,
        );
      return { record: this.get(existing.id)!, created: false };
    }

    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO spend_cap_overrides
           (id, scope, scope_id, period_start, expires_at, note, created_at, updated_at,
            revoked_at, extended_at, extension_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)`,
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

  listHistory(filter: SpendCapOverrideHistoryFilter, now: number): SpendCapOverrideRecord[] {
    const { clause, params } = historyWhere(filter, now);
    const rows = this.db
      .prepare(
        `SELECT * FROM spend_cap_overrides
         ${clause}
         ORDER BY period_start DESC, created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, filter.limit, filter.offset) as SpendCapOverrideRow[];
    return rows.map(toRecord);
  }

  countHistory(filter: SpendCapOverrideHistoryFilter, now: number): number {
    const { clause, params } = historyWhere(filter, now);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM spend_cap_overrides ${clause}`)
      .get(...params) as { count: number } | undefined;
    return row?.count ?? 0;
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
