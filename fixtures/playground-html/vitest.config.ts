import { homedir } from 'node:os';
import path from 'node:path';

import { defineConfig } from 'vitest/config';

// playwright-core resolves its browsers directory at MODULE LOAD, so this must be set before
// test/browser.test.ts imports it - setting it in `beforeAll` is too late.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(homedir(), '.cache', 'ms-playwright');

export default defineConfig({
  test: {
    // Both suites boot a real τjs server and drive it over HTTP/a real browser - node only, and
    // never in parallel (each allocates its own ports, but only one server boot at a time keeps
    // the child-process lifecycle simple and the logs readable on failure).
    environment: 'node',
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
    env: { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH },
  },
});
