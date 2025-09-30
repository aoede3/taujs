import { readFile } from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';

import { Logger } from './Logger';
import { ServiceError } from './ServiceError';
import { isDevelopment } from './System';
import { getCssLinks, renderPreloadLinks } from './Templates';

import type { Manifest } from 'vite';
import type { TEMPLATE } from '../constants';
import type { DebugConfig, Logs } from './Logger';
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
  opts: { debug?: DebugConfig; logger?: Logs } = {},
) => {
  const { debug, logger: providedLogger } = opts;
  const baseLogger = providedLogger ?? new Logger();
  if (debug !== undefined) baseLogger.configure(debug);
  const logger = baseLogger.child({ component: 'asset-loader' });

  for (const config of processedConfigs) {
    const { clientRoot, entryClient, entryServer, htmlTemplate } = config;
    const log = logger.child({ clientRoot, entryClient, entryServer });

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
            throw ServiceError.infra(`Entry client file not found in manifest for ${entryClient}.tsx`, {
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
            throw ServiceError.infra(`Failed to load render module ${renderModulePath}`, {
              cause: err,
              details: { moduleUrl, clientRoot, entryServer },
            });
          }
        } catch (err) {
          if (err instanceof ServiceError) {
            log.error('Asset load failed (production)', {
              error: { name: err.name, message: err.message, stack: err.stack, code: (err as any).code },
              stage: 'loadAssets:production',
            });
          } else {
            log.error('Asset load failed (production)', {
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
      log.error('Failed to process config', {
        error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
        stage: 'loadAssets:config',
      });
    }
  }
};
