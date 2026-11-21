import { describe, expect, it } from 'vitest';
import {
  COLUMN_STATE,
  STATE_LABELS,
  TERMINAL_STATES,
  canTransition,
  columnOf,
  timeAgo,
} from './types';

describe('workflow helpers', () => {
  it('uses the shared server transition table', () => {
    expect(canTransition('clarify', 'dispatch')).toBe(true);
    expect(canTransition('clarify', 'review')).toBe(false);
    expect(canTransition('dispatch', 'review')).toBe(true);
    expect(canTransition('dispatch', 'finalize')).toBe(false);
    expect(canTransition('review', 'finalize')).toBe(true);
    expect(canTransition('review', 'dispatch')).toBe(true);
    expect(canTransition('finalize', 'done')).toBe(true);
    expect(canTransition('done', 'clarify')).toBe(false);
    expect(canTransition('dropped', 'dispatch')).toBe(false);
    expect(TERMINAL_STATES).toEqual(['done', 'dropped']);
  });

  it('puts unstarted clarify requests in intake and started ones in plan', () => {
    expect(columnOf({ state: 'clarify', clarifyStarted: false })).toBe('intake');
    expect(columnOf({ state: 'clarify', clarifyStarted: true })).toBe('clarify');
    expect(columnOf({ state: 'dispatch', clarifyStarted: true })).toBe('dispatch');
    expect(columnOf({ state: 'review', clarifyStarted: true })).toBe('review');
    expect(columnOf({ state: 'finalize', clarifyStarted: true })).toBe('finalize');
  });

  it('keeps done and dropped off the board columns', () => {
    expect(columnOf({ state: 'done', clarifyStarted: true })).toBeNull();
    expect(columnOf({ state: 'dropped', clarifyStarted: true })).toBeNull();
  });

  it('maps columns to the state a drop should reach', () => {
    expect(COLUMN_STATE).toEqual({
      intake: null,
      clarify: 'clarify',
      dispatch: 'dispatch',
      review: 'review',
      finalize: 'finalize',
    });
  });

  it('labels every state', () => {
    expect(STATE_LABELS.clarify).toBe('Clarify');
    expect(STATE_LABELS.dropped).toBe('Dropped');
  });

  it('formats relative timestamps', () => {
    expect(timeAgo(Date.now())).toBe('0s');
    expect(timeAgo(Date.now() - 90_000)).toBe('1m');
    expect(timeAgo(Date.now() - 3 * 3_600_000)).toBe('3h');
    expect(timeAgo(Date.now() - 2 * 86_400_000)).toBe('2d');
  });
});
