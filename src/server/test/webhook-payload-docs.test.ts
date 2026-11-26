import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { budgetAlertEvent, type BudgetAlert } from '../src/domain/budget.js';
import {
  masterErrorEnvelope,
  spendOverrideEnvelope,
  summaryFailedEnvelope,
  turnFailedEnvelope,
} from '../src/domain/notifications.js';

// The receiver-facing payload page is hand-written prose with generated examples. This
// guard keeps every documented field aligned with the real builders: a builder change that
// is not reflected in docs/14-webhook-payloads.md fails here.

const repo = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const PAGE = readFileSync(path.join(repo, 'docs/14-webhook-payloads.md'), 'utf8');

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const PERIOD_START = Date.UTC(2026, 10, 1);

const ALERT: BudgetAlert = {
  id: 'alert-7f3c2a',
  scope: 'cell',
  cellId: 'cell-1',
  cellName: 'Acme',
  threshold: 'warning',
  alertAtPercent: 80,
  budgetUsd: 250,
  spendUsd: 203.5,
  unknownCostTurns: 2,
  periodStart: PERIOD_START,
  createdAt: NOW,
  acknowledgedAt: null,
};

const BUDGET = budgetAlertEvent(ALERT);
const TURN = turnFailedEnvelope(
  {
    turnId: 'turn-1',
    requestId: 'req-1',
    requestTitle: 'Fix the parser',
    state: 'dispatch',
    cellId: 'cell-1',
    harness: 'claude',
    model: 'claude-sonnet-4-5',
    source: 'engine.exit',
    reason: 'process exited with code 1',
    occurredAt: NOW,
  },
  'Acme',
);
const MASTER = masterErrorEnvelope(
  {
    source: 'master.cycle',
    cellId: 'cell-1',
    requestId: null,
    segment: null,
    occurredAt: NOW,
  },
  'Acme',
);
const SUMMARY = summaryFailedEnvelope(
  {
    cellId: 'cell-1',
    source: 'summary.exit',
    reason: 'process exited with code 1',
    occurredAt: NOW,
  },
  'Acme',
);
const OVERRIDE = spendOverrideEnvelope(
  {
    overrideId: 'override-1',
    change: 'granted',
    scope: 'overall',
    cellId: null,
    reason: 'cap_reached',
    periodStart: PERIOD_START,
    expiresAt: NOW + 15 * 60_000,
    note: 'release review',
    budgetUsd: 100,
    spendUsd: 120,
    spendIsLowerBound: false,
    capSpendUsd: 125,
    capSpendIsLowerBound: false,
    occurredAt: NOW,
  },
  null,
);

const EXAMPLES: Array<[string, object]> = [
  ['budget.alert', BUDGET],
  ['turn.failed', TURN],
  ['master.error', MASTER],
  ['summary.failed', SUMMARY],
  ['spend.override', OVERRIDE],
];

type Shape = string | Shape[] | { [key: string]: Shape };

/** Key structure with value kinds; catches a missing or invented field in either direction. */
function shape(value: unknown): Shape {
  if (Array.isArray(value)) return value.map(shape);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, shape(record[key])]),
    );
  }
  return typeof value;
}

/** The first fenced JSON block under the heading whose text starts with `kind`. */
function documentedExample(kind: string): Record<string, unknown> {
  const lines = PAGE.split('\n');
  const heading = lines.findIndex((line) => {
    const match = /^#{1,6}\s+(.*)$/.exec(line);
    return match !== null && match[1] !== undefined && match[1].startsWith(kind);
  });
  expect(heading, `missing heading for ${kind}`).toBeGreaterThanOrEqual(0);
  const open = lines.findIndex((line, index) => index > heading && line.trim() === '```json');
  expect(open, `missing json fence for ${kind}`).toBeGreaterThan(heading);
  const close = lines.findIndex((line, index) => index > open && line.trim() === '```');
  expect(close, `unterminated json fence for ${kind}`).toBeGreaterThan(open);
  return JSON.parse(lines.slice(open + 1, close).join('\n')) as Record<string, unknown>;
}

describe('webhook payload reference', () => {
  for (const [kind, expected] of EXAMPLES) {
    it(`documents ${kind} exactly as the builder sends it`, () => {
      const documented = documentedExample(kind);
      const sent = expected as Record<string, unknown>;
      expect(shape(documented)).toEqual(shape(sent));
      expect(documented['version']).toBe(sent['version']);
      expect(documented['event']).toBe(sent['event']);
      expect(documented['severity']).toBe(sent['severity']);
      expect(documented['title']).toBe(sent['title']);
      expect(documented['text']).toBe(sent['text']);
    });
  }

  it('names every discriminator, nested object, text body, and dedupe id', () => {
    for (const event of [
      'budget.alert',
      'budget.test',
      'turn.failed',
      'master.error',
      'summary.failed',
      'spend.override',
    ]) {
      expect(PAGE).toContain(`\`${event}\``);
    }
    for (const nested of ['alert', 'turn', 'master', 'summary', 'override']) {
      expect(PAGE).toContain(`\`${nested}\``);
    }
    expect(PAGE).toContain('{ "text":');
    expect(PAGE).toContain('{ "content":');
    expect(PAGE).toContain('test-<uuid>');
    for (const field of [
      'alert.id',
      'turn.turnId',
      'turn.requestId',
      'master.cellId',
      'master.source',
      'master.occurredAt',
      'summary.cellId',
      'summary.source',
      'summary.occurredAt',
      'override.overrideId',
      'override.change',
      'override.expiresAt',
      'Idempotency-Key',
    ]) {
      expect(PAGE).toContain(field);
    }
  });
});
