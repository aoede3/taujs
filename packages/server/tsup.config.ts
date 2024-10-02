// tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig({
  clean: true,
  dts: true,
  entryPoints: ['src/data.ts', 'src/index.ts'],
  external: ['@types/node', 'fastify', 'node:fs/promises', 'node:path', 'node:url', 'node:stream', 'react', 'react-dom', 'vite'],
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  shims: false,
  splitting: false,
  target: 'esnext',
});
