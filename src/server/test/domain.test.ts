import { describe, expect, it } from 'vitest';
import {
  canTransition,
  isIntake,
  STATES,
  TERMINAL_STATES,
  TRANSITIONS,
} from '../src/domain/request.js';

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
