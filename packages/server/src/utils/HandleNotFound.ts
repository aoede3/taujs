import { AppError } from '../core/errors/AppError';
import { SSRTAG } from '../constants';
import { createLogger } from '../logging/Logger';
import { isDevelopment } from '../System';
import { ensureNonNull, addNonceToInlineScripts, applyViteTransform, injectBootstrapModule, injectCssLink, stripDevClientAndStyles } from './Templates';

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { ViteDevServer } from 'vite';
import type { DebugConfig, Logs } from '../core/logging/types';
import type { ProcessedConfig } from '../types';

export const handleNotFound = async (
  req: FastifyRequest,
  reply: FastifyReply,
  processedConfigs: ProcessedConfig[],
  maps: {
    cssLinks: Map<string, string>;
    bootstrapModules: Map<string, string>;
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
    opts.logger ??
    createLogger({
      debug: opts.debug,
      context: { component: 'handle-not-found', url: req.url, method: req.method, traceId: (req as any).id },
    });

  try {
    if (/\.\w+$/.test(req.raw.url ?? '')) {
      logger.debug?.('ssr', { url: req.raw.url }, 'Delegating asset-like request to Fastify notFound handler');

      return reply.callNotFound();
    }

    const defaultConfig = processedConfigs[0];
    if (!defaultConfig) {
      logger.error?.({ configCount: processedConfigs.length, url: req.raw.url }, 'No default configuration found');
      throw AppError.internal('No default configuration found', {
        details: { configCount: processedConfigs.length, url: req.raw.url },
      });
    }

    const { clientRoot } = defaultConfig;
    const cspNonce: string | undefined = (req as any).cspNonce ?? undefined;

    const template = ensureNonNull(maps.templates.get(clientRoot), `Template not found for clientRoot: ${clientRoot}`);

    const cssLink = maps.cssLinks.get(clientRoot);
    const bootstrapModule = maps.bootstrapModules.get(clientRoot);

    let processedTemplate = template.replace(SSRTAG.ssrHead, '').replace(SSRTAG.ssrHtml, '');

    if (isDevelopment && viteDevServer) {
      processedTemplate = stripDevClientAndStyles(processedTemplate);

      const url = req.url ? new URL(req.url, `http://${req.headers.host}`).pathname : '/';

      processedTemplate = await applyViteTransform(processedTemplate, url, viteDevServer);

      if (cspNonce) processedTemplate = addNonceToInlineScripts(processedTemplate, cspNonce);
    } else if (!isDevelopment && cssLink) {
      processedTemplate = injectCssLink(processedTemplate, cssLink);
    }

    processedTemplate = injectBootstrapModule(processedTemplate, bootstrapModule, cspNonce);

    logger.debug?.('ssr', { status: 200 }, 'Sending not-found fallback HTML');

    const result = reply.status(200).type('text/html').send(processedTemplate);

    return result;
  } catch (err) {
    logger.error?.({ error: err, url: req.url, clientRoot: processedConfigs[0]?.clientRoot }, 'handleNotFound failed');
    throw AppError.internal('handleNotFound failed', err, {
      stage: 'handleNotFound',
      url: req.url,
      clientRoot: processedConfigs[0]?.clientRoot,
    });
  }
};
