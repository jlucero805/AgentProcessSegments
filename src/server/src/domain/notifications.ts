/**
 * Operational notification contract shared by the server and the SPA. Keep this
 * module free of Node-only imports so `src/web/src/types.ts` can re-export the
 * pure helpers for Vite.
 */
import type { HarnessId } from './harness.js';
import type { State } from './request.js';

export const EVENT_NOTIFICATION_KINDS = [
  'turn.failed',
  'master.error',
  'summary.failed',
  'spend.override',
] as const;
export type NotificationEventKind = (typeof EVENT_NOTIFICATION_KINDS)[number];

export type TurnFailureSource =
  | 'engine.result'
  | 'engine.exit'
  | 'engine.timeout'
  | 'engine.turn';

/** One failed request-scoped turn. Contains classifications, never raw errors. */
export interface TurnFailureNotification {
  turnId: string;
  requestId: string;
  requestTitle: string;
  state: State;
  cellId: string | null;
  harness: HarnessId;
  model: string | null;
  source: TurnFailureSource;
  /** A short safe label such as `process exited with code 1`. */
  reason: string;
  occurredAt: number;
}

/** One failed master turn or scheduler cycle. Contains ids, never raw errors. */
export interface MasterErrorNotification {
  source: 'master.turn' | 'master.cycle';
  cellId: string;
  requestId: string | null;
  segment: string | null;
  occurredAt: number;
}

export type SummaryFailureSource =
  | 'summary.result'
  | 'summary.exit'
  | 'summary.timeout'
  | 'summary.turn'
  | 'summary.empty'
  | 'summary.store';

/** One failed scorecard generation. Contains classifications, never raw errors. */
export interface SummaryFailureNotification {
  cellId: string;
  source: SummaryFailureSource;
  reason: string;
  occurredAt: number;
}

/** A hard spend cap override transitioned while the scope was still blocked. */
export type SpendOverrideChange = 'granted' | 'extended' | 'expired';
/** Mirrors `BudgetScope`; kept local so this module stays acyclic. */
export type SpendOverrideScope = 'overall' | 'cell';
/** Mirrors `SpendPauseReason`; the cap is still blocking work. */
export type SpendOverrideReason = 'cap_reached' | 'unknown_cost';

/** One override grant, extension, or expiry. Contains ids and amounts only. */
export interface SpendCapOverrideNotification {
  overrideId: string;
  change: SpendOverrideChange;
  scope: SpendOverrideScope;
  cellId: string | null;
  reason: SpendOverrideReason;
  periodStart: number;
  expiresAt: number;
  note: string | null;
  budgetUsd: number;
  spendUsd: number;
  spendIsLowerBound: boolean;
  capSpendUsd: number;
  capSpendIsLowerBound: boolean;
  occurredAt: number;
}

/**
 * The safe, read-only projection of one event delivery row. It contains only
 * classifications and ids already sent outbound; never the raw payload.
 */
export interface EventDeliverySnapshot {
  kind: NotificationEventKind;
  /** Envelope title without the `[APS] ` email prefix. */
  title: string;
  /** Safe outbound human text, or '' when the payload is unreadable. */
  text: string;
  /** Engine/master/summary failure source, or null for an unreadable payload. */
  source: string | null;
  reason: string | null;
  cellId: string | null;
  cellName: string | null;
  requestId: string | null;
  turnId: string | null;
  segment: string | null;
  occurredAt: number | null;
  /** Spend-override transition, or null for the failure event kinds. */
  change: SpendOverrideChange | null;
}

export interface TurnFailedEnvelope {
  version: 1;
  event: 'turn.failed';
  severity: 'error';
  title: string;
  occurredAt: number;
  text: string;
  turn: TurnFailureNotification;
}

export interface MasterErrorEnvelope {
  version: 1;
  event: 'master.error';
  severity: 'error';
  title: string;
  occurredAt: number;
  text: string;
  master: MasterErrorNotification;
}

export interface SummaryFailedEnvelope {
  version: 1;
  event: 'summary.failed';
  severity: 'error';
  title: string;
  occurredAt: number;
  text: string;
  summary: SummaryFailureNotification;
}

export interface SpendOverrideEnvelope {
  version: 1;
  event: 'spend.override';
  severity: 'warning';
  title: string;
  occurredAt: number;
  text: string;
  override: SpendCapOverrideNotification;
}

export type NotificationEventEnvelope =
  | TurnFailedEnvelope
  | MasterErrorEnvelope
  | SummaryFailedEnvelope
  | SpendOverrideEnvelope;

const MAX_TITLE_LENGTH = 200;

/** Collapse whitespace so a title can never carry newlines into a subject. */
export function clipNotificationText(value: string, max = MAX_TITLE_LENGTH): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(0, max - 1))}…`;
}

function turnLabel(turn: TurnFailureNotification, cellName: string | null): string {
  const where = [turn.state, cellName ?? (turn.cellId === null ? null : 'Deleted cell')]
    .filter((part): part is string => part !== null && part !== '')
    .join(', ');
  return `"${clipNotificationText(turn.requestTitle)}"${where === '' ? '' : ` in ${where}`}`;
}

function masterLabel(event: MasterErrorNotification, cellName: string | null): string {
  const cell = cellName ?? 'Deleted cell';
  if (event.source === 'master.cycle') return `cell "${cell}"`;
  const segment = event.segment === null ? '' : ` in ${event.segment}`;
  const request = event.requestId === null ? '' : ` on request ${event.requestId}`;
  return `cell "${cell}"${request}${segment}`;
}

export function turnFailedText(
  turn: TurnFailureNotification,
  cellName: string | null,
): string {
  return `Turn failed for ${turnLabel(turn, cellName)}: ${turn.reason}.`;
}

export function masterErrorText(
  event: MasterErrorNotification,
  cellName: string | null,
): string {
  const what = event.source === 'master.cycle' ? 'Master cycle' : 'Master turn';
  return `${what} failed for ${masterLabel(event, cellName)}.`;
}

export function turnFailedEnvelope(
  turn: TurnFailureNotification,
  cellName: string | null,
): TurnFailedEnvelope {
  return {
    version: 1,
    event: 'turn.failed',
    severity: 'error',
    title: `Turn failed: ${clipNotificationText(turn.requestTitle)}`,
    occurredAt: turn.occurredAt,
    text: turnFailedText(turn, cellName),
    turn,
  };
}

export function masterErrorEnvelope(
  event: MasterErrorNotification,
  cellName: string | null,
): MasterErrorEnvelope {
  const cell = cellName ?? 'Deleted cell';
  return {
    version: 1,
    event: 'master.error',
    severity: 'error',
    title: `Master error: ${cell}`,
    occurredAt: event.occurredAt,
    text: masterErrorText(event, cellName),
    master: event,
  };
}

export function summaryFailedText(
  summary: SummaryFailureNotification,
  cellName: string | null,
): string {
  const cell = cellName ?? 'Deleted cell';
  return `Scorecard generation failed for cell "${cell}": ${summary.reason}.`;
}

export function summaryFailedEnvelope(
  summary: SummaryFailureNotification,
  cellName: string | null,
): SummaryFailedEnvelope {
  const cell = cellName ?? 'Deleted cell';
  return {
    version: 1,
    event: 'summary.failed',
    severity: 'error',
    title: `Scorecard failed: ${cell}`,
    occurredAt: summary.occurredAt,
    text: summaryFailedText(summary, cellName),
    summary,
  };
}

const overrideMoney = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

function overrideScopeLabel(
  event: SpendCapOverrideNotification,
  cellName: string | null,
): string {
  return event.scope === 'overall' ? 'overall spend' : `cell "${cellName ?? 'Deleted cell'}"`;
}

function overrideTitleScope(
  event: SpendCapOverrideNotification,
  cellName: string | null,
): string {
  return event.scope === 'overall' ? 'Overall' : cellName ?? 'Deleted cell';
}

function overrideReasonLabel(reason: SpendOverrideReason): string {
  return reason === 'cap_reached' ? 'cap reached' : 'unknown turn cost';
}

export function spendOverrideText(
  event: SpendCapOverrideNotification,
  cellName: string | null,
): string {
  const scope = overrideScopeLabel(event, cellName);
  const spend = event.spendIsLowerBound
    ? `at least ${overrideMoney.format(event.spendUsd)}`
    : overrideMoney.format(event.spendUsd);
  const budget = overrideMoney.format(event.budgetUsd);
  const reason = overrideReasonLabel(event.reason);
  const note = event.note === null ? '' : ` Note: ${clipNotificationText(event.note, 280)}.`;
  if (event.change === 'expired') {
    return `Spend cap override for ${scope} expired at ${new Date(event.expiresAt).toISOString()}. The hard cap is blocking new work again (${reason}): ${spend} of a ${budget} monthly budget.${note}`;
  }
  const action = event.change === 'extended' ? 'extended' : 'granted';
  return `Spend cap override ${action} for ${scope} until ${new Date(event.expiresAt).toISOString()}. The hard cap is still blocking new work (${reason}): ${spend} of a ${budget} monthly budget.${note}`;
}

export function spendOverrideEnvelope(
  event: SpendCapOverrideNotification,
  cellName: string | null,
): SpendOverrideEnvelope {
  return {
    version: 1,
    event: 'spend.override',
    severity: 'warning',
    title: `Spend cap override ${event.change}: ${overrideTitleScope(event, cellName)}`,
    occurredAt: event.occurredAt,
    text: spendOverrideText(event, cellName),
    override: event,
  };
}

export function notificationEventSubject(
  event: NotificationEventEnvelope,
  cellName: string | null,
): string {
  let title: string;
  switch (event.event) {
    case 'turn.failed':
      title = turnFailedEnvelope(event.turn, cellName).title;
      break;
    case 'master.error':
      title = masterErrorEnvelope(event.master, cellName).title;
      break;
    case 'summary.failed':
      title = summaryFailedEnvelope(event.summary, cellName).title;
      break;
    case 'spend.override':
      title = spendOverrideEnvelope(event.override, cellName).title;
      break;
  }
  return `[APS] ${title}`;
}

export function notificationEventEmailText(
  event: NotificationEventEnvelope,
  cellName: string | null,
): string {
  let text: string;
  switch (event.event) {
    case 'turn.failed':
      text = turnFailedText(event.turn, cellName);
      break;
    case 'master.error':
      text = masterErrorText(event.master, cellName);
      break;
    case 'summary.failed':
      text = summaryFailedText(event.summary, cellName);
      break;
    case 'spend.override':
      text = spendOverrideText(event.override, cellName);
      break;
  }
  const lines = [
    text,
    '',
    `Event: ${event.event}`,
    `Occurred: ${new Date(event.occurredAt).toISOString()}`,
  ];
  if (event.event === 'turn.failed') {
    lines.push(
      `Request: ${event.turn.requestId}`,
      `Turn: ${event.turn.turnId}`,
      `Cell: ${event.turn.cellId ?? 'unassigned'}`,
      `Harness: ${event.turn.harness}`,
      `Source: ${event.turn.source}`,
      `Reason: ${event.turn.reason}`,
    );
  } else if (event.event === 'master.error') {
    lines.push(
      `Cell: ${event.master.cellId}`,
      `Source: ${event.master.source}`,
      `Request: ${event.master.requestId ?? 'none'}`,
      `Segment: ${event.master.segment ?? 'none'}`,
    );
  } else if (event.event === 'summary.failed') {
    lines.push(
      `Cell: ${event.summary.cellId}`,
      `Source: ${event.summary.source}`,
      `Reason: ${event.summary.reason}`,
    );
  } else {
    lines.push(
      `Change: ${event.override.change}`,
      `Scope: ${event.override.scope}`,
      `Cell: ${event.override.cellId ?? 'overall'}`,
      `Override: ${event.override.overrideId}`,
      `Reason: ${event.override.reason}`,
      `Expires: ${new Date(event.override.expiresAt).toISOString()}`,
      `Budget: ${overrideMoney.format(event.override.budgetUsd)}`,
      `Spend: ${event.override.spendIsLowerBound ? 'at least ' : ''}${overrideMoney.format(event.override.spendUsd)}`,
    );
    if (event.override.note !== null) {
      lines.push(`Note: ${clipNotificationText(event.override.note, 280)}`);
    }
  }
  return lines.join('\n');
}

const MINUTE_MS = 60_000;

function safeKeyPart(value: string): string {
  const cleaned = value.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.slice(0, 60);
}

/** Fixed coalescing-window start for an occurrence, anchored at the Unix epoch. */
export function eventNotificationWindowStart(
  occurredAt: number,
  coalesceMinutes: number,
): number {
  const windowMs = coalesceMinutes * MINUTE_MS;
  return Math.floor(occurredAt / windowMs) * windowMs;
}

/**
 * Stable per-channel idempotency key. Failure events coalesce in a window;
 * override transitions dedupe on the override, change, and stored expiry.
 */
export function eventDedupeKey(
  event:
    | TurnFailureNotification
    | MasterErrorNotification
    | SummaryFailureNotification
    | SpendCapOverrideNotification,
  kind: NotificationEventKind,
  coalesceMinutes: number,
): string {
  if (kind === 'spend.override') {
    const override = event as SpendCapOverrideNotification;
    return `override:${override.overrideId}:${override.change}:${override.expiresAt}`;
  }
  const windowStart = eventNotificationWindowStart(event.occurredAt, coalesceMinutes);
  if (kind === 'turn.failed') {
    const turn = event as TurnFailureNotification;
    return `turn:${turn.requestId}:${turn.source}:${safeKeyPart(turn.reason)}:${coalesceMinutes}:${windowStart}`;
  }
  if (kind === 'master.error') {
    const master = event as MasterErrorNotification;
    return `master:${master.cellId}:${master.source}:${safeKeyPart(master.segment ?? '')}:${coalesceMinutes}:${windowStart}`;
  }
  const summary = event as SummaryFailureNotification;
  return `summary:${summary.cellId}:${summary.source}:${safeKeyPart(summary.reason)}:${coalesceMinutes}:${windowStart}`;
}
