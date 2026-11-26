import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { SpendCapOverrideRepository } from '../src/usage/spend-cap-overrides.js';

const PERIOD = Date.UTC(2026, 10, 1);
const NOW = Date.UTC(2026, 10, 15, 12);

function makeRepo(): SpendCapOverrideRepository {
  return new SpendCapOverrideRepository(openDb(':memory:'));
}

describe('spend cap overrides', () => {
  it('creates one active row and extends it instead of stacking', () => {
    const repo = makeRepo();

    const first = repo.grant(
      {
        scope: 'overall',
        scopeId: '',
        periodStart: PERIOD,
        expiresAt: NOW + 60_000,
        note: 'release review',
      },
      NOW,
    );
    expect(first.created).toBe(true);
    expect(first.record.note).toBe('release review');

    const second = repo.grant(
      {
        scope: 'overall',
        scopeId: '',
        periodStart: PERIOD,
        expiresAt: NOW + 120_000,
        note: null,
      },
      NOW + 1000,
    );
    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);
    expect(second.record.expiresAt).toBe(NOW + 120_000);
    expect(second.record.note).toBe('release review');
    expect(repo.listActive(PERIOD, NOW)).toHaveLength(1);
  });

  it('honours expiry, revocation, and the period', () => {
    const repo = makeRepo();
    const { record } = repo.grant(
      {
        scope: 'cell',
        scopeId: 'cell-1',
        periodStart: PERIOD,
        expiresAt: NOW + 60_000,
        note: null,
      },
      NOW,
    );

    expect(repo.activeFor('cell', 'cell-1', PERIOD, NOW)).not.toBeNull();
    expect(repo.activeFor('cell', 'cell-1', PERIOD, NOW + 60_000)).toBeNull();
    expect(repo.activeFor('cell', 'cell-1', PERIOD + 1, NOW)).toBeNull();
    expect(repo.activeFor('cell', 'cell-2', PERIOD, NOW)).toBeNull();

    const revoked = repo.revoke(record.id, NOW + 1000);
    expect(revoked?.revokedAt).toBe(NOW + 1000);
    expect(repo.activeFor('cell', 'cell-1', PERIOD, NOW + 2000)).toBeNull();
    expect(repo.revoke(record.id, NOW + 3000)?.revokedAt).toBe(NOW + 1000);
    expect(repo.revoke('missing', NOW)).toBeNull();
  });

  it('allows a new active row after revocation and keeps history', () => {
    const repo = makeRepo();
    const first = repo.grant(
      {
        scope: 'overall',
        scopeId: '',
        periodStart: PERIOD,
        expiresAt: NOW + 60_000,
        note: null,
      },
      NOW,
    );
    repo.revoke(first.record.id, NOW + 1000);

    const second = repo.grant(
      {
        scope: 'overall',
        scopeId: '',
        periodStart: PERIOD,
        expiresAt: NOW + 120_000,
        note: null,
      },
      NOW + 2000,
    );
    expect(second.created).toBe(true);
    expect(second.record.id).not.toBe(first.record.id);
    expect(repo.get(first.record.id)?.revokedAt).toBe(NOW + 1000);
    expect(repo.listActive(PERIOD, NOW + 2000)).toHaveLength(1);
  });

  it('counts only a later expiry as an extension and preserves the last one', () => {
    const repo = makeRepo();
    const first = repo.grant(
      {
        scope: 'overall',
        scopeId: '',
        periodStart: PERIOD,
        expiresAt: NOW + 60_000,
        note: 'release review',
      },
      NOW,
    );
    expect(first.record.extensionCount).toBe(0);
    expect(first.record.extendedAt).toBeNull();

    const later = repo.grant(
      {
        scope: 'overall',
        scopeId: '',
        periodStart: PERIOD,
        expiresAt: NOW + 120_000,
        note: null,
      },
      NOW + 1000,
    );
    expect(later.record.extensionCount).toBe(1);
    expect(later.record.extendedAt).toBe(NOW + 1000);
    expect(later.record.expiresAt).toBe(NOW + 120_000);

    const shorter = repo.grant(
      {
        scope: 'overall',
        scopeId: '',
        periodStart: PERIOD,
        expiresAt: NOW + 90_000,
        note: 'still the same window',
      },
      NOW + 2000,
    );
    expect(shorter.record.extensionCount).toBe(1);
    expect(shorter.record.extendedAt).toBe(NOW + 1000);
    expect(shorter.record.expiresAt).toBe(NOW + 120_000);
    expect(shorter.record.note).toBe('still the same window');

    const secondExtension = repo.grant(
      {
        scope: 'overall',
        scopeId: '',
        periodStart: PERIOD,
        expiresAt: NOW + 180_000,
        note: null,
      },
      NOW + 3000,
    );
    expect(secondExtension.record.extensionCount).toBe(2);
    expect(secondExtension.record.extendedAt).toBe(NOW + 3000);

    const revoked = repo.revoke(first.record.id, NOW + 4000);
    expect(revoked?.extensionCount).toBe(2);
    expect(revoked?.extendedAt).toBe(NOW + 3000);

    const replacement = repo.grant(
      {
        scope: 'overall',
        scopeId: '',
        periodStart: PERIOD,
        expiresAt: NOW + 240_000,
        note: null,
      },
      NOW + 5000,
    );
    expect(replacement.created).toBe(true);
    expect(replacement.record.id).not.toBe(first.record.id);
    expect(replacement.record.extensionCount).toBe(0);
    expect(replacement.record.extendedAt).toBeNull();
  });

  it('lists retained history across periods with state, scope, and page filters', () => {
    const repo = makeRepo();
    const previous = Date.UTC(2026, 9, 1);
    const activeOverall = repo.grant(
      {
        scope: 'overall',
        scopeId: '',
        periodStart: PERIOD,
        expiresAt: NOW + 60_000,
        note: 'overall window',
      },
      NOW - 4000,
    );
    const activeCell = repo.grant(
      {
        scope: 'cell',
        scopeId: 'cell-1',
        periodStart: PERIOD,
        expiresAt: NOW + 120_000,
        note: null,
      },
      NOW - 3000,
    );
    repo.grant(
      {
        scope: 'cell',
        scopeId: 'cell-2',
        periodStart: PERIOD,
        expiresAt: NOW - 1000,
        note: 'already expired',
      },
      NOW - 2000,
    );
    repo.grant(
      {
        scope: 'overall',
        scopeId: '',
        periodStart: previous,
        expiresAt: previous + 60_000,
        note: 'prior month',
      },
      previous,
    );
    const revoked = repo.grant(
      {
        scope: 'cell',
        scopeId: 'cell-3',
        periodStart: PERIOD,
        expiresAt: NOW + 180_000,
        note: 'ended early',
      },
      NOW - 1000,
    );
    repo.revoke(revoked.record.id, NOW - 500);

    const all = { limit: 10, offset: 0 };
    const history = repo.listHistory(all, NOW);
    expect(history).toHaveLength(5);
    expect(repo.countHistory(all, NOW)).toBe(5);
    expect(history.map((record) => record.note)).toEqual([
      'ended early',
      'already expired',
      null,
      'overall window',
      'prior month',
    ]);

    expect(repo.countHistory({ ...all, state: 'active' }, NOW)).toBe(2);
    expect(repo.countHistory({ ...all, state: 'expired' }, NOW)).toBe(2);
    expect(repo.countHistory({ ...all, state: 'revoked' }, NOW)).toBe(1);
    expect(repo.countHistory({ ...all, scope: 'overall' }, NOW)).toBe(2);
    expect(repo.countHistory({ ...all, scope: 'cell' }, NOW)).toBe(3);
    expect(repo.countHistory({ ...all, scope: 'cell', scopeId: 'cell-2' }, NOW)).toBe(1);
    expect(repo.countHistory({ ...all, from: PERIOD }, NOW)).toBe(4);
    expect(repo.countHistory({ ...all, to: PERIOD }, NOW)).toBe(1);
    expect(repo.countHistory({ ...all, from: previous, to: PERIOD }, NOW)).toBe(1);

    const page = repo.listHistory({ limit: 2, offset: 1 }, NOW);
    expect(page.map((record) => record.note)).toEqual(['already expired', null]);
    expect(repo.listHistory({ ...all, state: 'active' }, NOW).map((record) => record.id)).toEqual([
      activeCell.record.id,
      activeOverall.record.id,
    ]);
  });

  it('prunes only periods older than the cutoff', () => {
    const repo = makeRepo();
    repo.grant(
      {
        scope: 'overall',
        scopeId: '',
        periodStart: PERIOD,
        expiresAt: NOW + 60_000,
        note: null,
      },
      NOW,
    );
    const nextPeriod = Date.UTC(2026, 11, 1);
    repo.grant(
      {
        scope: 'overall',
        scopeId: '',
        periodStart: nextPeriod,
        expiresAt: nextPeriod + 60_000,
        note: null,
      },
      nextPeriod,
    );

    expect(repo.pruneBefore(nextPeriod)).toBe(1);
    expect(repo.listActive(nextPeriod, nextPeriod)).toHaveLength(1);
  });
});
