import path from 'node:path';

import { build } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

import { processConfigs, TEMPLATE } from './SSRServer';

import type { InlineConfig, PluginOption } from 'vite';
import type { AppConfig } from './config';

export async function taujsBuild({
  configs,
  projectRoot,
  clientBaseDir,
  isSSRBuild = process.env.BUILD_MODE === 'ssr',
}: {
  configs: AppConfig[];
  projectRoot: string;
  clientBaseDir: string;
  isSSRBuild?: boolean;
}) {
  const deleteDist = async () => {
    // imported here as dynamic to avoid vitest hoisting issues
    const { rm } = await import('node:fs/promises');
    const distPath = path.resolve(projectRoot, 'dist');
    try {
      await rm(distPath, { recursive: true, force: true });
      console.log('Deleted the dist directory\n');
    } catch (err) {
      console.error('Error deleting dist directory:', err);
    }
  };

  const processedConfigs = processConfigs(configs, clientBaseDir, TEMPLATE);

  if (!isSSRBuild) await deleteDist();

  for (const config of processedConfigs) {
    const { appId, entryPoint, clientRoot, entryClient, entryServer, htmlTemplate, plugins = [] } = config;

    const outDir = path.resolve(projectRoot, `dist/client/${entryPoint}`);
    const root = entryPoint ? path.resolve(clientBaseDir, entryPoint) : clientBaseDir;

    const server = path.resolve(clientRoot, `${entryServer}.tsx`);
    const client = path.resolve(clientRoot, `${entryClient}.tsx`);
    const main = path.resolve(clientRoot, htmlTemplate);

    const viteConfig: InlineConfig = {
      base: entryPoint ? `/${entryPoint}/` : '/',
      build: {
        outDir,
        manifest: !isSSRBuild,
        rollupOptions: {
          input: isSSRBuild ? { server } : { client, main },
        },
        ssr: isSSRBuild ? server : undefined,
        ssrManifest: isSSRBuild,
        ...(isSSRBuild && {
          format: 'esm',
          target: `node${process.versions.node.split('.').map(Number)[0]}`,
        }),
      },
      css: {
        preprocessorOptions: {
          scss: { api: 'modern-compiler' },
        },
      },
      plugins: [...(config.plugins ?? []), nodePolyfills({ include: ['fs', 'stream'] })] as PluginOption[],
      publicDir: 'public',
      resolve: {
        alias: {
          '@client': root,
          '@server': path.resolve(projectRoot, 'src/server'),
          '@shared': path.resolve(projectRoot, 'src/shared'),
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
      console.log(`Building for entryPoint: "${entryPoint}" (${appId})`);
      await build(viteConfig);
      console.log(`Build complete for entryPoint: "${entryPoint}"\n`);
    } catch (error) {
      console.error(`Error building for entryPoint: "${entryPoint}"\n`, error);
      process.exit(1);
    }
  }
}
