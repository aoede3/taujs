import { readFile } from 'node:fs/promises';
import path from 'node:path';

import fp from 'fastify-plugin';
import pc from 'picocolors';

import { RENDERTYPE, SSRTAG, TEMPLATE } from './constants';
import {
  __dirname,
  collectStyle,
  ensureNonNull,
  fetchInitialData,
  getCssLinks,
  isDevelopment,
  matchRoute,
  overrideCSSHMRConsoleError,
  renderPreloadLinks,
} from './utils';

import type { ServerResponse } from 'node:http';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ViteDevServer } from 'vite';

export { TEMPLATE };

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

export const SSRServer: FastifyPluginAsync<SSRServerOptions> = fp(
  async (app: FastifyInstance, opts: SSRServerOptions) => {
    const { alias, configs, routes, serviceRegistry, isDebug, clientRoot: baseClientRoot } = opts;
    const { bootstrapModules, cssLinks, manifests, preloadLinks, renderModules, ssrManifests, templates } = createMaps();
    const processedConfigs = processConfigs(configs, baseClientRoot, TEMPLATE);

    for (const config of processedConfigs) {
      const { clientRoot, entryClient, htmlTemplate } = config;

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
      } else {
        const bootstrapModule = `/${adjustedRelativePath}/${entryClient}`.replace(/\/{2,}/g, '/');
        bootstrapModules.set(clientRoot, bootstrapModule);
      }
    }

    let viteDevServer: ViteDevServer;

    await app.register(import('@fastify/static'), {
      index: false,
      prefix: '/',
      root: baseClientRoot,
      wildcard: false,
    });

    if (isDevelopment) {
      const { createServer } = await import('vite');

      viteDevServer = await createServer({
        appType: 'custom',
        css: {
          preprocessorOptions: {
            scss: {
              api: 'modern-compiler',
            },
          },
        },
        mode: 'development',
        plugins: [
          ...(isDebug
            ? [
                {
                  name: 'taujs-development-server-debug-logging',
                  configureServer(server: ViteDevServer) {
                    console.log(pc.green('τjs development server debug started.'));

                    server.middlewares.use((req, res, next) => {
                      console.log(pc.cyan(`← rx: ${req.url}`));

                      res.on('finish', () => console.log(pc.yellow(`→ tx: ${req.url}`)));

                      next();
                    });
                  },
                },
              ]
            : []),
        ],
        resolve: {
          alias: {
            '@client': path.resolve(baseClientRoot),
            '@server': path.resolve(__dirname),
            '@shared': path.resolve(__dirname, '../shared'),
            ...alias,
          },
        },
        root: baseClientRoot,
        server: {
          middlewareMode: true,
          hmr: {
            port: 5174,
          },
        },
      });

      overrideCSSHMRConsoleError();

      app.addHook('onRequest', async (request, reply) => {
        await new Promise<void>((resolve) => {
          viteDevServer.middlewares(request.raw, reply.raw, () => {
            if (!reply.sent) resolve();
          });
        });
      });
    }

    app.get('/*', async (req, reply) => {
      try {
        // fastify/static wildcard: false and /* => checks for .assets here and routes 404
        if (/\.\w+$/.test(req.raw.url ?? '')) return reply.callNotFound();

        const url = req.url ? new URL(req.url, `http://${req.headers.host}`).pathname : '/';
        const matchedRoute = matchRoute(url, routes);

        if (!matchedRoute) {
          reply.callNotFound();
          return;
        }

        const { route, params } = matchedRoute;
        const { attr, appId } = route;

        const config = processedConfigs.find((config) => config.appId === appId) || processedConfigs[0];
        if (!config) throw new Error('No configuration found for the request.');

        const { clientRoot, entryServer } = config;

        let template = ensureNonNull(templates.get(clientRoot), `Template not found for clientRoot: ${clientRoot}`);

        const bootstrapModule = bootstrapModules.get(clientRoot);
        const cssLink = cssLinks.get(clientRoot);
        const manifest = manifests.get(clientRoot);
        const preloadLink = preloadLinks.get(clientRoot);
        const ssrManifest = ssrManifests.get(clientRoot);

        let renderModule: RenderModule;

        if (isDevelopment) {
          template = template.replace(/<script type="module" src="\/@vite\/client"><\/script>/g, '');
          template = template.replace(/<style type="text\/css">[\s\S]*?<\/style>/g, '');

          const entryServerPath = path.join(clientRoot, `${entryServer}.tsx`);
          const executedModule = await viteDevServer.ssrLoadModule(entryServerPath);
          renderModule = executedModule as RenderModule;

          const styles = await collectStyle(viteDevServer, [entryServerPath]);
          template = template?.replace('</head>', `<style type="text/css">${styles}</style></head>`);

          template = await viteDevServer.transformIndexHtml(url, template);
        } else {
          renderModule = renderModules.get(clientRoot) as RenderModule;

          if (!renderModule) {
            const renderModulePath = path.join(clientRoot, `${entryServer}.js`);
            const importedModule = await import(renderModulePath);

            renderModule = importedModule as RenderModule;
            renderModules.set(clientRoot, renderModule);
          }
        }

        const renderType = attr?.render || RENDERTYPE.ssr;
        const [beforeBody = '', afterBody = ''] = template.split(SSRTAG.ssrHtml);
        const [beforeHead = '', afterHead = ''] = beforeBody.split(SSRTAG.ssrHead);
        const initialDataPromise = fetchInitialData(attr, params, serviceRegistry);

        if (renderType === RENDERTYPE.ssr) {
          const { renderSSR } = renderModule;
          const initialDataResolved = await initialDataPromise;
          const initialDataScript = `<script>window.__INITIAL_DATA__ = ${JSON.stringify(initialDataResolved).replace(/</g, '\\u003c')}</script>`;
          const { headContent, appHtml } = await renderSSR(initialDataResolved as Record<string, unknown>, req.url!, attr?.meta);

          let aggregateHeadContent = headContent;

          if (ssrManifest && preloadLink) aggregateHeadContent += preloadLink;
          if (manifest && cssLink) aggregateHeadContent += cssLink;

          const fullHtml = template
            .replace(SSRTAG.ssrHead, aggregateHeadContent)
            .replace(SSRTAG.ssrHtml, `${appHtml}${initialDataScript}<script type="module" src="${bootstrapModule}" async=""></script>`);

          return reply.status(200).header('Content-Type', 'text/html').send(fullHtml);
        } else {
          const { renderStream } = renderModule;

          reply.raw.writeHead(200, { 'Content-Type': 'text/html' });

          renderStream(
            reply.raw,
            {
              onHead: (headContent: string) => {
                let aggregateHeadContent = headContent;

                if (ssrManifest && preloadLink) aggregateHeadContent += preloadLink;
                if (manifest && cssLink) aggregateHeadContent += cssLink;

                reply.raw.write(`${beforeHead}${aggregateHeadContent}${afterHead}`);
              },

              onFinish: async (initialDataResolved: unknown) => {
                reply.raw.write(`<script>window.__INITIAL_DATA__ = ${JSON.stringify(initialDataResolved).replace(/</g, '\\u003c')}</script>`);
                reply.raw.write(afterBody);
                reply.raw.end();
              },

              onError: (error: unknown) => {
                console.error('Critical rendering onError:', error);
                reply.raw.end('Internal Server Error');
              },
            },
            initialDataPromise,
            req.url!,
            bootstrapModule,
            attr?.meta,
          );
        }
      } catch (error) {
        console.error('Error setting up SSR stream:', error);

        if (!reply.raw.headersSent) reply.raw.writeHead(500, { 'Content-Type': 'text/plain' });

        reply.raw.end('Internal Server Error');
      }
    });

    app.setNotFoundHandler(async (req, reply) => {
      if (/\.\w+$/.test(req.raw.url ?? '')) return reply.callNotFound();

      try {
        const defaultConfig = processedConfigs[0];
        if (!defaultConfig) throw new Error('No default configuration found.');

        const { clientRoot } = defaultConfig;

        let template = ensureNonNull(templates.get(clientRoot), `Template not found for clientRoot: ${clientRoot}`);

        const cssLink = cssLinks.get(clientRoot);
        const bootstrapModule = bootstrapModules.get(clientRoot);

        template = template.replace(SSRTAG.ssrHead, '').replace(SSRTAG.ssrHtml, '');
        if (!isDevelopment && cssLink) template = template.replace('</head>', `${cssLink}</head>`);
        if (bootstrapModule) template = template.replace('</body>', `<script type="module" src="${bootstrapModule}" async=""></script></body>`);

        reply.status(200).type('text/html').send(template);
      } catch (error) {
        console.error('Failed to serve clientHtmlTemplate:', error);
        reply.status(500).send('Internal Server Error');
      }
    });
  },
  { name: 'taujs-ssr-server' },
);

export type Config = {
  appId: string;
  entryPoint: string;
  entryClient?: string;
  entryServer?: string;
  htmlTemplate?: string;
};

export type ProcessedConfig = {
  appId: string;
  clientRoot: string;
  entryClient: string;
  entryPoint: string;
  entryServer: string;
  htmlTemplate: string;
};

export type SSRServerOptions = {
  alias?: Record<string, string>;
  clientRoot: string;
  configs: Config[];
  routes: Route<RouteParams>[];
  serviceRegistry: ServiceRegistry;
  isDebug?: boolean;
};

export type ServiceRegistry = {
  [serviceName: string]: {
    [methodName: string]: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  };
};

export type RenderCallbacks = {
  onHead: (headContent: string) => void;
  onFinish: (initialDataResolved: unknown) => void;
  onError: (error: unknown) => void;
};

export type FetchConfig = {
  url?: string;
  options: RequestInit & { params?: Record<string, unknown> };
  serviceName?: string;
  serviceMethod?: string;
};

export type SSRManifest = {
  [key: string]: string[];
};

export type ManifestEntry = {
  file: string;
  src?: string;
  isDynamicEntry?: boolean;
  imports?: string[];
  css?: string[];
  assets?: string[];
};

export type Manifest = {
  [key: string]: ManifestEntry;
};

export type RenderSSR = (
  initialDataResolved: Record<string, unknown>,
  location: string,
  meta?: Record<string, unknown>,
) => Promise<{
  headContent: string;
  appHtml: string;
  initialDataScript: string;
}>;

export type RenderStream = (
  serverResponse: ServerResponse,
  callbacks: RenderCallbacks,
  initialDataPromise: Promise<Record<string, unknown>>,
  location: string,
  bootstrapModules?: string,
  meta?: Record<string, unknown>,
) => void;

export type RenderModule = {
  renderSSR: RenderSSR;
  renderStream: RenderStream;
};

export type RouteAttributes<Params = {}> = {
  fetch?: (params?: Params, options?: RequestInit & { params?: Record<string, unknown> }) => Promise<FetchConfig>;
} & (
  | {
      render?: typeof RENDERTYPE.ssr;
      meta?: Record<string, unknown>;
    }
  | {
      render: typeof RENDERTYPE.streaming;
      meta: Record<string, unknown>;
    }
);

export type Route<Params = {}> = {
  attr?: RouteAttributes<Params>;
  path: string;
  appId?: string;
};

export interface InitialRouteParams extends Record<string, unknown> {
  serviceName?: string;
  serviceMethod?: string;
}

export type RouteParams = InitialRouteParams & Record<string, unknown>;

export type RoutePathsAndAttributes<Params = {}> = Omit<Route<Params>, 'element'>;
