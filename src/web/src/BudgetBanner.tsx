import { budgetAlertText, type BudgetAlert, type BudgetsResponse } from './types';
import { cn } from './ui';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function moneyLabel(value: number): string {
  return money.format(value);
}

/** Durable alerts plus non-dismissible hard-cap pause notices shared by every page. */
export function BudgetBanner({
  budgets,
  onAck,
}: {
  budgets: BudgetsResponse | null;
  onAck: (alert: BudgetAlert) => void;
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
        const spend = `${pause.spendIsLowerBound ? 'at least ' : ''}${moneyLabel(pause.spendUsd)}`;
        return (
          <div
            key={`pause:${pause.scope}:${pause.cellId ?? ''}`}
            role="alert"
            className="rounded-lg border border-red-900 bg-red-950/60 px-3 py-2 text-xs text-red-200"
          >
            <p className="break-words">
              {pause.reason === 'unknown_cost' ? (
                <>
                  {label} cost is unknown: {pause.unpricedTurns} unpriced turn
                  {pause.unpricedTurns === 1 ? '' : 's'} in the current UTC month, so known
                  spend is {spend} of {moneyLabel(pause.budgetUsd)}. New work is paused; add a
                  matching price, clear the budget, or turn off strict pause to resume.
                </>
              ) : (
                <>
                  {label} hard cap reached: {spend} of {moneyLabel(pause.budgetUsd)} for the
                  current UTC month. New work is paused; raise or clear the budget, or turn off
                  the pause option, to resume.
                </>
              )}
            </p>
            {pause.reason === 'cap_reached' && pause.spendIsLowerBound ? (
              <p className="mt-0.5 text-[11px] opacity-80">
                {pause.unpricedTurns} unpriced turn{pause.unpricedTurns === 1 ? '' : 's'}; cap
                spend is a lower bound.
              </p>
            ) : null}
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
