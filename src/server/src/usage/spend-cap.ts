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

function pauseSentence(pause: SpendPause): string {
  const spend = `${pause.spendIsLowerBound ? 'at least ' : ''}${money.format(pause.spendUsd)}`;
  return `${scopeLabel(pause)} reached: ${spend} of ${money.format(pause.budgetUsd)} for the current UTC month.`;
}

/** Human-readable reason used by the 409 response and scheduler notes. */
export function spendPauseMessage(pause: SpendPause): string {
  return [
    pauseSentence(pause),
    'New work is paused; raise the budget, clear it,',
    'or turn off the pause option to resume.',
  ].join(' ');
}

/** Human-readable reason written into a turn that a hard cap stopped. */
export function spendPauseInterruptMessage(pause: SpendPause): string {
  return [
    pauseSentence(pause),
    'This turn was stopped; new work stays paused',
    'until you raise the budget, clear it, or turn off the pause option.',
  ].join(' ');
}

/** Expected policy refusal; HTTP maps it to 409 without error-logging it. */
export class SpendCapError extends Error {
  constructor(readonly pause: SpendPause) {
    super(spendPauseMessage(pause));
    this.name = 'SpendCapError';
  }
}
