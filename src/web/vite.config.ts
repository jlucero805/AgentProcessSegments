import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    // jsdom costs about 1.5 s per file to construct. vmThreads creates one V8 context
    // and one jsdom environment per worker while still isolating each file, which
    // roughly halves the suite's wall time. setup.ts supplies the web-stream globals
    // that a bare VM context lacks.
    pool: 'vmThreads',
    restoreMocks: true,
    // The brain unit exports NODE_ENV=production and agent shells inherit it. Vitest
    // only defaults NODE_ENV=test when it is unset, and Vite substitutes the inherited
    // value into the test graph, so React loads its production build where act() throws.
    // Pin it here so every invocation runs as a test.
    env: { NODE_ENV: 'test' },
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.APS_PORT ?? process.env.SBOX_PORT ?? 7391}`,
        changeOrigin: true,
      },
      '/ws': {
        target: `http://127.0.0.1:${process.env.APS_PORT ?? process.env.SBOX_PORT ?? 7391}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
