import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { RENDERTYPE } from '../core/constants';
import { AppError, normaliseError, toReason } from '../core/errors/AppError';
import { logResponseFailure } from '../core/errors/ResponseFailureLog';
import { fetchHeadData, fetchInitialData } from '../core/routes/DataRoutes';
import { buildDeferredEnvelopeJson, createDeferredData } from '../core/routes/DeferredData';
import { now } from '../core/telemetry/Telemetry';
import { createLogger } from '../logging/Logger';
import { isDevelopment } from '../System';
import { resolveEntryFile } from './Entry';
import { createRequestContext, getRequestContext, recordPreCommitFailure } from './Telemetry';
import {
  requireTemplate,
  buildTaujsDevStamp,
  collectStyle,
  escapeHtmlAttribute,
  processTemplate,
  rebuildTemplate,
  addNonceToInlineScripts,
  extractHeadInner,
  stripDevClient,
  applyViteTransform,
} from './Templates';
import { inlineJsFromJson, serializeInlineData } from './InlineData';
import { assertRenderContract, declaredContractOf, requireRendererContribution } from './RendererContract';

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ViteDevServer } from 'vite';
import type { DebugConfig, Logs } from '../core/logging/types';
import type { SelectedPageRoute } from '../core/routes/FastifyRoutes';
import type { ServiceRegistry } from '../core/services/DataServices';
import type { DeferredDataController } from '../core/routes/DeferredData';
import type { Manifest, ProcessedConfig, RenderModule } from '../types';

/**
 * RFC 0007 (R4, decision 15): the PRIVATE deferred-outcome envelope carrier. Undocumented and
 * unsupported for applications - assigned inside the SAME nonced end-of-stream script as the public
 * snapshot, only under the host-resolved hydration policy.
 */
const DEFERRED_STATE_CARRIER = '__TAUJS_DEFERRED_STATE__';

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
  selectedRoute: SelectedPageRoute,
  processedConfigs: ProcessedConfig[],
  serviceRegistry: ServiceRegistry,
  maps: {
    bootstrapModules: Map<string, string>;
    cssLinks: Map<string, string>;
    manifests: Map<string, Manifest>;
    preloadLinks: Map<string, string>;
    renderModules: Map<string, RenderModule>;
    templates: Map<string, string>;
    /** The original boot-time template read failure, retained by clientRoot (development only). */
    templateLoadFailures?: Map<string, unknown>;
  },
  opts: {
    debug?: DebugConfig;
    logger?: Logs;
    viteDevServer?: ViteDevServer;
    /** RFC 0012: the installation's validated emission coordinate; prefixes the dev beacon URL. */
    publicBasePath?: string;
  } = {},
) => {
  const { viteDevServer } = opts;

  const baseLogger =
    (opts.logger as Logs | undefined) ??
    createLogger({
      debug: opts.debug,
      minLevel: isDevelopment ? 'debug' : 'info',
      includeContext: true,
      includeStack: (lvl) => lvl === 'error' || isDevelopment,
    });
  const requestContext = getRequestContext(req) ?? createRequestContext(req, reply, baseLogger);
  const { requestId, logger, headers, url: requestUrl, recorder } = requestContext;
  const reqLogger = logger;

  // RFC 0007 (R2 item 8): FUNCTION-SCOPED, not block-scoped inside the streaming branch. A
  // synchronous throw out of `renderStream` - or anything else escaping that branch into the outer
  // catch - is a response terminal that reaches it with entries already started; without this
  // binding nothing would classify them, no R5 episode event would fire and their child abort signal
  // would outlive the response.
  let deferred: DeferredDataController | undefined;

  /**
   * The streaming response-terminal coordinator, hoisted so the outer catch cannot become a SECOND
   * terminal owner. Set once the streaming branch installs it; `undefined` on the SSR path, which
   * keeps its own terminals.
   */
  let finaliseStreamingResponse:
    ((arm: 'complete' | 'failed' | 'aborted', info?: { error?: unknown; phase?: 'render' | 'send' | 'stream' }) => void) | undefined;

  /**
   * The SSR response-terminal coordinator, hoisted for the same reason: the outer catch must not
   * become a SECOND terminal owner. Set once the SSR branch installs it; `undefined` on the
   * streaming path, and `undefined` on the SSR path for a throw that happens BEFORE the branch is
   * reached, which is why the outer catch still keeps its direct arm.
   */
  let finaliseSsrResponse:
    | ((
        arm: 'complete' | 'failed' | 'aborted',
        info?: { error?: unknown; kind?: string; phase?: 'pre-render' | 'render' | 'post-render' | 'send'; disconnect?: boolean },
      ) => void)
    | undefined;

  try {
    const url = req.url ? new URL(req.url, `http://${req.headers.host}`).pathname : '/';

    const rawNonce = req.cspNonce;
    const cspNonce = rawNonce && rawNonce.length > 0 ? rawNonce : undefined;

    const { route, params } = selectedRoute;
    const { attr, appId } = route;

    // Dev-only recorder riding the hoisted context (P0B-02); absent → all calls no-op.
    if (recorder) recorder.routeMatched({ requestId, path: route.path, appId: appId ?? '', render: attr?.render ?? RENDERTYPE.ssr });
    const routeContext = {
      appId,
      path: route.path,
      attr,
      params,
    };

    // ESC-2: the host-resolved hydration policy, computed ONCE and passed on BOTH render strategies (in
    // opts.shouldHydrate). It also drives the host's operative hydration mechanism (the SSR bootstrap tag /
    // the stream bootstrapModules gate) - one host-side source of truth.
    const shouldHydrate = attr?.hydrate !== false;

    const config = processedConfigs.find((c) => c.appId === appId);
    if (!config) {
      throw AppError.internal('No configuration found for the request', undefined, {
        appId,
        availableAppIds: processedConfigs.map((c) => c.appId),
        url,
      });
    }

    const { clientRoot, entryServer } = config;

    let template = requireTemplate(maps.templates, maps.templateLoadFailures, clientRoot);

    const bootstrapModule = maps.bootstrapModules.get(clientRoot);
    const cssLink = maps.cssLinks.get(clientRoot);
    const manifest = maps.manifests.get(clientRoot);
    const preloadLink = maps.preloadLinks.get(clientRoot);
    let devHead = '';

    let renderModule: RenderModule;

    if (isDevelopment && viteDevServer) {
      try {
        template = stripDevClient(template);

        const entryServerFile = resolveEntryFile(clientRoot, entryServer);
        const entryServerPath = path.join(clientRoot, entryServerFile);
        const executedModule = await viteDevServer.ssrLoadModule(entryServerPath);

        // Renderer v1: validate the dev-loaded module's identity against the app's renderer declaration
        // BEFORE it is invoked for this request (prod modules are validated once at boot). `renderer:` is
        // required and every renderer ships a render module - a missing/invalid one hard-errors here.
        const contribution = requireRendererContribution(config.appId, config.renderer);
        assertRenderContract(executedModule, declaredContractOf(contribution), { phase: 'dev', appId: config.appId, clientRoot });
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
        // Preserve a render-contract validation AppError's migration guidance rather than masking it as a
        // generic dev-asset failure.
        if (AppError.isAppError(error)) throw error;
        throw AppError.internal('Failed to load dev assets', error, { clientRoot, entryServer, url });
      }
    } else {
      renderModule = maps.renderModules.get(clientRoot) as RenderModule;
      if (!renderModule) throw AppError.internal(`Render module not found for clientRoot: ${clientRoot}. Module should have been preloaded.`);
    }

    const renderType = attr?.render ?? RENDERTYPE.ssr;
    const templateParts = processTemplate(template);

    // The request context is hoisted by SSRServer's onRequest hook (P0B-01); direct
    // handler invocation creates it once at entry so every branch uses one logger lineage.
    // Dev stamp (spec 03 §7): present only when the structural gate holds — the decoration
    // exists solely on dev boots, so production HTML never carries it.
    const devtools = (req as { server?: { taujsIntrospection?: { token: string } } }).server?.taujsIntrospection;
    const devStamp = devtools ? buildTaujsDevStamp(requestId, devtools.token, cspNonce, opts.publicBasePath ?? '') : '';
    // R1-01 (design 4): each branch sets `ctx.signal` from its request AbortController BEFORE the
    // data is fetched, so loaders that honour `ctx.signal` stop on client disconnect / deadline.
    const ctx = { requestId, logger: reqLogger, headers, url: requestUrl, recorder, signal: undefined as AbortSignal | undefined };
    const initialDataInput = async () => {
      const dataT0 = now();
      try {
        const out = await fetchInitialData(attr, params, serviceRegistry, ctx);
        recorder?.dataFetch({ requestId, ms: +(now() - dataT0).toFixed(1), ok: true });
        return out;
      } catch (err) {
        recorder?.dataFetch({ requestId, ms: +(now() - dataT0).toFixed(1), ok: false });
        throw err;
      }
    };

    // RFC 0004 (H1): resolve `attr.head` BEFORE the renderer starts, on both strategies. Signed
    // taxonomy, tracked by WHICH source fired (never inferred from error shape - R0-02 doctrine):
    // - caller abort  -> { aborted: true }; the branch returns through its existing abort path -
    //                    a dead request never proceeds into the renderer with degraded head data;
    // - deadline      -> Policy ii: proceed with headData undefined + an advisory warn. The
    //                    deadline WINS THE AWAIT via a race (a loader that ignores ctx.signal
    //                    cannot hold the shell hostage); the loser's eventual settlement is
    //                    pre-observed so it can never raise unhandledRejection (R0-01 class);
    // - rejection     -> rethrow into the branch's existing error path, unless the route opted in
    //                    with `head.optional`, which degrades like the deadline.
    // No recorder events here - request-graph/episode support is the rule-11 escalation (H4).
    const resolveHeadData = async (requestSignal: AbortSignal): Promise<{ aborted: boolean; headData?: Record<string, unknown> }> => {
      const head = attr?.head;
      if (!head) return { aborted: false, headData: undefined };
      if (requestSignal.aborted) return { aborted: true };

      const timeoutMs = head.timeoutMs ?? 3_000;
      const headAbort = new AbortController();
      let deadlineHit = false;
      const onRequestAbort = () => headAbort.abort((requestSignal as { reason?: unknown }).reason ?? new Error('request aborted'));
      requestSignal.addEventListener('abort', onRequestAbort, { once: true });
      const timer = setTimeout(() => {
        deadlineHit = true;
        headAbort.abort(new Error(`head data deadline (${timeoutMs}ms) reached`));
      }, timeoutMs);

      const abortRace = new Promise<never>((_, rejectRace) => {
        headAbort.signal.addEventListener('abort', () => rejectRace(headAbort.signal.reason ?? new Error('head data aborted')), { once: true });
      });
      abortRace.catch(() => {}); // pre-observed: the race loser must never be an unhandled rejection

      try {
        // Same shape as the body-data ctx, but with the HEAD controller's signal: loaders that
        // honour ctx.signal stop on the head deadline as well as on client disconnect.
        const headCtx = { ...ctx, signal: headAbort.signal };
        const fetchPromise = fetchHeadData(attr, params, serviceRegistry, headCtx);
        fetchPromise.catch(() => {}); // pre-observed for the same reason (a late loser settlement is discarded)

        const headData = await Promise.race([fetchPromise, abortRace]);
        return { aborted: false, headData };
      } catch (err) {
        if (requestSignal.aborted) return { aborted: true };
        if (deadlineHit || head.optional === true) {
          logger.warn(
            { url: req.url, timeoutMs, optional: head.optional === true, reason: safeErrorMessage(err) },
            'Head data degraded; rendering with headData undefined',
          );
          return { aborted: false, headData: undefined };
        }
        throw err;
      } finally {
        clearTimeout(timer);
        requestSignal.removeEventListener('abort', onRequestAbort);
      }
    };

    if (renderType === RENDERTYPE.ssr) {
      const { renderSSR } = renderModule;
      if (!renderSSR) {
        throw AppError.internal('renderSSR function not found in module', undefined, {
          clientRoot,
          availableFunctions: Object.keys(renderModule),
        });
      }

      logger.debug?.('ssr', {}, 'ssr requested');

      const ac = new AbortController();
      const onAborted = () => ac.abort('client_aborted');

      /**
       * The ONE SSR response-terminal coordinator - parallel in REACH to the streaming one, not in
       * complexity. Cancellation OBSERVATIONS stay plural (request abort, response close, a
       * τjs-observed failure); the terminal OWNER is singular and latched:
       *
       *   finish, captured socket healthy  -> sent(reply.raw.statusCode, ssr) -> complete
       *   finish, captured socket dead     -> aborted('send') + warning        -> aborted
       *   τjs-observed failure             -> failed(error)                    -> failed
       *   close while the latch is open    -> aborted(current stage) + warning -> aborted
       *
       * `reply.send()` merely QUEUES a response, so recording delivery from its return classified
       * an abandoned response as a successful 200. `finish` is not delivery either: it means the
       * payload was handed to the operating system for transmission, NOT that the client received
       * it (Node's documented `ServerResponse` contract), and on this BUFFERED arm it fires even
       * after the peer has reset - measured. So the SOCKET is the discriminator, not the event.
       */
      let ssrFinalised = false;
      /** How far the SSR arm got, so an abort keeps the phase it already reported. */
      let ssrStage: 'pre-render' | 'render' | 'post-render' | 'send' = 'pre-render';

      const finaliseSsrOnce = (
        arm: 'complete' | 'failed' | 'aborted',
        info: { error?: unknown; kind?: string; phase?: 'pre-render' | 'render' | 'post-render' | 'send'; disconnect?: boolean } = {},
      ): void => {
        if (ssrFinalised) return;
        ssrFinalised = true;

        // Release-first ordering, mirroring the streaming coordinator. `deferred` is created only
        // in the streaming branch, so this is a deliberate no-op here; it keeps the outer catch's
        // rewiring honest rather than making the ordering a streaming-only property.
        try {
          deferred?.release();
        } catch {}

        try {
          if (arm === 'complete') {
            recorder?.sent({ requestId, status: reply.raw.statusCode ?? 200, mode: 'ssr' });
          } else if (arm === 'failed') {
            // Each failing site keeps the kind it records today - 'send' for a send failure, the
            // AppError kind (or 'internal') for a throw reaching the outer catch. Only the OWNER
            // moved; the recorded classification did not.
            recorder?.failed({
              requestId,
              error: {
                kind: info.kind ?? (AppError.isAppError(info.error) ? (info.error as { kind: string }).kind : 'internal'),
                message: safeErrorMessage(info.error),
              },
            });
          } else {
            recorder?.aborted({ requestId, phase: info.phase ?? ssrStage });
          }
        } catch {}

        // Classification FIRST, warning second: a throwing logger must never prevent the terminal.
        // The latch makes the warning exactly-once, and `disconnect` confines it to socket-observed
        // aborts - the signal-abort sites keep their own existing log lines.
        if (arm === 'aborted' && info.disconnect) {
          try {
            logger.warn({ url: req.url, phase: info.phase ?? ssrStage }, 'Client disconnected before the SSR response finished');
          } catch {}
        }
      };

      finaliseSsrResponse = finaliseSsrOnce;

      // The response socket, captured HERE and never re-read: by `finish` time `reply.raw.socket`
      // already reads null (measured), so the reference has to be taken as the listeners install.
      const sock = reply.raw.socket;

      req.raw.on('aborted', onAborted);
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) ac.abort('socket_closed');

        // No guard: a close that follows a healthy `finish` is latched out by event ordering, and
        // that ordering plus the latch is what owns normal finish-then-close. `writableFinished` is
        // deliberately absent everywhere in this arm - it is measurably unsound in BOTH directions
        // (true on a real mid-delivery reset, false on a healthy `inject()` response).
        finaliseSsrOnce('aborted', { phase: ssrStage, disconnect: true });
      });
      reply.raw.on('finish', () => {
        req.raw.off('aborted', onAborted);

        // The peer's departure is only visible on the SOCKET, so that is what decides the arm. An
        // ABSENT socket is not by itself evidence of failure - it classifies `complete`, and a
        // response already dead when the listeners attached is owned by the check below.
        //
        // HONEST LIMITATION: this detects socket failure OBSERVED BY THE TIME `finish` RUNS. A reset
        // observed only after a healthy `finish` cannot be classified retroactively without claiming
        // knowledge the server did not have, and an abandonment further downstream - a proxy timing
        // out behind us - is not detectable here at all. Neither is claimed.
        if (sock && (sock.destroyed || sock.errored)) finaliseSsrOnce('aborted', { phase: 'send', disconnect: true });
        else finaliseSsrOnce('complete');
      });

      // A client can leave BEFORE this point: an awaiting host hook sits in front of the handler,
      // and in development so does Vite's own module loading. `close` has then ALREADY been
      // emitted, so the listeners above can never fire and nothing would classify the response. An
      // event that already happened has to be observed by asking, not by listening.
      if (reply.raw.destroyed) finaliseSsrOnce('aborted', { phase: ssrStage, disconnect: true });

      ctx.signal = ac.signal; // R1-01: propagate into the data context before fetching

      if (ac.signal.aborted) {
        logger.warn({ url: req.url }, 'SSR skipped; already aborted');
        finaliseSsrOnce('aborted', { phase: 'pre-render' });
        return;
      }

      const initialDataResolved = await initialDataInput();

      // RFC 0004 (H1): head data resolves after the body data (both are pre-render on this
      // strategy); a caller abort during either returns through the same abort path.
      const headResolution = await resolveHeadData(ac.signal);
      if (headResolution.aborted) {
        logger.warn({ url: req.url }, 'SSR skipped; client disconnected during head data');
        finaliseSsrOnce('aborted', { phase: 'pre-render' });
        return;
      }

      let headContent = '';
      let appHtml = '';
      try {
        ssrStage = 'render';
        // RFC 0004: `headData` is present only when the route's head RESOLVED to a value -
        // conditional spread so no-head (and degraded) routes show no observable key.
        const res = await renderSSR(initialDataResolved, req.url!, attr?.meta, ac.signal, {
          logger: reqLogger,
          routeContext,
          ...(headResolution.headData !== undefined ? { headData: headResolution.headData } : {}),
          // ESC-2: cspNonce + shouldHydrate are delivered on BOTH strategies (symmetric RenderOptions).
          ...(cspNonce ? { cspNonce } : {}),
          shouldHydrate,
        });
        headContent = res.headContent;
        appHtml = res.appHtml;
        ssrStage = 'post-render';

        logger.debug?.('ssr', {}, 'ssr data resolved');

        if (ac.signal.aborted) {
          logger.warn({}, 'SSR completed but client disconnected');
          finaliseSsrOnce('aborted', { phase: 'post-render' });
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
              reason: safeErrorMessage(err),
            },
            'SSR aborted mid-render (client disconnected)',
          );
          finaliseSsrOnce('aborted', { phase: 'render' });
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

      // RULED 2026-08-26: module preloads accelerate the CLIENT execution graph, so a route that
      // does not hydrate must not receive them - there is nothing to accelerate. CSS is emitted
      // either way: the server-rendered HTML still needs styling.
      if (shouldHydrate && preloadLink) aggregateHeadContent += preloadLink;
      if (manifest && cssLink) aggregateHeadContent += cssLink;

      const nonceAttr = cspNonce ? ` nonce="${cspNonce}"` : '';
      // R0-04: single serialization boundary. On the SSR path a failure is inside the request
      // try/catch, so throw into the existing 500 machinery (valid-data output is unchanged).
      const serialized = serializeInlineData(initialDataResolved);
      if (!serialized.ok) {
        throw AppError.internal('Failed to serialize initial data for inline injection', serialized.error, { clientRoot, url: req.url });
      }
      const initialDataScript = `<script${nonceAttr}>window.__INITIAL_DATA__ = ${serialized.js};</script>`;

      const bootstrapScriptTag =
        shouldHydrate && bootstrapModule ? `<script${nonceAttr} type="module" src="${escapeHtmlAttribute(bootstrapModule)}" defer></script>` : '';

      const safeAppHtml = appHtml.trim();
      const fullHtml = rebuildTemplate(templateParts, aggregateHeadContent, `${safeAppHtml}${initialDataScript}${devStamp}${bootstrapScriptTag}`);

      logger.debug?.('ssr', {}, 'ssr template rebuilt and sending response');

      try {
        const sendResult = reply.status(200).header('Content-Type', 'text/html').send(fullHtml);
        // HANDOFF, not delivery: `send()` queues the response and returns. Only the stage advances
        // here - the terminal belongs to `finish` (or to a `close` that beats it).
        ssrStage = 'send';
        return sendResult;
      } catch (err) {
        const msg = safeErrorMessage(err);
        // R0-02: a send failure is socket/writable-origin — classify by socket taxonomy.
        const benign = isBenignSocketError(err);

        if (!benign) {
          logger.error({ url: req.url, error: safeNormaliseError(err) }, 'SSR send failed');
          finaliseSsrOnce('failed', { error: err, kind: 'send' });
        } else {
          logger.warn({ url: req.url, reason: msg }, 'SSR send aborted (benign)');
          finaliseSsrOnce('aborted', { phase: 'send' });
        }

        return;
      }
    } else {
      const { renderStream } = renderModule;
      if (!renderStream) {
        throw AppError.internal('renderStream function not found in module', undefined, {
          clientRoot,
          availableFunctions: Object.keys(renderModule),
        });
      }

      // FASTIFY OWNS THE SEND. The handler returns a COLD document stream: nothing runs until
      // Fastify consumes it, so `onSend` hooks, host transformations and payload replacement all
      // compose normally, and there is no window in which τjs owns a live stream Fastify has not
      // taken over. Fastify writes the head, so no header object is assembled here and the
      // response type is declared on the reply.
      //
      // The commitment boundary is the BYTE, not a renderer callback: before the first document
      // byte is yielded to Fastify a failure can still become a real 500; after it, a failure
      // aborts the transfer. Renderers reach that boundary on their own terms - React at its shell,
      // Vue after publishing its head, Solid possibly not until component work succeeds.
      reply.type('text/html; charset=utf-8');

      /** Resolved when the renderer's head is ready; REJECTED by a pre-byte failure. */
      let resolveShell: (html: string) => void = () => {};
      let rejectShell: (reason: unknown) => void = () => {};
      const shellReady = new Promise<string>((resolve, reject) => {
        resolveShell = resolve;
        rejectShell = reject;
      });

      // The document may NEVER be pulled - an `onSend` hook can replace the payload outright - so a
      // pre-consumption failure would otherwise reject this promise with nothing to observe it, and
      // Node would report an unhandledRejection. This acknowledgement owns that case; the real
      // `await` inside the document still sees the rejection when the document IS consumed.
      void shellReady.catch(() => {});

      /** Resolved with the closing document bytes, or `undefined` when the response is failing. */
      let resolveTail: (html: string | undefined) => void = () => {};
      const tailReady = new Promise<string | undefined>((resolve) => {
        resolveTail = resolve;
      });

      const documentState = { committed: false, completed: false, settledEarly: false };

      /**
       * A failure that arrived BEFORE the first byte was yielded, held so the document can re-throw
       * it.
       *
       * `onHead` resolving the shell is not commitment: the generator is still suspended, and
       * nothing has left the process until it resumes and yields. A fatal inside that gap cannot
       * reject `shellReady` - it is already resolved - so without this the document would commit
       * and deliver a truncated page under a clean 200.
       */
      let preCommitFailure: { reason: unknown } | undefined;

      const abortedState = { aborted: false };
      const ac = new AbortController();

      /**
       * The ONE response-terminal coordinator. Multiple cancellation OBSERVATIONS are allowed -
       * request abort, response close, stream cancellation - but there is exactly one terminal
       * OWNER, and it is latched:
       *
       *   response finish            -> release deferred -> sent(status, streaming) -> complete
       *   renderer / response fatal  -> release deferred -> failed(error)           -> failed
       *   close without a finish     -> release deferred -> aborted(phase)          -> aborted
       *
       * Deferred release happens BEFORE telemetry and is idempotent, so a host that REPLACES the
       * payload - meaning no terminal of ours ever runs inside the document - still releases the
       * work that started eagerly in this handler.
       */
      let responseFinalised = false;

      const finaliseResponseOnce = (arm: 'complete' | 'failed' | 'aborted', info: { error?: unknown; phase?: 'render' | 'send' | 'stream' } = {}): void => {
        if (responseFinalised) return;
        responseFinalised = true;

        try {
          deferred?.release();
        } catch {}

        try {
          if (arm === 'complete') {
            recorder?.sent({ requestId, status: reply.raw.statusCode ?? 200, mode: 'streaming' });
          } else if (arm === 'failed') {
            recorder?.failed({ requestId, error: { kind: safeErrorKind(info.error), message: safeErrorMessage(info.error) } });
          } else {
            recorder?.aborted({ requestId, phase: info.phase ?? 'stream' });
          }
        } catch {}
      };

      finaliseStreamingResponse = finaliseResponseOnce;

      /** Pre-byte failures can still become a real 500; post-byte failures abort the transfer. */
      const failResponse = (reason?: unknown): void => {
        finaliseResponseOnce('failed', { error: reason });

        if (!documentState.committed) {
          documentState.settledEarly = true;

          // Transport failure REJECTS the document; choosing the error representation belongs to
          // the response error handler, not here. (`sendStream` has already copied this response's
          // `text/html` onto the raw response, so a content-type change at this point would be
          // shadowed by the raw header anyway.)
          const failure = reason ?? new Error('taujs: streaming failed before the first document byte');

          preCommitFailure = { reason: failure };

          // Docs/followups/live/streaming-pre-shell-error-transform-ruling.md: a payload transform
          // (compression, for example) sitting between this cold document and the wire may replace
          // the stream error it is about to observe with one of its own, so the scope error handler
          // cannot rely on the object Fastify eventually hands it. Recording the original error here,
          // keyed by this exact request, gives that handler a way back to it without widening any
          // public shape.
          recordPreCommitFailure(req, failure);
          rejectShell(failure);
          resolveTail(undefined);

          return;
        }

        resolveTail(undefined);
        if (!writable.destroyed) writable.destroy(reason instanceof Error ? reason : new Error('taujs: streaming failed after commitment'));
      };

      const abortResponse = (phase: 'render' | 'send' | 'stream' = 'stream'): void => {
        finaliseResponseOnce('aborted', { phase });

        if (!documentState.committed) {
          documentState.settledEarly = true;
          resolveShell('');
          resolveTail(undefined);
        }

        resolveTail(undefined);
        if (!writable.destroyed) writable.destroy();
      };

      const onAborted = () => {
        if (!abortedState.aborted) {
          logger.warn({}, 'Client disconnected before stream finished');
          abortedState.aborted = true;
        }
        ac.abort();
        abortResponse('stream');
      };

      req.raw.on('aborted', onAborted);

      // Fastify owns delivery, so its own response events are the authority: `finish` means the
      // bytes left, whoever produced them; `close` without a finish is premature termination.
      reply.raw.on('finish', () => {
        req.raw.off('aborted', onAborted);
        finaliseResponseOnce('complete');
      });

      reply.raw.on('close', () => {
        if (reply.raw.writableFinished) return;

        if (!abortedState.aborted) {
          logger.warn({}, 'Client disconnected before stream finished');
          abortedState.aborted = true;
        }

        ac.abort();
        abortResponse('stream');
      });

      ctx.signal = ac.signal; // R1-01: propagate into the data context before renderStream fetches it

      // RFC 0007 (R2, decision 2): the declared deferred entries start HERE - immediately after
      // `ctx.signal` is assigned and BEFORE head resolution, the earliest point at which the
      // request context is complete. Each handler is invoked exactly once, eagerly, outside the
      // component tree, with the matched params and the same request service context `attr.data`
      // uses. The host never awaits an entry and never inspects one mid-stream.
      deferred = createDeferredData({ attr, params, serviceRegistry, ctx, requestId, recorder });

      const writable = new PassThrough();
      writable.on('error', (err) => {
        if (!isBenignSocketError(err)) logger.error({ error: err }, 'PassThrough error:');
      });

      reply.raw.on('error', (err) => {
        if (!isBenignSocketError(err)) logger.error({ error: err }, 'HTTP socket error:');
      });

      // A client can leave BEFORE this point: any awaiting host hook sits in front of the handler,
      // and in development so does Vite's own module loading. `close` has then ALREADY been emitted,
      // so the listeners above can never fire - nothing would classify the response, and nothing
      // would release the deferred work that started eagerly a few lines up. An event that already
      // happened has to be observed by asking, not by listening.
      if (reply.raw.destroyed || req.raw.aborted) {
        if (!abortedState.aborted) {
          logger.warn({}, 'Client disconnected before stream finished');
          abortedState.aborted = true;
        }

        ac.abort();
        abortResponse('render');
      }

      let finalData: unknown = undefined;

      /**
       * The document is CREATED before head resolution but CONSUMED only when Fastify pulls, so
       * the renderer start and the response terminal are wired through this holder rather than
       * captured early. Assigned below, once both exist.
       */
      const documentWiring: { startRenderer?: () => { done: Promise<unknown> }; onWritableFinish?: () => void } = {};

      /**
       * The COLD document. Nothing here runs until Fastify consumes the payload, which is what
       * makes `onSend` composable: a hook may delay it, transform it, or replace it outright, and
       * in the replacement case the renderer never starts at all.
       */
      const documentPayload = Readable.from(
        (async function* () {
          try {
            // A response that already settled before any byte - a head-data failure or a caller
            // abort - never starts the renderer at all. Renderer CONSTRUCTION is inside this try
            // deliberately: a SYNCHRONOUS `renderStream` throw would otherwise escape before any
            // terminal ran, leaving the registry unreleased and the episode unclassified.
            if (!documentState.settledEarly) {
              // R0-01: observe the stream handle's `done`. Fatal stream errors are handled by the
              // `onError` callback, so this catch is acknowledgement and defence in depth against a
              // renderer that omits its own pre-attached handler.
              const { done } = documentWiring.startRenderer!();
              void done.catch(() => {});
              writable.on('finish', documentWiring.onWritableFinish!);
            }

            const shell = await shellReady;

            // Commitment is the first byte YIELDED TO FASTIFY, not the head resolving. A fatal that
            // arrived while this was suspended is still pre-byte, so it re-throws here and becomes a
            // real error response instead of committing a truncated document.
            if (preCommitFailure) throw preCommitFailure.reason;

            documentState.committed = true;
            yield shell;

            for await (const chunk of writable) yield chunk;

            const tail = await tailReady;
            if (tail) yield tail;

            documentState.completed = true;
          } catch (error) {
            // The LATCH makes this safe: a callback-driven fatal has already finalised, so this
            // cannot record twice; a synchronous renderer throw has not, so this becomes its
            // terminal owner. The original rejection is rethrown so Fastify converts it - a
            // pre-byte throw becomes a real 500, a post-byte one aborts delivery.
            //
            // Deliberately NOT `failResponse()`: for a synchronous construction throw, execution
            // never reaches `await shellReady`, so rejecting it here would leave an unobserved
            // rejected promise.
            finaliseResponseOnce('failed', { error });

            throw error;
          } finally {
            // LOCAL disposal only: the response terminal is owned by the coordinator, never here.
            if (!documentState.completed && !ac.signal.aborted) ac.abort();
          }
        })(),
      );

      // RFC 0004 (H1): head data resolves BEFORE the renderer starts - the only pre-shell await on
      // this strategy (body data streams as always). Placed AFTER the abort wiring so those
      // handlers observe errors during the head fetch too. Fastify owns the response, so an arm
      // here settles the DOCUMENT (through the coordinator) and returns the payload; the outer
      // catch must not rethrow past a payload Fastify is already holding.
      let headResolution: { aborted: boolean; headData?: Record<string, unknown> };
      try {
        headResolution = await resolveHeadData(ac.signal);
      } catch (err) {
        // Non-optional head rejection: terminate deterministically (the finish-listener
        // serialize-failure idiom) - 500 if the head has not been committed, destroy otherwise.
        // Telemetry is BELTED INDEPENDENTLY of the teardown (gate-review finding 1, same rule as
        // A critical head failure IS a response terminal, and it goes through the coordinator like
        // every other one: `failResponse` releases the registry BEFORE telemetry and records the
        // failure exactly once. Logging is belted separately so a throwing logger cannot skip the
        // settlement.
        try {
          failResponse(err);
        } catch {}
        try {
          logger.error({ error: safeNormaliseError(err), url: req.url }, 'Head data failed; terminating streaming request');
        } catch {}
        return await documentPayload;
      }
      if (headResolution.aborted) {
        try {
          abortResponse('render');
        } catch {}
        return await documentPayload;
      }

      const startRenderer = (): { done: Promise<unknown> } =>
        renderStream(
          writable,
          {
            onHead: (headContent: string) => {
              let aggregateHeadContent = '';

              if (devHead) aggregateHeadContent += devHead;
              aggregateHeadContent += headContent;

              // Same policy as the SSR arm: hydration-gated module preloads, CSS unconditional.
              if (shouldHydrate && preloadLink) aggregateHeadContent += preloadLink;
              if (manifest && cssLink) aggregateHeadContent += cssLink;

              // devStamp lives in <head>, never inside #root: a leading <script> before the
              // streamed app HTML is a Vue hydration node mismatch (the whole app re-renders
              // as a duplicate sibling). React skips unexpected scripts, Vue does not.
              resolveShell(`${templateParts.beforeHead}${aggregateHeadContent}${devStamp}${templateParts.afterHead}${templateParts.beforeBody}`);
              recorder?.streamPhase({ requestId, phase: 'head' });
            },
            onShellReady: () => {
              recorder?.streamPhase({ requestId, phase: 'shellReady' });
            },
            onAllReady: (data: unknown) => {
              if (!abortedState.aborted) finalData = data;
              recorder?.streamPhase({ requestId, phase: 'allReady' });
            },
            onRenderError: (info) => {
              // R1-01 (design 7): NON-FATAL structured render-error channel — wired to the request
              // logger with structured fields. No new recorder methods (EpisodeRecorder integration is
              // introspection-owned, conventions #3). Never fails the response.
              //
              // Log at `warn`, not `error`: this channel is advisory by contract. Only `post-shell`
              // errors are provably recoverable (the renderer's client runtime completes the affected
              // boundary); a `pre-shell` error's fatality is resolved by the SEPARATE fatal channel
              // (`onError`/`onShellError`), which logs the real failure at `error` if it fails the
              // response. Keying the message on `recoverable` avoids claiming "Recoverable" for a
              // pre-shell error that then turns fatal (which previously double-logged at `error` with
              // contradictory framing). ESC-2: framework-neutral wording (the host is multi-renderer).
              const message =
                info.recoverable === true
                  ? 'Recoverable render error (the client runtime completes the affected boundary)'
                  : 'Render error observed (pre-shell); response outcome resolved by the fatal channel';
              reqLogger.warn({ error: safeNormaliseError(info.error), phase: info.phase, recoverable: info.recoverable, clientRoot, url: req.url }, message);
            },
            onError: (err: unknown) => {
              // RFC 0007 (R2 item 8): the fatal renderer terminal releases the registry FIRST, before
              // any telemetry or teardown, on both arms below.
              try {
                deferred?.release();
              } catch {}
              // Gate finding 1: `onError` is the renderer's FATAL channel — the renderer already
              // established origin (benign socket disconnects are handled by the writable guards via
              // `benignAbort`, never routed here). Trust it: the only benign condition is ACTUAL
              // request-abort state, never the shape of an app-controlled error (re-classifying by
              // `code`/`name`/message would re-introduce the R0-02 spoofing at the cross-package join).
              if (abortedState.aborted) {
                logger.warn({}, 'Client disconnected before stream finished');
                try {
                  abortResponse('stream');
                } catch (e) {
                  logger.debug?.('ssr', { error: safeNormaliseError(e) }, 'stream teardown: abort failed');
                }
                return;
              }

              abortedState.aborted = true;

              // Recheck: this callback must NEVER throw — a throw here (e.g. formatting a hostile
              // error for telemetry) would skip the response teardown below and hang the request.
              // Format defensively and belt the telemetry so teardown always runs.
              try {
                logResponseFailure({
                  terminal: 'streaming',
                  logger,
                  error: err,
                  clientRoot,
                  url: req.url,
                });
              } catch {
                // telemetry formatting must not veto teardown
              }

              try {
                ac?.abort?.();
              } catch (e) {
                logger.debug?.('ssr', { error: safeNormaliseError(e) }, 'stream teardown: abort() failed');
              }

              try {
                failResponse(safeToReason(err));
              } catch (e) {
                logger.debug?.('ssr', { error: safeNormaliseError(e) }, 'stream teardown: failure settlement failed');
              }
            },
          },
          initialDataInput,
          req.url!,
          // The bootstrapModules gate stays the operative hydration mechanism; the host keeps it consistent
          // with the same `shouldHydrate` it now also passes explicitly in opts (one host-side source).
          shouldHydrate ? bootstrapModule : undefined,
          attr?.meta,
          ac.signal,
          // ESC-2: cspNonce is now opts-authoritative (was a positional argument); shouldHydrate is the
          // host-resolved policy. RFC 0004: headData conditional inclusion - see the renderSSR call site.
          {
            logger: reqLogger,
            routeContext,
            ...(headResolution.headData !== undefined ? { headData: headResolution.headData } : {}),
            ...(cspNonce ? { cspNonce } : {}),
            shouldHydrate,
            // RFC 0007 (decision 14): conditionally spread exactly like `headData` - a route
            // declaring no deferred entries has no `deferredData` property at all, so its opts bag
            // and its rendered bytes are unchanged.
            ...(deferred ? { deferredData: deferred.registry } : {}),
          },
        );

      const finishListener = () => {
        // R0-04: this listener runs on a stream tick, OUTSIDE the request try/catch, so an
        // uncaught throw here becomes an `uncaughtException` → process exit. `serializeInlineData`
        // never throws; the outer try/catch is a belt so nothing else in the listener can either.
        try {
          // RFC 0007 (R4): this early return IS a response terminal - the bytes are already gone,
          // so no envelope can be emitted, but outstanding deferred work must still be signalled
          // and classified `aborted` here. Releasing is idempotent, so the paths that already
          // released (the fatal channel, the head terminals) are unaffected.
          if (abortedState.aborted || reply.raw.writableEnded) {
            try {
              deferred?.release();
            } catch {}
            return;
          }

          const data = finalData ?? {};
          const serialized = serializeInlineData(data);

          if (!serialized.ok) {
            abortedState.aborted = true;
            logger.error({ error: safeNormaliseError(serialized.error), clientRoot, url: req.url }, 'Failed to serialize streaming initial data');

            // Deterministic termination — the same failure arm as every other fatal.
            try {
              failResponse(serialized.error);
            } catch (e) {
              logger.debug?.('ssr', { error: safeNormaliseError(e) }, 'stream teardown: failure settlement failed');
            }
            return;
          }

          // RFC 0007 (R4): this write site IS the response terminal for deferred work. Classify
          // everything (anything still pending is `aborted`), then release - the envelope text is
          // already assembled from the retained settlement bytes, so nothing is serialised here.
          //
          // Decision 8: the carrier is emitted ONLY under the host-resolved hydration policy. Under
          // `hydrate: false` there is no client runtime to seed, so the rest of this script is
          // byte-for-byte what it has always been while the registry is still settled, classified
          // and released - R5 outcomes are unaffected either way.
          let deferredAssignment = '';
          if (deferred) {
            const settlements = deferred.settleAll();
            if (shouldHydrate) deferredAssignment = ` window.${DEFERRED_STATE_CARRIER} = ${inlineJsFromJson(buildDeferredEnvelopeJson(settlements))};`;
            deferred.release();
          }

          const initialDataScript = `<script${
            cspNonce ? ` nonce="${cspNonce}"` : ''
          }>window.__INITIAL_DATA__ = ${serialized.js};${deferredAssignment} window.dispatchEvent(new Event('taujs:data-ready'));</script>`;

          // The document tail goes to the generator; DELIVERY is reported by `reply.raw` 'finish',
          // because the payload may still be transformed, replaced or fail downstream of here.
          resolveTail(`${initialDataScript}${templateParts.afterBody}`);
        } catch (e) {
          // Belt: never let this listener throw — an uncaughtException here would exit the process.
          try {
            deferred?.release();
          } catch {}
          logger.error({ error: safeNormaliseError(e), clientRoot, url: req.url }, 'Streaming finish listener failed');
          try {
            failResponse(e);
          } catch {}
        }
      };

      documentWiring.startRenderer = startRenderer;
      documentWiring.onWritableFinish = finishListener;

      return await documentPayload;
    }
  } catch (err) {
    // RFC 0007: release FIRST, before any telemetry - a throwing recorder or logger must never
    // strand a started registry (this is the terminal a synchronous `renderStream` throw reaches).
    //
    // ONE TERMINAL OWNER: each strategy installs a latched coordinator that owns both the release
    // and the classification, so an error escaping to here routes through whichever one exists and
    // cannot record a second terminal - a render failure whose 500 response later emits `finish`
    // stays `failed`. The final arm still covers a throw that happened BEFORE either branch was
    // reached, which has no coordinator to route through.
    if (finaliseStreamingResponse) {
      finaliseStreamingResponse('failed', { error: err });
    } else if (finaliseSsrResponse) {
      finaliseSsrResponse('failed', { error: err });
    } else {
      try {
        deferred?.release();
      } catch {}

      recorder?.failed({
        requestId,
        error: { kind: AppError.isAppError(err) ? err.kind : 'internal', message: safeErrorMessage(err) },
      });
    }

    if (AppError.isAppError(err)) throw err;

    throw AppError.internal('handleRender failed', err, {
      url: req.url,
      route: req.routeOptions?.url,
    });
  }
};
