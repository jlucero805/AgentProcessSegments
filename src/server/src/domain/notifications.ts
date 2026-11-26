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

export type NotificationEventEnvelope =
  | TurnFailedEnvelope
  | MasterErrorEnvelope
  | SummaryFailedEnvelope;

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

export function notificationEventSubject(
  event: NotificationEventEnvelope,
  cellName: string | null,
): string {
  const title =
    event.event === 'turn.failed'
      ? turnFailedEnvelope(event.turn, cellName).title
      : event.event === 'master.error'
        ? masterErrorEnvelope(event.master, cellName).title
        : summaryFailedEnvelope(event.summary, cellName).title;
  return `[APS] ${title}`;
}

export function notificationEventEmailText(
  event: NotificationEventEnvelope,
  cellName: string | null,
): string {
  const text =
    event.event === 'turn.failed'
      ? turnFailedText(event.turn, cellName)
      : event.event === 'master.error'
        ? masterErrorText(event.master, cellName)
        : summaryFailedText(event.summary, cellName);
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
  } else {
    lines.push(
      `Cell: ${event.summary.cellId}`,
      `Source: ${event.summary.source}`,
      `Reason: ${event.summary.reason}`,
    );
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

/** Stable per-channel idempotency key for one event signature in a window. */
export function eventDedupeKey(
  event: TurnFailureNotification | MasterErrorNotification | SummaryFailureNotification,
  kind: NotificationEventKind,
  coalesceMinutes: number,
): string {
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
