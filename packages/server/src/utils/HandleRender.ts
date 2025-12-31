import path from 'node:path';
import { PassThrough } from 'node:stream';

import { ensureNonNull, collectStyle, processTemplate, rebuildTemplate } from '../core/assets/Templates';
import { AppError, normaliseError, toReason } from '../core/errors/AppError';
import { fetchInitialData, matchRoute } from '../core/routes/DataRoutes';
import { isDevelopment } from '../core/system/System';
import { createRequestContext } from '../core/telemetry/Telemetry';
import { REGEX, RENDERTYPE } from '../constants';
import { createLogger } from '../logging/Logger';

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ViteDevServer } from 'vite';
import type { RouteMatcher } from '../core/routes/DataRoutes';
import type { ServiceRegistry } from '../core/services/DataServices';
import type { DebugConfig, Logs } from '../core/logging/types';
import type { ProcessedConfig, RenderModule, Manifest, SSRManifest, PathToRegExpParams } from '../core/config/types';

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
    const routeContext = {
      appId,
      path: route.path,
      attr,
      params,
    };

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

    const { clientRoot, entryServerFile } = config;

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

        const entryServerPath = path.join(clientRoot, entryServerFile);
        const executedModule = await viteDevServer.ssrLoadModule(entryServerPath);
        renderModule = executedModule as RenderModule;

        const styles = await collectStyle(viteDevServer, [entryServerPath]);
        const styleNonce = cspNonce ? ` nonce="${cspNonce}"` : '';
        template = template?.replace('</head>', `<style type="text/css"${styleNonce}>${styles}</style></head>`);

        template = await viteDevServer.transformIndexHtml(url, template);
      } catch (error) {
        throw AppError.internal('Failed to load dev assets', { cause: error, details: { clientRoot, entryServerFile, url } });
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
        throw AppError.internal(
          'ssr',
          {
            details: { clientRoot, availableFunctions: Object.keys(renderModule) },
          },
          'renderSSR function not found in module',
        );
      }

      logger.debug?.('ssr', {}, 'ssr requested');

      const ac = new AbortController();
      const onAborted = () => ac.abort('client_aborted');

      req.raw.on('aborted', onAborted);
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) ac.abort('socket_closed');
      });
      reply.raw.on('finish', () => req.raw.off('aborted', onAborted));

      if (ac.signal.aborted) {
        logger.warn({ url: req.url }, 'SSR skipped; already aborted');
        return;
      }

      const initialDataResolved = await initialDataInput();

      let headContent = '';
      let appHtml = '';
      try {
        const res = await renderSSR(initialDataResolved, req.url!, attr?.meta, ac.signal, { logger: reqLogger, routeContext });
        headContent = res.headContent;
        appHtml = res.appHtml;

        logger.debug?.('ssr', {}, 'ssr data resolved');

        if (ac.signal.aborted) {
          logger.warn({}, 'SSR completed but client disconnected');
          return;
        }
      } catch (err) {
        const msg = String((err as any)?.message ?? err ?? '');
        const benign = REGEX.BENIGN_NET_ERR.test(msg);

        if (ac.signal.aborted || benign) {
          logger.warn(
            {
              url: req.url,
              reason: msg,
            },
            'SSR aborted mid-render (benign)',
          );
          return;
        }

        logger.error(
          {
            url: req.url,
            error: normaliseError(err),
          },
          'SSR render failed',
        );
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

      logger.debug?.('ssr', {}, 'ssr template rebuilt and sending response');

      try {
        return reply.status(200).header('Content-Type', 'text/html').send(fullHtml);
      } catch (err) {
        const msg = String((err as any)?.message ?? err ?? '');
        const benign = REGEX.BENIGN_NET_ERR.test(msg);

        if (!benign) logger.error({ url: req.url, error: normaliseError(err) }, 'SSR send failed');
        else logger.warn({ url: req.url, reason: msg }, 'SSR send aborted (benign)');

        return;
      }
    } else {
      const { renderStream } = renderModule;
      if (!renderStream) {
        throw AppError.internal('renderStream function not found in module', {
          details: { clientRoot, availableFunctions: Object.keys(renderModule) },
        });
      }

      const headers = reply.getHeaders(); // includes x-trace-id from createRequestContext
      headers['Content-Type'] = 'text/html; charset=utf-8';
      const cspHeader = reply.getHeader('Content-Security-Policy');
      if (cspHeader) headers['Content-Security-Policy'] = cspHeader as any;

      reply.raw.writeHead(200, headers as any);

      const abortedState = { aborted: false };
      const ac = new AbortController();

      const onAborted = () => {
        if (!abortedState.aborted) {
          logger.warn({}, 'Client disconnected before stream finished');
          abortedState.aborted = true;
        }
        ac.abort();
      };

      req.raw.on('aborted', onAborted);
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) {
          if (!abortedState.aborted) {
            logger.warn({}, 'Client disconnected before stream finished');
            abortedState.aborted = true;
          }
          ac.abort();
        }
      });

      reply.raw.on('finish', () => {
        req.raw.off('aborted', onAborted);
      });

      const shouldHydrate = attr?.hydrate !== false;

      const isBenignSocketAbort = (e: unknown) => {
        const msg = String((e as any)?.message ?? e ?? '');
        return REGEX.BENIGN_NET_ERR.test(msg);
      };

      const writable = new PassThrough();
      writable.on('error', (err) => {
        if (!isBenignSocketAbort(err)) logger.error({ error: err }, 'PassThrough error:');
      });

      reply.raw.on('error', (err) => {
        if (!isBenignSocketAbort(err)) logger.error({ error: err }, 'HTTP socket error:');
      });

      let finalData: unknown = undefined;
      let pipedToReply = false;

      renderStream(
        writable,
        {
          onHead: (headContent: string) => {
            let aggregateHeadContent = headContent;
            if (ssrManifest && preloadLink) aggregateHeadContent += preloadLink;
            if (manifest && cssLink) aggregateHeadContent += cssLink;

            reply.raw.write(`${templateParts.beforeHead}${aggregateHeadContent}${templateParts.afterHead}${templateParts.beforeBody}`);

            if (!pipedToReply) {
              pipedToReply = true;
              writable.pipe(reply.raw, { end: false });
            }
          },
          onShellReady: () => {},
          onAllReady: (data: unknown) => {
            if (!abortedState.aborted) finalData = data;
          },
          onError: (err: unknown) => {
            if (abortedState.aborted || isBenignSocketAbort(err)) {
              logger.warn({}, 'Client disconnected before stream finished');
              try {
                if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.destroy();
              } catch (e) {
                logger.debug?.('ssr', { error: normaliseError(e) }, 'stream teardown: destroy() failed');
              }
              return;
            }

            abortedState.aborted = true;

            logger.error(
              {
                error: normaliseError(err),
                clientRoot,
                url: req.url,
              },
              'Critical rendering error during stream',
            );

            try {
              ac?.abort?.();
            } catch (e) {
              logger.debug?.('ssr', { error: normaliseError(e) }, 'stream teardown: abort() failed');
            }

            const reason = toReason(err);

            try {
              if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.destroy(reason);
            } catch (e) {
              logger.debug?.('ssr', { error: normaliseError(e) }, 'stream teardown: destroy() failed');
            }
          },
        },
        initialDataInput,
        req.url!,
        shouldHydrate ? bootstrapModule : undefined,
        attr?.meta,
        cspNonce,
        ac.signal,
        { logger: reqLogger, routeContext },
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
