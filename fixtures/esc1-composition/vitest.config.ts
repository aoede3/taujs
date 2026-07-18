import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Real Vite builds are slower than unit tests.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
