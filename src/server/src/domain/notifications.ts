/**
 * Operational notification contract shared by the server and the SPA. Keep this
 * module free of Node-only imports so `src/web/src/types.ts` can re-export the
 * pure helpers for Vite.
 */
import type { HarnessId } from './harness.js';
import type { State } from './request.js';

export const EVENT_NOTIFICATION_KINDS = ['turn.failed', 'master.error'] as const;
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
  /** Engine/master failure source, or null for an unreadable payload. */
  source: string | null;
  reason: string | null;
  cellId: string | null;
  cellName: string | null;
  requestId: string | null;
  turnId: string | null;
  segment: string | null;
  occurredAt: number | null;
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

export type NotificationEventEnvelope = TurnFailedEnvelope | MasterErrorEnvelope;

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

export function notificationEventSubject(
  event: NotificationEventEnvelope,
  cellName: string | null,
): string {
  const title =
    event.event === 'turn.failed'
      ? turnFailedEnvelope(event.turn, cellName).title
      : masterErrorEnvelope(event.master, cellName).title;
  return `[APS] ${title}`;
}

export function notificationEventEmailText(
  event: NotificationEventEnvelope,
  cellName: string | null,
): string {
  const text =
    event.event === 'turn.failed'
      ? turnFailedText(event.turn, cellName)
      : masterErrorText(event.master, cellName);
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
  } else {
    lines.push(
      `Cell: ${event.master.cellId}`,
      `Source: ${event.master.source}`,
      `Request: ${event.master.requestId ?? 'none'}`,
      `Segment: ${event.master.segment ?? 'none'}`,
    );
  }
  return lines.join('\n');
}
