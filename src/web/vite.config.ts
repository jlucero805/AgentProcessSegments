/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
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
