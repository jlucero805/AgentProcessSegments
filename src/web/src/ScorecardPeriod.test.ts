import { describe, expect, it } from 'vitest';
import {
  dateTimeInputValue,
  readScorecardRoute,
  scorecardRouteParams,
} from './ScorecardPeriod';

const NOW = new Date(2026, 10, 27, 10, 0, 0, 0).getTime();

describe('readScorecardRoute', () => {
  it('defaults to the last 72 hours and grouped layout', () => {
    expect(readScorecardRoute('', NOW)).toEqual({
      range: '72h',
      view: 'grouped',
      customSeed: {
        start: '2026-11-24',
        end: '2026-11-27',
        startTime: '00:00',
        endTime: '23:59',
      },
      appliedCustom: {},
      normalize: false,
    });
  });

  it.each(['24h', '72h', '7d', '30d', 'all'])('restores the %s preset', (range) => {
    const route = readScorecardRoute(`?period=${range}`, NOW);
    expect(route.range).toBe(range);
    expect(route.appliedCustom).toEqual({});
    expect(route.normalize).toBe(false);
  });

  it('accepts explicit defaults without rewriting the URL', () => {
    const route = readScorecardRoute('?period=72h&view=grouped', NOW);
    expect(route.range).toBe('72h');
    expect(route.view).toBe('grouped');
    expect(route.normalize).toBe(false);
  });

  it('restores a custom window with local minute edges', () => {
    const route = readScorecardRoute(
      '?period=custom&from=2026-11-01T08:00&to=2026-11-01T12:00&view=flat',
      NOW,
    );
    expect(route.range).toBe('custom');
    expect(route.view).toBe('flat');
    expect(route.customSeed).toEqual({
      start: '2026-11-01',
      end: '2026-11-01',
      startTime: '08:00',
      endTime: '12:00',
    });
    expect(route.appliedCustom).toEqual({
      since: new Date(2026, 10, 1, 8, 0, 0, 0).getTime(),
      until: new Date(2026, 10, 1, 12, 0, 59, 999).getTime(),
    });
    expect(route.normalize).toBe(false);
  });

  it('does not revalidate a past custom window against now', () => {
    const route = readScorecardRoute(
      '?period=custom&from=2020-01-01T00:00&to=2020-01-02T23:59',
      NOW,
    );
    expect(route.range).toBe('custom');
    expect(route.appliedCustom.since).toBe(new Date(2020, 0, 1, 0, 0, 0, 0).getTime());
    expect(route.appliedCustom.until).toBe(new Date(2020, 0, 2, 23, 59, 59, 999).getTime());
    expect(route.normalize).toBe(false);
  });

  it.each([
    ['missing end', '?period=custom&from=2026-11-01T08:00'],
    ['malformed edge', '?period=custom&from=2026-11-01&to=2026-11-02'],
    ['impossible date', '?period=custom&from=2026-02-31T08:00&to=2026-02-31T12:00'],
    ['inverted', '?period=custom&from=2026-11-02T08:00&to=2026-11-01T12:00'],
    ['unknown period', '?period=month'],
    ['empty period', '?period='],
  ])('falls back to 72h for %s', (_label, search) => {
    const route = readScorecardRoute(search, NOW);
    expect(route.range).toBe('72h');
    expect(route.appliedCustom).toEqual({});
    expect(route.normalize).toBe(true);
  });

  it('drops stale edges from a preset URL', () => {
    const route = readScorecardRoute(
      '?period=7d&from=2026-11-01T08:00&to=2026-11-01T12:00',
      NOW,
    );
    expect(route.range).toBe('7d');
    expect(route.normalize).toBe(true);
  });

  it('falls back to grouped for an unknown or empty layout', () => {
    for (const search of ['?view=wide', '?view=']) {
      const route = readScorecardRoute(search, NOW);
      expect(route.view).toBe('grouped');
      expect(route.normalize).toBe(true);
    }
  });

  it('keeps a valid custom window when only the layout is invalid', () => {
    const route = readScorecardRoute(
      '?period=custom&from=2026-11-01T08:00&to=2026-11-01T12:00&view=wide',
      NOW,
    );
    expect(route.range).toBe('custom');
    expect(route.view).toBe('grouped');
    expect(route.normalize).toBe(true);
  });
});

describe('scorecardRouteParams', () => {
  const custom = {
    since: new Date(2026, 10, 1, 8, 0, 0, 0).getTime(),
    until: new Date(2026, 10, 1, 12, 0, 59, 999).getTime(),
  };

  it('omits the canonical defaults', () => {
    expect(scorecardRouteParams('72h', 'grouped', {})).toEqual({
      period: null,
      from: null,
      to: null,
      view: null,
    });
  });

  it('writes a short preset token and removes the edges', () => {
    expect(scorecardRouteParams('7d', 'grouped', custom)).toEqual({
      period: '7d',
      from: null,
      to: null,
      view: null,
    });
  });

  it('encodes both custom edges in local minute form with the inclusive end minute', () => {
    expect(scorecardRouteParams('custom', 'flat', custom)).toEqual({
      period: 'custom',
      from: '2026-11-01T08:00',
      to: '2026-11-01T12:00',
      view: 'flat',
    });
  });

  it('does not emit a partial custom URL', () => {
    expect(scorecardRouteParams('custom', 'grouped', { since: custom.since })).toEqual({
      period: null,
      from: null,
      to: null,
      view: null,
    });
  });

  it('formats the inclusive end minute from the window end', () => {
    expect(dateTimeInputValue(custom.until)).toBe('2026-11-01T12:00');
  });
});
