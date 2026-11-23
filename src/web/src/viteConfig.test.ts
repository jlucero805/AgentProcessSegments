import { describe, expect, it } from 'vitest';
import config from '../vite.config';

describe('web vitest config', () => {
  it('pins the test environment to NODE_ENV=test', () => {
    expect(config.test?.env?.NODE_ENV).toBe('test');
  });
});
