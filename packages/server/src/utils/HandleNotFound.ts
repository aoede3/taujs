import type { FastifyRequest, FastifyReply } from 'fastify';

import { ServiceError } from './ServiceError';
import { createLogger } from './Logger';
import { isDevelopment } from './System';
import { ensureNonNull } from './Templates';
import { SSRTAG } from '../constants';

import type { DebugConfig, Logger } from './Logger';
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
    logger?: Partial<Logger>;
  } = {},
) => {
  const { debug = false, logger: customLogger } = opts;
  const logger = createLogger(debug, customLogger);

  try {
    if (/\.\w+$/.test(req.raw.url ?? '')) return reply.callNotFound();

    const defaultConfig = processedConfigs[0];
    if (!defaultConfig) {
      throw ServiceError.infra('No default configuration found', {
        details: { configCount: processedConfigs.length, url: req.raw.url },
      });
    }

    const { clientRoot } = defaultConfig;
    const cspNonce = req.cspNonce;

    const template = ensureNonNull(maps.templates.get(clientRoot), `Template not found for clientRoot: ${clientRoot}`);

    const cssLink = maps.cssLinks.get(clientRoot);
    const bootstrapModule = maps.bootstrapModules.get(clientRoot);

    let processedTemplate = template.replace(SSRTAG.ssrHead, '').replace(SSRTAG.ssrHtml, '');

    if (!isDevelopment && cssLink) {
      processedTemplate = processedTemplate.replace('</head>', `${cssLink}</head>`);
    }

    if (bootstrapModule) {
      const initialDataScript = `<script${cspNonce ? ` nonce="${cspNonce}"` : ''}>
    window.__INITIAL_DATA__ = {};
  </script>`;
      processedTemplate = processedTemplate.replace(
        '</body>',
        `${initialDataScript}<script${cspNonce ? ` nonce="${cspNonce}"` : ''} type="module" src="${bootstrapModule}" defer></script></body>`,
      );
    }

    reply.status(200).type('text/html').send(processedTemplate);
  } catch (err) {
    logger.serviceError(err, {
      stage: 'handleNotFound',
      url: req.raw.url,
      clientRoot: processedConfigs[0]?.clientRoot,
    });

    reply.status(500).send('Internal Server Error');
  }
};
