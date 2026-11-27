export type RangeKey = '24h' | '72h' | '7d' | '30d' | 'all';

export const RANGES: Array<{ key: RangeKey; label: string; spellout: string; ms: number | null }> = [
  { key: '24h', label: '24h', spellout: 'the last 24 hours', ms: 24 * 60 * 60_000 },
  { key: '72h', label: '72h', spellout: 'the last 72 hours', ms: 72 * 60 * 60_000 },
  { key: '7d', label: '7d', spellout: 'the last 7 days', ms: 7 * 24 * 60 * 60_000 },
  { key: '30d', label: '30d', spellout: 'the last 30 days', ms: 30 * 24 * 60 * 60_000 },
  { key: 'all', label: 'All', spellout: 'all time', ms: null },
];

export const DEFAULT_RANGE: RangeKey = '72h';

export function rangeOption(range: RangeKey) {
  return RANGES.find((option) => option.key === range) ?? RANGES[1]!;
}

/** Inclusive lower bound for the selected period; undefined means all time. */
export function sinceFor(range: RangeKey): number | undefined {
  const option = rangeOption(range);
  return option.ms === null ? undefined : Date.now() - option.ms;
}

/** Generation-time period control shared by the Scorecards page and master drawer. */
export function ScorecardPeriod({
  value,
  onChange,
}: {
  value: RangeKey;
  onChange: (range: RangeKey) => void;
}) {
  return (
    <div
      className="flex rounded-lg border border-zinc-800 p-0.5"
      role="group"
      aria-label="Scorecard period"
    >
      {RANGES.map((item) => (
        <button
          key={item.key}
          type="button"
          aria-pressed={value === item.key}
          onClick={() => {
            if (item.key === value) return;
            onChange(item.key);
          }}
          className={
            value === item.key
              ? 'rounded-md bg-zinc-800 px-2 py-1 text-xs text-zinc-100'
              : 'rounded-md px-2 py-1 text-xs text-zinc-500 hover:text-zinc-200'
          }
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
