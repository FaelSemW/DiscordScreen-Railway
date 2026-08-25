import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.js'],
    include: ['server/**/*.test.js', 'shared/**/*.test.js', 'client/**/*.test.js', 'tests/**/*.test.js'],
  },
});
