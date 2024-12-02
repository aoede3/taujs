import path from 'node:path';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const isDevelopment = process.env.NODE_ENV === 'development';
export const __filename = fileURLToPath(import.meta.url);
export const __dirname = join(dirname(__filename), './');

const isSSRBuild = process.env.BUILD_MODE === 'ssr';

export default defineConfig({
  base: '/',
  build: {
    emptyOutDir: !isSSRBuild,
    manifest: !isSSRBuild,
    outDir: path.resolve(__dirname, 'dist/client'),
    rollupOptions: {
      external: ['@taujs/server'],
      input: isSSRBuild
        ? {
            server: path.resolve(__dirname, 'src/client/entry-server.tsx'),
          }
        : {
            client: path.resolve(__dirname, 'src/client/entry-client.tsx'),
            main: path.resolve(__dirname, 'src/client/index.html'),
          },
    },
    ssr: isSSRBuild ? path.resolve(__dirname, 'src/client/entry-server.tsx') : undefined,
    ssrManifest: isSSRBuild,
  },
  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern-compiler',
      },
    },
  },
  plugins: [react(), nodePolyfills({ include: ['fs', 'stream'] })],
  publicDir: 'public',
  resolve: {
    alias: {
      '@client': path.resolve(__dirname, 'src/client'),
      '@server': path.resolve(__dirname, 'src/server'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  root: path.resolve(__dirname, 'src/client'),
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
});
