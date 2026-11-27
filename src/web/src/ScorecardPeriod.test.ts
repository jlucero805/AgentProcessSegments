import { describe, expect, it } from 'vitest';
import { customWindow, formatMinute } from './ScorecardPeriod';

const INVERTED = 'Choose a start date and time on or before the end date and time.';

describe('customWindow', () => {
  it('requires both dates', () => {
    expect(customWindow('', '2026-11-15')).toBe('Choose both a start and end date.');
    expect(customWindow('2026-11-01', '')).toBe('Choose both a start and end date.');
  });

  it('rejects impossible dates and times', () => {
    expect(customWindow('2026-02-30', '2026-03-01')).toBe(
      'Choose a valid start and end date.',
    );
    expect(customWindow('2026-11-01', '2026-11-15', '24:00')).toBe(
      'Choose a valid start and end time.',
    );
    expect(customWindow('2026-11-01', '2026-11-15', '', '08:60')).toBe(
      'Choose a valid start and end time.',
    );
  });

  it('defaults blank times to the local day edges', () => {
    expect(customWindow('2026-11-01', '2026-11-15')).toEqual({
      since: new Date(2026, 10, 1).getTime(),
      until: new Date(2026, 10, 15, 23, 59, 59, 999).getTime(),
    });
  });

  it('resolves explicit times to whole minutes', () => {
    expect(customWindow('2026-11-01', '2026-11-01', '08:00', '12:00')).toEqual({
      since: new Date(2026, 10, 1, 8, 0, 0, 0).getTime(),
      until: new Date(2026, 10, 1, 12, 0, 59, 999).getTime(),
    });
  });

  it('ignores seconds on an HH:mm:ss time input', () => {
    expect(customWindow('2026-11-01', '2026-11-01', '08:00:45', '12:00:45')).toEqual({
      since: new Date(2026, 10, 1, 8, 0, 0, 0).getTime(),
      until: new Date(2026, 10, 1, 12, 0, 59, 999).getTime(),
    });
  });

  it('allows an equal start and end minute', () => {
    expect(customWindow('2026-11-01', '2026-11-01', '09:30', '09:30')).toEqual({
      since: new Date(2026, 10, 1, 9, 30, 0, 0).getTime(),
      until: new Date(2026, 10, 1, 9, 30, 59, 999).getTime(),
    });
  });

  it('rejects an inverted window', () => {
    expect(customWindow('2026-11-02', '2026-11-01')).toBe(INVERTED);
    expect(customWindow('2026-11-01', '2026-11-01', '12:00', '08:00')).toBe(INVERTED);
  });
});

describe('formatMinute', () => {
  it('pads the local date and clock to two digits', () => {
    expect(formatMinute(new Date(2026, 0, 2, 3, 4).getTime())).toBe('2026-01-02 03:04');
  });
});
