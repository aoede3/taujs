// tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig({
  // R3-05 (Q6, signed 2026-07-12): `bundle: false` preserves the source module graph in dist so a
  // browser bundler can prove `react-dom/server` unreachable from the client entry (`hydrateApp`).
  // The single-module barrel forced every client bundle to retain the CJS browser build of
  // react-dom/server (-49% raw / -48% gzip once split). Two load-bearing details:
  // 1. `bundle: false` does NOT follow the import graph — every source module must be an entry
  //    (the glob below), or its output is silently missing from dist.
  // 2. Source files must use explicit `.js` relative specifiers — tsup emits specifiers as-is,
  //    and extensionless relative imports fail Node ESM with ERR_MODULE_NOT_FOUND. A lint guard
  //    (`SpecifierExtensions.test.ts`) and a client-bundle absence guard (`ClientBundle.test.ts`)
  //    keep both properties from regressing.
  bundle: false,
  clean: true,
  dts: true,
  entryPoints: ['src/**/*.ts', 'src/**/*.tsx', '!src/**/test/**', '!src/**/*.d.ts'],
  external: ['node:fs/promises', 'node:path', 'node:url', 'node:stream', 'react', 'react-dom', 'vite', '@vitejs/plugin-react'],
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  shims: false,
  splitting: false,
  target: 'esnext',
});
