import { readFile } from 'node:fs/promises';
import path from 'node:path';

import fp from 'fastify-plugin';
import { createViteRuntime } from 'vite';

import { __dirname, collectStyle, fetchInitialData, getCssLinks, isDevelopment, matchRoute, overrideCSSHMRConsoleError, renderPreloadLinks } from './utils';
import { RENDERTYPE, SSRTAG } from './constants';

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ViteDevServer } from 'vite';
import type { ViteRuntime } from 'vite/runtime';
import type { ServerResponse } from 'node:http';

export const SSRServer: FastifyPluginAsync<SSRServerOptions> = fp(
  async (app: FastifyInstance, opts: SSRServerOptions) => {
    const { alias, clientRoot, clientHtmlTemplate, clientEntryClient, clientEntryServer, routes, serviceRegistry, isDebug } = opts;
    const templateHtmlPath = path.join(clientRoot, clientHtmlTemplate);
    const templateHtml = !isDevelopment ? await readFile(templateHtmlPath, 'utf-8') : await readFile(path.join(clientRoot, clientHtmlTemplate), 'utf-8');
    const ssrManifestPath = path.join(clientRoot, '.vite/ssr-manifest.json');
    const ssrManifest = !isDevelopment ? JSON.parse(await readFile(ssrManifestPath, 'utf-8')) : undefined;
    const manifestPath = path.join(clientRoot, '.vite/manifest.json');
    const manifest = !isDevelopment ? JSON.parse(await readFile(manifestPath, 'utf-8')) : undefined;
    const bootstrapModules = isDevelopment ? `/${clientEntryClient}.tsx` : `/${manifest[`${clientEntryClient}.tsx`]?.file}`;
    const preloadLinks = !isDevelopment ? renderPreloadLinks(Object.keys(ssrManifest), ssrManifest) : undefined;
    const cssLinks = !isDevelopment ? getCssLinks(manifest) : undefined;

    let renderModule: RenderModule;
    let styles: string;
    let template = templateHtml;
    let viteDevServer: ViteDevServer;
    let viteRuntime: ViteRuntime;

    void (await app.register(import('@fastify/static'), {
      index: false,
      prefix: '/',
      root: clientRoot,
      wildcard: false,
    }));

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
                  configureServer(server: ViteDevServer) {
                    console.log('τjs debug ssr server started.');

                    server.middlewares.use((req, res, next) => {
                      console.log(`rx: ${req.url}`);
                      res.on('finish', () => {
                        console.log(`cx: ${req.url}`);
                      });

                      next();
                    });
                  },
                  name: 'taujs-ssr-server-debug-logging',
                },
              ]
            : []),
        ],
        resolve: {
          alias: {
            ...{
              '@client': path.resolve(clientRoot),
              '@server': path.resolve(__dirname),
              '@shared': path.resolve(__dirname, '../shared'),
            },
            ...alias,
          },
        },
        root: clientRoot,
        server: {
          middlewareMode: true,
          hmr: {
            port: 5174,
          },
        },
      });

      viteRuntime = await createViteRuntime(viteDevServer);
      overrideCSSHMRConsoleError();

      void app.addHook('onRequest', async (request, reply) => {
        await new Promise<void>((resolve) => {
          viteDevServer.middlewares(request.raw, reply.raw, () => {
            if (!reply.sent) resolve();
          });
        });
      });
    } else {
      renderModule = await import(path.join(clientRoot, `${clientEntryServer}.js`));
    }

    void app.get('/*', async (req, reply) => {
      try {
        // fastify/static wildcard: false and /* => checks for .assets here and routes 404
        if (/\.\w+$/.test(req.raw.url ?? '')) return reply.callNotFound();

        const url = req.url ? new URL(req.url, `http://${req.headers.host}`).pathname : '/';
        const matchedRoute = matchRoute(url, routes);

        if (!matchedRoute) {
          reply.callNotFound();

          return;
        }

        if (isDevelopment) {
          template = template.replace(/<script type="module" src="\/@vite\/client"><\/script>/g, '');
          template = template.replace(/<style type="text\/css">[\s\S]*?<\/style>/g, '');

          renderModule = await viteRuntime.executeEntrypoint(path.join(clientRoot, `${clientEntryServer}.tsx`));

          styles = await collectStyle(viteDevServer, [`${clientRoot}/${clientEntryServer}.tsx`]);
          template = template.replace('</head>', `<style type="text/css">${styles}</style></head>`);

          template = await viteDevServer.transformIndexHtml(url, template);
        }

        const { route, params } = matchedRoute;
        const { attr } = route;
        const renderType = attr?.render || RENDERTYPE.streaming;
        const [beforeBody = '', afterBody] = template.split(SSRTAG.ssrHtml);
        const [beforeHead, afterHead] = beforeBody.split(SSRTAG.ssrHead);
        const initialDataPromise = fetchInitialData(attr, params, serviceRegistry);

        if (renderType === RENDERTYPE.ssr) {
          const { renderSSR } = renderModule;
          const initialDataResolved = await initialDataPromise;
          const initialDataScript = `<script>window.__INITIAL_DATA__ = ${JSON.stringify(initialDataResolved).replace(/</g, '\\u003c')}</script>`;
          const { headContent, appHtml } = await renderSSR(initialDataResolved, req.url, attr?.meta);

          const fullHtml = template
            .replace(SSRTAG.ssrHead, headContent)
            .replace(SSRTAG.ssrHtml, `${appHtml}${initialDataScript}<script type="module" src="${bootstrapModules}" async=""></script>`);

          return reply.status(200).header('Content-Type', 'text/html').send(fullHtml);
        } else {
          const { renderStream } = renderModule;

          reply.raw.writeHead(200, { 'Content-Type': 'text/html' });

          renderStream(
            reply.raw,
            {
              onHead: (headContent: string) => {
                let aggregateHeadContent = headContent;

                if (ssrManifest) aggregateHeadContent += preloadLinks;
                if (manifest) aggregateHeadContent += cssLinks;

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
            req.url,
            bootstrapModules,
            attr?.meta,
          );
        }
      } catch (error) {
        console.error('Error setting up SSR stream:', error);

        if (!reply.raw.headersSent) reply.raw.writeHead(500, { 'Content-Type': 'text/plain' });

        reply.raw.end('Internal Server Error');
      }
    });

    void app.setNotFoundHandler(async (req, reply) => {
      if (/\.\w+$/.test(req.raw.url ?? '')) return reply.callNotFound();

      try {
        let template = templateHtml;

        template = template.replace(SSRTAG.ssrHead, '').replace(SSRTAG.ssrHtml, '');
        if (!isDevelopment) template = template.replace('</head>', `${getCssLinks(manifest)}</head>`);
        template = template.replace('</body>', `<script type="module" src="${bootstrapModules}" async=""></script></body>`);

        reply.status(200).type('text/html').send(template);
      } catch (error) {
        console.error('Failed to serve clientHtmlTemplate:', error);
        reply.status(500).send('Internal Server Error');
      }
    });
  },
  { name: 'taujs-ssr-server' },
);

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

export type SSRServerOptions = {
  alias?: Record<string, string>;
  clientRoot: string;
  clientHtmlTemplate: string;
  clientEntryClient: string;
  clientEntryServer: string;
  routes: Route<RouteParams>[];
  serviceRegistry: ServiceRegistry;
  isDebug?: boolean;
};

export type Manifest = {
  [key: string]: {
    file: string;
    src?: string;
    isDynamicEntry?: boolean;
    imports?: string[];
    css?: string[];
    assets?: string[];
  };
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
  fetch: (
    params?: Params,
    options?: RequestInit & { params?: Record<string, unknown> },
  ) => Promise<{
    options: RequestInit & { params?: Record<string, unknown> };
    serviceName?: string;
    serviceMethod?: string;
    url?: string;
  }>;
  meta?: Record<string, unknown>;
  render?: typeof RENDERTYPE.ssr | typeof RENDERTYPE.streaming;
};

export type Route<Params = {}> = {
  attr?: RouteAttributes<Params>;
  path: string;
};

export interface InitialRouteParams extends Record<string, unknown> {
  serviceName?: string;
  serviceMethod?: string;
}

export type RouteParams = InitialRouteParams & Record<string, unknown>;

export type RoutePathsAndAttributes<Params = {}> = Omit<Route<Params>, 'element'>;
