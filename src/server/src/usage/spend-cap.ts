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
  if (pause.reason === 'unknown_cost') {
    const turns = `${pause.unpricedTurns} unpriced turn${pause.unpricedTurns === 1 ? '' : 's'}`;
    return [
      `${scopeLabel(pause)} cannot be verified: ${turns} in the current UTC month,`,
      `so known spend is ${spend} of ${money.format(pause.budgetUsd)}.`,
    ].join(' ');
  }
  return `${scopeLabel(pause)} reached: ${spend} of ${money.format(pause.budgetUsd)} for the current UTC month.`;
}

/** Human-readable reason used by the 409 response and scheduler notes. */
export function spendPauseMessage(pause: SpendPause): string {
  const remedy =
    pause.reason === 'unknown_cost'
      ? [
          'New work is paused; add a matching price for the model, clear the budget,',
          'or turn off pause-on-unknown-cost to resume.',
        ].join(' ')
      : [
          'New work is paused; raise the budget, clear it,',
          'or turn off the pause option to resume.',
        ].join(' ');
  return `${pauseSentence(pause)} ${remedy}`;
}

/** Human-readable reason written into a turn that a hard cap stopped. */
export function spendPauseInterruptMessage(pause: SpendPause): string {
  const remedy =
    pause.reason === 'unknown_cost'
      ? [
          'This turn was stopped; new work stays paused until you add a matching price',
          'for the model, clear the budget, or turn off pause-on-unknown-cost.',
        ].join(' ')
      : [
          'This turn was stopped; new work stays paused',
          'until you raise the budget, clear it, or turn off the pause option.',
        ].join(' ');
  return `${pauseSentence(pause)} ${remedy}`;
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
