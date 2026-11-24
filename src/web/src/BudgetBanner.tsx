import { SpendOverrideControl } from './SpendOverrideControl';
import {
  budgetAlertText,
  type BudgetAlert,
  type BudgetsResponse,
  type SpendPause,
} from './types';
import { cn } from './ui';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function moneyLabel(value: number): string {
  return money.format(value);
}

/** Durable alerts plus non-dismissible hard-cap pause notices shared by every page. */
export function BudgetBanner({
  budgets,
  onAck,
  onSnooze,
  onRevoke,
}: {
  budgets: BudgetsResponse | null;
  onAck: (alert: BudgetAlert) => void;
  onSnooze: (pause: SpendPause, minutes: number) => void;
  onRevoke: (id: string) => void;
}) {
  const alerts = budgets?.alerts ?? [];
  const pauses = budgets?.pauses ?? [];
  if (alerts.length === 0 && pauses.length === 0) return null;
  const ordered = [...alerts].sort((left, right) => {
    if (left.threshold !== right.threshold) {
      return left.threshold === 'exceeded' ? -1 : 1;
    }
    return right.createdAt - left.createdAt;
  });

  return (
    <div
      aria-label="Budget alerts"
      className="space-y-2 border-b border-zinc-900 bg-zinc-950 px-3 py-2"
    >
      {pauses.map((pause) => {
        const label = pause.scope === 'overall' ? 'Overall spend' : pause.cellName ?? 'Cell spend';
        const controlLabel =
          pause.scope === 'overall' ? 'overall spend' : `${pause.cellName ?? 'cell'} spend`;
        const spend = `${pause.spendIsLowerBound ? 'at least ' : ''}${moneyLabel(pause.spendUsd)}`;
        const status = budgets?.statuses.find(
          (candidate) =>
            candidate.scope === pause.scope && candidate.cellId === pause.cellId,
        );
        const overridden = Boolean(status?.overrideId && status.overrideExpiresAt);
        return (
          <div
            key={`pause:${pause.scope}:${pause.cellId ?? ''}`}
            role="alert"
            className={cn(
              'rounded-lg border px-3 py-2 text-xs',
              overridden
                ? 'border-amber-900 bg-amber-950/40 text-amber-200'
                : 'border-red-900 bg-red-950/60 text-red-200',
            )}
          >
            <p className="break-words">
              {label} hard cap reached: {spend} of {moneyLabel(pause.budgetUsd)} for the current
              UTC month.{' '}
              {overridden
                ? 'New work is allowed while the override is active.'
                : 'New work is paused; raise or clear the budget, turn off the pause option, or snooze it to resume.'}
            </p>
            {pause.spendIsLowerBound ? (
              <p className="mt-0.5 text-[11px] opacity-80">
                {pause.unpricedTurns} unpriced turn{pause.unpricedTurns === 1 ? '' : 's'}; cap
                spend is a lower bound.
              </p>
            ) : null}
            <div className="mt-1.5">
              <SpendOverrideControl
                label={controlLabel}
                paused
                overrideId={status?.overrideId ?? null}
                overrideExpiresAt={status?.overrideExpiresAt ?? null}
                periodEnd={pause.periodEnd}
                onSnooze={(minutes) => onSnooze(pause, minutes)}
                onRevoke={onRevoke}
              />
            </div>
          </div>
        );
      })}
      {ordered.map((alert) => {
        const exceeded = alert.threshold === 'exceeded';
        return (
          <div
            key={alert.id}
            role={exceeded ? 'alert' : 'status'}
            className={cn(
              'flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-xs',
              exceeded
                ? 'border-red-900 bg-red-950/50 text-red-200'
                : 'border-amber-900 bg-amber-950/40 text-amber-200',
            )}
          >
            <div className="min-w-0">
              <p className="break-words">{budgetAlertText(alert)}</p>
              {alert.unknownCostTurns > 0 ? (
                <p className="mt-0.5 text-[11px] opacity-80">
                  {alert.unknownCostTurns} unpriced turn
                  {alert.unknownCostTurns === 1 ? '' : 's'}; this total is a lower bound.
                </p>
              ) : null}
            </div>
            <button
              type="button"
              aria-label={`Dismiss budget alert for ${alert.scope === 'overall' ? 'overall spend' : alert.cellName ?? 'cell'}`}
              onClick={() => onAck(alert)}
              className="shrink-0 rounded px-1 text-base leading-none opacity-70 hover:opacity-100"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
