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
    // M1's detachment proof is causal (WeakRef + forced GC), so the workers need
    // `--expose-gc`. Vitest 4 moved this from `poolOptions.<pool>.execArgv` to top-level
    // `test.execArgv`, which is cross-platform and needs no env-var prefix or `cross-env`.
    // The tests SKIP visibly if `globalThis.gc` is ever absent, so a misconfiguration here can
    // never look like a pass.
    execArgv: ['--expose-gc'],
  },
});
