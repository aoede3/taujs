import path from 'node:path';
import { build } from 'vite';
import baseConfig from './vite.config.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const isDevelopment = process.env.NODE_ENV === 'development';
export const __filename = fileURLToPath(import.meta.url);
export const __dirname = join(dirname(__filename), './');

const configs = [{ entryPoint: '' }, { entryPoint: '@admin' }];

async function runBuilds() {
  for (const config of configs) {
    const entryPoint = config.entryPoint;
    const root = entryPoint ? path.resolve(__dirname, `src/client/${entryPoint}`) : path.resolve(__dirname, 'src/client');
    const outputDir = entryPoint ? path.resolve(__dirname, `dist/client/${entryPoint}`) : path.resolve(__dirname, 'dist/client');

    console.log(`Building for entryPoint: "${entryPoint}"`);

    const customConfig = {
      ...baseConfig,
      base: entryPoint ? `/${entryPoint}/` : '/',
      build: {
        ...baseConfig.build,
        outDir: outputDir,
        rollupOptions: {
          ...baseConfig.build.rollupOptions,
          input: {
            client: path.resolve(root, 'entry-client.tsx'),
            main: path.resolve(root, 'index.html'),
          },
        },
      },
      resolve: {
        alias: {
          '@client': path.resolve(__dirname, `src/client/${entryPoint || ''}`),
          '@server': path.resolve(__dirname, 'src/server'),
          '@shared': path.resolve(__dirname, 'src/shared'),
        },
      },
      root,
    };

    try {
      await build(customConfig);
      console.log(`Build complete for entryPoint: "${entryPoint}"`);
    } catch (error) {
      console.error(`Error building for entryPoint: "${entryPoint}"`, error);
      process.exit(1);
    }
  }
}

runBuilds();
