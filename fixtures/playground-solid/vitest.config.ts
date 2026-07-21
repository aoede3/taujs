import { homedir } from 'node:os';
import path from 'node:path';

import { defineConfig } from 'vitest/config';

// playwright-core resolves its browsers directory at MODULE LOAD, so this must be set before the
// test file imports it - setting it in `beforeAll` is too late. The value is Playwright's own
// Linux default; it is stated explicitly because a sandboxed editor (Flatpak) redirects
// XDG_CACHE_HOME and Playwright then looks somewhere the browsers were never installed.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.join(homedir(), '.cache', 'ms-playwright');

export default defineConfig({
  test: {
    // These suites boot real τjs servers and drive them over HTTP - node only, and never in
    // parallel with each other (one port, several server lifecycles).
    environment: 'node',
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
    env: { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH },
  },
});
