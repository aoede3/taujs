import { defineConfig } from 'tsup';

export default defineConfig([
  {
    clean: true,
    dts: true,
    entryPoints: ['src/SSRServer.ts'],
    external: ['@types/node', 'fastify', 'node16', 'vite'],
    format: ['esm'],
    outDir: 'dist',
    platform: 'node',
    shims: false,
    splitting: false,
    target: 'esnext',
  },
  {
    dts: true,
    entryPoints: ['src/SSRDataStore.tsx'],
    external: ['@types/react', 'node16', 'react', 'react-dom'],
    format: ['esm'],
    outDir: 'dist',
    platform: 'node',
    shims: false,
    splitting: false,
    target: 'esnext',
  },
  {
    dts: true,
    entryPoints: ['src/SSRRender.ts'],
    external: ['@types/react', 'node16', 'react', 'react-dom'],
    format: ['esm'],
    outDir: 'dist',
    platform: 'node',
    shims: false,
    splitting: false,
    target: 'esnext',
  },
]);
