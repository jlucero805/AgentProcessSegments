import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Each test file's temp root is removed by afterAll in test/setup.ts.
    setupFiles: ['./test/setup.ts'],
  },
});
