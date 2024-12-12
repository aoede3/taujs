import fs from 'node:fs/promises';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { build } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

import { configs } from './buildConfig';

export const __filename = fileURLToPath(import.meta.url);
export const __dirname = join(dirname(__filename), './');

const isSSRBuild = process.env.BUILD_MODE === 'ssr';

const deleteDist = async () => {
  const distPath = path.resolve(__dirname, 'dist');
  try {
    await fs.rm(distPath, { recursive: true, force: true });
    console.log('Deleted the dist directory\n');
  } catch (err) {
    console.error('Error deleting dist directory:', err);
  }
};

const runBuilds = async () => {
  await deleteDist();

  for (const config of configs) {
    const entryPoint = config.entryPoint;
    const root = entryPoint ? path.resolve(__dirname, `src/client/${entryPoint}`) : path.resolve(__dirname, 'src/client');
    const outDir = entryPoint ? path.resolve(__dirname, `dist/client/${entryPoint}`) : path.resolve(__dirname, 'dist/client');

    console.log(`Building for entryPoint: "${entryPoint}" on ${root}`);

    const server = path.resolve(root, 'entry-server.tsx');
    const client = path.resolve(root, 'entry-client.tsx');
    const main = path.resolve(root, 'index.html');

    const customConfig = {
      base: entryPoint ? `/${entryPoint}/` : '/',
      build: {
        outDir,
        manifest: !isSSRBuild,
        rollupOptions: {
          input: isSSRBuild ? { server } : { client, main },
        },
        ssr: isSSRBuild ? server : undefined,
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
          '@client': path.resolve(__dirname, `src/client/${entryPoint || ''}`),
          '@server': path.resolve(__dirname, 'src/server'),
          '@shared': path.resolve(__dirname, 'src/shared'),
        },
      },
      root,
      server: {
        proxy: {
          '/api': {
            target: 'http://localhost:3000',
            changeOrigin: true,
            rewrite: (path: string) => path.replace(/^\/api/, ''),
          },
        },
      },
    };

    try {
      await build(customConfig);
      console.log(`Build complete for entryPoint: "${entryPoint}"\n`);
    } catch (error) {
      console.error(`Error building for entryPoint: "${entryPoint}"\n`, error);
      process.exit(1);
    }
  }
};

runBuilds();
