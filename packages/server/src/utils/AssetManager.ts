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

    return {
      clientRoot,
      entryPoint: config.entryPoint,
      entryClient: config.entryClient || templateDefaults.defaultEntryClient, // stem
      entryServer: config.entryServer || templateDefaults.defaultEntryServer, // stem
      htmlTemplate: config.htmlTemplate || templateDefaults.defaultHtmlTemplate,
      appId: config.appId,
      plugins: config.plugins ?? [],
    };
  }) as ProcessedConfig<P>[];
};

const logAssetError = (logger: Logs, stage: string, err: unknown) => {
  if (err instanceof AppError) {
    logger.error(
      {
        error: {
          name: err.name,
          message: err.message,
          stack: err.stack,
          code: (err as any).code,
        },
        stage,
      },
      'Asset load failed',
    );
    return;
  }

  logger.error(
    {
      error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
      stage,
    },
    'Asset load failed',
  );
};

const findManifestEntry = (manifest: Manifest, stem: string) => {
  for (const ext of ENTRY_EXTENSIONS) {
    const entry = manifest[`${stem}${ext}`];
    if (entry?.file) return entry;
  }
  return null;
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
    const { clientRoot, entryServer, entryClient, htmlTemplate, entryPoint } = config;

    try {
      const templateHtmlPath = path.join(clientRoot, htmlTemplate);
      templates.set(clientRoot, await readFile(templateHtmlPath, 'utf-8'));

      const relativeBasePath = path.relative(baseClientRoot, clientRoot).replace(/\\/g, '/');
      const adjustedRelativePath = relativeBasePath ? `/${relativeBasePath}` : '';

      if (isDevelopment) {
        const bootstrapModule = `/${adjustedRelativePath}/${entryClient}`.replace(/\/{2,}/g, '/');
        bootstrapModules.set(clientRoot, bootstrapModule);
        continue;
      }

      const distRoot = path.dirname(baseClientRoot);
      const ssrRoot = path.join(distRoot, 'ssr');

      const clientDistPath = path.join(baseClientRoot, entryPoint);
      const manifestPath = path.join(clientDistPath, '.vite/manifest.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf-8')) as Manifest;
      manifests.set(clientRoot, manifest);

      const ssrDistPath = path.join(ssrRoot, entryPoint);
      const ssrManifestPath = path.join(ssrDistPath, '.vite/ssr-manifest.json');
      const ssrManifest = JSON.parse(await readFile(ssrManifestPath, 'utf-8')) as SSRManifest;
      ssrManifests.set(clientRoot, ssrManifest);

      const manifestEntry = findManifestEntry(manifest, entryClient);
      if (!manifestEntry?.file) {
        throw AppError.internal(`Entry "${entryClient}" not found in manifest`, {
          details: {
            tried: ENTRY_EXTENSIONS.map((e) => `${entryClient}${e}`),
            availableKeys: Object.keys(manifest),
            clientRoot,
            entryPoint,
            manifestPath,
          },
        });
      }

      const bootstrapModule = `/${adjustedRelativePath}/${manifestEntry.file}`.replace(/\/{2,}/g, '/');
      bootstrapModules.set(clientRoot, bootstrapModule);

      preloadLinks.set(clientRoot, renderPreloadLinks(ssrManifest, adjustedRelativePath));
      cssLinks.set(clientRoot, getCssLinks(manifest, adjustedRelativePath));

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
      logAssetError(logger, isDevelopment ? 'loadAssets:development' : 'loadAssets:production', err);

      if (!isDevelopment) throw err;
    }
  }
};
