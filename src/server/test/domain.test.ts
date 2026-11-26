import { describe, expect, it } from 'vitest';
import { resolveHarness } from '../src/domain/harness.js';
import {
  clipNotificationText,
  eventDedupeKey,
  eventNotificationWindowStart,
  masterErrorEnvelope,
  turnFailedEnvelope,
} from '../src/domain/notifications.js';
import {
  DEFAULT_EVENT_NOTIFICATIONS,
  eventRouteAllows,
  eventRouteCells,
} from '../src/domain/budget.js';
import {
  cellSessionIds,
  isReservedSessionId,
  KB_SESSION_ID,
  masterSessionId,
  setupSessionId,
  summarySessionId,
} from '../src/domain/sessions.js';
import {
  canTransition,
  isIntake,
  STATES,
  TERMINAL_STATES,
  TRANSITIONS,
} from '../src/domain/request.js';

describe('harness resolution', () => {
  it('prefers a request override, then the cell, then the process default', () => {
    expect(
      resolveHarness({ request: 'opencode', cell: 'claude', process: 'claude' }),
    ).toEqual({ harness: 'opencode', source: 'request' });
    expect(resolveHarness({ request: null, cell: 'opencode', process: 'claude' })).toEqual({
      harness: 'opencode',
      source: 'cell',
    });
    expect(resolveHarness({ request: null, cell: null, process: 'claude' })).toEqual({
      harness: 'claude',
      source: 'process',
    });
  });
});

describe('request state machine', () => {
  it('walks the happy path and refuses every backward jump the spec forbids', () => {
    expect(canTransition('clarify', 'dispatch')).toBe(true);
    expect(canTransition('dispatch', 'review')).toBe(true);
    expect(canTransition('review', 'finalize')).toBe(true);
    expect(canTransition('finalize', 'done')).toBe(true);

    expect(canTransition('clarify', 'done')).toBe(false);
    expect(canTransition('clarify', 'review')).toBe(false);
    expect(canTransition('dispatch', 'done')).toBe(false);
    expect(canTransition('finalize', 'dispatch')).toBe(false);
  });

  it('allows review to bounce back to plan or implement', () => {
    expect(canTransition('review', 'clarify')).toBe(true);
    expect(canTransition('review', 'dispatch')).toBe(true);
  });

  it('never leaves a terminal state', () => {
    for (const state of TERMINAL_STATES) {
      expect(TRANSITIONS[state]).toEqual([]);
    }
    expect(STATES.filter((state) => TERMINAL_STATES.includes(state))).toEqual(['done', 'dropped']);
  });

  it('treats intake as a view over clarify', () => {
    expect(isIntake({ state: 'clarify', clarifyStarted: false })).toBe(true);
    expect(isIntake({ state: 'clarify', clarifyStarted: true })).toBe(false);
    expect(isIntake({ state: 'review', clarifyStarted: false })).toBe(false);
  });
});

describe('event notification routing and windows', () => {
  const events = {
    ...DEFAULT_EVENT_NOTIFICATIONS,
    failedTurns: { webhook: true, email: true },
    masterErrors: { webhook: true, email: false },
  };
  const turn = {
    turnId: 'turn-1',
    requestId: 'req-1',
    requestTitle: 'Fix the parser',
    state: 'dispatch' as const,
    cellId: 'cell-a',
    harness: 'opencode' as const,
    model: null,
    source: 'engine.exit' as const,
    reason: 'process exited with code 1',
    occurredAt: Date.UTC(2026, 10, 15, 12, 0, 0),
  };

  it('treats an empty pair as all cells and a route as an exact cell allowlist', () => {
    expect(eventRouteCells(events, 'turn.failed', 'webhook')).toBeNull();
    expect(eventRouteAllows(events, 'turn.failed', 'webhook', 'cell-a')).toBe(true);
    expect(eventRouteAllows(events, 'turn.failed', 'webhook', null)).toBe(true);

    const routed = {
      ...events,
      routes: [{ kind: 'turn.failed' as const, channel: 'webhook' as const, cellId: 'cell-a' }],
    };
    expect(eventRouteCells(routed, 'turn.failed', 'webhook')).toEqual(['cell-a']);
    expect(eventRouteAllows(routed, 'turn.failed', 'webhook', 'cell-a')).toBe(true);
    expect(eventRouteAllows(routed, 'turn.failed', 'webhook', 'cell-b')).toBe(false);
    expect(eventRouteAllows(routed, 'turn.failed', 'webhook', null)).toBe(false);
    expect(eventRouteAllows(routed, 'turn.failed', 'email', 'cell-b')).toBe(true);
    expect(eventRouteAllows(routed, 'master.error', 'webhook', 'cell-a')).toBe(true);
  });

  it('anchors configurable windows to the Unix epoch', () => {
    const noon = Date.UTC(2026, 10, 15, 12, 0, 0);
    expect(eventNotificationWindowStart(noon, 60)).toBe(noon);
    expect(eventNotificationWindowStart(noon + 25 * 60_000, 30)).toBe(noon);
    expect(eventNotificationWindowStart(noon + 35 * 60_000, 30)).toBe(
      noon + 30 * 60_000,
    );
    expect(eventNotificationWindowStart(noon + 59 * 60_000, 60)).toBe(noon);
    expect(eventNotificationWindowStart(noon + 60 * 60_000, 60)).toBe(
      noon + 60 * 60_000,
    );

    expect(eventDedupeKey(turn, 'turn.failed', 30)).toBe(
      `turn:req-1:engine.exit:process_exited_with_code_1:30:${noon}`,
    );
    expect(eventDedupeKey(turn, 'turn.failed', 60)).toBe(
      `turn:req-1:engine.exit:process_exited_with_code_1:60:${noon}`,
    );
  });
});

describe('reserved session ids', () => {
  it('marks every virtual chat and summary generator as unprunable', () => {
    expect(isReservedSessionId(KB_SESSION_ID)).toBe(true);
    expect(isReservedSessionId(masterSessionId('cell-a'))).toBe(true);
    expect(isReservedSessionId(summarySessionId('cell-a'))).toBe(true);
    expect(isReservedSessionId(setupSessionId('draft-a'))).toBe(true);
    expect(isReservedSessionId('f1c2e3d4-0000-4000-8000-000000000000')).toBe(false);
  });

  it('lists the master and summary sessions owned by one cell', () => {
    expect(cellSessionIds('cell-a')).toEqual([
      masterSessionId('cell-a'),
      summarySessionId('cell-a'),
    ]);
    expect(cellSessionIds('cell-a').every(isReservedSessionId)).toBe(true);
  });
});

describe('notification event builders', () => {
  const turn = {
    turnId: 'turn-1',
    requestId: 'req-1',
    requestTitle: 'Fix the parser',
    state: 'dispatch' as const,
    cellId: 'cell-1',
    harness: 'opencode' as const,
    model: 'model-1',
    source: 'engine.timeout' as const,
    reason: 'timeout after 10m',
    occurredAt: 1,
  };

  it('clips titles and builds a text-only master turn sentence', () => {
    expect(clipNotificationText('  one\n two  ', 20)).toBe('one two');
    expect(clipNotificationText('x'.repeat(30), 10)).toBe(`${'x'.repeat(9)}…`);

    const envelope = masterErrorEnvelope(
      {
        source: 'master.turn',
        cellId: 'cell-1',
        requestId: 'req-1',
        segment: 'implement',
        occurredAt: 1,
      },
      'Acme',
    );
    expect(envelope.title).toBe('Master error: Acme');
    expect(envelope.text).toBe(
      'Master turn failed for cell "Acme" on request req-1 in implement.',
    );
    expect(envelope.master.source).toBe('master.turn');
  });

  it('marks a deleted cell and keeps the turn classification in the envelope', () => {
    const envelope = turnFailedEnvelope(turn, null);
    expect(envelope.title).toBe('Turn failed: Fix the parser');
    expect(envelope.text).toBe(
      'Turn failed for "Fix the parser" in dispatch, Deleted cell: timeout after 10m.',
    );
    expect(envelope.turn).toEqual(turn);
  });
});
