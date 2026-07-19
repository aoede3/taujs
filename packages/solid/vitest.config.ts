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
    // M1's detachment proof is causal (WeakRef + forced GC), which needs `--expose-gc`. Setting it
    // HERE rather than as `NODE_OPTIONS=--expose-gc` in the `test` script keeps the command
    // cross-platform: the env-var prefix form is POSIX-only and fails under Windows cmd.exe, and
    // the repo has no `cross-env`. The tests SKIP visibly if `globalThis.gc` is ever absent, so a
    // misconfiguration here can never look like a pass.
    poolOptions: {
      forks: { execArgv: ['--expose-gc'] },
      threads: { execArgv: ['--expose-gc'] },
    },
  },
});
