import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      exclude: [...configDefaults.exclude, '**/index.ts', '**/*test*/**'],
      reporter: ['html'],
    },
    // Plugin/compiler tests import Vite + typescript + vitefu; the default node environment matches
    // (no jsdom shims that would break esbuild's TextEncoder invariant).
    environment: 'node',
  },
});
