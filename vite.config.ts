import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the static build works from any path (incl. GitHub Pages).
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
  worker: {
    format: 'es',
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 120000,
  },
});
