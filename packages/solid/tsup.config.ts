import { defineConfig } from 'tsup';

export default defineConfig({
  // Mirror @taujs/react: `bundle: false` preserves the source module graph so lazy `import()` of the
  // ownership machinery keeps `typescript`/`vitefu` out of a raw `pluginSolid()` user's module graph.
  // Every source module must be an entry (glob), and relative imports MUST carry `.js` specifiers.
  bundle: false,
  clean: true,
  dts: true,
  entryPoints: ['src/**/*.ts', '!src/**/test/**', '!src/**/*.d.ts'],
  external: ['node:fs', 'node:fs/promises', 'node:path', 'node:url', 'vite', 'vite-plugin-solid', 'solid-js', 'typescript', 'vitefu'],
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  shims: false,
  splitting: false,
  target: 'esnext',
});
