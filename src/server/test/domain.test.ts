import { describe, expect, it } from 'vitest';
import { resolveHarness } from '../src/domain/harness.js';
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
