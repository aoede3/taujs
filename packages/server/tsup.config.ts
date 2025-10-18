import { defineConfig } from 'tsup';

export default defineConfig({
  clean: true,
  dts: true,
  entryPoints: ['src/index.ts', 'src/Build.ts', 'src/Config.ts', 'src/types.ts'],
  external: ['@types/node', 'fastify', 'node:fs/promises', 'node:path', 'node:url', 'node:stream', 'vite'],
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  shims: false,
  splitting: false,
  target: 'esnext',
});
