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
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': { target: `http://127.0.0.1:${process.env.SBOX_PORT ?? 7391}`, changeOrigin: true },
      '/ws': {
        target: `http://127.0.0.1:${process.env.SBOX_PORT ?? 7391}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
