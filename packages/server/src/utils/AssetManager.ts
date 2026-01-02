import { existsSync } from 'node:fs';
import { readFile } from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';

import { ENTRY_EXTENSIONS, TEMPLATE } from '../constants';
import { AppError } from '../core/errors/AppError';
import { resolveLogs } from '../core/logging/resolve';
import { isDevelopment } from '../System';
import { getCssLinks, renderPreloadLinks } from './Templates';

import type { Logs } from '../core/logging/types';
import type { Config, Manifest, ProcessedConfig, RenderModule, SSRManifest } from '../types';

/**
 * Resolve entry file by checking filesystem for supported extensions.
 * @throws Error if no matching file found
 */
function resolveEntryFile(clientRoot: string, stem: string): string {
  for (const ext of ENTRY_EXTENSIONS) {
    const filename = `${stem}${ext}`;
    const absPath = path.join(clientRoot, filename);

    if (existsSync(absPath)) return filename; // Return relative filename (e.g., "entry-server.ts")
  }

  throw new Error(`Entry file "${stem}" not found in ${clientRoot}. ` + `Tried: ${ENTRY_EXTENSIONS.map((e) => stem + e).join(', ')}`);
}

export const createMaps = () => ({
  bootstrapModules: new Map<string, string>(),
  cssLinks: new Map<string, string>(),
  manifests: new Map<string, Manifest>(),
  preloadLinks: new Map<string, string>(),
  renderModules: new Map<string, RenderModule>(),
  ssrManifests: new Map<string, SSRManifest>(),
  templates: new Map<string, string>(),
});

export const processConfigs = <P = unknown>(configs: readonly Config<P>[], baseClientRoot: string, templateDefaults: typeof TEMPLATE): ProcessedConfig<P>[] => {
  return configs.map((config) => {
    const clientRoot = path.resolve(baseClientRoot, config.entryPoint);

    const entryClient = config.entryClient || templateDefaults.defaultEntryClient;
    const entryServer = config.entryServer || templateDefaults.defaultEntryServer;

    const entryClientFile = resolveEntryFile(clientRoot, entryClient);
    const entryServerFile = resolveEntryFile(clientRoot, entryServer);

    return {
      clientRoot,
      entryPoint: config.entryPoint,
      entryClient,
      entryServer,
      htmlTemplate: config.htmlTemplate || templateDefaults.defaultHtmlTemplate,
      appId: config.appId,
      plugins: config.plugins ?? [],
      entryClientFile,
      entryServerFile,
    };
  }) as ProcessedConfig<P>[];
};

export const loadAssets = async (
  processedConfigs: readonly ProcessedConfig[],
  baseClientRoot: string,
  bootstrapModules: Map<string, string>,
  cssLinks: Map<string, string>,
  manifests: Map<string, Manifest>,
  preloadLinks: Map<string, string>,
  renderModules: Map<string, RenderModule>,
  ssrManifests: Map<string, SSRManifest>,
  templates: Map<string, string>,
  opts: { logger?: Logs } = {},
) => {
  const logger = resolveLogs(opts.logger);

  for (const config of processedConfigs) {
    const { clientRoot, entryServer, htmlTemplate, entryPoint, entryClientFile } = config;

    try {
      const templateHtmlPath = path.join(clientRoot, htmlTemplate);
      const templateHtml = await readFile(templateHtmlPath, 'utf-8');
      templates.set(clientRoot, templateHtml);

      const relativeBasePath = path.relative(baseClientRoot, clientRoot).replace(/\\/g, '/');
      const adjustedRelativePath = relativeBasePath ? `/${relativeBasePath}` : '';

      if (!isDevelopment) {
        try {
          const distRoot = path.dirname(baseClientRoot);
          const ssrRoot = path.join(distRoot, 'ssr');

          const clientDistPath = path.join(baseClientRoot, entryPoint);
          const manifestPath = path.join(clientDistPath, '.vite/manifest.json');
          const manifestContent = await readFile(manifestPath, 'utf-8');
          const manifest = JSON.parse(manifestContent) as Manifest;
          manifests.set(clientRoot, manifest);

          const ssrDistPath = path.join(ssrRoot, entryPoint);
          const ssrManifestPath = path.join(ssrDistPath, '.vite/ssr-manifest.json');
          const ssrManifestContent = await readFile(ssrManifestPath, 'utf-8');
          const ssrManifest = JSON.parse(ssrManifestContent) as SSRManifest;
          ssrManifests.set(clientRoot, ssrManifest);

          const manifestEntry = manifest[entryClientFile];
          if (!manifestEntry?.file) {
            throw AppError.internal(`Entry client file not found in manifest for ${entryClientFile}`, {
              details: {
                clientRoot,
                entryClientFile,
                availableKeys: Object.keys(manifest),
              },
            });
          }

          const bootstrapModule = `/${adjustedRelativePath}/${manifestEntry.file}`.replace(/\/{2,}/g, '/');
          bootstrapModules.set(clientRoot, bootstrapModule);

          const preloadLink = renderPreloadLinks(ssrManifest, adjustedRelativePath);
          preloadLinks.set(clientRoot, preloadLink);

          const cssLink = getCssLinks(manifest, adjustedRelativePath);
          cssLinks.set(clientRoot, cssLink);

          const renderModulePath = path.join(ssrDistPath, `${entryServer}.js`);
          const moduleUrl = pathToFileURL(renderModulePath).href;

          try {
            const importedModule = await import(moduleUrl);
            renderModules.set(clientRoot, importedModule as RenderModule);
          } catch (err) {
            throw AppError.internal(`Failed to load render module ${renderModulePath}`, {
              cause: err,
              details: { moduleUrl, clientRoot, entryServer, ssrDistPath },
            });
          }
        } catch (err) {
          if (err instanceof AppError) {
            logger.error(
              {
                error: { name: err.name, message: err.message, stack: err.stack, code: (err as any).code },
                stage: 'loadAssets:production',
              },
              'Asset load failed',
            );
          } else {
            logger.error(
              {
                error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
                stage: 'loadAssets:production',
              },
              'Asset load failed',
            );
          }
        }
      } else {
        const bootstrapModule = `/${adjustedRelativePath}/${entryClientFile}`.replace(/\/{2,}/g, '/');
        bootstrapModules.set(clientRoot, bootstrapModule);
      }
    } catch (err) {
      logger.error(
        {
          error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
          stage: 'loadAssets:config',
        },
        'Failed to process config',
      );
    }
  }
};
