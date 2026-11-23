import { useCallback, useEffect, useRef, useState } from 'react';
import { api, describeError } from './api';
import type { BudgetAlert, BudgetsResponse } from './types';

export const BUDGET_POLL_MS = 60_000;

export interface BudgetFeed {
  /** Last successful payload; kept while a refresh is failing. */
  budgets: BudgetsResponse | null;
  /** Why the most recent load or refresh failed, or null after a success. */
  error: string | null;
  /** True while a load is in flight. */
  loading: boolean;
  /** Fetch now. Concurrent calls share one request. */
  refresh: () => Promise<void>;
  /** Acknowledge an alert and remove it from this feed. */
  acknowledge: (alert: BudgetAlert) => Promise<void>;
}

/**
 * A malformed payload must not read as "no budgets configured". A missing
 * `statuses` array cannot be distinguished from an empty one, so treat it as a
 * failure; the optional lists normalize to empty.
 */
function normalize(response: BudgetsResponse): BudgetsResponse {
  if (!response || !Array.isArray(response.statuses)) {
    throw new Error('Budget status response was malformed.');
  }
  return {
    ...response,
    alerts: Array.isArray(response.alerts) ? response.alerts : [],
    pauses: Array.isArray(response.pauses) ? response.pauses : [],
  };
}

/**
 * The SPA's only budget poll. The banner and the Usage page both read this
 * snapshot, so an acknowledgement made in either place clears the other.
 */
export function useBudgets(
  onError: (message: string) => void,
  intervalMs = BUDGET_POLL_MS,
): BudgetFeed {
  const [budgets, setBudgets] = useState<BudgetsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const alive = useRef(true);
  const inFlight = useRef<Promise<void> | null>(null);
  // A poll that started before an ack can resolve after it with the old alert.
  const acknowledged = useRef(new Set<string>());

  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;

    const run = (async () => {
      if (alive.current) setLoading(true);
      try {
        const response = normalize(await api.getBudgets());
        if (!alive.current) return;
        setBudgets({
          ...response,
          alerts: response.alerts.filter((alert) => !acknowledged.current.has(alert.id)),
        });
        setError(null);
      } catch (caught) {
        if (alive.current) setError(describeError(caught));
      } finally {
        if (alive.current) setLoading(false);
      }
    })();

    inFlight.current = run;
    void run.finally(() => {
      if (inFlight.current === run) inFlight.current = null;
    });
    return run;
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = window.setInterval(() => void refresh(), intervalMs);
    return () => {
      alive.current = false;
      window.clearInterval(timer);
    };
  }, [intervalMs, refresh]);

  const acknowledge = useCallback(
    async (alert: BudgetAlert): Promise<void> => {
      try {
        await api.ackBudgetAlert(alert.id);
        acknowledged.current.add(alert.id);
        if (!alive.current) return;
        setBudgets((current) =>
          current
            ? { ...current, alerts: current.alerts.filter((item) => item.id !== alert.id) }
            : current,
        );
      } catch (caught) {
        onError(describeError(caught));
      }
    },
    [onError],
  );

  return { budgets, error, loading, refresh, acknowledge };
}
