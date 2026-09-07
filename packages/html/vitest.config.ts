import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      exclude: [...configDefaults.exclude, '**/index.ts', '**/global.d.ts', '**/*test*/**'],
      reporter: ['html'],
    },
    // The server modules render strings; only Client.test.ts touches the DOM, and opts into jsdom
    // itself with a `// @vitest-environment jsdom` header.
    environment: 'node',
  },
});
