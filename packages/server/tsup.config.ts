import { defineConfig } from 'tsup';

export default defineConfig({
  clean: true,
  dts: true,
  // Build.ts / Config.ts / Renderer.ts are real entries: the "./build" / "./config" / "./renderer"
  // exports subpaths point at dist/Build.js / dist/Config.js / dist/Renderer.js.
  entryPoints: ['src/index.ts', 'src/Config.ts', 'src/Build.ts', 'src/Renderer.ts'],
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
