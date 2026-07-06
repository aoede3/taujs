import { defineConfig } from 'tsup';

export default defineConfig({
  clean: true,
  dts: true,
  // Build.ts is a real entry: the "./build" exports subpath points at dist/Build.js.
  entryPoints: ['src/index.ts', 'src/Config.ts', 'src/Build.ts'],
  external: ['@types/node', 'fastify', 'node:fs/promises', 'node:path', 'node:url', 'node:stream', 'vite'],
  format: ['esm'],
  outDir: 'dist',
  platform: 'node',
  shims: false,
  // Shared chunks keep one AppError class identity across all entry points;
  // instanceof would otherwise fail between index.js and Config.js consumers.
  splitting: true,
  target: 'esnext',
});
