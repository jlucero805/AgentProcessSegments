export type RangeKey = '24h' | '72h' | '7d' | '30d' | 'all';
export type PageRangeKey = RangeKey | 'custom';
export type ScorecardsView = 'grouped' | 'flat';

/** Inclusive generation-time window; an empty object means all time. */
export interface DateWindow {
  since?: number;
  until?: number;
}

/** Scorecards page state encoded in the URL. */
export interface ScorecardRouteState {
  range: PageRangeKey;
  view: ScorecardsView;
  customStart: string;
  customEnd: string;
  customStartTime: string;
  customEndTime: string;
  appliedCustom: DateWindow;
  /** The URL carried an invalid or stale value and should be rewritten once. */
  normalize: boolean;
}

/** Scorecards-owned query values; null means remove the parameter. */
export interface ScorecardRouteParams {
  period: string | null;
  from: string | null;
  to: string | null;
  view: string | null;
}

export const RANGES: Array<{ key: RangeKey; label: string; spellout: string; ms: number | null }> = [
  { key: '24h', label: '24h', spellout: 'the last 24 hours', ms: 24 * 60 * 60_000 },
  { key: '72h', label: '72h', spellout: 'the last 72 hours', ms: 72 * 60 * 60_000 },
  { key: '7d', label: '7d', spellout: 'the last 7 days', ms: 7 * 24 * 60 * 60_000 },
  { key: '30d', label: '30d', spellout: 'the last 30 days', ms: 30 * 24 * 60 * 60_000 },
  { key: 'all', label: 'All', spellout: 'all time', ms: null },
];

export const DEFAULT_RANGE: RangeKey = '72h';
/** Fallback span when Custom is opened from All, which has no lower bound. */
export const CUSTOM_FALLBACK_MS = 72 * 60 * 60_000;
/** Default Custom start time; the start instant is exact at this minute. */
export const CUSTOM_DEFAULT_START_TIME = '00:00';
/** Default Custom end time; the end instant includes this whole minute. */
export const CUSTOM_DEFAULT_END_TIME = '23:59';

export function rangeOption(range: RangeKey) {
  return RANGES.find((option) => option.key === range) ?? RANGES[1]!;
}

/** Inclusive window for a preset, evaluated at `now`; an empty window means all time. */
export function presetWindow(range: RangeKey, now = Date.now()): DateWindow {
  const option = rangeOption(range);
  return option.ms === null ? {} : { since: now - option.ms };
}

/** Inclusive lower bound for the selected period; undefined means all time. */
export function sinceFor(range: RangeKey): number | undefined {
  return presetWindow(range).since;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Local `YYYY-MM-DD` value for an `<input type="date">`. */
export function dateInputValue(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local `YYYY-MM-DDTHH:mm` value used by the URL and Custom inputs. */
export function dateTimeInputValue(timestamp: number): string {
  const date = new Date(timestamp);
  return `${dateInputValue(timestamp)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface ClockTime {
  hours: number;
  minutes: number;
}

function parseClockTime(value: string, fallback: string): ClockTime | null {
  const candidate = value.trim() === '' ? fallback : value;
  const match = /^(\d{2}):(\d{2})$/.exec(candidate);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours <= 23 && minutes <= 59 ? { hours, minutes } : null;
}

/**
 * Local window for two date inputs and optional minute-level times. The start
 * is exact at the selected minute; the end includes the whole selected minute.
 * Blank times fall back to the whole-day defaults. Returns a validation message
 * when a value is missing, malformed, not a real local time, or inverted.
 */
export function customWindow(
  start: string,
  end: string,
  startTime = CUSTOM_DEFAULT_START_TIME,
  endTime = CUSTOM_DEFAULT_END_TIME,
): DateWindow | string {
  const startMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(start);
  const endMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(end);
  if (!startMatch || !endMatch) return 'Choose both a start and end date.';
  const startClock = parseClockTime(startTime, CUSTOM_DEFAULT_START_TIME);
  const endClock = parseClockTime(endTime, CUSTOM_DEFAULT_END_TIME);
  if (!startClock || !endClock) return 'Choose a valid start and end time.';
  const bounded = (match: RegExpExecArray, clock: ClockTime): number | null => {
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const date = new Date(year, month, day, clock.hours, clock.minutes, 0, 0);
    return date.getFullYear() === year &&
      date.getMonth() === month &&
      date.getDate() === day &&
      date.getHours() === clock.hours &&
      date.getMinutes() === clock.minutes
      ? date.getTime()
      : null;
  };
  const since = bounded(startMatch, startClock);
  const endMinute = bounded(endMatch, endClock);
  if (since === null || endMinute === null) return 'Choose a valid start and end date.';
  const until = endMinute + 59_999;
  if (until < since) return 'Choose a start on or before the end.';
  return { since, until };
}

const SCORECARD_EDGE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

function splitScorecardEdge(value: string | null): { date: string; time: string } | null {
  if (value === null) return null;
  const match = SCORECARD_EDGE.exec(value);
  if (!match) return null;
  return {
    date: `${match[1]}-${match[2]}-${match[3]}`,
    time: `${match[4]}:${match[5]}`,
  };
}

/**
 * Read the Scorecards period and layout from a query string. Missing values use
 * the defaults; a malformed or partial Custom range falls back to 72h and asks
 * the caller to normalize the URL. Custom bounds are restored as-is and are not
 * re-validated against the current time.
 */
export function readScorecardRoute(
  search: string,
  now = Date.now(),
): ScorecardRouteState {
  const params = new URLSearchParams(search);
  const defaults: ScorecardRouteState = {
    range: DEFAULT_RANGE,
    view: 'grouped',
    customStart: dateInputValue(now - CUSTOM_FALLBACK_MS),
    customEnd: dateInputValue(now),
    customStartTime: CUSTOM_DEFAULT_START_TIME,
    customEndTime: CUSTOM_DEFAULT_END_TIME,
    appliedCustom: {},
    normalize: false,
  };
  const rawView = params.get('view');
  const view: ScorecardsView = rawView === 'flat' ? 'flat' : 'grouped';
  const badView = rawView !== null && rawView !== 'grouped' && rawView !== 'flat';
  const rawPeriod = params.get('period');
  if (rawPeriod === null) {
    return {
      ...defaults,
      view,
      normalize: badView || params.has('from') || params.has('to'),
    };
  }
  if (rawPeriod === 'custom') {
    const start = splitScorecardEdge(params.get('from'));
    const end = splitScorecardEdge(params.get('to'));
    if (!start || !end) return { ...defaults, view, normalize: true };
    const window = customWindow(start.date, end.date, start.time, end.time);
    if (typeof window === 'string') return { ...defaults, view, normalize: true };
    return {
      ...defaults,
      range: 'custom',
      view,
      customStart: start.date,
      customEnd: end.date,
      customStartTime: start.time,
      customEndTime: end.time,
      appliedCustom: window,
      normalize: badView,
    };
  }
  const option = RANGES.find((item) => item.key === rawPeriod);
  if (!option) return { ...defaults, view, normalize: true };
  return {
    ...defaults,
    range: option.key,
    view,
    normalize: badView || params.has('from') || params.has('to'),
  };
}

/** Canonical query values for a Scorecards page state. */
export function scorecardRouteParams(
  range: PageRangeKey,
  view: ScorecardsView,
  appliedCustom: DateWindow,
): ScorecardRouteParams {
  const since = appliedCustom.since;
  const until = appliedCustom.until;
  const custom = range === 'custom' && since !== undefined && until !== undefined;
  let period: string | null;
  if (range === 'custom') period = custom ? 'custom' : null;
  else if (range === DEFAULT_RANGE) period = null;
  else period = range;
  const encodeEdges = range === 'custom' && since !== undefined && until !== undefined;
  return {
    period,
    from: encodeEdges ? dateTimeInputValue(since) : null,
    to: encodeEdges ? dateTimeInputValue(until) : null,
    view: view === 'grouped' ? null : view,
  };
}

function segmentClass(active: boolean): string {
  return active
    ? 'rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-100'
    : 'rounded-md px-2 py-1 text-xs text-zinc-500 hover:text-zinc-200';
}

/** Generation-time period control shared by the Scorecards page and master drawer. */
export function ScorecardPeriod({
  value,
  onChange,
  onSelectCustom,
  customSelected = false,
}: {
  value: RangeKey | null;
  onChange: (range: RangeKey) => void;
  /** Renders a trailing Custom segment when provided. */
  onSelectCustom?: () => void;
  customSelected?: boolean;
}) {
  return (
    <div
      className="flex rounded-lg border border-zinc-800 p-0.5"
      role="group"
      aria-label="Scorecard period"
    >
      {RANGES.map((item) => {
        const active = !customSelected && value === item.key;
        return (
          <button
            key={item.key}
            type="button"
            aria-pressed={active}
            onClick={() => {
              if (item.key === value) return;
              onChange(item.key);
            }}
            className={segmentClass(active)}
          >
            {item.label}
          </button>
        );
      })}
      {onSelectCustom ? (
        <button
          type="button"
          aria-pressed={customSelected}
          onClick={onSelectCustom}
          className={segmentClass(customSelected)}
        >
          Custom
        </button>
      ) : null}
    </div>
  );
}
