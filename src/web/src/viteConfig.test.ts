import { describe, expect, it } from 'vitest';
import config from '../vite.config';

describe('web vitest config', () => {
  it('pins the test environment and the per-worker jsdom pool', () => {
    expect(config.test?.env?.NODE_ENV).toBe('test');
    expect(config.test?.pool).toBe('vmThreads');
  });
});
