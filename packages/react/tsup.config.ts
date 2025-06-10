// tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig({
  clean: true,
  dts: true,
  entryPoints: ['src/index.ts'],
  external: ['node:fs/promises', 'node:path', 'node:url', 'node:stream', 'react', 'react-dom', 'vite'],
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  shims: false,
  splitting: false,
  target: 'esnext',
});
