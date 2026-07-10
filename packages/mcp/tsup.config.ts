import { defineConfig } from 'tsup';

export default defineConfig({
  clean: true,
  dts: true,
  entryPoints: ['src/index.ts', 'src/bin.ts'],
  external: ['node:fs', 'node:fs/promises', 'node:path', 'node:process'],
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  shims: false,
  splitting: true,
  target: 'esnext',
});
