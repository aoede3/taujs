import fs from 'node:fs/promises';
import path from 'node:path';

import fp from 'fastify-plugin';
import { createViteRuntime } from 'vite';

import {
  __dirname,
  callServiceMethod,
  collectStyle,
  fetchData,
  fetchInitialData,
  getCssLinks,
  isDevelopment,
  matchRoute,
  overrideCSSHMRConsoleError,
  renderPreloadLinks,
} from './utils';

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ViteDevServer } from 'vite';
import type { ViteRuntime } from 'vite/runtime';
import type { ServerResponse } from 'node:http';

export const SSRServer: FastifyPluginAsync<SSRServerOptions> = fp(
  async (app: FastifyInstance, opts: SSRServerOptions) => {
    const { alias, clientRoot, clientHtmlTemplate, clientEntryClient, clientEntryServer, routes, serviceRegistry, isDebug } = opts;
    const templateHtmlPath = path.join(clientRoot, clientHtmlTemplate);
    const templateHtml = !isDevelopment ? await fs.readFile(templateHtmlPath, 'utf-8') : await fs.readFile(path.join(clientRoot, clientHtmlTemplate), 'utf-8');
    const ssrManifestPath = path.join(clientRoot, '.vite/ssr-manifest.json');
    const ssrManifest = !isDevelopment ? JSON.parse(await fs.readFile(ssrManifestPath, 'utf-8')) : undefined;
    const manifestPath = path.join(clientRoot, '.vite/manifest.json');
    const manifest = !isDevelopment ? JSON.parse(await fs.readFile(manifestPath, 'utf-8')) : undefined;
    const bootstrapModules = isDevelopment ? `/${clientEntryClient}.tsx` : `/${manifest[`${clientEntryClient}.tsx`].file}`;
    const preloadLinks = !isDevelopment ? renderPreloadLinks(Object.keys(ssrManifest), ssrManifest) : undefined;
    const cssLinks = !isDevelopment ? getCssLinks(manifest) : undefined;

    let renderModule: RenderModule;
    let styles: string;
    let template = templateHtml;
    let viteDevServer: ViteDevServer;
    let viteRuntime: ViteRuntime;

    if (isDevelopment) {
      const { createServer } = await import('vite');

      viteDevServer = await createServer({
        appType: 'custom',
        mode: 'development',
        plugins: [
          ...(isDebug
            ? [
                {
                  name: 'taujs-ssr-server-debug-logging',
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

      void (await app.register(import('@fastify/static'), {
        index: false,
        root: path.resolve(clientRoot),
        wildcard: false,
      }));
    }

    void app.get('/*', async (req, reply) => {
      try {
        const url = req.url ? new URL(req.url, `http://${req.headers.host}`).pathname : '/';
        const matchedRoute = matchRoute(url, routes);

        if (!matchedRoute) {
          reply.callNotFound();

          return;
        }

        if (isDevelopment) {
          template = await viteDevServer.transformIndexHtml(url, template);
          renderModule = await viteRuntime.executeEntrypoint(path.join(clientRoot, `${clientEntryServer}.tsx`));
          styles = await collectStyle(viteDevServer, [`${clientRoot}/${clientEntryServer}.tsx`]);
          template = template.replace('</head>', `<style type="text/css">${styles}</style></head>`);
        }

        const { streamRender } = renderModule;
        const { route, params } = matchedRoute;
        const { attributes } = route;
        const [beforeBody = '', afterBody] = template.split('<!--ssr-html-->');
        const [beforeHead, afterHead] = beforeBody.split('<!--ssr-head-->');
        const initialDataPromise = fetchInitialData(attributes, params, serviceRegistry);

        reply.raw.writeHead(200, { 'Content-Type': 'text/html' });
        reply.raw.write(beforeHead);

        streamRender(
          reply.raw,
          {
            onHead: (headContent: string) => {
              let fullHeadContent = headContent;

              if (ssrManifest) fullHeadContent += preloadLinks;
              if (manifest) fullHeadContent += cssLinks;

              reply.raw.write(`${fullHeadContent}${afterHead}`);
            },

            onFinish: async (initialDataResolved: unknown) => {
              reply.raw.write(`<script>window.__INITIAL_DATA__ = ${JSON.stringify(initialDataResolved).replace(/</g, '\\u003c')}</script>`);
              reply.raw.write(afterBody);
              reply.raw.end();
            },

            onError: (error: unknown) => {
              console.error('Critical rendering error:', error);

              if (!reply.raw.headersSent) reply.raw.writeHead(500, { 'Content-Type': 'text/plain' });

              reply.raw.end('Internal Server Error');
            },
          },
          initialDataPromise,
          bootstrapModules,
        );
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

        template = template.replace('<!--ssr-head-->', '').replace('<!--ssr-html-->', '');
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
  options: RequestInit & { params?: any };
  serviceName?: string;
  serviceMethod?: string;
};

export type SSRServerOptions = {
  alias: Record<string, string>;
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

export type RenderModule = {
  streamRender: (
    serverResponse: ServerResponse,
    callbacks: RenderCallbacks,
    initialDataPromise: Promise<Record<string, unknown>>,
    bootstrapModules: string,
  ) => void;
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
};

export type Route<Params = {}> = {
  attributes?: RouteAttributes<Params>;
  path: string;
};

export interface InitialRouteParams extends Record<string, unknown> {
  serviceName?: string;
  serviceMethod?: string;
}

export type RouteParams = InitialRouteParams & Record<string, unknown>;

export type RoutePathsAndAttributes<Params = {}> = Omit<Route<Params>, 'element'>;
