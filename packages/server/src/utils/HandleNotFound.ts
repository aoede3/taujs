import { Logger } from './Logger';
import { ServiceError } from './ServiceError';
import { isDevelopment } from './System';
import { ensureNonNull } from './Templates';
import { SSRTAG } from '../constants';

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { DebugConfig, Logs } from './Logger';
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
  const baseLogger = opts.logger ?? new Logger();
  if (opts.debug !== undefined) baseLogger.configure(opts.debug);
  const logger = baseLogger.child({ component: 'handleNotFound' });

  try {
    if (/\.\w+$/.test(req.raw.url ?? '')) return reply.callNotFound();

    const defaultConfig = processedConfigs[0];
    if (!defaultConfig) {
      throw ServiceError.infra('No default configuration found', {
        details: { configCount: processedConfigs.length, url: req.raw.url },
      });
    }

    const { clientRoot } = defaultConfig;
    const cspNonce: string | undefined = (req as any).cspNonce ?? undefined;

    const template = ensureNonNull(maps.templates.get(clientRoot), `Template not found for clientRoot: ${clientRoot}`);

    const cssLink = maps.cssLinks.get(clientRoot);
    const bootstrapModule = maps.bootstrapModules.get(clientRoot);

    let processedTemplate = template.replace(SSRTAG.ssrHead, '').replace(SSRTAG.ssrHtml, '');

    if (!isDevelopment && cssLink) processedTemplate = processedTemplate.replace('</head>', `${cssLink}</head>`);

    if (bootstrapModule) {
      const nonceAttr = cspNonce ? ` nonce="${cspNonce}"` : '';
      const initialDataScript = `<script${nonceAttr}>
        window.__INITIAL_DATA__ = {};
      </script>`;

      processedTemplate = processedTemplate.replace(
        '</body>',
        `${initialDataScript}<script${nonceAttr} type="module" src="${bootstrapModule}" defer></script></body>`,
      );
    }

    reply.status(200).type('text/html').send(processedTemplate);
  } catch (err) {
    logger.error('handleNotFound failed', {
      stage: 'handleNotFound',
      url: req.raw.url,
      clientRoot: processedConfigs[0]?.clientRoot,
      error: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err),
    });

    reply.status(500).send('Internal Server Error');
  }
};
