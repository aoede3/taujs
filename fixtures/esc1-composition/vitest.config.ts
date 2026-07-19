import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // TEST-ONLY aliases to @taujs/server host-internal source modules. These exist ONLY while the
  // repository's own fixtures run; they are NOT part of @taujs/server's package `exports`, so the ESC-1
  // host pre-pass/composition primitives can never become an accidental user dependency. The reduced
  // checkpoint's one new public concept remains the managed contribution alone.
  resolve: {
    alias: {
      '@taujs/server-internal/ownership': resolve(here, '../../packages/server/src/utils/OwnershipPrepass.ts'),
      // Renderer v1: solidRenderer() is INTERNAL (no public `@taujs/solid/renderer` export); the fixtures
      // reach the internal factory directly so the composition/build matrix can still exercise Solid.
    },
  },
  test: {
    environment: 'node',
    // Real Vite builds are slower than unit tests.
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
