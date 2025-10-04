import { readFile } from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';

import { AppError } from '../logging/AppError';
import { createLogger } from '../logging/Logger';
import { isDevelopment } from './System';
import { getCssLinks, renderPreloadLinks } from './Templates';

import type { Manifest } from 'vite';
import type { TEMPLATE } from '../constants';
import type { Logs } from '../logging/Logger';
import type { DebugInput } from '../logging/Parser';
import type { RenderModule, SSRManifest, Config, ProcessedConfig } from '../types';

export const createMaps = () => ({
  bootstrapModules: new Map<string, string>(),
  cssLinks: new Map<string, string>(),
  manifests: new Map<string, Manifest>(),
  preloadLinks: new Map<string, string>(),
  renderModules: new Map<string, RenderModule>(),
  ssrManifests: new Map<string, SSRManifest>(),
  templates: new Map<string, string>(),
});

export const processConfigs = (configs: Config[], baseClientRoot: string, templateDefaults: typeof TEMPLATE): ProcessedConfig[] => {
  return configs.map((config) => {
    const clientRoot = path.resolve(baseClientRoot, config.entryPoint);

    return {
      clientRoot,
      entryPoint: config.entryPoint,
      entryClient: config.entryClient || templateDefaults.defaultEntryClient,
      entryServer: config.entryServer || templateDefaults.defaultEntryServer,
      htmlTemplate: config.htmlTemplate || templateDefaults.defaultHtmlTemplate,
      appId: config.appId,
    };
  });
};

export const loadAssets = async (
  processedConfigs: ProcessedConfig[],
  baseClientRoot: string,
  bootstrapModules: Map<string, string>,
  cssLinks: Map<string, string>,
  manifests: Map<string, Manifest>,
  preloadLinks: Map<string, string>,
  renderModules: Map<string, RenderModule>,
  ssrManifests: Map<string, SSRManifest>,
  templates: Map<string, string>,
  opts: { debug?: DebugInput; logger?: Logs } = {},
) => {
  const { debug, logger: providedLogger } = opts;
  const logger: Logs = providedLogger ?? createLogger({ debug });

  for (const config of processedConfigs) {
    const { clientRoot, entryClient, entryServer, htmlTemplate } = config;

    try {
      const templateHtmlPath = path.join(clientRoot, htmlTemplate);
      const templateHtml = await readFile(templateHtmlPath, 'utf-8');
      templates.set(clientRoot, templateHtml);

      const relativeBasePath = path.relative(baseClientRoot, clientRoot).replace(/\\/g, '/');
      const adjustedRelativePath = relativeBasePath ? `/${relativeBasePath}` : '';

      if (!isDevelopment) {
        try {
          const manifestPath = path.join(clientRoot, '.vite/manifest.json');
          const manifestContent = await readFile(manifestPath, 'utf-8');
          const manifest = JSON.parse(manifestContent) as Manifest;
          manifests.set(clientRoot, manifest);

          const ssrManifestPath = path.join(clientRoot, '.vite/ssr-manifest.json');
          const ssrManifestContent = await readFile(ssrManifestPath, 'utf-8');
          const ssrManifest = JSON.parse(ssrManifestContent) as SSRManifest;
          ssrManifests.set(clientRoot, ssrManifest);

          const entryClientFile = manifest[`${entryClient}.tsx`]?.file;
          if (!entryClientFile) {
            throw AppError.internal(`Entry client file not found in manifest for ${entryClient}.tsx`, {
              details: {
                clientRoot,
                entryClient,
                availableKeys: Object.keys(manifest),
              },
            });
          }

          const bootstrapModule = `/${adjustedRelativePath}/${entryClientFile}`.replace(/\/{2,}/g, '/');
          bootstrapModules.set(clientRoot, bootstrapModule);

          const preloadLink = renderPreloadLinks(ssrManifest, adjustedRelativePath);
          preloadLinks.set(clientRoot, preloadLink);

          const cssLink = getCssLinks(manifest, adjustedRelativePath);
          cssLinks.set(clientRoot, cssLink);

          const renderModulePath = path.join(clientRoot, `${entryServer}.js`);
          const moduleUrl = pathToFileURL(renderModulePath).href;

          try {
            const importedModule = await import(moduleUrl);
            renderModules.set(clientRoot, importedModule as RenderModule);
          } catch (err) {
            throw AppError.internal(`Failed to load render module ${renderModulePath}`, {
              cause: err,
              details: { moduleUrl, clientRoot, entryServer },
            });
          }
        } catch (err) {
          if (err instanceof AppError) {
            logger.error('Asset load failed', {
              error: { name: err.name, message: err.message, stack: err.stack, code: (err as any).code },
              stage: 'loadAssets:production',
            });
          } else {
            logger.error('Asset load failed', {
              error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
              stage: 'loadAssets:production',
            });
          }
        }
      } else {
        const bootstrapModule = `/${adjustedRelativePath}/${entryClient}`.replace(/\/{2,}/g, '/');
        bootstrapModules.set(clientRoot, bootstrapModule);
      }
    } catch (err) {
      logger.error('Failed to process config', {
        error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
        stage: 'loadAssets:config',
      });
    }
  }
};
