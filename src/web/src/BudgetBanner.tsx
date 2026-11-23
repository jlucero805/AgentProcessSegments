import { useEffect, useState } from 'react';
import { api, describeError } from './api';
import { budgetAlertText, type BudgetAlert } from './types';
import { cn } from './ui';

const POLL_MS = 60_000;

/** Durable, dismissible budget alerts shared by every page. */
export function BudgetBanner({ onError }: { onError?: (message: string) => void }) {
  const [alerts, setAlerts] = useState<BudgetAlert[]>([]);

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const response = await api.getBudgets();
        if (mounted) setAlerts(Array.isArray(response.alerts) ? response.alerts : []);
      } catch {
        // The banner is ambient; a transient poll failure must not replace the page.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, []);

  const dismiss = async (alert: BudgetAlert) => {
    try {
      await api.ackBudgetAlert(alert.id);
      setAlerts((current) => current.filter((item) => item.id !== alert.id));
    } catch (error) {
      onError?.(describeError(error));
    }
  };

  if (alerts.length === 0) return null;
  const ordered = [...alerts].sort((left, right) => {
    if (left.threshold !== right.threshold) return left.threshold === 'exceeded' ? -1 : 1;
    return right.createdAt - left.createdAt;
  });

  return (
    <div
      aria-label="Budget alerts"
      className="space-y-2 border-b border-zinc-900 bg-zinc-950 px-3 py-2"
    >
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
              onClick={() => void dismiss(alert)}
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
