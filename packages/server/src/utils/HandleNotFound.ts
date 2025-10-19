import { AppError } from '../logging/AppError';
import { isDevelopment } from './System';
import { ensureNonNull } from './Templates';
import { SSRTAG } from '../constants';

import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Logs } from '../logging/Logger';
import type { ProcessedConfig } from '../types';
import type { DebugInput } from '../logging/Parser';

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
    debug?: DebugInput;
    logger?: Logs;
  } = {},
) => {
  try {
    if (/\.\w+$/.test(req.raw.url ?? '')) return reply.callNotFound();

    const defaultConfig = processedConfigs[0];
    if (!defaultConfig) {
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

    if (!isDevelopment && cssLink) processedTemplate = processedTemplate.replace('</head>', `${cssLink}</head>`);

    if (bootstrapModule) {
      const nonceAttr = cspNonce ? ` nonce="${cspNonce}"` : '';
      processedTemplate = processedTemplate.replace('</body>', `<script${nonceAttr} type="module" src="${bootstrapModule}" defer></script></body>`);
    }

    reply.status(200).type('text/html').send(processedTemplate);
  } catch (err) {
    throw AppError.internal('handleNotFound failed', err, {
      stage: 'handleNotFound',
      url: req.url,
      clientRoot: processedConfigs[0]?.clientRoot,
    });
  }
};
