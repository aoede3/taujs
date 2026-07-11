import path from 'node:path';
import { PassThrough } from 'node:stream';

import { RENDERTYPE } from '../core/constants';
import { AppError, normaliseError, toReason } from '../core/errors/AppError';
import { fetchInitialData, matchRoute } from '../core/routes/DataRoutes';
import { now } from '../core/telemetry/Telemetry';
import { resolveEntryFile } from '../Build';
import { createLogger } from '../logging/Logger';
import { isDevelopment } from '../System';
import { createRequestContext, getRequestContext } from './Telemetry';
import {
  ensureNonNull,
  buildTaujsDevStamp,
  collectStyle,
  processTemplate,
  rebuildTemplate,
  addNonceToInlineScripts,
  extractHeadInner,
  stripDevClientAndStyles,
  applyViteTransform,
} from './Templates';
import { serializeInlineData } from './InlineData';

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ViteDevServer } from 'vite';
import type { PathToRegExpParams } from '../core/config/types';
import type { DebugConfig, Logs } from '../core/logging/types';
import type { RouteMatcher } from '../core/routes/DataRoutes';
import type { ServiceRegistry } from '../core/services/DataServices';
import type { Manifest, ProcessedConfig, RenderModule, SSRManifest } from '../types';
import { handleNotFound } from './HandleNotFound';

// R0-02: origin-aware benign classification, textually parallel to `isBenignStreamErr` in
// packages/react/src/utils/Streaming.ts (the server does not import renderer utils). A
// socket/writable-origin error is a benign client disconnect iff its code/name/exact message
// says so; render/data-origin errors are never benign by shape — an app error whose message
// merely contains "aborted" must not be swallowed as a disconnect.
const BENIGN_SOCKET_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED']);
const BENIGN_SOCKET_MESSAGES = new Set(['aborted', 'socket hang up', 'premature close', 'request aborted']);

const isBenignSocketError = (err: unknown): boolean => {
  const e = err as { code?: unknown; name?: unknown; message?: unknown } | null | undefined;
  if (typeof e?.code === 'string' && BENIGN_SOCKET_CODES.has(e.code)) return true;
  if (e?.name === 'AbortError') return true;

  return BENIGN_SOCKET_MESSAGES.has(
    String(e?.message ?? '')
      .trim()
      .toLowerCase(),
  );
};

// Recheck: the streaming render `onError` callback runs on a stream tick with a possibly-HOSTILE
// `unknown` — a component may throw an object with a throwing `message` getter / `Symbol.toPrimitive`,
// or a proxy with a throwing brand getter. These helpers extract telemetry WITHOUT ever throwing so
// that formatting a fatal error can never veto the response teardown (500 / socket destroy).
const safeStringify = (value: unknown): string => {
  try {
    return String(value);
  } catch {
    return '[unstringifiable]';
  }
};

const safeErrorMessage = (err: unknown): string => {
  try {
    const message = (err as { message?: unknown } | null | undefined)?.message;
    return safeStringify(message ?? err ?? '');
  } catch {
    return '[unstringifiable]';
  }
};

const safeErrorKind = (err: unknown): string => {
  try {
    return AppError.isAppError(err) ? safeStringify((err as { kind?: unknown }).kind) : 'stream';
  } catch {
    return 'stream';
  }
};

const safeNormaliseError = (err: unknown): ReturnType<typeof normaliseError> => {
  try {
    return normaliseError(err);
  } catch {
    return { name: 'Error', message: '[unstringifiable]' };
  }
};

const safeToReason = (err: unknown): Error => {
  try {
    return toReason(err);
  } catch {
    return new Error('[unstringifiable render error]');
  }
};

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
    // Pathname only: a query string like ?q=file.txt must not make a route look like an asset
    const rawPath = req.raw.url ? new URL(req.raw.url, `http://${req.headers.host}`).pathname : '';
    if (/\.\w+$/.test(rawPath)) return reply.callNotFound();

    const url = req.url ? new URL(req.url, `http://${req.headers.host}`).pathname : '/';
    const matchedRoute = matchRoute(url, routeMatchers);

    const rawNonce = (req as any).cspNonce as string | undefined | null;
    const cspNonce = rawNonce && rawNonce.length > 0 ? rawNonce : undefined;

    if (!matchedRoute) {
      return reply.callNotFound();
    }

    const { route, params } = matchedRoute;
    const { attr, appId } = route;

    // Dev-only recorder riding the hoisted context (P0B-02); absent → all calls no-op.
    const hoistedContext = getRequestContext(req);
    const recorder = hoistedContext?.recorder;
    if (recorder && hoistedContext)
      recorder.routeMatched({ traceId: hoistedContext.traceId, path: route.path, appId: appId ?? '', render: attr?.render ?? RENDERTYPE.ssr });
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

    const { clientRoot, entryServer } = config;

    let template = ensureNonNull(maps.templates.get(clientRoot), `Template not found for clientRoot: ${clientRoot}`);

    const bootstrapModule = maps.bootstrapModules.get(clientRoot);
    const cssLink = maps.cssLinks.get(clientRoot);
    const manifest = maps.manifests.get(clientRoot);
    const preloadLink = maps.preloadLinks.get(clientRoot);
    const ssrManifest = maps.ssrManifests.get(clientRoot);
    let devHead = '';

    let renderModule: RenderModule;

    if (isDevelopment && viteDevServer) {
      try {
        template = stripDevClientAndStyles(template);

        const entryServerFile = resolveEntryFile(clientRoot, entryServer);
        const entryServerPath = path.join(clientRoot, entryServerFile);
        const executedModule = await viteDevServer.ssrLoadModule(entryServerPath);
        renderModule = executedModule as RenderModule;

        const styles = await collectStyle(viteDevServer, [entryServerPath]);
        const styleNonce = cspNonce ? ` nonce="${cspNonce}"` : '';
        template = template?.replace('</head>', `<style type="text/css"${styleNonce}>${styles}</style></head>`);

        const isStreaming = attr?.render === RENDERTYPE.streaming;

        if (isStreaming) {
          // https://github.com/vitejs/vite-plugin-react/issues/222
          // Generate initial head with a stub to ensure vite HMR scripts/styles are included
          const stub = '<!doctype html><html><head></head><body></body></html>';
          const transformed = await viteDevServer.transformIndexHtml(url, stub);

          devHead = extractHeadInner(transformed);

          if (cspNonce) devHead = addNonceToInlineScripts(devHead, cspNonce);
        } else {
          template = await applyViteTransform(template, url, viteDevServer);
          if (cspNonce) template = addNonceToInlineScripts(template, cspNonce);
        }
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
    // Hoisted by SSRServer's onRequest hook (P0B-01); created in place only when handleRender
    // is invoked without the hook, preserving standalone behaviour byte-for-byte.
    const { traceId, logger: reqLogger, headers } = hoistedContext ?? createRequestContext(req, reply, baseLogger);
    // Dev stamp (spec 03 §7): present only when the structural gate holds — the decoration
    // exists solely on dev boots, so production HTML never carries it.
    const devtools = (req as { server?: { taujsIntrospection?: { token: string } } }).server?.taujsIntrospection;
    const devStamp = devtools ? buildTaujsDevStamp(traceId, devtools.token, cspNonce) : '';
    // R1-01 (design 4): each branch sets `ctx.signal` from its request AbortController BEFORE the
    // data is fetched, so loaders that honour `ctx.signal` stop on client disconnect / deadline.
    const ctx = { traceId, logger: reqLogger, headers, recorder, signal: undefined as AbortSignal | undefined };
    const initialDataInput = async () => {
      const dataT0 = now();
      try {
        const out = await fetchInitialData(attr, params, serviceRegistry, ctx);
        recorder?.dataFetch({ traceId, ms: +(now() - dataT0).toFixed(1), ok: true });
        return out;
      } catch (err) {
        recorder?.dataFetch({ traceId, ms: +(now() - dataT0).toFixed(1), ok: false });
        throw err;
      }
    };

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

      ctx.signal = ac.signal; // R1-01: propagate into the data context before fetching

      if (ac.signal.aborted) {
        logger.warn({ url: req.url }, 'SSR skipped; already aborted');
        recorder?.aborted({ traceId, phase: 'pre-render' });
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
          recorder?.aborted({ traceId, phase: 'post-render' });
          return;
        }
      } catch (err) {
        // R0-02: a renderSSR failure is render/data-origin — never benign by shape. Only an
        // actual client disconnect (signal aborted) is benign; anything else is an application
        // error that must produce a real 500. Previously a disconnect-shaped message returned
        // here WITHOUT sending a response, hanging the request.
        if (ac.signal.aborted) {
          logger.warn(
            {
              url: req.url,
              reason: String((err as any)?.message ?? err ?? ''),
            },
            'SSR aborted mid-render (client disconnected)',
          );
          recorder?.aborted({ traceId, phase: 'render' });
          return;
        }

        logger.error(
          {
            url: req.url,
            error: safeNormaliseError(err),
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
      // R0-04: single serialization boundary. On the SSR path a failure is inside the request
      // try/catch, so throw into the existing 500 machinery (valid-data output is unchanged).
      const serialized = serializeInlineData(initialDataResolved);
      if (!serialized.ok) {
        throw AppError.internal('Failed to serialize initial data for inline injection', serialized.error, { clientRoot, url: req.url });
      }
      const initialDataScript = `<script${nonceAttr}>window.__INITIAL_DATA__ = ${serialized.js};</script>`;

      const bootstrapScriptTag = shouldHydrate && bootstrapModule ? `<script${nonceAttr} type="module" src="${bootstrapModule}" defer></script>` : '';

      const safeAppHtml = appHtml.trim();
      const fullHtml = rebuildTemplate(templateParts, aggregateHeadContent, `${safeAppHtml}${initialDataScript}${devStamp}${bootstrapScriptTag}`);

      logger.debug?.('ssr', {}, 'ssr template rebuilt and sending response');

      try {
        const sendResult = reply.status(200).header('Content-Type', 'text/html').send(fullHtml);
        recorder?.sent({ traceId, status: 200, mode: 'ssr' });
        return sendResult;
      } catch (err) {
        const msg = String((err as any)?.message ?? err ?? '');
        // R0-02: a send failure is socket/writable-origin — classify by socket taxonomy.
        const benign = isBenignSocketError(err);

        if (!benign) {
          logger.error({ url: req.url, error: safeNormaliseError(err) }, 'SSR send failed');
          recorder?.failed({ traceId, error: { kind: 'send', message: msg } });
        } else {
          logger.warn({ url: req.url, reason: msg }, 'SSR send aborted (benign)');
          recorder?.aborted({ traceId, phase: 'send' });
        }

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

      // The raw socket is ours from here. The status is committed on first
      // output (onHead) rather than up front, so a render failure before any
      // bytes are written can still produce a real 500 response.
      reply.hijack();

      const commitHead = () => {
        if (!reply.raw.headersSent) reply.raw.writeHead(200, headers as any);
      };

      const abortedState = { aborted: false };
      const ac = new AbortController();

      const onAborted = () => {
        if (!abortedState.aborted) {
          logger.warn({}, 'Client disconnected before stream finished');
          abortedState.aborted = true;
          recorder?.aborted({ traceId, phase: 'stream' });
        }
        ac.abort();
      };

      req.raw.on('aborted', onAborted);
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) {
          if (!abortedState.aborted) {
            logger.warn({}, 'Client disconnected before stream finished');
            abortedState.aborted = true;
            recorder?.aborted({ traceId, phase: 'stream' });
          }
          ac.abort();
        }
      });

      reply.raw.on('finish', () => {
        req.raw.off('aborted', onAborted);
      });

      ctx.signal = ac.signal; // R1-01: propagate into the data context before renderStream fetches it

      const shouldHydrate = attr?.hydrate !== false;

      const writable = new PassThrough();
      writable.on('error', (err) => {
        if (!isBenignSocketError(err)) logger.error({ error: err }, 'PassThrough error:');
      });

      reply.raw.on('error', (err) => {
        if (!isBenignSocketError(err)) logger.error({ error: err }, 'HTTP socket error:');
      });

      let finalData: unknown = undefined;
      let pipedToReply = false;

      const { done } = renderStream(
        writable,
        {
          onHead: (headContent: string) => {
            let aggregateHeadContent = '';

            if (devHead) aggregateHeadContent += devHead;
            aggregateHeadContent += headContent;

            if (ssrManifest && preloadLink) aggregateHeadContent += preloadLink;
            if (manifest && cssLink) aggregateHeadContent += cssLink;

            commitHead();
            // devStamp lives in <head>, never inside #root: a leading <script> before the
            // streamed app HTML is a Vue hydration node mismatch (the whole app re-renders
            // as a duplicate sibling). React skips unexpected scripts, Vue does not.
            reply.raw.write(`${templateParts.beforeHead}${aggregateHeadContent}${devStamp}${templateParts.afterHead}${templateParts.beforeBody}`);
            recorder?.streamPhase({ traceId, phase: 'head' });

            if (!pipedToReply) {
              pipedToReply = true;
              writable.pipe(reply.raw, { end: false });
            }
          },
          onShellReady: () => {
            recorder?.streamPhase({ traceId, phase: 'shellReady' });
          },
          onAllReady: (data: unknown) => {
            if (!abortedState.aborted) finalData = data;
            recorder?.streamPhase({ traceId, phase: 'allReady' });
          },
          onRenderError: (info) => {
            // R1-01 (design 7): NON-FATAL structured render-error channel — wired to the request
            // logger with structured fields. No new recorder methods (TraceRecorder integration is
            // introspection-owned, conventions #3). Never fails the response.
            //
            // Log at `warn`, not `error`: this channel is advisory by contract. Only `post-shell`
            // errors are provably recoverable (React retries the boundary client-side); a
            // `pre-shell` error's fatality is resolved by the SEPARATE fatal channel
            // (`onError`/`onShellError`), which logs the real failure at `error` if it fails the
            // response. Keying the message on `recoverable` avoids claiming "Recoverable" for a
            // pre-shell error that then turns fatal (which previously double-logged at `error` with
            // contradictory framing).
            const message =
              info.recoverable === true
                ? 'Recoverable render error (React retries the affected boundary client-side)'
                : 'Render error observed (pre-shell); response outcome resolved by the fatal channel';
            reqLogger.warn({ error: safeNormaliseError(info.error), phase: info.phase, recoverable: info.recoverable, clientRoot, url: req.url }, message);
          },
          onError: (err: unknown) => {
            // Gate finding 1: `onError` is the renderer's FATAL channel — the renderer already
            // established origin (benign socket disconnects are handled by the writable guards via
            // `benignAbort`, never routed here). Trust it: the only benign condition is ACTUAL
            // request-abort state, never the shape of an app-controlled error (re-classifying by
            // `code`/`name`/message would re-introduce the R0-02 spoofing at the cross-package join).
            if (abortedState.aborted) {
              logger.warn({}, 'Client disconnected before stream finished');
              recorder?.aborted({ traceId, phase: 'stream' });
              try {
                if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.destroy();
              } catch (e) {
                logger.debug?.('ssr', { error: safeNormaliseError(e) }, 'stream teardown: destroy() failed');
              }
              return;
            }

            abortedState.aborted = true;

            // Recheck: this callback must NEVER throw — a throw here (e.g. formatting a hostile
            // error for telemetry) would skip the response teardown below and hang the request.
            // Format defensively and belt the telemetry so teardown always runs.
            try {
              recorder?.failed({ traceId, error: { kind: safeErrorKind(err), message: safeErrorMessage(err) } });
              logger.error({ error: safeNormaliseError(err), clientRoot, url: req.url }, 'Critical rendering error during stream');
            } catch {
              // telemetry formatting must not veto teardown
            }

            try {
              ac?.abort?.();
            } catch (e) {
              logger.debug?.('ssr', { error: safeNormaliseError(e) }, 'stream teardown: abort() failed');
            }

            if (!reply.raw.headersSent) {
              // Nothing committed yet - send a real error response instead of
              // tearing down the socket.
              try {
                reply.raw.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                reply.raw.end('Internal Server Error');
              } catch (e) {
                logger.debug?.('ssr', { error: safeNormaliseError(e) }, 'stream teardown: error response failed');
              }
              return;
            }

            const reason = safeToReason(err);

            try {
              if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.destroy(reason);
            } catch (e) {
              logger.debug?.('ssr', { error: safeNormaliseError(e) }, 'stream teardown: destroy() failed');
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

      // R0-01: observe the stream handle's `done`. Fatal stream errors are already fully handled
      // via the `onError` callback above, so this catch is acknowledgement (it marks the
      // rejection handled) and defence in depth if a renderer omits its own pre-attached handler
      // — an unobserved rejected `done` would otherwise crash the process under Node's default
      // unhandled-rejection mode.
      void done.catch(() => {});

      writable.on('finish', () => {
        // R0-04: this listener runs on a stream tick, OUTSIDE the request try/catch, so an
        // uncaught throw here becomes an `uncaughtException` → process exit. `serializeInlineData`
        // never throws; the outer try/catch is a belt so nothing else in the listener can either.
        try {
          if (abortedState.aborted || reply.raw.writableEnded) return;

          const data = finalData ?? {};
          const serialized = serializeInlineData(data);

          if (!serialized.ok) {
            abortedState.aborted = true;
            logger.error({ error: safeNormaliseError(serialized.error), clientRoot, url: req.url }, 'Failed to serialize streaming initial data');
            recorder?.failed({ traceId, error: { kind: 'serialize', message: String(serialized.error.message) } });

            // Deterministic termination — mirror the onError teardown idioms above.
            if (!reply.raw.headersSent) {
              try {
                reply.raw.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
                reply.raw.end('Internal Server Error');
              } catch (e) {
                logger.debug?.('ssr', { error: safeNormaliseError(e) }, 'stream teardown: error response failed');
              }
            } else {
              // Shell already committed: end without the data script and destroy.
              try {
                if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.destroy();
              } catch (e) {
                logger.debug?.('ssr', { error: safeNormaliseError(e) }, 'stream teardown: destroy() failed');
              }
            }
            return;
          }

          const initialDataScript = `<script${
            cspNonce ? ` nonce="${cspNonce}"` : ''
          }>window.__INITIAL_DATA__ = ${serialized.js}; window.dispatchEvent(new Event('taujs:data-ready'));</script>`;

          commitHead();
          reply.raw.write(initialDataScript);
          reply.raw.write(templateParts.afterBody);
          reply.raw.end();
          recorder?.sent({ traceId, status: 200, mode: 'streaming' });
        } catch (e) {
          // Belt: never let this listener throw — an uncaughtException here would exit the process.
          logger.error({ error: safeNormaliseError(e), clientRoot, url: req.url }, 'Streaming finish listener failed');
          try {
            if (!reply.raw.writableEnded && !reply.raw.destroyed) reply.raw.destroy();
          } catch {}
        }
      });
    }
  } catch (err) {
    const hoisted = getRequestContext(req);
    hoisted?.recorder?.failed({
      traceId: hoisted.traceId,
      error: { kind: AppError.isAppError(err) ? (err as any).kind : 'internal', message: String((err as any)?.message ?? err ?? '') },
    });

    if (AppError.isAppError(err)) throw err;

    throw AppError.internal('handleRender failed', err, {
      url: req.url,
      route: (req as any).routeOptions?.url,
    });
  }
};
