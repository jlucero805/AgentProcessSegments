import type { SpendPause } from '../domain/budget.js';

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

function scopeLabel(pause: SpendPause): string {
  if (pause.scope === 'overall') return 'Overall monthly spend cap';
  return `${pause.cellName ?? 'Cell'} monthly spend cap`;
}

/** Human-readable reason used by the 409 response and scheduler notes. */
export function spendPauseMessage(pause: SpendPause): string {
  const spend = `${pause.spendIsLowerBound ? 'at least ' : ''}${money.format(pause.spendUsd)}`;
  return [
    `${scopeLabel(pause)} reached: ${spend} of ${money.format(pause.budgetUsd)}`,
    'for the current UTC month. New work is paused; raise the budget, clear it,',
    'or turn off the pause option to resume.',
  ].join(' ');
}

/** Expected policy refusal; HTTP maps it to 409 without error-logging it. */
export class SpendCapError extends Error {
  constructor(readonly pause: SpendPause) {
    super(spendPauseMessage(pause));
    this.name = 'SpendCapError';
  }
}

export type SpendCapOverrideErrorCode = 'cap_not_configured' | 'period_ending';

/** A refused override grant; HTTP maps it to 409 without error-logging it. */
export class SpendCapOverrideError extends Error {
  constructor(
    readonly code: SpendCapOverrideErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SpendCapOverrideError';
  }
}
