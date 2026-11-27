import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../src/db.js';
import { SummaryRepository } from '../src/summary/repository.js';
import type { SummaryStats } from '../src/summary/types.js';

let db: Db | null = null;

const STATS: SummaryStats = {
  windowStart: 0,
  windowEnd: 0,
  windowMinutes: 6,
  cell: { id: 'c1', name: 'Alpha' },
  requests: {
    total: 0,
    byState: {
      clarify: 0,
      dispatch: 0,
      review: 0,
      merge: 0,
      finalize: 0,
      done: 0,
      dropped: 0,
    },
    created: 0,
    updated: 0,
    completed: 0,
    dropped: 0,
    stalled: [],
    unchecked: 0,
    agentStatus: { none: 0, idle: 0, working: 0, blocked: 0, error: 0 },
  },
  activity: {
    cycles: 0,
    started: 0,
    prodded: 0,
    reviewed: 0,
    advanced: 0,
    followUps: 0,
    skipped: 0,
    followUpTitles: [],
    skipReasons: [],
  },
  previous: {
    created: 0,
    completed: 0,
    dropped: 0,
    activity: {
      cycles: 0,
      started: 0,
      prodded: 0,
      reviewed: 0,
      advanced: 0,
      followUps: 0,
      skipped: 0,
    },
  },
};

function setup(): SummaryRepository {
  db = openDb(':memory:');
  return new SummaryRepository(db);
}

function recordAt(
  repo: SummaryRepository,
  cellId: string,
  content: string,
  createdAt: number,
) {
  vi.spyOn(Date, 'now').mockReturnValue(createdAt);
  return repo.record({
    cellId,
    windowStart: createdAt - 6 * 60_000,
    windowEnd: createdAt,
    windowMinutes: 6,
    content,
    stats: STATS,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  db?.close();
  db = null;
});

describe('summary repository history filters', () => {
  it('filters on generation time with an inclusive since bound', () => {
    const repo = setup();
    recordAt(repo, 'c1', 'oldest', 1_000);
    recordAt(repo, 'c1', 'middle', 2_000);
    recordAt(repo, 'c1', 'newest', 3_000);

    expect(repo.list().map((row) => row.content)).toEqual(['newest', 'middle', 'oldest']);
    expect(repo.list({ since: 2_000 }).map((row) => row.content)).toEqual([
      'newest',
      'middle',
    ]);
    expect(repo.list({ since: 2_001 }).map((row) => row.content)).toEqual(['newest']);
    expect(repo.list({ since: 3_001 })).toEqual([]);
  });

  it('filters on generation time with an inclusive until bound', () => {
    const repo = setup();
    recordAt(repo, 'c1', 'oldest', 1_000);
    recordAt(repo, 'c1', 'middle', 2_000);
    recordAt(repo, 'c1', 'newest', 3_000);

    expect(repo.list({ until: 2_000 }).map((row) => row.content)).toEqual([
      'middle',
      'oldest',
    ]);
    expect(repo.list({ until: 1_999 }).map((row) => row.content)).toEqual(['oldest']);
    expect(
      repo.list({ since: 2_000, until: 2_000 }).map((row) => row.content),
    ).toEqual(['middle']);
    expect(repo.list({ since: 3_000, until: 1_000 })).toEqual([]);
  });

  it('combines until with cell and cursor filters', () => {
    const repo = setup();
    recordAt(repo, 'c1', 'alpha-old', 1_000);
    const alphaNew = recordAt(repo, 'c1', 'alpha-new', 3_000);
    recordAt(repo, 'c2', 'beta-new', 3_000);

    expect(
      repo.list({ cellId: 'c1', since: 0, until: 2_000 }).map((row) => row.content),
    ).toEqual(['alpha-old']);
    expect(
      repo
        .list({
          cellId: 'c1',
          since: 0,
          until: alphaNew.createdAt,
          before: alphaNew.createdAt,
          beforeId: alphaNew.id,
        })
        .map((row) => row.content),
    ).toEqual(['alpha-old']);
  });

  it('pages with a tie-safe created_at and id cursor', () => {
    const repo = setup();
    const below = recordAt(repo, 'c1', 'below', 4_000);
    const first = recordAt(repo, 'c1', 'tie-a', 5_000);
    const second = recordAt(repo, 'c1', 'tie-b', 5_000);
    const above = recordAt(repo, 'c1', 'above', 6_000);

    const [newerTie, olderTie] = [first, second].sort((a, b) => (a.id < b.id ? 1 : -1));
    if (!newerTie || !olderTie) throw new Error('expected two tied reports');

    expect(repo.list({ since: 4_000 }).map((row) => row.id)).toEqual([
      above.id,
      newerTie.id,
      olderTie.id,
      below.id,
    ]);

    const afterNewer = repo.list({
      since: 4_000,
      before: newerTie.createdAt,
      beforeId: newerTie.id,
    });
    expect(afterNewer.map((row) => row.content)).toEqual([olderTie.content, 'below']);

    const afterOlder = repo.list({
      since: 4_000,
      before: olderTie.createdAt,
      beforeId: olderTie.id,
    });
    expect(afterOlder.map((row) => row.content)).toEqual(['below']);
  });

  it('combines cell, period, and cursor filters without leaking another cell', () => {
    const repo = setup();
    recordAt(repo, 'c1', 'alpha-old', 1_000);
    const alphaNew = recordAt(repo, 'c1', 'alpha-new', 3_000);
    recordAt(repo, 'c2', 'beta-new', 3_000);

    expect(repo.list({ cellId: 'c1', since: 2_000 }).map((row) => row.content)).toEqual([
      'alpha-new',
    ]);
    expect(repo.list({ cellId: 'c2', since: 2_000 }).map((row) => row.content)).toEqual([
      'beta-new',
    ]);
    expect(
      repo
        .list({
          cellId: 'c1',
          since: 0,
          before: alphaNew.createdAt,
          beforeId: alphaNew.id,
        })
        .map((row) => row.content),
    ).toEqual(['alpha-old']);
  });

  it('keeps the one-to-fifty limit clamp and leaves latest alone', () => {
    const repo = setup();
    for (let index = 0; index < 51; index += 1) {
      recordAt(repo, 'c1', `report-${index}`, 1_000 + index);
    }

    expect(repo.list({ limit: 100 })).toHaveLength(50);
    expect(repo.list({ limit: 0 })).toHaveLength(1);
    expect(repo.list({ limit: 1 })[0]?.content).toBe('report-50');
    expect(repo.latest('c1')?.content).toBe('report-50');
  });
});
