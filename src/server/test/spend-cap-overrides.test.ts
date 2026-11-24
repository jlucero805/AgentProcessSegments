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
