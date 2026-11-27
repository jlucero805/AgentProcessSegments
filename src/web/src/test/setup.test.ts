import { describe, expect, it, vi } from 'vitest';

// These cases are intentionally ordered and must stay in one file. Vitest runs
// cases in declaration order, so the first case leaks fake timers and the shared
// afterEach in setup.ts must restore the real clock before the second case runs.
describe('web test setup', () => {
  it('keeps fake timers installed when a case forgets to restore them', () => {
    vi.useFakeTimers();
    expect(vi.isFakeTimers()).toBe(true);
  });

  it('restores real timers between cases', async () => {
    expect(vi.isFakeTimers()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }, 2_000);
});
