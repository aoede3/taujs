import path from 'node:path';
import { PassThrough } from 'node:stream';

import { fetchInitialData, matchRoute } from './DataRoutes';
import { AppError, normaliseError, toReason } from '../logging/AppError';
import { createLogger } from '../logging/Logger';
import { isDevelopment } from './System';
import { createRequestContext } from './Telemetry';
import { ensureNonNull, collectStyle, processTemplate, rebuildTemplate } from './Templates';
import { REGEX, RENDERTYPE } from '../constants';

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ViteDevServer } from 'vite';
import type { RouteMatcher } from './DataRoutes';
import type { ServiceRegistry } from './DataServices';
import type { DebugConfig, Logs } from '../logging/Logger';
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

  const logger =
    (opts.logger as any) ??
    createLogger({
      debug: opts.debug,
      minLevel: isDevelopment ? 'debug' : 'info',
      includeContext: true,
      includeStack: (lvl) => lvl === 'error' || isDevelopment,
    });

  try {
    // fastify/static wildcard: false and /* => checks for .assets here and routes 404
    if (/\.\w+$/.test(req.raw.url ?? '')) return reply.callNotFound();

    const url = req.url ? new URL(req.url, `http://${req.headers.host}`).pathname : '/';
    const matchedRoute = matchRoute(url, routeMatchers);

    const rawNonce = (req as any).cspNonce as string | undefined | null;
    const cspNonce = rawNonce && rawNonce.length > 0 ? rawNonce : undefined;

    if (!matchedRoute) {
      reply.callNotFound();
      return;
    }

    const { route, params } = matchedRoute;
    const { attr, appId } = route;

    const config = processedConfigs.find((c) => c.appId === appId);
    if (!config) {
      throw AppError.internal('No configuration found for the request', {
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
        const styleNonce = cspNonce ? ` nonce="${cspNonce}"` : '';
        template = template?.replace('</head>', `<style type="text/css"${styleNonce}>${styles}</style></head>`);

        template = await viteDevServer.transformIndexHtml(url, template);
      } catch (error) {
        throw AppError.internal('Failed to load dev assets', { cause: error, details: { clientRoot, entryServer, url } });
      }
    } else {
      renderModule = maps.renderModules.get(clientRoot) as RenderModule;
      if (!renderModule) throw AppError.internal(`Render module not found for clientRoot: ${clientRoot}. Module should have been preloaded.`);
    }

    const renderType = attr?.render ?? RENDERTYPE.ssr;
    const templateParts = processTemplate(template);

    const baseLogger = (opts.logger ?? logger) as Logs;
    const { traceId, logger: reqLogger, headers } = createRequestContext(req, reply, baseLogger);
    const ctx = { traceId, logger: reqLogger, headers };
    const initialDataInput = () => fetchInitialData(attr, params, serviceRegistry, ctx);

    if (renderType === RENDERTYPE.ssr) {
      const { renderSSR } = renderModule;
      if (!renderSSR) {
        throw AppError.internal('renderSSR function not found in module', {
          details: { clientRoot, availableFunctions: Object.keys(renderModule) },
        });
      }

      const ac = new AbortController();
      const onAborted = () => ac.abort('client_aborted');

      req.raw.on('aborted', onAborted);
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) ac.abort('socket_closed');
      });
      reply.raw.on('finish', () => req.raw.off('aborted', onAborted));

      if (ac.signal.aborted) {
        logger.warn('SSR skipped; already aborted', { url: req.url });
        return;
      }

      const initialDataResolved = await initialDataInput();

      let headContent = '';
      let appHtml = '';
      try {
        const res = await renderSSR(initialDataResolved, req.url!, attr?.meta, ac.signal, { logger: reqLogger });
        headContent = res.headContent;
        appHtml = res.appHtml;
      } catch (err) {
        const msg = String((err as any)?.message ?? err ?? '');
        const benign = REGEX.BENIGN_NET_ERR.test(msg);

        if (ac.signal.aborted || benign) {
          logger.warn('SSR aborted mid-render (benign)', { url: req.url, reason: msg });
          return;
        }

        logger.error('SSR render failed', { url: req.url, error: normaliseError(err) });
        throw err;
      }

      let aggregateHeadContent = headContent;
      if (ssrManifest && preloadLink) aggregateHeadContent += preloadLink;
      if (manifest && cssLink) aggregateHeadContent += cssLink;

      const shouldHydrate = attr?.hydrate !== false;
      const nonceAttr = cspNonce ? ` nonce="${cspNonce}"` : '';
      const initialDataScript = `<script${nonceAttr}>window.__INITIAL_DATA__ = ${JSON.stringify(initialDataResolved).replace(/</g, '\\u003c')};</script>`;

      const bootstrapScriptTag = shouldHydrate && bootstrapModule ? `<script${nonceAttr} type="module" src="${bootstrapModule}" defer></script>` : '';

      const safeAppHtml = appHtml.trim();
      const fullHtml = rebuildTemplate(templateParts, aggregateHeadContent, `${safeAppHtml}${initialDataScript}${bootstrapScriptTag}`);

      try {
        return reply.status(200).header('Content-Type', 'text/html').send(fullHtml);
      } catch (err) {
        const msg = String((err as any)?.message ?? err ?? '');
        const benign = REGEX.BENIGN_NET_ERR.test(msg);

        if (!benign) logger.error('SSR send failed', { url: req.url, error: normaliseError(err) });
        else logger.warn('SSR send aborted (benign)', { url: req.url, reason: msg });

        return;
      }
    } else {
      const { renderStream } = renderModule;
      if (!renderStream) {
        throw AppError.internal('renderStream function not found in module', {
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
        return REGEX.BENIGN_NET_ERR.test(msg);
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
            return reply.raw.write(`${templateParts.beforeHead}${aggregateHeadContent}${templateParts.afterHead}${templateParts.beforeBody}`);
          },
          onShellReady: () => {},
          onAllReady: (data: unknown) => {
            if (!abortedState.aborted) finalData = data;
          },
          onError: (err: unknown) => {
            if (abortedState.aborted || isBenignSocketAbort(err)) {
              logger.warn('Client disconnected before stream finished');
              try {
                if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.destroy();
              } catch (e) {
                logger.debug?.('stream teardown: destroy() failed', { error: normaliseError(e) });
              }
              return;
            }

            abortedState.aborted = true;

            logger.error('Critical rendering error during stream', {
              error: normaliseError(err),
              clientRoot,
              url: req.url,
            });

            try {
              ac?.abort?.();
            } catch (e) {
              logger.debug?.('stream teardown: abort() failed', { error: normaliseError(e) });
            }

            const reason = toReason(err);

            try {
              if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.destroy(reason);
            } catch (e) {
              logger.debug?.('stream teardown: destroy() failed', { error: normaliseError(e) });
            }
          },
        },
        initialDataInput,
        req.url!,
        shouldHydrate ? bootstrapModule : undefined,
        attr?.meta,
        cspNonce,
        ac.signal,
        { logger: reqLogger },
      );

      writable.on('finish', () => {
        if (abortedState.aborted || reply.raw.writableEnded) return;

        const data = finalData ?? {};
        const initialDataScript = `<script${cspNonce ? ` nonce="${cspNonce}"` : ''}>window.__INITIAL_DATA__ = ${JSON.stringify(data).replace(
          /</g,
          '\\u003c',
        )}; window.dispatchEvent(new Event('taujs:data-ready'));</script>`;

        reply.raw.write(initialDataScript);
        reply.raw.write(templateParts.afterBody);
        reply.raw.end();
      });
    }
  } catch (err) {
    if (err instanceof AppError) throw err;

    throw AppError.internal('handleRender failed', err, {
      url: req.url,
      route: (req as any).routeOptions?.url,
    });
  }
};
