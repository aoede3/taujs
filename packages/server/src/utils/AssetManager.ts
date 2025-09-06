import { readFile } from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';

import { isDevelopment } from './System';
import { getCssLinks, renderPreloadLinks } from './Templates';

import type { Manifest } from 'vite';
import type { TEMPLATE } from '../constants';
import type { RenderModule, SSRManifest, Config, ProcessedConfig } from '../types';

export const createMaps = () => {
  return {
    bootstrapModules: new Map<string, string>(),
    cssLinks: new Map<string, string>(),
    manifests: new Map<string, Manifest>(),
    preloadLinks: new Map<string, string>(),
    renderModules: new Map<string, RenderModule>(),
    ssrManifests: new Map<string, SSRManifest>(),
    templates: new Map<string, string>(),
  };
};

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
) => {
  for (const config of processedConfigs) {
    const { clientRoot, entryClient, entryServer, htmlTemplate } = config;

    const templateHtmlPath = path.join(clientRoot, htmlTemplate);
    const templateHtml = await readFile(templateHtmlPath, 'utf-8');
    templates.set(clientRoot, templateHtml);

    const relativeBasePath = path.relative(baseClientRoot, clientRoot).replace(/\\/g, '/');
    const adjustedRelativePath = relativeBasePath ? `/${relativeBasePath}` : '';

    if (!isDevelopment) {
      const manifestPath = path.join(clientRoot, '.vite/manifest.json');
      const manifestContent = await readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent) as Manifest;
      manifests.set(clientRoot, manifest);

      const ssrManifestPath = path.join(clientRoot, '.vite/ssr-manifest.json');
      const ssrManifestContent = await readFile(ssrManifestPath, 'utf-8');
      const ssrManifest = JSON.parse(ssrManifestContent) as SSRManifest;
      ssrManifests.set(clientRoot, ssrManifest);

      const entryClientFile = manifest[`${entryClient}.tsx`]?.file;
      if (!entryClientFile) throw new Error(`Entry client file not found in manifest for ${entryClient}.tsx`);

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
      } catch (error) {
        throw new Error(`Failed to load render module ${renderModulePath}: ${error}`);
      }
    } else {
      const bootstrapModule = `/${adjustedRelativePath}/${entryClient}`.replace(/\/{2,}/g, '/');
      bootstrapModules.set(clientRoot, bootstrapModule);
    }
  }
};
