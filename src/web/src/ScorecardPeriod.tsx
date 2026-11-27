import { useState } from 'react';
import { Button, Field, Input } from './ui';

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

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Local `YYYY-MM-DD` value for an `<input type="date">`. */
export function dateInputValue(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
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

/** Draft inputs for the Custom period, prefilled from the current preset. */
export interface CustomRangeSeed {
  /** Local `YYYY-MM-DD` for `<input type="date">`. */
  start: string;
  end: string;
  /** Local `HH:mm` for `<input type="time">`. */
  startTime: string;
  endTime: string;
}

/**
 * Custom inputs prefilled from `range` at `now`. The start is the local midnight
 * of the preset's rolling start (or the 72-hour fallback from All); the end is
 * today. The caller parses the seed with `customWindow`.
 */
export function customRangeSeed(range: RangeKey, now = Date.now()): CustomRangeSeed {
  const start =
    range === 'all'
      ? now - CUSTOM_FALLBACK_MS
      : presetWindow(range, now).since ?? now - CUSTOM_FALLBACK_MS;
  return {
    start: dateInputValue(start),
    end: dateInputValue(now),
    startTime: CUSTOM_DEFAULT_START_TIME,
    endTime: CUSTOM_DEFAULT_END_TIME,
  };
}

/** Applied Custom window in the operator's local time, to minute precision. */
export function appliedRangeLabel(window: DateWindow): string {
  if (window.since === undefined || window.until === undefined) return '';
  const format = (value: number) =>
    new Date(value).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  return `Applied: ${format(window.since)} – ${format(window.until)} (local; the end minute is included)`;
}

/**
 * The Custom start/end date and time inputs, Apply, and the inline applied or
 * validation message. The caller owns the applied window and refetches it. The
 * draft is seeded once per mount, so remount the component (by switching the
 * period away and back) to reset it.
 */
export function ScorecardCustomRange({
  seed,
  applied,
  onApply,
}: {
  seed: CustomRangeSeed;
  applied: DateWindow;
  onApply: (window: DateWindow) => void;
}) {
  const [start, setStart] = useState(seed.start);
  const [end, setEnd] = useState(seed.end);
  const [startTime, setStartTime] = useState(seed.startTime);
  const [endTime, setEndTime] = useState(seed.endTime);
  const draftWindow = customWindow(start, end, startTime, endTime);
  const draftError = typeof draftWindow === 'string' ? draftWindow : null;

  return (
    <div className="flex flex-wrap items-end gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
      <Field label="Start date">
        <Input
          type="date"
          aria-label="Start date"
          className="w-40"
          value={start}
          onChange={(event) => setStart(event.target.value)}
        />
      </Field>
      <Field label="Start time">
        <Input
          type="time"
          step={60}
          aria-label="Start time"
          className="w-28"
          value={startTime}
          onChange={(event) => setStartTime(event.target.value)}
        />
      </Field>
      <Field label="End date">
        <Input
          type="date"
          aria-label="End date"
          className="w-40"
          value={end}
          onChange={(event) => setEnd(event.target.value)}
        />
      </Field>
      <Field label="End time">
        <Input
          type="time"
          step={60}
          aria-label="End time"
          className="w-28"
          value={endTime}
          onChange={(event) => setEndTime(event.target.value)}
        />
      </Field>
      <Button
        variant="secondary"
        size="sm"
        disabled={draftError !== null}
        onClick={() => {
          if (typeof draftWindow !== 'string') onApply(draftWindow);
        }}
      >
        Apply
      </Button>
      <p className={draftError ? 'text-[11px] text-amber-300' : 'text-[11px] text-zinc-600'}>
        {draftError ?? appliedRangeLabel(applied)}
      </p>
    </div>
  );
}

/** Applied scorecard period as captured by the URL route. */
export interface ScorecardPeriodSelection {
  range: PageRangeKey;
  /** Present only when `range` is `custom`. */
  custom?: CustomRangeSeed;
}

export type ScorecardsView = 'grouped' | 'flat';
export const DEFAULT_SCORECARDS_VIEW: ScorecardsView = 'grouped';

/** Read the Scorecards layout from route params; unknown values use Grouped. */
export function parseScorecardView(params: URLSearchParams): ScorecardsView {
  return params.get('view') === 'flat' ? 'flat' : DEFAULT_SCORECARDS_VIEW;
}

/** Write the Scorecards layout; the Grouped default is omitted. */
export function writeScorecardView(
  params: URLSearchParams,
  view: ScorecardsView,
): void {
  params.delete('view');
  if (view === 'flat') params.set('view', 'flat');
}

/** Local `HH:mm` value for an `<input type="time">`. */
function timeInputValue(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Convert an applied Custom window back to its four local input values. */
export function customRangeSeedFromWindow(window: DateWindow): CustomRangeSeed | null {
  if (window.since === undefined || window.until === undefined) return null;
  return {
    start: dateInputValue(window.since),
    end: dateInputValue(window.until),
    startTime: timeInputValue(window.since),
    endTime: timeInputValue(window.until),
  };
}

function normalizeCustomSeed(seed: CustomRangeSeed): CustomRangeSeed {
  return {
    ...seed,
    startTime: seed.startTime.trim() || CUSTOM_DEFAULT_START_TIME,
    endTime: seed.endTime.trim() || CUSTOM_DEFAULT_END_TIME,
  };
}

/**
 * Read the Scorecards period from route params. Unknown or incomplete values
 * fall back to the default preset so a tampered URL cannot query a partial
 * custom window.
 */
export function parseScorecardPeriod(params: URLSearchParams): ScorecardPeriodSelection {
  const raw = params.get('period');
  if (raw === null) return { range: DEFAULT_RANGE };
  if (raw === 'custom') {
    const custom = normalizeCustomSeed({
      start: params.get('startDate') ?? '',
      end: params.get('endDate') ?? '',
      startTime: params.get('startTime') ?? '',
      endTime: params.get('endTime') ?? '',
    });
    const window = customWindow(custom.start, custom.end, custom.startTime, custom.endTime);
    return typeof window === 'string' ? { range: DEFAULT_RANGE } : { range: 'custom', custom };
  }
  const preset = RANGES.find((option) => option.key === raw);
  return preset ? { range: preset.key } : { range: DEFAULT_RANGE };
}

/**
 * Write the applied scorecard period to route params. The default 72h preset
 * is omitted; a Custom selection is only written when it is a valid window.
 */
export function writeScorecardPeriod(
  params: URLSearchParams,
  selection: ScorecardPeriodSelection,
): void {
  params.delete('period');
  params.delete('startDate');
  params.delete('startTime');
  params.delete('endDate');
  params.delete('endTime');
  if (selection.range === DEFAULT_RANGE) return;
  if (selection.range !== 'custom') {
    params.set('period', selection.range);
    return;
  }
  if (!selection.custom) return;
  const custom = normalizeCustomSeed(selection.custom);
  const window = customWindow(custom.start, custom.end, custom.startTime, custom.endTime);
  if (typeof window === 'string') return;
  params.set('period', 'custom');
  params.set('startDate', custom.start);
  params.set('startTime', custom.startTime);
  params.set('endDate', custom.end);
  params.set('endTime', custom.endTime);
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
