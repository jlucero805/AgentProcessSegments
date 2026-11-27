import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RANGE,
  customRangeSeedFromWindow,
  customWindow,
  parseScorecardPeriod,
  writeScorecardPeriod,
} from './ScorecardPeriod';

function periodParams(values: Record<string, string>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) params.set(key, value);
  return params;
}

const CUSTOM = {
  period: 'custom',
  startDate: '2026-11-01',
  startTime: '08:00',
  endDate: '2026-11-01',
  endTime: '12:00',
};

describe('parseScorecardPeriod', () => {
  it.each([undefined, '', '72h', 'bogus'])(
    'falls back to the default for period=%s',
    (value) => {
      const params = new URLSearchParams();
      if (value !== undefined) params.set('period', value);
      expect(parseScorecardPeriod(params)).toEqual({ range: DEFAULT_RANGE });
    },
  );

  it.each(['24h', '7d', '30d', 'all'] as const)('reads the %s preset', (range) => {
    expect(parseScorecardPeriod(periodParams({ period: range }))).toEqual({ range });
  });

  it('reads a complete custom range', () => {
    expect(parseScorecardPeriod(periodParams(CUSTOM))).toEqual({
      range: 'custom',
      custom: {
        start: '2026-11-01',
        end: '2026-11-01',
        startTime: '08:00',
        endTime: '12:00',
      },
    });
  });

  it('defaults blank custom times to the day edges', () => {
    expect(
      parseScorecardPeriod(
        periodParams({
          period: 'custom',
          startDate: '2026-11-01',
          startTime: '',
          endDate: '2026-11-15',
          endTime: '',
        }),
      ),
    ).toEqual({
      range: 'custom',
      custom: {
        start: '2026-11-01',
        end: '2026-11-15',
        startTime: '00:00',
        endTime: '23:59',
      },
    });
  });

  it.each([
    ['a missing start date', { period: 'custom', endDate: '2026-11-01' }],
    ['a missing end date', { period: 'custom', startDate: '2026-11-01' }],
    ['an impossible date', { ...CUSTOM, startDate: '2026-02-30' }],
    ['a malformed time', { ...CUSTOM, startTime: '8:00' }],
    ['an out-of-range time', { ...CUSTOM, endTime: '24:00' }],
    ['an inverted range', { ...CUSTOM, startTime: '12:00', endTime: '08:00' }],
  ] as Array<[string, Record<string, string>]>)(
    'falls back for %s',
    (_name, values) => {
      expect(parseScorecardPeriod(periodParams(values))).toEqual({ range: DEFAULT_RANGE });
    },
  );
});

describe('writeScorecardPeriod', () => {
  it('omits the default and clears stale custom keys', () => {
    const params = periodParams({ ...CUSTOM, cell: 'c1' });
    writeScorecardPeriod(params, { range: DEFAULT_RANGE });
    expect(params.toString()).toBe('cell=c1');
  });

  it('writes a preset and removes custom keys', () => {
    const params = periodParams(CUSTOM);
    writeScorecardPeriod(params, { range: '7d' });
    expect(params.toString()).toBe('period=7d');
  });

  it('writes a complete custom range', () => {
    const params = periodParams({ period: '7d' });
    writeScorecardPeriod(params, {
      range: 'custom',
      custom: {
        start: '2026-11-01',
        end: '2026-11-01',
        startTime: '08:00',
        endTime: '12:00',
      },
    });
    expect(params.get('period')).toBe('custom');
    expect(params.get('startDate')).toBe('2026-11-01');
    expect(params.get('startTime')).toBe('08:00');
    expect(params.get('endDate')).toBe('2026-11-01');
    expect(params.get('endTime')).toBe('12:00');
  });

  it('normalizes blank times to the day edges', () => {
    const params = new URLSearchParams();
    writeScorecardPeriod(params, {
      range: 'custom',
      custom: {
        start: '2026-11-01',
        end: '2026-11-15',
        startTime: '',
        endTime: '',
      },
    });
    expect(params.get('startTime')).toBe('00:00');
    expect(params.get('endTime')).toBe('23:59');
  });

  it('writes nothing for an invalid custom range', () => {
    const params = periodParams({ cell: 'c1' });
    writeScorecardPeriod(params, {
      range: 'custom',
      custom: {
        start: '2026-02-30',
        end: '2026-11-15',
        startTime: '00:00',
        endTime: '23:59',
      },
    });
    expect(params.toString()).toBe('cell=c1');
  });
});

describe('customRangeSeedFromWindow', () => {
  it('round-trips an applied custom window', () => {
    const window = {
      since: new Date(2026, 10, 1, 8, 0, 0, 0).getTime(),
      until: new Date(2026, 10, 1, 12, 0, 59, 999).getTime(),
    };
    const seed = customRangeSeedFromWindow(window);
    expect(seed).toEqual({
      start: '2026-11-01',
      end: '2026-11-01',
      startTime: '08:00',
      endTime: '12:00',
    });
    expect(customWindow(seed!.start, seed!.end, seed!.startTime, seed!.endTime)).toEqual(
      window,
    );
  });

  it('keeps the end of day at the selected minute', () => {
    expect(
      customRangeSeedFromWindow({
        since: new Date(2026, 10, 1, 0, 0, 0, 0).getTime(),
        until: new Date(2026, 10, 15, 23, 59, 59, 999).getTime(),
      }),
    ).toEqual({
      start: '2026-11-01',
      end: '2026-11-15',
      startTime: '00:00',
      endTime: '23:59',
    });
  });

  it.each([{}, { since: 1 }, { until: 2 }])('returns null for a partial window', (window) => {
    expect(customRangeSeedFromWindow(window)).toBeNull();
  });
});
