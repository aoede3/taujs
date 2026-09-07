import { defineConfig } from 'tsup';

export default defineConfig({
  // Same structural reasoning as @taujs/vue and @taujs/react: `bundle: false` preserves the source
  // module graph in dist, so every module must be an entry (`bundle: false` does not follow the
  // import graph) and relative specifiers must carry explicit `.js` extensions.
  bundle: false,
  clean: true,
  dts: true,
  entryPoints: ['src/**/*.ts', '!src/**/test/**', '!src/**/*.d.ts'],
  external: [],
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  shims: false,
  splitting: false,
  target: 'esnext',
});
