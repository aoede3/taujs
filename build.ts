import fs from 'node:fs/promises';
import path, { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { processConfigs, TEMPLATE } from '@taujs/server';
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
  const baseClientRoot = path.resolve(__dirname, 'src/client');
  const processedConfigs = processConfigs(configs, baseClientRoot, TEMPLATE);

  for (const config of processedConfigs) {
    const { clientRoot, entryPoint, entryClient, entryServer, htmlTemplate } = config;
    const outDir = path.resolve(__dirname, `dist/client/${entryPoint}`);
    const root = entryPoint ? path.resolve(__dirname, `src/client/${entryPoint}`) : path.resolve(__dirname, 'src/client');

    console.log(`Building for entryPoint: "${entryPoint}" on ${clientRoot}`);

    const server = path.resolve(clientRoot, `${entryServer}.tsx`);
    const client = path.resolve(clientRoot, `${entryClient}.tsx`);
    const main = path.resolve(clientRoot, htmlTemplate);

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

if (!isSSRBuild) await deleteDist();
runBuilds();
