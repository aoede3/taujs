import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The matrix boots real τjs servers and drives them over HTTP - node only, and never in
    // parallel with itself (one port, two server lifecycles).
    environment: 'node',
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
