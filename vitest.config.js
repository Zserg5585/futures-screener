import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    testTimeout: 10000,
    hookTimeout: 10000,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      include: ['server/**/*.js'],
      exclude: ['server/node_modules/**', 'server/data/**'],
    },
  },
});
