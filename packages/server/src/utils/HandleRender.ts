import path from 'node:path';

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ViteDevServer } from 'vite';

import { fetchInitialData, matchRoute } from './DataRoutes';
import { ensureNonNull, collectStyle } from './Templates';
import { isDevelopment } from './System';
import { RENDERTYPE, SSRTAG } from '../constants';

import type { RouteMatcher } from './DataRoutes';
import type { ServiceRegistry } from './DataServices';
import type { ProcessedConfig, RenderModule, Manifest, SSRManifest, PathToRegExpParams } from '../types';

export const handleRender = async (
  req: FastifyRequest,
  reply: FastifyReply,
  routeMatchers: RouteMatcher<PathToRegExpParams>[],
  processedConfigs: ProcessedConfig[],
  serviceRegistry: ServiceRegistry,
  maps: {
    bootstrapModules: Map<string, string>;
    cssLinks: Map<string, string>;
    manifests: Map<string, Manifest>;
    preloadLinks: Map<string, string>;
    renderModules: Map<string, RenderModule>;
    ssrManifests: Map<string, SSRManifest>;
    templates: Map<string, string>;
  },
  viteDevServer?: ViteDevServer,
) => {
  try {
    // fastify/static wildcard: false and /* => checks for .assets here and routes 404
    if (/\.\w+$/.test(req.raw.url ?? '')) return reply.callNotFound();

    const url = req.url ? new URL(req.url, `http://${req.headers.host}`).pathname : '/';
    const matchedRoute = matchRoute(url, routeMatchers);
    const cspNonce = req.cspNonce;

    if (!matchedRoute) {
      reply.callNotFound();
      return;
    }

    const { route, params } = matchedRoute;
    const { attr, appId } = route;

    const config = processedConfigs.find((config) => config.appId === appId) || processedConfigs[0];
    if (!config) throw new Error('No configuration found for the request.');

    const { clientRoot, entryServer } = config;

    let template = ensureNonNull(maps.templates.get(clientRoot), `Template not found for clientRoot: ${clientRoot}`);

    const bootstrapModule = maps.bootstrapModules.get(clientRoot);
    const cssLink = maps.cssLinks.get(clientRoot);
    const manifest = maps.manifests.get(clientRoot);
    const preloadLink = maps.preloadLinks.get(clientRoot);
    const ssrManifest = maps.ssrManifests.get(clientRoot);

    let renderModule: RenderModule;

    if (isDevelopment && viteDevServer) {
      template = template.replace(/<script type="module" src="\/@vite\/client"><\/script>/g, '');
      template = template.replace(/<style type="text\/css">[\s\S]*?<\/style>/g, '');

      const entryServerPath = path.join(clientRoot, `${entryServer}.tsx`);
      const executedModule = await viteDevServer.ssrLoadModule(entryServerPath);
      renderModule = executedModule as RenderModule;

      const styles = await collectStyle(viteDevServer, [entryServerPath]);
      template = template?.replace('</head>', `<style type="text/css">${styles}</style></head>`);

      template = await viteDevServer.transformIndexHtml(url, template);
    } else {
      renderModule = ensureNonNull(
        maps.renderModules.get(clientRoot),
        `Render module not found for clientRoot: ${clientRoot}. Module should have been preloaded.`,
      );
    }

    const renderType = attr?.render || RENDERTYPE.ssr;
    const [beforeBody = '', afterBody = ''] = template.split(SSRTAG.ssrHtml);
    const [beforeHead = '', afterHead = ''] = beforeBody.split(SSRTAG.ssrHead);
    const initialDataPromise = fetchInitialData(attr, params, serviceRegistry);

    if (renderType === RENDERTYPE.ssr) {
      const { renderSSR } = renderModule;
      const initialDataResolved = await initialDataPromise;
      const initialDataScript = `<script nonce="${cspNonce}">window.__INITIAL_DATA__ = ${JSON.stringify(initialDataResolved).replace(/</g, '\\u003c')}</script>`;
      const { headContent, appHtml } = await renderSSR(initialDataResolved as Record<string, unknown>, req.url!, attr?.meta);

      let aggregateHeadContent = headContent;

      if (ssrManifest && preloadLink) aggregateHeadContent += preloadLink;
      if (manifest && cssLink) aggregateHeadContent += cssLink;

      const shouldHydrate = attr?.hydrate !== false;
      const bootstrapScriptTag = shouldHydrate ? `<script nonce="${cspNonce}" type="module" src="${bootstrapModule}" defer></script>` : '';

      const fullHtml = template.replace(SSRTAG.ssrHead, aggregateHeadContent).replace(SSRTAG.ssrHtml, `${appHtml}${initialDataScript}${bootstrapScriptTag}`);

      return reply.status(200).header('Content-Type', 'text/html').send(fullHtml);
    } else {
      const { renderStream } = renderModule;
      const cspNonce = req.cspNonce;
      // we're using `raw` so we need to rewrite csp from Fastify lifecycle to raw!
      const cspHeader = reply.getHeader('Content-Security-Policy');

      reply.raw.writeHead(200, {
        'Content-Security-Policy': cspHeader,
        'Content-Type': 'text/html',
      });

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
            reply.raw.write(`<script nonce="${cspNonce}">window.__INITIAL_DATA__ = ${JSON.stringify(initialDataResolved).replace(/</g, '\\u003c')}</script>`);
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
        cspNonce,
      );
    }
  } catch (error) {
    console.error('Error setting up SSR stream:', error);

    if (!reply.raw.headersSent) reply.raw.writeHead(500, { 'Content-Type': 'text/plain' });

    reply.raw.end('Internal Server Error');
  }
};
