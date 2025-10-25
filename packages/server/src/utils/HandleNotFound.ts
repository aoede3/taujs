import { AppError } from '../logging/AppError';
import { createLogger } from '../logging/Logger';
import { isDevelopment } from './System';
import { ensureNonNull } from './Templates';
import { SSRTAG } from '../constants';

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { DebugConfig, Logs } from '../logging/Logger';
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
  } = {},
) => {
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

    logger.debug?.(
      'ssr',
      {
        clientRoot,
        hasCssLink: !!cssLink,
        hasBootstrapModule: !!bootstrapModule,
        isDevelopment,
        hasCspNonce: !!cspNonce,
      },
      'Preparing not-found fallback HTML',
    );

    let processedTemplate = template.replace(SSRTAG.ssrHead, '').replace(SSRTAG.ssrHtml, '');

    if (!isDevelopment && cssLink) {
      processedTemplate = processedTemplate.replace('</head>', `${cssLink}</head>`);
    }

    if (bootstrapModule) {
      const nonceAttr = cspNonce ? ` nonce="${cspNonce}"` : '';
      processedTemplate = processedTemplate.replace('</body>', `<script${nonceAttr} type="module" src="${bootstrapModule}" defer></script></body>`);
    }

    logger.debug?.('ssr', { status: 200 }, 'Sending not-found fallback HTML');
    return reply.status(200).type('text/html').send(processedTemplate);
  } catch (err) {
    logger.error?.({ error: err, url: req.url, clientRoot: processedConfigs[0]?.clientRoot }, 'handleNotFound failed');
    throw AppError.internal('handleNotFound failed', err, {
      stage: 'handleNotFound',
      url: req.url,
      clientRoot: processedConfigs[0]?.clientRoot,
    });
  }
};
