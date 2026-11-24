import { useState } from 'react';
import { Button, Select } from './ui';

const PRESET_MINUTES = [15, 60, 240, 1440];
const MAX_MINUTES = 44_640;

const until = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/** Shared expiry label so status copy and the control never drift. */
export function overrideExpiryLabel(value: number): string {
  return until.format(value);
}

function optionLabel(minutes: number): string {
  if (minutes === 15) return '15 minutes';
  if (minutes === 60) return '1 hour';
  if (minutes === 240) return '4 hours';
  if (minutes === 1440) return '24 hours';
  return 'Rest of month';
}

/**
 * Snooze or end a hard-cap override for one scope. Rendered only while the cap
 * is reached; an active override shows its expiry and an end action instead.
 */
export function SpendOverrideControl({
  label,
  paused,
  overrideId,
  overrideExpiresAt,
  periodEnd,
  onSnooze,
  onRevoke,
}: {
  label: string;
  paused: boolean;
  overrideId?: string | null;
  overrideExpiresAt?: number | null;
  periodEnd?: number;
  onSnooze: (minutes: number) => Promise<void> | void;
  onRevoke: (id: string) => Promise<void> | void;
}) {
  const [minutes, setMinutes] = useState(60);
  const [working, setWorking] = useState(false);

  if (!paused) return null;

  const restMinutes = Math.max(
    1,
    Math.min(
      MAX_MINUTES,
      periodEnd === undefined
        ? MAX_MINUTES
        : Math.ceil((periodEnd - Date.now()) / 60_000),
    ),
  );
  const options = [
    ...PRESET_MINUTES.map((value) => ({ value, label: optionLabel(value) })),
    ...(restMinutes > PRESET_MINUTES[PRESET_MINUTES.length - 1]
      ? [{ value: restMinutes, label: optionLabel(restMinutes) }]
      : []),
  ];

  const run = async (action: () => Promise<void> | void): Promise<void> => {
    setWorking(true);
    try {
      await action();
    } catch {
      // The caller reports the failure through the app error toast.
    } finally {
      setWorking(false);
    }
  };

  if (overrideId && overrideExpiresAt) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="text-amber-300">
          Override active until {overrideExpiryLabel(overrideExpiresAt)}
        </span>
        <Button
          size="sm"
          variant="outline"
          aria-label={`End override for ${label}`}
          disabled={working}
          onClick={() => void run(() => onRevoke(overrideId))}
        >
          End override
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px]">
      <Select
        aria-label={`Snooze duration for ${label}`}
        className="w-auto"
        value={minutes}
        disabled={working}
        onChange={(event) => setMinutes(Number(event.target.value))}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
      <Button
        size="sm"
        aria-label={`Snooze ${label}`}
        disabled={working}
        onClick={() => void run(() => onSnooze(minutes))}
      >
        Snooze
      </Button>
    </div>
  );
}
