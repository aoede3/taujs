import { defineConfig } from 'tsup';

export default defineConfig({
  // R3-05 (Q6, signed 2026-07-12): `bundle: false` preserves the source module graph in dist.
  // For vue this is STRUCTURAL HARDENING, not a defect fix — `@vue/server-renderer`'s import
  // condition is pure ESM and already tree-shakes to ~0 bytes in client bundles; the unbundled
  // graph removes the latent dependence on that build STAYING tree-shakeable and keeps both
  // renderers' toolchain shape identical (react is the defect case — see its tsup config).
  // Same load-bearing details as react: every module must be an entry (`bundle: false` does not
  // follow the import graph), and relative specifiers must carry explicit `.js` extensions
  // (guards: `SpecifierExtensions.test.ts`, `ClientBundle.test.ts`).
  bundle: false,
  clean: true,
  dts: true,
  entryPoints: ['src/**/*.ts', '!src/**/test/**', '!src/**/*.d.ts'],
  external: ['vue', '@vue/server-renderer', 'vite', '@vitejs/plugin-vue'],
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  shims: false,
  splitting: false,
  target: 'esnext',
});
