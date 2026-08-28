import { AppError } from '../core/errors/AppError';
import { SSRTAG } from '../constants';
import { createLogger } from '../logging/Logger';
import { isDevelopment } from '../System';
import { getRequestContext } from './Telemetry';
import {
  requireTemplate,
  addNonceToInlineScripts,
  applyViteTransform,
  buildTaujsDevStamp,
  injectBootstrapModule,
  injectCssLink,
  stripDevClient,
} from './Templates';

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ViteDevServer } from 'vite';
import type { DebugConfig, Logs } from '../core/logging/types';
import type { ProcessedConfig } from '../types';

// A thrown value is untrusted: its message getter or toString may itself throw, and a failure to
// describe it must not cost the terminal.
const describeError = (error: unknown): string => {
  try {
    return error instanceof Error ? String(error.message) : String(error);
  } catch {
    return 'unknown error';
  }
};

export const handleNotFound = async (
  req: FastifyRequest,
  reply: FastifyReply,
  processedConfigs: ProcessedConfig[],
  maps: {
    cssLinks: Map<string, string>;
    bootstrapModules: Map<string, string>;
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

  // Hoisted context (P0B-01): fallthrough logs carry the canonical reqId; the x-request-id
  // response header is already set by the hook. Without the hook, behaviour is unchanged.
  const requestContext = getRequestContext(req);

  const logger =
    requestContext?.logger ??
    opts.logger ??
    createLogger({
      debug: opts.debug,
      context: { component: 'handle-not-found', url: req.url, method: req.method, reqId: (req as any).id },
    });

  try {
    // Pathname only: a query string like ?q=file.txt must not make a route look like an asset
    const rawPath = req.raw.url ? new URL(req.raw.url, `http://${req.headers.host}`).pathname : '';
    if (/\.\w+$/.test(rawPath)) {
      logger.debug?.('ssr', { url: req.raw.url }, 'Delegating asset-like request to Fastify notFound handler');

      return reply.callNotFound();
    }

    const defaultConfig = processedConfigs[0];
    if (!defaultConfig) {
      logger.error?.({ configCount: processedConfigs.length, url: req.raw.url }, 'No default configuration found');
      throw AppError.internal('No default configuration found', undefined, { configCount: processedConfigs.length, url: req.raw.url });
    }

    const { clientRoot } = defaultConfig;
    const cspNonce: string | undefined = (req as any).cspNonce ?? undefined;

    const template = requireTemplate(maps.templates, maps.templateLoadFailures, clientRoot);

    const cssLink = maps.cssLinks.get(clientRoot);
    const bootstrapModule = maps.bootstrapModules.get(clientRoot);

    let processedTemplate = template.replace(SSRTAG.ssrHead, '').replace(SSRTAG.ssrHtml, '');

    if (isDevelopment && viteDevServer) {
      processedTemplate = stripDevClient(processedTemplate);

      const url = req.url ? new URL(req.url, `http://${req.headers.host}`).pathname : '/';

      processedTemplate = await applyViteTransform(processedTemplate, url, viteDevServer);

      if (cspNonce) processedTemplate = addNonceToInlineScripts(processedTemplate, cspNonce);
    } else if (!isDevelopment && cssLink) {
      processedTemplate = injectCssLink(processedTemplate, cssLink);
    }

    processedTemplate = injectBootstrapModule(processedTemplate, bootstrapModule, cspNonce);

    // Dev stamp (spec 03 §7): the fallthrough shell has no __INITIAL_DATA__ script to ride
    // with, so it gets its own — only when the structural gate holds (dev decoration).
    const devtools = (req as { server?: { taujsIntrospection?: { token: string } } }).server?.taujsIntrospection;
    if (devtools && requestContext) {
      processedTemplate = processedTemplate.replace(
        '</body>',
        `${buildTaujsDevStamp(requestContext.requestId, devtools.token, cspNonce, opts.publicBasePath ?? '')}</body>`,
      );
    }

    logger.debug?.('ssr', { status: 200 }, 'Sending not-found fallback HTML');

    // Deliberate SPA fallback: unmatched page URLs get the default app's shell
    // with a 200 so client-side routes beyond taujs.config still work.
    const recorder = requestContext?.recorder;

    // Fallthrough terminal event (spec 03 §1): requestStart → sent, no routeMatched - this is what
    // makes accidental CSR visible. `finish` is not delivery: the terminal classifies from the socket
    // captured here, the same discriminator the SSR arm uses (`writableFinished` is deliberately not
    // consulted). A throwing send latches `failed` first, so the host's own error response cannot
    // later finish as a healthy `sent`.
    let finalised = false;
    const finalise = (outcome: 'sent' | 'aborted' | 'failed', error?: unknown) => {
      if (finalised || !recorder) return;
      finalised = true;
      try {
        if (outcome === 'sent') recorder.sent({ requestId: requestContext.requestId, status: reply.raw.statusCode ?? 200, mode: 'fallthrough' });
        else if (outcome === 'failed') {
          recorder.failed({ requestId: requestContext.requestId, error: { kind: 'internal', message: describeError(error) } });
        } else {
          recorder.aborted({ requestId: requestContext.requestId, phase: 'send' });
          logger.warn?.({ url: req.url }, 'Client disconnected before the fallthrough response finished');
        }
      } catch {}
    };

    if (recorder) {
      const sock = reply.raw.socket;
      reply.raw.on('close', () => finalise('aborted'));
      reply.raw.on('finish', () => finalise(sock && (sock.destroyed || sock.errored) ? 'aborted' : 'sent'));
      if (reply.raw.destroyed) finalise('aborted');
    }

    try {
      return reply.status(200).type('text/html').send(processedTemplate);
    } catch (err) {
      finalise('failed', err);
      throw err;
    }
  } catch (err) {
    logger.error?.({ error: err, url: req.url, clientRoot: processedConfigs[0]?.clientRoot }, 'handleNotFound failed');
    throw AppError.internal('handleNotFound failed', err, {
      stage: 'handleNotFound',
      url: req.url,
      clientRoot: processedConfigs[0]?.clientRoot,
    });
  }
};
