export type RangeKey = '24h' | '72h' | '7d' | '30d' | 'all';
export type PageRangeKey = RangeKey | 'custom';

/** Inclusive generation-time window; an empty object means all time. */
export interface DateWindow {
  since?: number;
  until?: number;
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

/** Local `YYYY-MM-DD HH:mm` label for an applied window bound. */
export function formatMinute(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** Local calendar day parsed from a `YYYY-MM-DD` input, or null when impossible. */
function localDate(match: RegExpExecArray): { year: number; month: number; day: number } | null {
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const probe = new Date(year, month, day);
  return probe.getFullYear() === year && probe.getMonth() === month && probe.getDate() === day
    ? { year, month, day }
    : null;
}

/** Local clock parsed from an `HH:mm` (or `HH:mm:ss`) input; blank means the day edge. */
function localClock(
  value: string,
  edge: 'start' | 'end',
): { hours: number; minutes: number } | null {
  if (value === '') {
    return edge === 'start' ? { hours: 0, minutes: 0 } : { hours: 23, minutes: 59 };
  }
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(value);
  return match ? { hours: Number(match[1]), minutes: Number(match[2]) } : null;
}

/**
 * Local window for two date inputs and their optional time inputs. The start
 * edge lands on the selected minute (`HH:mm:00.000`) and the end edge includes
 * the whole selected minute (`HH:mm:59.999`); a blank time means local midnight
 * for the start and the last millisecond of the day for the end. Returns a
 * validation message when an input is missing, malformed, impossible, or
 * inverted.
 */
export function customWindow(
  start: string,
  end: string,
  startTime = '',
  endTime = '',
): DateWindow | string {
  const startMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(start);
  const endMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(end);
  if (!startMatch || !endMatch) return 'Choose both a start and end date.';
  const startDay = localDate(startMatch);
  const endDay = localDate(endMatch);
  if (startDay === null || endDay === null) return 'Choose a valid start and end date.';
  const startClock = localClock(startTime, 'start');
  const endClock = localClock(endTime, 'end');
  if (startClock === null || endClock === null) return 'Choose a valid start and end time.';
  const since = new Date(
    startDay.year,
    startDay.month,
    startDay.day,
    startClock.hours,
    startClock.minutes,
    0,
    0,
  ).getTime();
  const until = new Date(
    endDay.year,
    endDay.month,
    endDay.day,
    endClock.hours,
    endClock.minutes,
    59,
    999,
  ).getTime();
  if (until < since) return 'Choose a start date and time on or before the end date and time.';
  return { since, until };
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
