import path from 'node:path';
import { PassThrough } from 'node:stream';

import { fetchInitialData, matchRoute } from './DataRoutes';
import { Logger } from './Logger';
import { ServiceError } from './ServiceError';
import { isDevelopment } from './System';
import { ensureNonNull, collectStyle, processTemplate, rebuildTemplate } from './Templates';
import { RENDERTYPE } from '../constants';

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ViteDevServer } from 'vite';
import type { RouteMatcher } from './DataRoutes';
import type { ServiceRegistry } from './DataServices';
import type { DebugConfig, Logs } from './Logger';
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
  opts: {
    debug?: DebugConfig;
    logger?: Logs;
    viteDevServer?: ViteDevServer;
  } = {},
) => {
  const { viteDevServer } = opts;

  const baseLogger = opts.logger ?? new Logger();
  if (opts.debug !== undefined) baseLogger.configure(opts.debug);
  const requestId = (req.headers['x-request-id'] as string) || (req as any).id;
  const logger = baseLogger.child({ component: 'renderer', url: req.url, requestId });

  try {
    // fastify/static wildcard: false and /* => checks for .assets here and routes 404
    if (/\.\w+$/.test(req.raw.url ?? '')) return reply.callNotFound();

    const url = req.url ? new URL(req.url, `http://${req.headers.host}`).pathname : '/';
    const matchedRoute = matchRoute(url, routeMatchers);

    const rawNonce = (req as any).cspNonce as string | undefined | null;
    const cspNonce = rawNonce && rawNonce.length > 0 ? rawNonce : undefined;
    const nonceAttr = cspNonce ? ` nonce="${cspNonce}"` : '';

    if (!matchedRoute) {
      reply.callNotFound();
      return;
    }

    const { route, params } = matchedRoute;
    const { attr, appId } = route;

    const config = processedConfigs.find((c) => c.appId === appId) ?? processedConfigs[0];
    if (!config) {
      throw ServiceError.infra('No configuration found for the request', {
        details: {
          appId,
          availableAppIds: processedConfigs.map((c) => c.appId),
          url,
        },
      });
    }

    const { clientRoot, entryServer } = config;

    let template = ensureNonNull(maps.templates.get(clientRoot), `Template not found for clientRoot: ${clientRoot}`);

    const bootstrapModule = maps.bootstrapModules.get(clientRoot);
    const cssLink = maps.cssLinks.get(clientRoot);
    const manifest = maps.manifests.get(clientRoot);
    const preloadLink = maps.preloadLinks.get(clientRoot);
    const ssrManifest = maps.ssrManifests.get(clientRoot);

    let renderModule: RenderModule;

    if (isDevelopment && viteDevServer) {
      try {
        template = template.replace(/<script type="module" src="\/@vite\/client"><\/script>/g, '');
        template = template.replace(/<style type="text\/css">[\s\S]*?<\/style>/g, '');

        const entryServerPath = path.join(clientRoot, `${entryServer}.tsx`);
        const executedModule = await viteDevServer.ssrLoadModule(entryServerPath);
        renderModule = executedModule as RenderModule;

        const styles = await collectStyle(viteDevServer, [entryServerPath]);
        template = template?.replace('</head>', `<style type="text/css">${styles}</style></head>`);

        template = await viteDevServer.transformIndexHtml(url, template);
      } catch (error) {
        throw ServiceError.infra('Failed to load dev assets', {
          cause: error,
          details: { clientRoot, entryServer, url },
        });
      }
    } else {
      renderModule = maps.renderModules.get(clientRoot) as RenderModule;
      if (!renderModule) {
        throw ServiceError.infra(`Render module not found for clientRoot: ${clientRoot}. Module should have been preloaded.`);
      }
    }

    const renderType = attr?.render ?? RENDERTYPE.ssr;
    const templateParts = processTemplate(template);

    let initialDataInput: () => Promise<Record<string, unknown>>;
    try {
      initialDataInput = () => fetchInitialData(attr, params, serviceRegistry);
    } catch (err) {
      throw ServiceError.infra('Failed to build initial data input', {
        cause: err,
        details: { appId, url },
      });
    }

    if (renderType === RENDERTYPE.ssr) {
      const { renderSSR } = renderModule;
      if (!renderSSR) {
        throw ServiceError.infra('renderSSR function not found in module', {
          details: { clientRoot, availableFunctions: Object.keys(renderModule) },
        });
      }

      const initialDataResolved = await initialDataInput();
      const initialDataScript = `<script${nonceAttr}>window.__INITIAL_DATA__ = ${JSON.stringify(initialDataResolved).replace(/</g, '\\u003c')};</script>`;

      const { headContent, appHtml } = await renderSSR(initialDataResolved, req.url!, attr?.meta);

      let aggregateHeadContent = headContent;
      if (ssrManifest && preloadLink) aggregateHeadContent += preloadLink;
      if (manifest && cssLink) aggregateHeadContent += cssLink;

      const shouldHydrate = attr?.hydrate !== false;
      const bootstrapScriptTag = shouldHydrate && bootstrapModule ? `<script nonce="${cspNonce}" type="module" src="${bootstrapModule}" defer></script>` : '';

      const safeAppHtml = appHtml.trim();
      const fullHtml = rebuildTemplate(templateParts, aggregateHeadContent, `${safeAppHtml}${initialDataScript}${bootstrapScriptTag}`);

      return reply.status(200).header('Content-Type', 'text/html').send(fullHtml);
    } else {
      const { renderStream } = renderModule;
      if (!renderStream) {
        throw ServiceError.infra('renderStream function not found in module', {
          details: { clientRoot, availableFunctions: Object.keys(renderModule) },
        });
      }

      const cspHeader = reply.getHeader('Content-Security-Policy');
      reply.raw.writeHead(200, {
        'Content-Security-Policy': cspHeader,
        'Content-Type': 'text/html; charset=utf-8',
      });

      const ac = new AbortController();
      const onAborted = () => ac.abort();

      req.raw.on('aborted', onAborted);
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) ac.abort();
      });
      reply.raw.on('finish', () => req.raw.off('aborted', onAborted));

      const shouldHydrate = attr?.hydrate !== false;
      const abortedState = { aborted: false };

      const isBenignSocketAbort = (e: unknown) => {
        const msg = String((e as any)?.message ?? e ?? '');
        return /ECONNRESET|EPIPE|socket hang up|aborted|premature/i.test(msg);
      };

      const writable = new PassThrough();
      writable.on('error', (err) => {
        if (!isBenignSocketAbort(err)) logger.error('PassThrough error:', { error: err });
      });
      reply.raw.on('error', (err) => {
        if (!isBenignSocketAbort(err)) logger.error('HTTP socket error:', { error: err });
      });
      writable.pipe(reply.raw, { end: false });

      let finalData: unknown = undefined;

      renderStream(
        writable,
        {
          onHead: (headContent: string) => {
            let aggregateHeadContent = headContent;
            if (ssrManifest && preloadLink) aggregateHeadContent += preloadLink;
            if (manifest && cssLink) aggregateHeadContent += cssLink;
            reply.raw.write(`${templateParts.beforeHead}${aggregateHeadContent}${templateParts.afterHead}${templateParts.beforeBody}`);
          },
          onShellReady: () => {},
          onAllReady: (data: unknown) => {
            if (!abortedState.aborted) finalData = data;
          },
          onError: (err) => {
            if (abortedState.aborted || isBenignSocketAbort(err)) {
              logger.warn('Client disconnected before stream finished');
              try {
                if (!reply.raw.writableEnded) reply.raw.destroy();
              } catch {}
              return;
            }
            throw ServiceError.infra('Critical rendering onError', {
              cause: err,
              details: { clientRoot },
            });
          },
        },
        initialDataInput,
        req.url!,
        shouldHydrate ? bootstrapModule : undefined,
        attr?.meta,
        cspNonce,
        ac.signal,
      );

      writable.on('finish', () => {
        if (abortedState.aborted || reply.raw.writableEnded) return;

        const data = finalData ?? {};
        const initialDataScript = `<script${nonceAttr}>window.__INITIAL_DATA__ = ${JSON.stringify(data).replace(
          /</g,
          '\\u003c',
        )}; window.dispatchEvent(new Event('taujs:data-ready'));</script>`;

        reply.raw.write(initialDataScript);
        reply.raw.write(templateParts.afterBody);
        reply.raw.end();
      });
    }
  } catch (err) {
    // Surface a normalized infra error up to Fastify error handler
    throw ServiceError.infra('handleRender failed', {
      cause: err,
      details: {
        url: req.url,
        headers: req.headers,
        route: (req as any).routeOptions?.url,
      },
    });
  }
};
