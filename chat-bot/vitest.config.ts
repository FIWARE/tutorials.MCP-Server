import { defineConfig } from 'vitest/config';

export default defineConfig({
  // vite.config.ts scopes root to src/web for the client build; tests live outside that.
  root: '.',
  test: {
    include: ['test/**/*.test.ts'],
  },
});
